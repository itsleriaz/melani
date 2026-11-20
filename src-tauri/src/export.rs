// SPDX-License-Identifier: GPL-3.0-only
//! Export. Every format reads the same intermediate representation: the included
//! parts, chapters and scenes in binder order, with each scene's text. Markdown is
//! the only writer for now; .docx, .epub and PDF can be added beside it.
use crate::project::{atomic_write, read_binder, read_scene, BinderNode, NodeType, ProjectError};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, ProjectError>;

fn io<T>(p: &Path, r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| ProjectError::Io(p.display().to_string(), e))
}

/// One item of the intermediate representation.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Part { title: String },
    Chapter { title: String },
    Scene { id: String, title: String, text: String },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Layout {
    /// One combined file.
    #[default]
    Single,
    /// One file per chapter, in a new folder.
    PerChapter,
}

/// How a Word file looks.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum DocStyle {
    /// Standard submission format: 12 pt Times, double spaced, a title page and running header.
    #[default]
    Manuscript,
    /// A cleaner book page: smaller trim, Georgia, single and a half spacing, page numbers at the foot.
    Book,
}

/// What the book says about itself, from project.json.
#[derive(Debug, Clone)]
pub struct BookMeta {
    pub title: String,
    pub author: String,
    pub language: String,
    pub description: String,
    pub keywords: Vec<String>,
    pub subtitle: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default)]
    pub layout: Layout,
    /// Line placed between scenes in a chapter, e.g. "* * *". Empty means a blank line only.
    #[serde(default = "default_break")]
    pub scene_break: String,
    /// Put each scene's title above it as a heading.
    #[serde(default)]
    pub scene_titles: bool,
    /// Start the file with YAML front matter holding the title and author (useful for Pandoc).
    #[serde(default)]
    pub front_matter: bool,
    /// Export only this part or chapter (and what is in it); the whole book when None.
    #[serde(default)]
    pub root: Option<String>,
    /// Word only: the look of the pages.
    #[serde(default)]
    pub style: DocStyle,
    /// Word and EPUB: a title page with the title and author.
    #[serde(default = "yes")]
    pub title_page: bool,
    /// Word only: your own comments, as Word comments.
    #[serde(default)]
    pub comments: bool,
    /// EPUB only: an image file to use as the cover.
    #[serde(default)]
    pub cover: Option<String>,
}
fn yes() -> bool {
    true
}
fn default_break() -> String {
    "* * *".into()
}

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub parts: usize,
    pub chapters: usize,
    pub scenes: usize,
    pub words: usize,
    /// Items left out because their include-in-export flag is off.
    pub excluded: usize,
    /// Included scenes that still have pending AI suggestions; export is refused while any remain.
    pub pending: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub files: Vec<String>,
    pub summary: Summary,
}

fn find<'a>(nodes: &'a [BinderNode], id: &str) -> Option<&'a BinderNode> {
    nodes.iter().find_map(|n| if n.id == id { Some(n) } else { find(&n.children, id) })
}

fn has_pending(dir: &Path, id: &str) -> bool {
    let p = dir.join("manuscript").join(format!("{id}.meta.json"));
    let Ok(s) = fs::read_to_string(p) else { return false };
    serde_json::from_str::<serde_json::Value>(&s)
        .ok()
        .and_then(|v| v.get("suggestions").and_then(|x| x.as_array()).map(|a| !a.is_empty()))
        .unwrap_or(false)
}

