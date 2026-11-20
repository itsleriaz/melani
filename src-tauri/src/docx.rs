// SPDX-License-Identifier: GPL-3.0-only
//! Word (.docx) to Markdown, for import. It reads what matters to a manuscript: headings,
//! paragraphs, bold, italic, strikethrough, highlights, footnotes, comments and scene breaks.
//! Tables, images and layout are left out.
use crate::import::DocComment;
use roxmltree::{Document, Node};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
};

pub struct Converted {
    pub markdown: String,
    pub comments: Vec<DocComment>,
    pub footnotes: usize,
}

fn part(zip: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn is(n: &Node, local: &str) -> bool {
    n.is_element() && n.tag_name().name() == local
}

/// The `w:val` (or other attribute) of an element, by local name.
fn attr<'a>(n: &Node<'a, 'a>, name: &str) -> Option<&'a str> {
    n.attributes().find(|a| a.name() == name).map(|a| a.value())
}

/// Whether a toggle property such as `<w:b/>` is on (it is off with val="0" or "false").
fn on(rpr: &Node, local: &str) -> bool {
    rpr.children().find(|c| is(c, local)).is_some_and(|c| !matches!(attr(&c, "val"), Some("0" | "false" | "none")))
}

#[derive(Clone, PartialEq, Default, Debug)]
struct Fmt {
    bold: bool,
    italic: bool,
    strike: bool,
    highlight: Option<&'static str>,
}

/// Word's highlight names, as the colours the app has.
fn highlight_color(word: &str) -> &'static str {
    match word {
        "green" | "darkGreen" => "green",
        "cyan" | "blue" | "darkBlue" | "darkCyan" => "blue",
        "magenta" | "red" | "darkMagenta" | "darkRed" => "pink",
        "darkYellow" | "lightGray" | "darkGray" | "black" => "orange",
        _ => "yellow",
    }
}

fn run_fmt(r: &Node) -> Fmt {
    let Some(rpr) = r.children().find(|c| is(c, "rPr")) else { return Fmt::default() };
    let style = rpr.children().find(|c| is(c, "rStyle")).and_then(|c| attr(&c, "val")).unwrap_or("");
    Fmt {
        bold: on(&rpr, "b") || style.eq_ignore_ascii_case("strong"),
        italic: on(&rpr, "i") || style.eq_ignore_ascii_case("emphasis"),
        strike: on(&rpr, "strike"),
        highlight: rpr.children().find(|c| is(c, "highlight")).and_then(|c| attr(&c, "val")).filter(|v| *v != "none").map(highlight_color),
    }
}

/// Characters that would be read as Markdown if left as they are.
fn escape(text: &str, at_line_start: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        let eq_run = c == '=' && (chars.get(i + 1) == Some(&'=') || (i > 0 && chars[i - 1] == '='));
        let note = c == '^' && chars.get(i + 1) == Some(&'[');
        if matches!(c, '\\' | '*' | '_' | '`' | '[' | ']' | '~' | '<') || eq_run || note {
            out.push('\\');
        }
        out.push(c);
    }
    if at_line_start {
        let t = out.trim_start();
        let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
        if t.starts_with('#') || t.starts_with("> ") || t.starts_with("- ") || t.starts_with("+ ") || (digits > 0 && t[digits..].starts_with(". ")) {
            return format!("\\{out}");
        }
    }
    out
}

/// A footnote's note: one line of plain text, with brackets escaped.
fn note_text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]")
}

/// All the text under a node (used for footnotes and comments), ignoring the footnote mark itself.
fn flat_text(n: Node) -> String {
    n.descendants().filter(|d| is(d, "t")).map(|d| d.text().unwrap_or("")).collect::<Vec<_>>().join("")
}

fn notes(xml: Option<String>, tag: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(xml) = xml else { return map };
    let Ok(doc) = Document::parse(&xml) else { return map };
    for n in doc.descendants().filter(|n| is(n, tag)) {
        if let Some(id) = attr(&n, "id") {
            // Paragraphs are joined by a space.
            let text = n.descendants().filter(|d| is(d, "p")).map(flat_text).collect::<Vec<_>>().join(" ");
            map.insert(id.to_string(), text);
        }
    }
    map
}

struct Ctx<'a> {
    footnotes: &'a HashMap<String, String>,
    endnotes: &'a HashMap<String, String>,
    comment_text: &'a HashMap<String, (String, String)>,
    open: HashSet<String>,
    passages: HashMap<String, String>,
    note_count: usize,
}

/// One piece of a paragraph: text with its formatting, or an already-written footnote.
enum Piece {
    Text(String, Fmt),
    Note(String),
}

