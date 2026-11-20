// SPDX-License-Identifier: GPL-3.0-only
//! Word (.docx) export. Written directly (no Word or Pandoc needed): real headings, real
//! footnotes, highlights, and optionally your own comments as Word comments.
use crate::export::{BookMeta, DocStyle, Item, Options};
use crate::md::{self, Block, Inline};
use std::{
    collections::HashMap,
    io::{Cursor, Write},
};

/// A comment to put in the Word file, by the scene it belongs to.
#[derive(Debug, Clone)]
pub struct SceneNote {
    pub passage: String,
    pub text: String,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[derive(Clone, PartialEq, Default)]
struct Fmt {
    bold: bool,
    italic: bool,
    strike: bool,
    highlight: Option<&'static str>,
}

fn word_highlight(color: &str) -> &'static str {
    match color {
        "green" => "green",
        "blue" => "cyan",
        "pink" => "magenta",
        "orange" => "darkYellow",
        _ => "yellow",
    }
}

/// A paragraph's content before it becomes XML.
#[derive(Clone)]
enum It {
    Text(String, Fmt),
    Note(usize),
    CommentStart(usize),
    CommentEnd(usize),
    Break,
}

struct Doc<'a> {
    meta: &'a BookMeta,
    opts: &'a Options,
    notes: Vec<String>,
    comments: Vec<String>,
    body: String,
}

fn flatten(ins: &[Inline], fmt: &Fmt, out: &mut Vec<It>, notes: &mut Vec<String>) {
    for i in ins {
        match i {
            Inline::Text(t) => out.push(It::Text(t.clone(), fmt.clone())),
            Inline::Bold(c) => flatten(c, &Fmt { bold: true, ..fmt.clone() }, out, notes),
            Inline::Italic(c) => flatten(c, &Fmt { italic: true, ..fmt.clone() }, out, notes),
            Inline::Strike(c) => flatten(c, &Fmt { strike: true, ..fmt.clone() }, out, notes),
            Inline::Highlight(color, c) => flatten(c, &Fmt { highlight: Some(word_highlight(color)), ..fmt.clone() }, out, notes),
            Inline::Note(n) => {
                notes.push(n.clone());
                out.push(It::Note(notes.len()));
            }
            Inline::Break => out.push(It::Break),
        }
    }
}

/// Put comment range markers around `passage` where it is found in this paragraph's text.
fn anchor(items: Vec<It>, passage: &str, id: usize) -> (Vec<It>, bool) {
    let plain: Vec<char> = items.iter().filter_map(|i| if let It::Text(t, _) = i { Some(t.chars()) } else { None }).flatten().collect();
    let needle: Vec<char> = passage.trim().chars().collect();
    if needle.is_empty() || needle.len() > plain.len() {
        return (items, false);
    }
    let Some(start) = (0..=plain.len() - needle.len()).find(|&s| plain[s..s + needle.len()] == needle[..]) else { return (items, false) };
    let end = start + needle.len();
    let mut out = vec![];
    let mut pos = 0;
    let (mut started, mut ended) = (false, false);
    let mut mark = |out: &mut Vec<It>, at: usize| {
        if !started && at >= start {
            out.push(It::CommentStart(id));
            started = true;
        }
        if started && !ended && at >= end {
            out.push(It::CommentEnd(id));
            ended = true;
        }
    };
    for it in items {
        match it {
            It::Text(t, f) => {
                let chars: Vec<char> = t.chars().collect();
                let mut from = 0;
                for cut in [start, end] {
                    if cut > pos && cut < pos + chars.len() && cut - pos > from {
                        let piece: String = chars[from..cut - pos].iter().collect();
                        mark(&mut out, pos + from);
                        out.push(It::Text(piece, f.clone()));
                        from = cut - pos;
                        mark(&mut out, pos + from);
                    }
                }
                let rest: String = chars[from..].iter().collect();
                mark(&mut out, pos + from);
                if !rest.is_empty() {
                    out.push(It::Text(rest, f));
                }
                pos += chars.len();
                mark(&mut out, pos);
            }
            other => out.push(other),
        }
    }
    if started && !ended {
        out.push(It::CommentEnd(id));
    }
    (out, started)
}