/// Walk the binder into the intermediate representation. Trash and notes never export.
pub fn collect(dir: &Path, opts: &Options) -> Result<(Vec<Item>, Summary)> {
    let binder = read_binder(dir)?;
    let roots: Vec<&BinderNode> = match &opts.root {
        Some(id) => find(&binder.nodes, id).into_iter().collect(),
        None => binder.nodes.iter().collect(),
    };
    let mut items = vec![];
    let mut sum = Summary::default();
    fn walk(dir: &Path, n: &BinderNode, items: &mut Vec<Item>, sum: &mut Summary) -> Result<()> {
        if matches!(n.kind, NodeType::Trash | NodeType::Note) {
            return Ok(());
        }
        if !n.include_in_export {
            sum.excluded += 1;
            return Ok(());
        }
        match n.kind {
            NodeType::Part => {
                sum.parts += 1;
                items.push(Item::Part { title: n.title.clone() });
            }
            NodeType::Chapter => {
                sum.chapters += 1;
                items.push(Item::Chapter { title: n.title.clone() });
            }
            NodeType::Scene => {
                let text = read_scene(dir, &n.id)?;
                sum.scenes += 1;
                sum.words += text.split_whitespace().filter(|w| w.chars().any(|c| c.is_alphanumeric())).count();
                if has_pending(dir, &n.id) {
                    sum.pending.push(n.id.clone());
                }
                items.push(Item::Scene { id: n.id.clone(), title: n.title.clone(), text });
            }
            _ => {}
        }
        for c in &n.children {
            walk(dir, c, items, sum)?;
        }
        Ok(())
    }
    for n in roots {
        walk(dir, n, &mut items, &mut sum)?;
    }
    Ok((items, sum))
}

fn front_matter(title: &str, author: &str) -> String {
    let q = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    let mut s = format!("---\ntitle: {}\n", q(title));
    if !author.trim().is_empty() {
        s.push_str(&format!("author: {}\n", q(author)));
    }
    s.push_str("---\n\n");
    s
}

/// Render items as Markdown. Parts are `#` (when the export has any), chapters the next
/// level down, optional scene titles one below that. Scenes in the same chapter are
/// separated by the scene break.
pub fn render(items: &[Item], opts: &Options) -> String {
    let has_parts = items.iter().any(|i| matches!(i, Item::Part { .. }));
    let chapter_level = if has_parts { 2 } else { 1 };
    let mut out = String::new();
    let mut prev_scene = false;
    let block = |out: &mut String, s: &str| {
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push_str(if out.ends_with('\n') { "\n" } else { "\n\n" });
        }
        out.push_str(s.trim_end());
        out.push('\n');
    };
    for item in items {
        match item {
            Item::Part { title } => {
                block(&mut out, &format!("# {title}"));
                prev_scene = false;
            }
            Item::Chapter { title } => {
                block(&mut out, &format!("{} {title}", "#".repeat(chapter_level)));
                prev_scene = false;
            }
            Item::Scene { title, text, .. } => {
                if prev_scene && !opts.scene_break.trim().is_empty() {
                    // "* * *" and "***" are horizontal rules in Markdown, which is how other
                    // tools (Pandoc included) read a scene break.
                    block(&mut out, opts.scene_break.trim());
                }
                if opts.scene_titles {
                    block(&mut out, &format!("{} {title}", "#".repeat(chapter_level + 1)));
                }
                if !text.trim().is_empty() {
                    block(&mut out, text.trim());
                }
                prev_scene = true;
            }
        }
    }
    out
}

/// A file name from a title: no path separators or characters Windows refuses.
fn safe_name(s: &str) -> String {
    let cleaned: String = s.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '-' } else { c }).collect();
    let t = cleaned.trim().trim_matches('.').to_string();
    if t.is_empty() { "Untitled".into() } else { t.chars().take(80).collect() }
}

/// A folder under `parent` that does not exist yet: "name", then "name 2", "name 3"…
fn fresh_dir(parent: &Path, name: &str) -> PathBuf {
    let mut p = parent.join(name);
    let mut n = 2;
    while p.exists() {
        p = parent.join(format!("{name} {n}"));
        n += 1;
    }
    p
}