fn collect_runs(n: Node, cx: &mut Ctx, out: &mut Vec<Piece>) {
    for c in n.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "r" => {
                let fmt = run_fmt(&c);
                let mut text = String::new();
                for k in c.children().filter(|k| k.is_element()) {
                    match k.tag_name().name() {
                        "t" => text.push_str(k.text().unwrap_or("")),
                        "tab" => text.push(' '),
                        "br" | "cr" if attr(&k, "type") != Some("page") => text.push(' '),
                        "footnoteReference" | "endnoteReference" => {
                            if !text.is_empty() {
                                out.push(Piece::Text(std::mem::take(&mut text), fmt.clone()));
                            }
                            let id = attr(&k, "id").unwrap_or("");
                            let map = if k.tag_name().name() == "footnoteReference" { cx.footnotes } else { cx.endnotes };
                            if let Some(t) = map.get(id).filter(|t| !t.trim().is_empty()) {
                                cx.note_count += 1;
                                out.push(Piece::Note(format!("^[{}]", note_text(t))));
                            }
                        }
                        _ => {}
                    }
                }
                if !text.is_empty() {
                    for id in &cx.open {
                        cx.passages.entry(id.clone()).or_default().push_str(&text);
                    }
                    out.push(Piece::Text(text, fmt));
                }
            }
            "commentRangeStart" => {
                if let Some(id) = attr(&c, "id") {
                    cx.open.insert(id.to_string());
                }
            }
            "commentRangeEnd" => {
                if let Some(id) = attr(&c, "id") {
                    cx.open.remove(id);
                }
            }
            // Insertions, links, smart tags and the like hold more runs. Deletions hold none we read.
            "ins" | "hyperlink" | "smartTag" | "sdt" | "sdtContent" | "fldSimple" | "customXml" => collect_runs(c, cx, out),
            _ => {}
        }
    }
}

/// Merge neighbours with the same formatting, then write the Markdown marks around each.
fn render(pieces: Vec<Piece>) -> String {
    let mut merged: Vec<Piece> = vec![];
    for p in pieces {
        match (merged.last_mut(), p) {
            (Some(Piece::Text(t, f)), Piece::Text(t2, f2)) if *f == f2 => t.push_str(&t2),
            (_, p) => merged.push(p),
        }
    }
    let mut out = String::new();
    for p in merged {
        match p {
            Piece::Note(n) => out.push_str(&n),
            Piece::Text(t, f) => {
                // Spaces go outside the marks, which Markdown needs.
                let core = t.trim();
                if core.is_empty() {
                    out.push_str(&t);
                    continue;
                }
                let lead = &t[..t.len() - t.trim_start().len()];
                let trail = &t[t.trim_end().len()..];
                let mut s = escape(core, false);
                if f.strike {
                    s = format!("~~{s}~~");
                }
                if f.italic {
                    s = format!("*{s}*");
                }
                if f.bold {
                    s = format!("**{s}**");
                }
                if let Some(h) = f.highlight {
                    s = if h == "yellow" { format!("=={s}==") } else { format!("=={{{h}}}{s}==") };
                }
                out.push_str(lead);
                out.push_str(&s);
                out.push_str(trail);
            }
        }
    }
    out
}

/// The heading level of a paragraph, from its style or its outline level.
fn heading_level(p: &Node, has_h1: bool) -> Option<usize> {
    let ppr = p.children().find(|c| is(c, "pPr"))?;
    if let Some(style) = ppr.children().find(|c| is(c, "pStyle")).and_then(|c| attr(&c, "val")) {
        let s = style.to_ascii_lowercase().replace([' ', '-'], "");
        if let Some(n) = s.strip_prefix("heading").and_then(|n| n.parse::<usize>().ok()) {
            return Some(n.clamp(1, 6));
        }
        // A title counts as a top-level heading only when the document has no other.
        if s == "title" && !has_h1 {
            return Some(1);
        }
    }
    ppr.children().find(|c| is(c, "outlineLvl")).and_then(|c| attr(&c, "val")).and_then(|v| v.parse::<usize>().ok()).filter(|l| *l < 6).map(|l| l + 1)
}

fn is_list_item(p: &Node) -> bool {
    p.children().find(|c| is(c, "pPr")).is_some_and(|ppr| ppr.children().any(|c| is(&c, "numPr")))
}

/// The paragraph style's id, lowercased ("scenebreak").
fn style_of(p: &Node) -> String {
    p.children().find(|c| is(c, "pPr")).and_then(|ppr| ppr.children().find(|c| is(c, "pStyle")).and_then(|c| attr(&c, "val")).map(|v| v.to_ascii_lowercase())).unwrap_or_default()
}

fn centered(p: &Node) -> bool {
    p.children().find(|c| is(c, "pPr")).is_some_and(|ppr| ppr.children().any(|c| is(&c, "jc") && attr(&c, "val") == Some("center")))
}