fn rpr(f: &Fmt) -> String {
    let mut s = String::new();
    if f.bold {
        s.push_str("<w:b/>");
    }
    if f.italic {
        s.push_str("<w:i/>");
    }
    if f.strike {
        s.push_str("<w:strike/>");
    }
    if let Some(h) = f.highlight {
        s.push_str(&format!("<w:highlight w:val=\"{h}\"/>"));
    }
    if s.is_empty() { s } else { format!("<w:rPr>{s}</w:rPr>") }
}

fn runs(items: &[It]) -> String {
    let mut out = String::new();
    for it in items {
        match it {
            It::Text(t, f) => out.push_str(&format!("<w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r>", rpr(f), esc(t))),
            It::Note(n) => out.push_str(&format!("<w:r><w:rPr><w:rStyle w:val=\"FootnoteReference\"/></w:rPr><w:footnoteReference w:id=\"{n}\"/></w:r>")),
            It::CommentStart(id) => out.push_str(&format!("<w:commentRangeStart w:id=\"{}\"/>", id - 1)),
            It::CommentEnd(id) => out.push_str(&format!("<w:commentRangeEnd w:id=\"{0}\"/><w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"{0}\"/></w:r>", id - 1)),
            It::Break => out.push_str("<w:r><w:br/></w:r>"),
        }
    }
    out
}

impl Doc<'_> {
    fn para(&mut self, style: &str, items: &[It]) {
        self.body.push_str(&format!("<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>{}</w:p>", runs(items)));
    }

    /// A paragraph of inlines, with any of this scene's comments whose passage it holds.
    fn inline_para(&mut self, style: &str, ins: &[Inline], pending: &mut Vec<SceneNote>) {
        let mut items = vec![];
        flatten(ins, &Fmt::default(), &mut items, &mut self.notes);
        // Footnote ids were pushed in order, so they are the numbers already.
        let mut i = 0;
        while i < pending.len() {
            let id = self.comments.len() + 1;
            let (next, placed) = anchor(items.clone(), &pending[i].passage, id);
            if placed {
                items = next;
                self.comments.push(pending.remove(i).text);
            } else {
                i += 1;
            }
        }
        self.para(style, &items);
    }

    fn scene_break(&mut self) {
        let t = self.opts.scene_break.trim();
        let t = if t.is_empty() { "\u{a0}" } else { t };
        self.para("SceneBreak", &[It::Text(t.to_string(), Fmt::default())]);
    }

    fn blocks(&mut self, blocks: &[Block], pending: &mut Vec<SceneNote>, first: &mut bool, quote: bool) {
        for b in blocks {
            match b {
                Block::Para(ins) => {
                    let style = if quote { "Quote" } else if *first { "FirstParagraph" } else { "BodyText" };
                    self.inline_para(style, ins, pending);
                    *first = false;
                }
                Block::Heading(_, ins) => {
                    self.inline_para("Subhead", ins, pending);
                    *first = true;
                }
                Block::Quote(inner) => self.blocks(inner, pending, first, true),
                Block::List { ordered, items } => {
                    for (n, item) in items.iter().enumerate() {
                        let mark = if *ordered { format!("{}.\t", n + 1) } else { "\u{2022}\t".to_string() };
                        let mut ins = vec![Inline::Text(mark)];
                        ins.extend(item.clone());
                        self.inline_para("ListItem", &ins, pending);
                    }
                    *first = false;
                }
                Block::Rule => {
                    self.scene_break();
                    *first = true;
                }
            }
        }
    }
}

fn surname(author: &str) -> String {
    author.split_whitespace().last().unwrap_or("").to_string()
}

fn styles(style: DocStyle) -> String {
    let (font, size, line, indent, after, hsize, hbefore) = match style {
        DocStyle::Manuscript => ("Times New Roman", 24, 480, 720, 0, 24, 2880),
        DocStyle::Book => ("Georgia", 22, 288, 360, 0, 36, 1800),
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}" w:eastAsia="{font}"/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="{after}" w:line="{line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="{indent}"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="FirstParagraph"><w:name w:val="First Paragraph"/><w:basedOn w:val="BodyText"/><w:qFormat/><w:pPr><w:ind w:firstLine="{first}"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:pageBreakBefore/><w:spacing w:before="{hbefore}" w:after="480" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="{hsize}"/><w:szCs w:val="{hsize}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="240" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subhead"><w:name w:val="Subhead"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:next w:val="FirstParagraph"/><w:qFormat/><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="120" w:after="120" w:line="240" w:lineRule="auto"/><w:ind w:left="720" w:right="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListItem"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="240" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Author"><w:name w:val="Author"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TitleCorner"><w:name w:val="Title Corner"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/><w:jc w:val="right"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>
</w:styles>"#,
        first = if style == DocStyle::Manuscript { indent } else { 0 },
    )
}

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