pub fn book_meta(dir: &Path) -> Result<BookMeta> {
    let meta: crate::project::ProjectMeta = serde_json::from_str(&io(dir, fs::read_to_string(dir.join("project.json")))?).map_err(|e| ProjectError::Json("project.json".into(), e))?;
    let f = |k: &str| meta.fields.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    Ok(BookMeta {
        title: meta.title.clone(),
        author: meta.author.clone(),
        language: f("language").unwrap_or_else(|| "en".into()),
        description: f("description").unwrap_or_default(),
        keywords: meta.keywords.clone(),
        subtitle: f("subtitle"),
    })
}

/// Your own, unresolved comments on each scene, for the Word export.
fn scene_notes(dir: &Path, items: &[Item]) -> std::collections::HashMap<String, Vec<crate::docx_out::SceneNote>> {
    let mut out = std::collections::HashMap::new();
    for it in items {
        let Item::Scene { id, .. } = it else { continue };
        let Ok(raw) = fs::read_to_string(dir.join("manuscript").join(format!("{id}.meta.json"))) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let list: Vec<crate::docx_out::SceneNote> = v
            .get("comments")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
            .filter(|c| c.get("tool").and_then(|t| t.as_str()) == Some("author") && c.get("resolved").and_then(|r| r.as_bool()) != Some(true))
            .filter_map(|c| Some(crate::docx_out::SceneNote { passage: c.get("passage")?.as_str()?.to_string(), text: c.get("comment")?.as_str()?.to_string() }))
            .filter(|n| !n.text.trim().is_empty())
            .collect();
        if !list.is_empty() {
            out.insert(id.clone(), list);
        }
    }
    out
}

/// Write a Word file. Refuses (writing nothing) while suggestions are pending.
pub fn write_docx(dir: &Path, opts: &Options, target: &Path) -> Result<Written> {
    let (items, summary) = collect(dir, opts)?;
    if !summary.pending.is_empty() {
        return Ok(Written { files: vec![], summary });
    }
    let meta = book_meta(dir)?;
    let notes = if opts.comments { scene_notes(dir, &items) } else { Default::default() };
    let bytes = crate::docx_out::build(&items, opts, &meta, summary.words, &notes).map_err(ProjectError::Other)?;
    write_bytes(target, &bytes)?;
    Ok(Written { files: vec![target.display().to_string()], summary })
}

/// Write an EPUB. Refuses (writing nothing) while suggestions are pending.
pub fn write_epub(dir: &Path, opts: &Options, target: &Path) -> Result<Written> {
    let (items, summary) = collect(dir, opts)?;
    if !summary.pending.is_empty() {
        return Ok(Written { files: vec![], summary });
    }
    let meta = book_meta(dir)?;
    let cover = match &opts.cover {
        Some(p) if !p.trim().is_empty() => Some((io(Path::new(p), fs::read(p))?, Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default())),
        _ => None,
    };
    let bytes = crate::epub_out::build(&items, opts, &meta, cover).map_err(ProjectError::Other)?;
    write_bytes(target, &bytes)?;
    Ok(Written { files: vec![target.display().to_string()], summary })
}

fn write_bytes(target: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = target.with_extension("tmp-export");
    io(&tmp, fs::write(&tmp, bytes))?;
    io(target, fs::rename(&tmp, target))
}

/// Write the export. For `Single`, `target` is the file to write; for `PerChapter`, the
/// folder to create a new export folder in. Refuses while suggestions are pending.
pub fn write(dir: &Path, opts: &Options, target: &Path) -> Result<Written> {
    let meta: crate::project::ProjectMeta = serde_json::from_str(&io(dir, fs::read_to_string(dir.join("project.json")))?)
        .map_err(|e| ProjectError::Json("project.json".into(), e))?;
    write_as(dir, opts, target, &meta.title, &meta.author)
}