pub fn to_markdown(bytes: &[u8]) -> Result<Converted, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "this is not a Word (.docx) file".to_string())?;
    let body = part(&mut zip, "word/document.xml").ok_or("this Word file has no document in it")?;
    let footnotes = notes(part(&mut zip, "word/footnotes.xml"), "footnote");
    let endnotes = notes(part(&mut zip, "word/endnotes.xml"), "endnote");
    let mut comment_text: HashMap<String, (String, String)> = HashMap::new();
    if let Some(xml) = part(&mut zip, "word/comments.xml") {
        if let Ok(doc) = Document::parse(&xml) {
            for c in doc.descendants().filter(|n| is(n, "comment")) {
                if let Some(id) = attr(&c, "id") {
                    let text = c.descendants().filter(|d| is(d, "p")).map(flat_text).collect::<Vec<_>>().join(" ");
                    comment_text.insert(id.to_string(), (attr(&c, "author").unwrap_or("").to_string(), text.trim().to_string()));
                }
            }
        }
    }
    let doc = Document::parse(&body).map_err(|e| format!("could not read the document: {e}"))?;
    let has_h1 = doc.descendants().filter(|n| is(n, "p")).any(|p| heading_level(&p, true) == Some(1));
    let mut cx = Ctx { footnotes: &footnotes, endnotes: &endnotes, comment_text: &comment_text, open: HashSet::new(), passages: HashMap::new(), note_count: 0 };
    let mut out = String::new();
    let mut in_list = false;
    // Paragraphs inside a text box are also in the body; skip any paragraph that sits inside another.
    for p in doc.descendants().filter(|n| is(n, "p") && !n.ancestors().skip(1).any(|a| is(&a, "p"))) {
        let mut pieces = vec![];
        collect_runs(p, &mut cx, &mut pieces);
        let plain_text: String = pieces.iter().filter_map(|x| if let Piece::Text(t, _) = x { Some(t.as_str()) } else { None }).collect();
        let t = plain_text.trim();
        if t.is_empty() && !pieces.iter().any(|x| matches!(x, Piece::Note(_))) {
            in_list = false;
            continue;
        }
        let line = if let Some(level) = heading_level(&p, has_h1) {
            format!("{} {}", "#".repeat(level), escape(t, false))
        } else if t.chars().count() <= 5
            && t.chars().all(|c| matches!(c, '*' | '#' | '-' | '~' | '⁂' | '•' | '·' | ' '))
            && (centered(&p) || style_of(&p).contains("break") || t.contains('*') || t.contains('⁂'))
        {
            "* * *".to_string()
        } else if is_list_item(&p) {
            format!("- {}", render(pieces))
        } else {
            let r = render(pieces);
            let first = r.trim_start();
            // Make sure a paragraph that starts like a list or heading stays a paragraph.
            if first.starts_with('#') || first.starts_with("> ") || first.starts_with("- ") || first.starts_with("+ ") {
                format!("\\{}", r.trim_start())
            } else {
                r.trim().to_string()
            }
        };
        let list_line = line.starts_with("- ") && is_list_item(&p);
        if !out.is_empty() {
            out.push_str(if list_line && in_list { "\n" } else { "\n\n" });
        }
        in_list = list_line;
        out.push_str(&line);
    }
    out.push('\n');
    let comments = cx
        .passages
        .iter()
        .filter_map(|(id, passage)| cx.comment_text.get(id).map(|(author, text)| DocComment { passage: passage.trim().to_string(), author: author.clone(), text: text.clone() }))
        .filter(|c| !c.text.is_empty())
        .collect::<Vec<_>>();
    // A stable order: by position of the passage in the text.
    let mut comments = comments;
    comments.sort_by_key(|c| out.find(&c.passage).unwrap_or(usize::MAX));
    Ok(Converted { markdown: out, comments, footnotes: cx.note_count })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

    fn docx(document: &str, footnotes: Option<&str>, comments: Option<&str>) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("word/document.xml", o).unwrap();
            z.write_all(format!(r#"<?xml version="1.0"?><w:document {NS}><w:body>{document}</w:body></w:document>"#).as_bytes()).unwrap();
            if let Some(f) = footnotes {
                z.start_file("word/footnotes.xml", o).unwrap();
                z.write_all(format!(r#"<w:footnotes {NS}>{f}</w:footnotes>"#).as_bytes()).unwrap();
            }
            if let Some(c) = comments {
                z.start_file("word/comments.xml", o).unwrap();
                z.write_all(format!(r#"<w:comments {NS}>{c}</w:comments>"#).as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }
    fn p(style: Option<&str>, runs: &str) -> String {
        let ppr = style.map(|s| format!(r#"<w:pPr><w:pStyle w:val="{s}"/></w:pPr>"#)).unwrap_or_default();
        format!("<w:p>{ppr}{runs}</w:p>")
    }
    fn r(text: &str) -> String {
        format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
    }
    fn rf(props: &str, text: &str) -> String {
        format!(r#"<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>"#)
    }

    #[test]
    fn headings_paragraphs_and_formatting() {
        let body = [
            p(Some("Heading1"), &r("Chapter One")),
            p(None, &(r("She ") + &rf("<w:b/>", "said") + &r(" ") + &rf("<w:i/>", "no") + &r(" and ") + &rf("<w:strike/>", "left") + &r("."))),
            p(None, ""),
            p(None, &(rf(r#"<w:highlight w:val="yellow"/>"#, "bright") + &rf(r#"<w:highlight w:val="green"/>"#, " green"))),
            p(Some("Heading2"), &r("A scene")),
        ]
        .concat();
        let c = to_markdown(&docx(&body, None, None)).unwrap();
        assert_eq!(c.markdown, "# Chapter One\n\nShe **said** *no* and ~~left~~.\n\n==bright== =={green}green==\n\n## A scene\n");
    }

    #[test]
    fn runs_with_the_same_format_merge_and_spaces_stay_outside() {
        let body = p(None, &(rf("<w:b/>", "two ") + &rf("<w:b/>", "words ") + &r("after")));
        let c = to_markdown(&docx(&body, None, None)).unwrap();
        assert_eq!(c.markdown, "**two words** after\n");
    }

    #[test]
    fn punctuation_that_means_something_in_markdown_is_escaped() {
        let body = p(None, &r("2 * 3 = 6, snake_case, [x], 1. and ^[y] a==b"));
        let c = to_markdown(&docx(&body, None, None)).unwrap();
        assert_eq!(c.markdown, "2 \\* 3 = 6, snake\\_case, \\[x\\], 1. and \\^\\[y\\] a\\=\\=b\n");
        let lines = p(None, &r("- not a list")) + &p(None, &r("# not a heading"));
        assert_eq!(to_markdown(&docx(&lines, None, None)).unwrap().markdown, "\\- not a list\n\n\\# not a heading\n");
    }

    #[test]
    fn footnotes_become_inline_notes() {
        let body = p(None, &(r("Before") + r#"<w:r><w:footnoteReference w:id="2"/></w:r>"# + &r(" after.")));
        let notes = r#"<w:footnote w:id="0"><w:p><w:r><w:t>sep</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> See [chapter 2].</w:t></w:r></w:p></w:footnote>"#;
        let c = to_markdown(&docx(&body, Some(notes), None)).unwrap();
        assert_eq!(c.markdown, "Before^[See \\[chapter 2\\].] after.\n");
        assert_eq!(c.footnotes, 1);
    }

    #[test]
    fn comments_keep_their_passage_and_author() {
        let body = p(
            None,
            &(r("Start ") + r#"<w:commentRangeStart w:id="7"/>"# + &rf("<w:b/>", "the passage") + r#"<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>"# + &r(" end")),
        );
        let comments = r#"<w:comment w:id="7" w:author="Alex"><w:p><w:r><w:t>Cut this?</w:t></w:r></w:p></w:comment>"#;
        let c = to_markdown(&docx(&body, None, Some(comments))).unwrap();
        assert_eq!(c.markdown, "Start **the passage** end\n");
        assert_eq!(c.comments, vec![DocComment { passage: "the passage".into(), author: "Alex".into(), text: "Cut this?".into() }]);
    }

    #[test]
    fn a_centred_row_of_marks_is_a_scene_break_and_lists_are_lists() {
        let body = [
            p(None, &r("One.")),
            r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>* * *</w:t></w:r></w:p>"#.to_string(),
            p(None, &r("Two.")),
            r#"<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>item a</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>item b</w:t></w:r></w:p>"#.to_string(),
        ]
        .concat();
        let c = to_markdown(&docx(&body, None, None)).unwrap();
        assert_eq!(c.markdown, "One.\n\n* * *\n\nTwo.\n\n- item a\n- item b\n");
    }

    #[test]
    fn a_title_is_a_heading_only_when_there_is_no_other() {
        let only = p(Some("Title"), &r("My Book")) + &p(None, &r("Text."));
        assert!(to_markdown(&docx(&only, None, None)).unwrap().markdown.starts_with("# My Book"));
        let both = p(Some("Title"), &r("My Book")) + &p(Some("Heading1"), &r("One"));
        assert!(to_markdown(&docx(&both, None, None)).unwrap().markdown.starts_with("My Book\n\n# One"));
    }

    #[test]
    fn something_that_is_not_a_docx_is_refused_plainly() {
        let e = to_markdown(b"just text").err().unwrap();
        assert!(e.contains("not a Word"));
    }
}
