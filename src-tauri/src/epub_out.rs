// SPDX-License-Identifier: GPL-3.0-only
//! EPUB 3 export, written directly. Each part and chapter is its own page; footnotes become
//! pop-up notes where the reader supports them; the table of contents follows the book's
//! structure. (An NCX is included too, for older readers.)
use crate::export::{BookMeta, Item, Options};
use crate::md::{self, Block, Inline};
use std::io::{Cursor, Write};

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

struct Page {
    file: String,
    title: String,
    /// Part (0) or chapter (1): where it sits in the table of contents.
    depth: usize,
    body: String,
}

struct Notes {
    html: String,
    n: usize,
}

fn inline_html(ins: &[Inline], notes: &mut Notes) -> String {
    let mut out = String::new();
    for i in ins {
        match i {
            Inline::Text(t) => out.push_str(&esc(t)),
            Inline::Bold(c) => out.push_str(&format!("<strong>{}</strong>", inline_html(c, notes))),
            Inline::Italic(c) => out.push_str(&format!("<em>{}</em>", inline_html(c, notes))),
            Inline::Strike(c) => out.push_str(&format!("<del>{}</del>", inline_html(c, notes))),
            // Highlights are for you while you write; the book reads without them.
            Inline::Highlight(_, c) => out.push_str(&inline_html(c, notes)),
            Inline::Note(text) => {
                notes.n += 1;
                let n = notes.n;
                out.push_str(&format!("<a epub:type=\"noteref\" class=\"noteref\" href=\"#fn{n}\" id=\"r{n}\">{n}</a>"));
                notes.html.push_str(&format!("<aside epub:type=\"footnote\" id=\"fn{n}\"><p><a href=\"#r{n}\">{n}</a>. {}</p></aside>\n", esc(text)));
            }
            Inline::Break => out.push_str("<br/>"),
        }
    }
    out
}

fn blocks_html(blocks: &[Block], opts: &Options, notes: &mut Notes) -> String {
    let mut out = String::new();
    for b in blocks {
        match b {
            Block::Para(ins) => out.push_str(&format!("<p>{}</p>\n", inline_html(ins, notes))),
            Block::Heading(_, ins) => out.push_str(&format!("<h3 class=\"subhead\">{}</h3>\n", inline_html(ins, notes))),
            Block::Quote(inner) => out.push_str(&format!("<blockquote>\n{}</blockquote>\n", blocks_html(inner, opts, notes))),
            Block::List { ordered, items } => {
                let tag = if *ordered { "ol" } else { "ul" };
                out.push_str(&format!("<{tag}>\n"));
                for it in items {
                    out.push_str(&format!("<li>{}</li>\n", inline_html(it, notes)));
                }
                out.push_str(&format!("</{tag}>\n"));
            }
            Block::Rule => out.push_str(&scene_break(opts)),
        }
    }
    out
}

fn scene_break(opts: &Options) -> String {
    let t = opts.scene_break.trim();
    format!("<p class=\"scene-break\">{}</p>\n", if t.is_empty() { "&#160;".to_string() } else { esc(t) })
}

fn xhtml(title: &str, lang: &str, body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"{l}\" lang=\"{l}\">\n<head><meta charset=\"utf-8\"/><title>{t}</title><link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head>\n<body>\n{body}</body>\n</html>\n",
        l = esc(lang),
        t = esc(title)
    )
}