fn write_as(dir: &Path, opts: &Options, target: &Path, title: &str, author: &str) -> Result<Written> {
    let (items, summary) = collect(dir, opts)?;
    if !summary.pending.is_empty() {
        return Ok(Written { files: vec![], summary });
    }
    let head = if opts.front_matter { front_matter(title, author) } else { String::new() };
    let mut files = vec![];
    match opts.layout {
        Layout::Single => {
            atomic_write(target, &(head + &render(&items, opts)))?;
            files.push(target.display().to_string());
        }
        Layout::PerChapter => {
            let out = fresh_dir(target, &safe_name(&format!("{title} (Markdown)")));
            io(&out, fs::create_dir_all(&out))?;
            // Each chapter starts a file; a part heading travels with the chapter after it.
            let mut chunks: Vec<(String, Vec<Item>)> = vec![];
            let mut carry: Vec<Item> = vec![];
            for item in items {
                match &item {
                    Item::Part { .. } => carry.push(item),
                    Item::Chapter { title } => {
                        let mut v = std::mem::take(&mut carry);
                        v.push(item.clone());
                        chunks.push((title.clone(), v));
                    }
                    Item::Scene { .. } => match chunks.last_mut() {
                        Some((_, v)) if carry.is_empty() => v.push(item),
                        _ => {
                            carry.push(item);
                        }
                    },
                }
            }
            if !carry.is_empty() {
                chunks.push(("Front matter".into(), carry));
            }
            let width = chunks.len().to_string().len().max(2);
            for (i, (name, chunk)) in chunks.iter().enumerate() {
                let file = out.join(format!("{:0width$} {}.md", i + 1, safe_name(name), width = width));
                let body = if i == 0 { head.clone() + &render(chunk, opts) } else { render(chunk, opts) };
                atomic_write(&file, &body)?;
                files.push(file.display().to_string());
            }
        }
    }
    Ok(Written { files, summary })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{create_project, save_binder, write_scene, write_scene_meta, Binder};

    fn node(id: &str, kind: NodeType, title: &str, children: Vec<BinderNode>) -> BinderNode {
        BinderNode { id: id.into(), kind, title: title.into(), status: "draft".into(), label: None, synopsis: String::new(), include_in_export: true, keywords: vec![], fields: Default::default(), children }
    }

    fn book(d: &Path) {
        create_project(d, "The Widow's House").unwrap();
        let mut skipped = node("s3", NodeType::Scene, "Cut scene", vec![]);
        skipped.include_in_export = false;
        let binder = Binder {
            nodes: vec![
                node("c1", NodeType::Chapter, "The Letter", vec![node("s1", NodeType::Scene, "Arrival", vec![]), node("s2", NodeType::Scene, "Night", vec![]), skipped]),
                node("c2", NodeType::Chapter, "Low Tide", vec![node("s4", NodeType::Scene, "Ferry", vec![])]),
                node("n1", NodeType::Note, "Research", vec![]),
                node("t", NodeType::Trash, "Trash", vec![node("s5", NodeType::Scene, "Old", vec![])]),
            ],
        };
        save_binder(d, &binder).unwrap();
        write_scene(d, "s1", "She came by ferry.\n").unwrap();
        write_scene(d, "s2", "The house was cold.").unwrap();
        write_scene(d, "s3", "Never shown.").unwrap();
        write_scene(d, "s4", "The tide went out.").unwrap();
        write_scene(d, "n1", "Notes are not exported.").unwrap();
        write_scene(d, "s5", "Trashed.").unwrap();
    }

    fn opts() -> Options {
        Options { layout: Layout::Single, scene_break: "* * *".into(), scene_titles: false, front_matter: false, root: None, style: DocStyle::Manuscript, title_page: true, comments: false, cover: None }
    }

    #[test]
    fn collects_in_order_and_skips_excluded_notes_and_trash() {
        let d = tempfile::tempdir().unwrap();
        book(d.path());
        let (items, sum) = collect(d.path(), &opts()).unwrap();
        let ids: Vec<&str> = items.iter().filter_map(|i| if let Item::Scene { id, .. } = i { Some(id.as_str()) } else { None }).collect();
        assert_eq!(ids, ["s1", "s2", "s4"]);
        assert_eq!((sum.chapters, sum.scenes, sum.excluded, sum.words), (2, 3, 1, 12));
    }

    #[test]
    fn renders_chapters_and_scene_breaks() {
        let d = tempfile::tempdir().unwrap();
        book(d.path());
        let (items, _) = collect(d.path(), &opts()).unwrap();
        assert_eq!(
            render(&items, &opts()),
            "# The Letter\n\nShe came by ferry.\n\n* * *\n\nThe house was cold.\n\n# Low Tide\n\nThe tide went out.\n"
        );
        let mut o = opts();
        o.scene_break = "***".into();
        o.scene_titles = true;
        let md = render(&items, &o);
        assert!(md.contains("## Arrival\n\nShe came by ferry.\n\n***\n\n## Night"));
    }

    #[test]
    fn parts_push_chapters_down_a_level() {
        let items = vec![
            Item::Part { title: "One".into() },
            Item::Chapter { title: "A".into() },
            Item::Scene { id: "s".into(), title: "x".into(), text: "Text.".into() },
        ];
        assert_eq!(render(&items, &opts()), "# One\n\n## A\n\nText.\n");
    }

    #[test]
    fn pending_suggestions_block_the_export() {
        let d = tempfile::tempdir().unwrap();
        book(d.path());
        write_scene_meta(d.path(), "s2", r#"{"suggestions":[{"sid":"a"}]}"#).unwrap();
        let target = d.path().join("out.md");
        let w = write_as(d.path(), &opts(), &target, "T", "").unwrap();
        assert_eq!(w.summary.pending, vec!["s2".to_string()]);
        assert!(w.files.is_empty() && !target.exists());
        // An excluded scene's pending suggestions do not block it.
        write_scene_meta(d.path(), "s2", "").unwrap();
        write_scene_meta(d.path(), "s3", r#"{"suggestions":[{"sid":"b"}]}"#).unwrap();
        assert_eq!(write(d.path(), &opts(), &target).unwrap().files.len(), 1);
    }

    #[test]
    fn single_file_with_front_matter() {
        let d = tempfile::tempdir().unwrap();
        book(d.path());
        let target = d.path().join("book.md");
        let mut o = opts();
        o.front_matter = true;
        write_as(d.path(), &o, &target, "The \"Widow\"", "D. Marsh").unwrap();
        let s = fs::read_to_string(target).unwrap();
        assert!(s.starts_with("---\ntitle: \"The \\\"Widow\\\"\"\nauthor: \"D. Marsh\"\n---\n\n# The Letter"));
    }

    #[test]
    fn one_file_per_chapter_in_a_new_folder() {
        let d = tempfile::tempdir().unwrap();
        book(d.path());
        let out = tempfile::tempdir().unwrap();
        let mut o = opts();
        o.layout = Layout::PerChapter;
        let w = write_as(d.path(), &o, out.path(), "Book: One", "").unwrap();
        assert_eq!(w.files.len(), 2);
        assert!(w.files[0].ends_with("Book- One (Markdown)/01 The Letter.md"));
        assert_eq!(fs::read_to_string(&w.files[1]).unwrap(), "# Low Tide\n\nThe tide went out.\n");
        // A second export never overwrites the first.
        let w2 = write_as(d.path(), &o, out.path(), "Book: One", "").unwrap();
        assert!(w2.files[0].contains("Book- One (Markdown) 2"));
    }

    #[test]
    fn exports_just_one_chapter() {
        let d = tempfile::tempdir().unwrap();
        book(d.path());
        let mut o = opts();
        o.root = Some("c2".into());
        let (items, sum) = collect(d.path(), &o).unwrap();
        assert_eq!(sum.scenes, 1);
        assert_eq!(render(&items, &o), "# Low Tide\n\nThe tide went out.\n");
    }
}