/// Build the .docx. `notes` are the author's comments by scene id; they are used only when the options ask.
pub fn build(items: &[Item], opts: &Options, meta: &BookMeta, words: usize, notes: &HashMap<String, Vec<SceneNote>>) -> Result<Vec<u8>, String> {
    let mut d = Doc { meta, opts, notes: vec![], comments: vec![], body: String::new() };
    let has_parts = items.iter().any(|i| matches!(i, Item::Part { .. }));
    let manuscript = opts.style == DocStyle::Manuscript;

    if opts.title_page {
        let approx = ((words + 50) / 100) * 100;
        if manuscript {
            d.para("TitleCorner", &[It::Text(format!("{}", surname_line(meta)), Fmt::default())]);
            d.para("TitleCorner", &[It::Text(format!("approx. {} words", group(approx)), Fmt::default())]);
            for _ in 0..6 {
                d.para("TitleCorner", &[It::Text(String::new(), Fmt::default())]);
            }
        } else {
            for _ in 0..8 {
                d.para("Author", &[It::Text(String::new(), Fmt::default())]);
            }
        }
        d.para("Title", &[It::Text(meta.title.clone(), Fmt::default())]);
        if let Some(sub) = meta.subtitle.as_ref().filter(|s| !s.is_empty()) {
            d.para("Author", &[It::Text(sub.clone(), Fmt::default())]);
        }
        if !meta.author.trim().is_empty() {
            d.para("Author", &[It::Text(format!("by {}", meta.author.trim()), Fmt::default())]);
        }
    }

    let mut prev_scene = false;
    for item in items {
        match item {
            Item::Part { title } => {
                d.para("Heading1", &[It::Text(title.clone(), Fmt::default())]);
                prev_scene = false;
            }
            Item::Chapter { title } => {
                d.para(if has_parts { "Heading2" } else { "Heading1" }, &[It::Text(title.clone(), Fmt::default())]);
                prev_scene = false;
            }
            Item::Scene { id, title, text } => {
                if prev_scene {
                    d.scene_break();
                }
                if opts.scene_titles {
                    d.para("Heading3", &[It::Text(title.clone(), Fmt::default())]);
                }
                let mut pending = if opts.comments { notes.get(id).cloned().unwrap_or_default() } else { vec![] };
                let mut first = true;
                let blocks = md::parse(text);
                d.blocks(&blocks, &mut pending, &mut first, false);
                prev_scene = true;
            }
        }
    }

    let (page_w, page_h, mar_t, mar_s) = if manuscript { (12240, 15840, 1440, 1440) } else { (8640, 12960, 1260, 1080) };
    let furniture = if manuscript { r#"<w:headerReference w:type="default" r:id="rIdHdr"/>"# } else { r#"<w:footerReference w:type="default" r:id="rIdFtr"/>"# };
    let title_pg = if opts.title_page { "<w:titlePg/>" } else { "" };
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr>{furniture}<w:pgSz w:w="{page_w}" w:h="{page_h}"/><w:pgMar w:top="{mar_t}" w:right="{mar_s}" w:bottom="{mar_t}" w:left="{mar_s}" w:header="720" w:footer="720" w:gutter="0"/>{title_pg}</w:sectPr></w:body></w:document>"#,
        body = d.body
    );

    let mut foot = String::from(r#"<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>"#);
    for (i, n) in d.notes.iter().enumerate() {
        foot.push_str(&format!(
            "<w:footnote w:id=\"{}\"><w:p><w:pPr><w:pStyle w:val=\"FootnoteText\"/></w:pPr><w:r><w:rPr><w:rStyle w:val=\"FootnoteReference\"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space=\"preserve\"> {}</w:t></w:r></w:p></w:footnote>",
            i + 1,
            esc(n)
        ));
    }
    let footnotes = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes {NS}>{foot}</w:footnotes>"#);

    let who = if meta.author.trim().is_empty() { "Author".to_string() } else { meta.author.trim().to_string() };
    let initials: String = who.split_whitespace().filter_map(|w| w.chars().next()).take(2).collect();
    let mut com = String::new();
    for (i, t) in d.comments.iter().enumerate() {
        com.push_str(&format!(
            "<w:comment w:id=\"{i}\" w:author=\"{}\" w:initials=\"{}\"><w:p><w:pPr><w:pStyle w:val=\"CommentText\"/></w:pPr><w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:annotationRef/></w:r><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p></w:comment>",
            esc(&who),
            esc(&initials),
            esc(t)
        ));
    }
    let has_comments = !d.comments.is_empty();
    let comments = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments {NS}>{com}</w:comments>"#);

    let page_field = r#"<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>"#;
    let header = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr {NS}><w:p><w:pPr><w:pStyle w:val="Header"/><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">{} / {} / </w:t></w:r>{page_field}</w:p></w:hdr>"#,
        esc(&surname(&meta.author)),
        esc(&short_title(&meta.title)),
    );
    let footer = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr {NS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>{page_field}</w:p></w:ftr>"#);
    let settings = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings {NS}><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr></w:settings>"#);

    let mut rels = String::from(
        r#"<Relationship Id="rIdSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>"#,
    );
    let mut types = String::from(
        r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>"#,
    );
    if has_comments {
        rels.push_str(r#"<Relationship Id="rIdCom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>"#);
        types.push_str(r#"<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>"#);
    }
    if manuscript {
        rels.push_str(r#"<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>"#);
        types.push_str(r#"<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>"#);
    } else {
        rels.push_str(r#"<Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>"#);
        types.push_str(r#"<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>"#);
    }
    let content_types = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>{types}</Types>"#);
    let doc_rels = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>"#);
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#;
    let core = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><dc:language>{}</dc:language><dc:description>{}</dc:description></cp:coreProperties>"#,
        esc(&meta.title),
        esc(&meta.author),
        esc(&meta.language),
        esc(&meta.description)
    );

    let mut buf = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut put = |name: &str, body: &str| -> Result<(), String> {
            z.start_file(name, o).map_err(|e| e.to_string())?;
            z.write_all(body.as_bytes()).map_err(|e| e.to_string())
        };
        put("[Content_Types].xml", &content_types)?;
        put("_rels/.rels", root_rels)?;
        put("word/document.xml", &document)?;
        put("word/_rels/document.xml.rels", &doc_rels)?;
        put("word/styles.xml", &styles(opts.style))?;
        put("word/settings.xml", &settings)?;
        put("word/footnotes.xml", &footnotes)?;
        if has_comments {
            put("word/comments.xml", &comments)?;
        }
        if manuscript {
            put("word/header1.xml", &header)?;
        } else {
            put("word/footer1.xml", &footer)?;
        }
        put("docProps/core.xml", &core)?;
        z.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

fn surname_line(meta: &BookMeta) -> String {
    if meta.author.trim().is_empty() { String::new() } else { meta.author.trim().to_string() }
}

/// "The Long Road Home" -> "LONG ROAD HOME": a short running title.
fn short_title(title: &str) -> String {
    let words: Vec<&str> = title.split_whitespace().collect();
    let skip = if words.len() > 2 && matches!(words[0].to_lowercase().as_str(), "the" | "a" | "an") { 1 } else { 0 };
    words.iter().skip(skip).take(3).map(|w| w.to_uppercase()).collect::<Vec<_>>().join(" ")
}

fn group(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn meta() -> BookMeta {
        BookMeta { title: "The Long Road".into(), author: "Dana Marsh".into(), language: "en".into(), description: "A book.".into(), keywords: vec![], subtitle: None }
    }
    fn opts(style: DocStyle) -> Options {
        serde_json::from_str(&format!(r#"{{"style":"{}"}}"#, if style == DocStyle::Manuscript { "manuscript" } else { "book" })).unwrap()
    }
    fn items() -> Vec<Item> {
        vec![
            Item::Chapter { title: "One".into() },
            Item::Scene { id: "s1".into(), title: "A".into(), text: "She **ran**, and *hid*^[A note [here].] from ==them==.\n\nSecond paragraph.".into() },
            Item::Scene { id: "s2".into(), title: "B".into(), text: "Next scene.".into() },
            Item::Chapter { title: "Two".into() },
            Item::Scene { id: "s3".into(), title: "C".into(), text: "The end.".into() },
        ]
    }
    fn part(bytes: &[u8], name: &str) -> Option<String> {
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut f = z.by_name(name).ok()?;
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        Some(s)
    }

    #[test]
    fn every_part_is_well_formed_xml_in_both_styles() {
        for style in [DocStyle::Manuscript, DocStyle::Book] {
            let bytes = build(&items(), &opts(style), &meta(), 52_340, &HashMap::new()).unwrap();
            let mut z = zip::ZipArchive::new(Cursor::new(&bytes[..])).unwrap();
            let names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
            for n in &names {
                let s = part(&bytes, n).unwrap();
                roxmltree::Document::parse(&s).unwrap_or_else(|e| panic!("{n}: {e}"));
            }
            assert!(names.contains(&"word/document.xml".to_string()) && names.contains(&"word/footnotes.xml".to_string()));
            assert_eq!(names.contains(&"word/header1.xml".to_string()), style == DocStyle::Manuscript);
        }
    }

    #[test]
    fn it_reads_back_through_the_importer() {
        let bytes = build(&items(), &opts(DocStyle::Manuscript), &meta(), 1000, &HashMap::new()).unwrap();
        let back = crate::docx::to_markdown(&bytes).unwrap();
        // Title page text first, then the book with real headings, a footnote and a highlight.
        assert!(back.markdown.contains("# One\n\nShe **ran**, and *hid*^[A note \\[here\\].] from ==them==.\n\nSecond paragraph.\n\n* * *\n\nNext scene.\n\n# Two\n\nThe end."), "{}", back.markdown);
        assert_eq!(back.footnotes, 1);
    }

    #[test]
    fn parts_push_chapters_down_a_level() {
        let mut it = vec![Item::Part { title: "Part I".into() }];
        it.extend(items());
        let bytes = build(&it, &opts(DocStyle::Book), &meta(), 10, &HashMap::new()).unwrap();
        let back = crate::docx::to_markdown(&bytes).unwrap().markdown;
        assert!(back.contains("# Part I\n\n## One\n\n") && back.contains("## Two"), "{back}");
    }

    #[test]
    fn the_title_page_is_optional_and_shows_the_numbers() {
        let mut o = opts(DocStyle::Manuscript);
        let with = String::from_utf8(part(&build(&items(), &o, &meta(), 52_340, &HashMap::new()).unwrap(), "word/document.xml").unwrap().into_bytes()).unwrap();
        assert!(with.contains("approx. 52,300 words") && with.contains("by Dana Marsh") && with.contains("<w:titlePg/>"));
        o.title_page = false;
        let without = part(&build(&items(), &o, &meta(), 1, &HashMap::new()).unwrap(), "word/document.xml").unwrap();
        assert!(!without.contains("by Dana Marsh") && !without.contains("<w:titlePg/>"));
    }

    #[test]
    fn running_header_has_surname_short_title_and_page() {
        let bytes = build(&items(), &opts(DocStyle::Manuscript), &meta(), 1, &HashMap::new()).unwrap();
        let h = part(&bytes, "word/header1.xml").unwrap();
        assert!(h.contains("Marsh / LONG ROAD / ") && h.contains("PAGE"));
    }

    #[test]
    fn your_comments_become_word_comments_on_their_passage() {
        let mut notes = HashMap::new();
        notes.insert("s1".to_string(), vec![SceneNote { passage: "ran".into(), text: "Too fast?".into() }, SceneNote { passage: "not in the text".into(), text: "lost".into() }]);
        let mut o = opts(DocStyle::Book);
        // Off by default.
        assert!(part(&build(&items(), &o, &meta(), 1, &notes).unwrap(), "word/comments.xml").is_none());
        o.comments = true;
        let bytes = build(&items(), &o, &meta(), 1, &notes).unwrap();
        assert!(part(&bytes, "word/comments.xml").unwrap().contains("Too fast?"));
        let back = crate::docx::to_markdown(&bytes).unwrap();
        assert_eq!(back.comments.len(), 1);
        assert_eq!(back.comments[0].passage, "ran");
        assert_eq!(back.comments[0].text, "Too fast?");
        assert_eq!(back.comments[0].author, "Dana Marsh");
    }

    #[test]
    fn special_characters_are_escaped() {
        let it = vec![Item::Chapter { title: "A & B <c>".into() }, Item::Scene { id: "x".into(), title: "t".into(), text: "Tom & \"Jerry\" <3".into() }];
        let bytes = build(&it, &opts(DocStyle::Book), &meta(), 1, &HashMap::new()).unwrap();
        let back = crate::docx::to_markdown(&bytes).unwrap().markdown;
        assert!(back.contains("A & B <c>") || back.contains("A & B \\<c>"), "{back}");
        assert!(back.contains("Tom & \"Jerry\""), "{back}");
    }
}