const CSS: &str = r#"body { font-family: serif; line-height: 1.45; margin: 0 5%; }
h1, h2 { text-align: center; font-weight: bold; margin: 3em 0 1.5em; page-break-before: always; }
h1 { font-size: 1.6em; }
h2 { font-size: 1.35em; }
h3.subhead { font-size: 1em; margin: 1.5em 0 0.5em; }
p { margin: 0; text-indent: 1.4em; text-align: justify; }
h1 + p, h2 + p, .scene-break + p, h3 + p, blockquote + p { text-indent: 0; }
p.scene-break { text-align: center; text-indent: 0; margin: 1.4em 0; }
blockquote { margin: 1em 2em; font-style: italic; }
blockquote p { text-indent: 0; }
a.noteref { font-size: 0.75em; vertical-align: super; line-height: 0; text-decoration: none; }
aside[epub|type~="footnote"] { margin: 0; font-size: 0.85em; }
aside p { text-indent: 0; }
section.notes { margin-top: 2.5em; border-top: 1px solid #999; padding-top: 0.5em; }
.titlepage { text-align: center; margin-top: 30%; }
.titlepage h1 { page-break-before: avoid; margin: 0 0 0.4em; }
.titlepage p { text-indent: 0; text-align: center; }
.cover { text-align: center; margin: 0; }
.cover img { max-width: 100%; max-height: 100%; }
"#;

/// The current UTC time as 2026-11-20T14:05:09Z, with no date library.
fn utc_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn uuid() -> String {
    let b = ulid::Ulid::generate().to_bytes();
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn media_type(ext: &str) -> Result<(&'static str, &'static str), String> {
    match ext {
        "jpg" | "jpeg" => Ok(("image/jpeg", "jpg")),
        "png" => Ok(("image/png", "png")),
        "gif" => Ok(("image/gif", "gif")),
        _ => Err("The cover must be a JPEG, PNG or GIF image.".into()),
    }
}

pub fn build(items: &[Item], opts: &Options, meta: &BookMeta, cover: Option<(Vec<u8>, String)>) -> Result<Vec<u8>, String> {
    let has_parts = items.iter().any(|i| matches!(i, Item::Part { .. }));
    let lang = &meta.language;
    let mut pages: Vec<Page> = vec![];

    // Parts and chapters become pages; scenes fill the chapter before them.
    let mut notes = Notes { html: String::new(), n: 0 };
    let mut current: Option<usize> = None;
    let mut prev_scene = false;
    let finish = |pages: &mut Vec<Page>, notes: &mut Notes| {
        if !notes.html.is_empty() {
            if let Some(p) = pages.last_mut() {
                p.body.push_str(&format!("<section class=\"notes\" epub:type=\"footnotes\">\n{}</section>\n", notes.html));
            }
        }
        *notes = Notes { html: String::new(), n: 0 };
    };
    for item in items {
        match item {
            Item::Part { title } => {
                finish(&mut pages, &mut notes);
                let n = pages.len() + 1;
                pages.push(Page { file: format!("p{n}.xhtml"), title: title.clone(), depth: 0, body: format!("<h1>{}</h1>\n", esc(title)) });
                current = None;
                prev_scene = false;
            }
            Item::Chapter { title } => {
                finish(&mut pages, &mut notes);
                let n = pages.len() + 1;
                let tag = if has_parts { "h2" } else { "h1" };
                pages.push(Page { file: format!("c{n}.xhtml"), title: title.clone(), depth: usize::from(has_parts), body: format!("<{tag}>{}</{tag}>\n", esc(title)) });
                current = Some(pages.len() - 1);
                prev_scene = false;
            }
            Item::Scene { title, text, .. } => {
                // A scene with no chapter before it still needs a page.
                let idx = match current {
                    Some(i) => i,
                    None => {
                        finish(&mut pages, &mut notes);
                        let n = pages.len() + 1;
                        pages.push(Page { file: format!("c{n}.xhtml"), title: title.clone(), depth: 0, body: String::new() });
                        current = Some(pages.len() - 1);
                        pages.len() - 1
                    }
                };
                let mut html = String::new();
                if prev_scene {
                    html.push_str(&scene_break(opts));
                }
                if opts.scene_titles {
                    html.push_str(&format!("<h3 class=\"subhead\">{}</h3>\n", esc(title)));
                }
                html.push_str(&blocks_html(&md::parse(text), opts, &mut notes));
                pages[idx].body.push_str(&html);
                prev_scene = true;
            }
        }
    }
    finish(&mut pages, &mut notes);
    if pages.is_empty() {
        return Err("There is nothing to export.".into());
    }

    let cover = match cover {
        Some((bytes, ext)) => {
            let (mt, e) = media_type(&ext)?;
            Some((bytes, mt, e))
        }
        None => None,
    };
    let id = format!("urn:uuid:{}", uuid());
    let mut manifest = String::from("<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>\n<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>\n");
    let mut spine = String::new();
    if let Some((_, mt, e)) = &cover {
        manifest.push_str(&format!("<item id=\"cover-image\" href=\"cover.{e}\" media-type=\"{mt}\" properties=\"cover-image\"/>\n<item id=\"cover\" href=\"cover.xhtml\" media-type=\"application/xhtml+xml\"/>\n"));
        spine.push_str("<itemref idref=\"cover\" linear=\"yes\"/>\n");
    }
    if opts.title_page {
        manifest.push_str("<item id=\"titlepage\" href=\"title.xhtml\" media-type=\"application/xhtml+xml\"/>\n");
        spine.push_str("<itemref idref=\"titlepage\"/>\n");
    }
    for (i, p) in pages.iter().enumerate() {
        manifest.push_str(&format!("<item id=\"s{i}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>\n", p.file));
        spine.push_str(&format!("<itemref idref=\"s{i}\"/>\n"));
    }

    let mut dc = format!("<dc:identifier id=\"bookid\">{}</dc:identifier>\n<dc:title>{}</dc:title>\n<dc:language>{}</dc:language>\n", esc(&id), esc(&meta.title), esc(lang));
    if !meta.author.trim().is_empty() {
        dc.push_str(&format!("<dc:creator>{}</dc:creator>\n", esc(meta.author.trim())));
    }
    if !meta.description.is_empty() {
        dc.push_str(&format!("<dc:description>{}</dc:description>\n", esc(&meta.description)));
    }
    for k in &meta.keywords {
        dc.push_str(&format!("<dc:subject>{}</dc:subject>\n", esc(k)));
    }
    if cover.is_some() {
        dc.push_str("<meta name=\"cover\" content=\"cover-image\"/>\n");
    }
    dc.push_str(&format!("<meta property=\"dcterms:modified\">{}</meta>\n", utc_now()));
    let opf = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"bookid\" xml:lang=\"{}\">\n<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n{dc}</metadata>\n<manifest>\n{manifest}</manifest>\n<spine toc=\"ncx\">\n{spine}</spine>\n</package>\n", esc(lang));

    // Contents: chapters sit under their part.
    let mut nav = String::from("<ol>\n");
    let mut ncx = String::new();
    let mut order = 0;
    let mut open_part = false;
    for p in &pages {
        order += 1;
        if p.depth == 0 {
            if open_part {
                nav.push_str("</ol></li>\n");
                ncx.push_str("</navPoint>\n");
            }
            nav.push_str(&format!("<li><a href=\"{}\">{}</a>", p.file, esc(&p.title)));
            ncx.push_str(&format!("<navPoint id=\"n{order}\" playOrder=\"{order}\"><navLabel><text>{}</text></navLabel><content src=\"{}\"/>\n", esc(&p.title), p.file));
            if has_parts {
                nav.push_str("<ol>\n");
                open_part = true;
            } else {
                nav.push_str("</li>\n");
                ncx.push_str("</navPoint>\n");
            }
        } else {
            nav.push_str(&format!("<li><a href=\"{}\">{}</a></li>\n", p.file, esc(&p.title)));
            ncx.push_str(&format!("<navPoint id=\"n{order}\" playOrder=\"{order}\"><navLabel><text>{}</text></navLabel><content src=\"{}\"/></navPoint>\n", esc(&p.title), p.file));
        }
    }
    if open_part {
        nav.push_str("</ol></li>\n");
        ncx.push_str("</navPoint>\n");
    }
    nav.push_str("</ol>\n");
    let nav_doc = xhtml(
        &meta.title,
        lang,
        &format!("<nav epub:type=\"toc\" id=\"toc\"><h1>Contents</h1>\n{nav}</nav>\n<nav epub:type=\"landmarks\" hidden=\"hidden\"><ol><li><a epub:type=\"bodymatter\" href=\"{}\">Start of the book</a></li></ol></nav>\n", pages[0].file),
    );
    let ncx_doc = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\"><head><meta name=\"dtb:uid\" content=\"{}\"/></head><docTitle><text>{}</text></docTitle><navMap>\n{ncx}</navMap></ncx>\n",
        esc(&id),
        esc(&meta.title)
    );

    let mut buf = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut put = |name: &str, body: &[u8], o| -> Result<(), String> {
            z.start_file(name, o).map_err(|e| e.to_string())?;
            z.write_all(body).map_err(|e| e.to_string())
        };
        // The mimetype comes first and is not compressed, as the format requires.
        put("mimetype", b"application/epub+zip", stored)?;
        put("META-INF/container.xml", b"<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>\n", deflated)?;
        put("OEBPS/content.opf", opf.as_bytes(), deflated)?;
        put("OEBPS/nav.xhtml", nav_doc.as_bytes(), deflated)?;
        put("OEBPS/toc.ncx", ncx_doc.as_bytes(), deflated)?;
        put("OEBPS/style.css", CSS.as_bytes(), deflated)?;
        if let Some((bytes, _, e)) = &cover {
            put(&format!("OEBPS/cover.{e}"), bytes, stored)?;
            put("OEBPS/cover.xhtml", xhtml(&meta.title, lang, &format!("<div class=\"cover\"><img src=\"cover.{e}\" alt=\"Cover\"/></div>\n")).as_bytes(), deflated)?;
        }
        if opts.title_page {
            let mut t = format!("<div class=\"titlepage\"><h1>{}</h1>\n", esc(&meta.title));
            if let Some(s) = &meta.subtitle {
                t.push_str(&format!("<p>{}</p>\n", esc(s)));
            }
            if !meta.author.trim().is_empty() {
                t.push_str(&format!("<p>{}</p>\n", esc(meta.author.trim())));
            }
            t.push_str("</div>\n");
            put("OEBPS/title.xhtml", xhtml(&meta.title, lang, &t).as_bytes(), deflated)?;
        }
        for p in &pages {
            put(&format!("OEBPS/{}", p.file), xhtml(&p.title, lang, &p.body).as_bytes(), deflated)?;
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn meta() -> BookMeta {
        BookMeta { title: "The Long Road".into(), author: "Dana Marsh".into(), language: "en-GB".into(), description: "A & B".into(), keywords: vec!["noir".into()], subtitle: Some("A novel".into()) }
    }
    fn opts() -> Options {
        serde_json::from_str("{}").unwrap()
    }
    fn items() -> Vec<Item> {
        vec![
            Item::Chapter { title: "One".into() },
            Item::Scene { id: "a".into(), title: "A".into(), text: "She **ran**^[A note.] & hid.\n\n> Quote here.".into() },
            Item::Scene { id: "b".into(), title: "B".into(), text: "Next.".into() },
            Item::Chapter { title: "Two".into() },
            Item::Scene { id: "c".into(), title: "C".into(), text: "End^[Second [note].]".into() },
        ]
    }
    fn read(bytes: &[u8], name: &str) -> Option<String> {
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut f = z.by_name(name).ok()?;
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        Some(s)
    }
    fn names(bytes: &[u8]) -> Vec<String> {
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect()
    }

    #[test]
    fn it_is_a_valid_package_with_the_mimetype_first_and_stored() {
        let b = build(&items(), &opts(), &meta(), None).unwrap();
        let n = names(&b);
        assert_eq!(n[0], "mimetype");
        let mut z = zip::ZipArchive::new(Cursor::new(&b[..])).unwrap();
        assert_eq!(z.by_index(0).unwrap().compression(), zip::CompressionMethod::Stored);
        assert_eq!(read(&b, "mimetype").unwrap(), "application/epub+zip");
        assert!(read(&b, "META-INF/container.xml").unwrap().contains("OEBPS/content.opf"));
        for name in n.iter().filter(|n| n.ends_with(".xhtml") || n.ends_with(".opf") || n.ends_with(".ncx") || n.ends_with(".xml")) {
            roxmltree::Document::parse_with_options(&read(&b, name).unwrap(), roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }

    #[test]
    fn metadata_spine_and_contents() {
        let b = build(&items(), &opts(), &meta(), None).unwrap();
        let opf = read(&b, "OEBPS/content.opf").unwrap();
        assert!(opf.contains("<dc:title>The Long Road</dc:title>") && opf.contains("<dc:creator>Dana Marsh</dc:creator>") && opf.contains("<dc:language>en-GB</dc:language>"));
        assert!(opf.contains("<dc:description>A &amp; B</dc:description>") && opf.contains("<dc:subject>noir</dc:subject>") && opf.contains("dcterms:modified"));
        // Title page, then the chapters, in order.
        let spine: Vec<&str> = opf.split("<itemref idref=\"").skip(1).map(|s| s.split('"').next().unwrap()).collect();
        assert_eq!(spine, ["titlepage", "s0", "s1"]);
        let nav = read(&b, "OEBPS/nav.xhtml").unwrap();
        assert!(nav.contains("href=\"c1.xhtml\">One</a>") && nav.contains("href=\"c2.xhtml\">Two</a>"));
    }

    #[test]
    fn chapters_hold_their_scenes_breaks_quotes_and_numbered_notes() {
        let b = build(&items(), &opts(), &meta(), None).unwrap();
        let one = read(&b, "OEBPS/c1.xhtml").unwrap();
        assert!(one.contains("<h1>One</h1>") && one.contains("<strong>ran</strong>") && one.contains("&amp; hid."));
        assert!(one.contains("<p class=\"scene-break\">* * *</p>") && one.contains("<blockquote>"));
        assert!(one.contains("epub:type=\"noteref\"") && one.contains("<aside epub:type=\"footnote\" id=\"fn1\"><p><a href=\"#r1\">1</a>. A note.</p></aside>"));
        // Numbering starts again in each chapter.
        let two = read(&b, "OEBPS/c2.xhtml").unwrap();
        assert!(two.contains("id=\"fn1\"") && two.contains("Second [note]."));
    }

    #[test]
    fn parts_nest_chapters_in_the_contents() {
        let mut it = vec![Item::Part { title: "Part I".into() }];
        it.extend(items());
        let b = build(&it, &opts(), &meta(), None).unwrap();
        let nav = read(&b, "OEBPS/nav.xhtml").unwrap();
        assert!(nav.contains("Part I</a><ol>") && nav.contains("One</a></li>"), "{nav}");
        assert!(read(&b, "OEBPS/c2.xhtml").unwrap().contains("<h2>One</h2>"));
        roxmltree::Document::parse(&read(&b, "OEBPS/toc.ncx").unwrap()).unwrap();
    }

    #[test]
    fn a_cover_is_added_and_a_bad_one_is_refused() {
        let b = build(&items(), &opts(), &meta(), Some((vec![1, 2, 3], "png".into()))).unwrap();
        assert!(names(&b).contains(&"OEBPS/cover.png".to_string()));
        let opf = read(&b, "OEBPS/content.opf").unwrap();
        assert!(opf.contains("properties=\"cover-image\"") && opf.contains("idref=\"cover\""));
        assert!(build(&items(), &opts(), &meta(), Some((vec![1], "bmp".into()))).unwrap_err().contains("JPEG"));
    }

    #[test]
    fn the_time_is_formatted_as_utc() {
        let t = utc_now();
        assert_eq!(t.len(), 20);
        assert!(t.starts_with("20") && t.ends_with('Z') && &t[10..11] == "T");
    }

    #[test]
    fn an_empty_book_is_refused() {
        assert!(build(&[], &opts(), &meta(), None).unwrap_err().contains("nothing"));
    }
}
