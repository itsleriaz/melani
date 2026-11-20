// SPDX-License-Identifier: GPL-3.0-only
//! Import. Text from Markdown, plain text and Word files is split into parts, chapters and
//! scenes, then added to the end of the book. Nothing existing is touched.
use crate::project::{self, Binder, BinderNode, NodeType, ProjectError};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, ProjectError>;

/// What the headings in the text mean.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HeadingMode {
    /// `#` starts a chapter; deeper headings stay in the text.
    Chapters,
    /// `#` starts a chapter and `##` a scene.
    ChaptersScenes,
    /// `#` starts a part, `##` a chapter and `###` a scene.
    PartsChaptersScenes,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// None: work it out from the headings that are there.
    #[serde(default)]
    pub headings: Option<HeadingMode>,
    /// A line such as `* * *` or `---` starts a new scene.
    #[serde(default = "yes")]
    pub scene_breaks: bool,
    /// Each file is one chapter (titled by its first `#` heading, or its file name), whatever its headings say.
    #[serde(default)]
    pub file_as_chapter: bool,
}
fn yes() -> bool {
    true
}

/// A comment found in a Word file, to be attached to the scene that holds its passage.
#[derive(Debug, Clone, PartialEq)]
pub struct DocComment {
    pub passage: String,
    pub author: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanNode {
    pub kind: NodeType,
    pub title: String,
    /// Scene text, as Markdown.
    pub text: String,
    pub comments: Vec<DocComment>,
    pub children: Vec<PlanNode>,
}

fn node(kind: NodeType, title: &str) -> PlanNode {
    PlanNode { kind, title: title.to_string(), text: String::new(), comments: vec![], children: vec![] }
}

// ---- Splitting text into structure -----------------------------------------------------

#[derive(Debug, PartialEq)]
enum Line<'a> {
    Heading(usize, &'a str),
    Break,
    Text(&'a str),
}

/// `# Title`, `## Title ##`: the level and the text, or None.
fn heading(line: &str) -> Option<(usize, &str)> {
    let t = line.trim_start();
    if line.len() - t.len() > 3 {
        return None; // indented code
    }
    let level = t.chars().take_while(|&c| c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &t[level..];
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim_end();
    Some((level, text.trim()))
}

/// A line that is only a scene break: `* * *`, `***`, `---`, `___`, `⁂`, or a lone `#`.
fn is_break(line: &str) -> bool {
    let t = line.trim();
    if t == "#" || t == "⁂" || t == "* * *" {
        return true;
    }
    let marks: Vec<char> = t.chars().filter(|c| !c.is_whitespace()).collect();
    marks.len() >= 3 && matches!(marks[0], '*' | '-' | '_' | '~') && marks.iter().all(|&c| c == marks[0]) && t.chars().all(|c| c == marks[0] || c == ' ')
}

fn classify(line: &str, in_fence: bool) -> Line<'_> {
    if in_fence {
        return Line::Text(line);
    }
    if let Some((l, t)) = heading(line) {
        return Line::Heading(l, t);
    }
    if is_break(line) {
        return Line::Break;
    }
    Line::Text(line)
}

/// Which heading levels are used (outside code fences), to suggest what they mean.
pub fn suggest_headings(text: &str) -> HeadingMode {
    let mut seen = [false; 7];
    let mut fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fence = !fence;
        } else if !fence {
            if let Some((l, _)) = heading(line) {
                seen[l] = true;
            }
        }
    }
    match (seen[1], seen[2], seen[3]) {
        (true, true, true) => HeadingMode::PartsChaptersScenes,
        (true, true, false) => HeadingMode::ChaptersScenes,
        _ => HeadingMode::Chapters,
    }
}

/// "Chapter_One-draft" -> "Chapter One draft"
fn title_from_file(stem: &str) -> String {
    let t: String = stem.chars().map(|c| if c == '_' || c == '-' { ' ' } else { c }).collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() { "Imported text".into() } else { t }
}

struct Builder {
    roots: Vec<PlanNode>,
    part: Option<usize>,
    chapter: Option<usize>,
    lines: Vec<String>,
    scene_title: Option<String>,
    fallback: String,
}

impl Builder {
    fn container(&mut self) -> &mut Vec<PlanNode> {
        match self.part {
            Some(p) => &mut self.roots[p].children,
            None => &mut self.roots,
        }
    }
    fn chapter_mut(&mut self) -> &mut PlanNode {
        if self.chapter.is_none() {
            let title = self.fallback.clone();
            let c = self.container();
            c.push(node(NodeType::Chapter, &title));
            self.chapter = Some(c.len() - 1);
        }
        let ch = self.chapter.unwrap();
        &mut self.container()[ch]
    }
    fn flush_scene(&mut self) {
        let text = self.lines.join("\n").trim().to_string();
        let title = self.scene_title.take();
        self.lines.clear();
        if text.is_empty() && title.is_none() {
            return;
        }
        let chapter = self.chapter_mut();
        let title = title.unwrap_or_else(|| format!("Scene {}", chapter.children.len() + 1));
        let mut s = node(NodeType::Scene, &title);
        s.text = text;
        chapter.children.push(s);
    }
    fn new_chapter(&mut self, title: &str) {
        self.flush_scene();
        let c = self.container();
        c.push(node(NodeType::Chapter, title));
        self.chapter = Some(c.len() - 1);
    }
    fn new_part(&mut self, title: &str) {
        self.flush_scene();
        self.roots.push(node(NodeType::Part, title));
        self.part = Some(self.roots.len() - 1);
        self.chapter = None;
    }
}

/// Split one text into structure. `fallback` titles a chapter that has no heading of its own.
pub fn plan_text(text: &str, mode: HeadingMode, scene_breaks: bool, file_as_chapter: bool, fallback: &str) -> Vec<PlanNode> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
    let mut body = text.as_str();
    // YAML front matter is for other tools.
    if body.starts_with("---\n") {
        if let Some(end) = body[4..].find("\n---") {
            let after = &body[4 + end + 4..];
            body = after.strip_prefix('\n').unwrap_or(after);
        }
    }
    let mut b = Builder { roots: vec![], part: None, chapter: None, lines: vec![], scene_title: None, fallback: fallback.to_string() };
    let mut lines = body.lines().peekable();
    if file_as_chapter {
        // The first heading names the chapter; the rest of the file is its scenes.
        while lines.peek().is_some_and(|l| l.trim().is_empty()) {
            lines.next();
        }
        let title = match lines.peek().and_then(|l| heading(l)) {
            Some((1, t)) if !t.is_empty() => {
                let t = t.to_string();
                lines.next();
                t
            }
            _ => fallback.to_string(),
        };
        b.new_chapter(&title);
    }
    let mut fence = false;
    for line in lines {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fence = !fence;
        }
        match classify(line, fence) {
            Line::Heading(level, t) if !file_as_chapter && !t.is_empty() => match (mode, level) {
                (HeadingMode::PartsChaptersScenes, 1) => b.new_part(t),
                (HeadingMode::PartsChaptersScenes, 2) | (HeadingMode::Chapters, 1) | (HeadingMode::ChaptersScenes, 1) => b.new_chapter(t),
                (HeadingMode::PartsChaptersScenes, 3) | (HeadingMode::ChaptersScenes, 2) => {
                    b.flush_scene();
                    b.scene_title = Some(t.to_string());
                }
                _ => b.lines.push(line.to_string()),
            },
            Line::Break if scene_breaks => b.flush_scene(),
            _ => b.lines.push(line.to_string()),
        }
    }
    b.flush_scene();
    b.roots
}

// ---- Counting and placing --------------------------------------------------------------

pub fn words(s: &str) -> usize {
    s.split_whitespace().filter(|w| w.chars().any(|c| c.is_alphanumeric())).count()
}

/// Text as it reads in the editor: the Markdown marks (emphasis, highlights, footnotes) removed.
pub fn plain(md: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = md.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            out.push(chars[i + 1]);
            i += 2;
        } else if c == '^' && chars.get(i + 1) == Some(&'[') {
            // A footnote: skip to its closing bracket.
            let mut depth = 0;
            i += 2;
            while i < chars.len() {
                match chars[i] {
                    '\\' => i += 1,
                    '[' => depth += 1,
                    ']' if depth == 0 => break,
                    ']' => depth -= 1,
                    _ => {}
                }
                i += 1;
            }
            i += 1;
        } else if c == '=' && chars.get(i + 1) == Some(&'=') {
            i += 2;
            if chars.get(i) == Some(&'{') {
                while i < chars.len() && chars[i] != '}' {
                    i += 1;
                }
                i += 1;
            }
        } else if c == '*' || c == '~' {
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn count(nodes: &[PlanNode]) -> (usize, usize, usize) {
    nodes.iter().fold((0, 0, 0), |(c, s, w), n| {
        let (c2, s2, w2) = count(&n.children);
        (c + c2 + usize::from(n.kind == NodeType::Chapter), s + s2 + usize::from(n.kind == NodeType::Scene), w + w2 + words(&n.text))
    })
}

/// Give each comment to the first scene whose text holds its passage. Returns how many found a home.
fn place_comments(nodes: &mut [PlanNode], comments: Vec<DocComment>) -> usize {
    let mut placed = 0;
    for c in comments {
        let needle = c.passage.trim().to_string();
        if needle.is_empty() {
            continue;
        }
        fn find<'a>(nodes: &'a mut [PlanNode], needle: &str) -> Option<&'a mut PlanNode> {
            for n in nodes {
                if n.kind == NodeType::Scene && plain(&n.text).contains(needle) {
                    return Some(n);
                }
                if let Some(f) = find(&mut n.children, needle) {
                    return Some(f);
                }
            }
            None
        }
        if let Some(s) = find(nodes, &needle) {
            s.comments.push(c);
            placed += 1;
        }
    }
    placed
}

// ---- Reading sources -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Docx,
}

fn kind_of(p: &Path) -> Option<Kind> {
    match p.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "md" | "markdown" | "txt" | "text" => Some(Kind::Text),
        "docx" => Some(Kind::Docx),
        _ => None,
    }
}

/// "chapter 2" before "chapter 10".
fn natural_key(s: &str) -> Vec<(bool, String)> {
    let mut out: Vec<(bool, String)> = vec![];
    for c in s.to_lowercase().chars() {
        let digit = c.is_ascii_digit();
        match out.last_mut() {
            Some((d, run)) if *d == digit => run.push(c),
            _ => out.push((digit, c.to_string())),
        }
    }
    for (d, run) in &mut out {
        if *d {
            *run = format!("{:0>12}", run);
        }
    }
    out
}

/// The importable files under these paths (files as given; folders searched), in natural name order.
pub fn collect_files(paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
    fn walk(p: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
        let md = fs::metadata(p).map_err(|e| ProjectError::Io(p.display().to_string(), e))?;
        if md.is_dir() {
            let mut kids: Vec<PathBuf> = fs::read_dir(p).map_err(|e| ProjectError::Io(p.display().to_string(), e))?.filter_map(|e| e.ok().map(|e| e.path())).collect();
            kids.retain(|k| !k.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')));
            kids.sort_by_key(|k| natural_key(&k.file_name().unwrap_or_default().to_string_lossy()));
            for k in kids {
                walk(&k, out)?;
            }
        } else if kind_of(p).is_some() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("~$")) {
            out.push(p.to_path_buf());
        }
        Ok(())
    }
    let mut out = vec![];
    for p in paths {
        walk(p, &mut out)?;
    }
    Ok(out)
}

struct Loaded {
    name: String,
    markdown: String,
    comments: Vec<DocComment>,
    footnotes: usize,
}

fn load(path: &Path) -> Result<Loaded> {
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match kind_of(path) {
        Some(Kind::Docx) => {
            let bytes = fs::read(path).map_err(|e| ProjectError::Io(path.display().to_string(), e))?;
            let c = crate::docx::to_markdown(&bytes).map_err(|e| ProjectError::Other(format!("{}: {e}", path.display())))?;
            Ok(Loaded { name, footnotes: c.footnotes, markdown: c.markdown, comments: c.comments })
        }
        _ => {
            let bytes = fs::read(path).map_err(|e| ProjectError::Io(path.display().to_string(), e))?;
            let markdown = String::from_utf8_lossy(&bytes).into_owned();
            let footnotes = markdown.matches("^[").count();
            Ok(Loaded { name, markdown, comments: vec![], footnotes })
        }
    }
}

// ---- Preview and commit ----------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewNode {
    #[serde(rename = "type")]
    pub kind: NodeType,
    pub title: String,
    pub words: usize,
    pub children: Vec<PreviewNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub files: Vec<String>,
    /// The meaning given to headings (the one asked for, or the one worked out).
    pub headings: HeadingMode,
    pub nodes: Vec<PreviewNode>,
    pub parts: usize,
    pub chapters: usize,
    pub scenes: usize,
    pub words: usize,
    pub footnotes: usize,
    pub comments: usize,
    /// Comments whose text could not be found in any scene, so they are left out.
    pub lost_comments: usize,
}

pub struct Planned {
    pub nodes: Vec<PlanNode>,
    pub preview: Preview,
}

pub fn plan(paths: &[PathBuf], opts: &Options) -> Result<Planned> {
    let files = collect_files(paths)?;
    let loaded: Vec<Loaded> = files.iter().map(|f| load(f)).collect::<Result<_>>()?;
    let all_text: String = loaded.iter().map(|l| l.markdown.as_str()).collect::<Vec<_>>().join("\n");
    let mode = opts.headings.unwrap_or_else(|| suggest_headings(&all_text));
    let mut nodes: Vec<PlanNode> = vec![];
    let mut comments: Vec<DocComment> = vec![];
    for l in &loaded {
        nodes.extend(plan_text(&l.markdown, mode, opts.scene_breaks, opts.file_as_chapter, &title_from_file(&l.name)));
        comments.extend(l.comments.clone());
    }
    let total_comments = comments.len();
    let placed = place_comments(&mut nodes, comments);
    fn preview(nodes: &[PlanNode]) -> Vec<PreviewNode> {
        nodes.iter().map(|n| PreviewNode { kind: n.kind.clone(), title: n.title.clone(), words: count(std::slice::from_ref(n)).2, children: preview(&n.children) }).collect()
    }
    let (chapters, scenes, wcount) = count(&nodes);
    let parts = nodes.iter().filter(|n| n.kind == NodeType::Part).count();
    let pv = Preview {
        files: files.iter().map(|f| f.file_name().unwrap_or_default().to_string_lossy().into_owned()).collect(),
        headings: mode,
        nodes: preview(&nodes),
        parts,
        chapters,
        scenes,
        words: wcount,
        footnotes: loaded.iter().map(|l| l.footnotes).sum(),
        comments: placed,
        lost_comments: total_comments - placed,
    };
    Ok(Planned { nodes, preview: pv })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub binder: Binder,
    pub scenes: usize,
    pub chapters: usize,
    pub words: usize,
    /// The first scene added, so the app can open it.
    pub first_scene: Option<String>,
}

fn to_binder(n: &PlanNode, dir: &Path, first: &mut Option<String>) -> Result<BinderNode> {
    let id = project::new_id();
    let mut children = vec![];
    for c in &n.children {
        children.push(to_binder(c, dir, first)?);
    }
    if n.kind == NodeType::Scene {
        project::write_scene(dir, &id, &n.text)?;
        if !n.comments.is_empty() {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let comments: Vec<serde_json::Value> = n
                .comments
                .iter()
                .map(|c| {
                    let text = if c.author.trim().is_empty() { c.text.clone() } else { format!("{}: {}", c.author.trim(), c.text) };
                    serde_json::json!({ "id": project::new_id(), "passage": c.passage.trim(), "comment": text, "tool": "author", "model": "", "created": now })
                })
                .collect();
            project::write_scene_meta(dir, &id, &serde_json::json!({ "version": 1, "suggestions": [], "orphans": [], "comments": comments }).to_string())?;
        }
        first.get_or_insert_with(|| id.clone());
    }
    Ok(BinderNode { id, kind: n.kind.clone(), title: n.title.clone(), status: "draft".into(), label: None, synopsis: String::new(), include_in_export: true, keywords: vec![], fields: Default::default(), children })
}

/// Add the imported structure to the end of the book (before the trash).
pub fn commit(dir: &Path, paths: &[PathBuf], opts: &Options) -> Result<Imported> {
    let planned = plan(paths, opts)?;
    let mut binder = project::read_binder(dir)?;
    let mut first = None;
    let mut added = vec![];
    for n in &planned.nodes {
        added.push(to_binder(n, dir, &mut first)?);
    }
    let at = binder.nodes.iter().position(|n| n.kind == NodeType::Trash).unwrap_or(binder.nodes.len());
    for (i, n) in added.into_iter().enumerate() {
        binder.nodes.insert(at + i, n);
    }
    project::save_binder(dir, &binder)?;
    let p = &planned.preview;
    Ok(Imported { binder, scenes: p.scenes, chapters: p.chapters, words: p.words, first_scene: first })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(nodes: &[PlanNode]) -> Vec<String> {
        nodes.iter().map(|n| n.title.clone()).collect()
    }

    #[test]
    fn headings_make_chapters_and_breaks_make_scenes() {
        let md = "# One\n\nFirst scene.\n\n* * *\n\nSecond scene.\n\n# Two\n\nThird.\n";
        let p = plan_text(md, HeadingMode::Chapters, true, false, "x");
        assert_eq!(titles(&p), ["One", "Two"]);
        assert_eq!(titles(&p[0].children), ["Scene 1", "Scene 2"]);
        assert_eq!(p[0].children[1].text, "Second scene.");
        assert_eq!(p[1].children[0].text, "Third.");
    }

    #[test]
    fn scene_breaks_can_be_left_alone() {
        let p = plan_text("# One\n\nA.\n\n---\n\nB.\n", HeadingMode::Chapters, false, false, "x");
        assert_eq!(p[0].children.len(), 1);
        assert!(p[0].children[0].text.contains("---"));
    }

    #[test]
    fn levels_can_mean_parts_chapters_and_scenes() {
        let md = "# Part I\n\n## Dawn\n\n### The shop\n\nText.\n\n### The street\n\nMore.\n\n## Dusk\n\nEnd.\n";
        let p = plan_text(md, HeadingMode::PartsChaptersScenes, true, false, "x");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].kind, NodeType::Part);
        assert_eq!(titles(&p[0].children), ["Dawn", "Dusk"]);
        assert_eq!(titles(&p[0].children[0].children), ["The shop", "The street"]);
        assert_eq!(p[0].children[1].children[0].title, "Scene 1");
        let q = plan_text("# Book\n\n## Ch\n\nBody.\n", HeadingMode::ChaptersScenes, true, false, "x");
        assert_eq!((q[0].title.as_str(), q[0].children[0].title.as_str()), ("Book", "Ch"));
    }

    #[test]
    fn deeper_headings_stay_in_the_text_and_code_is_left_alone() {
        let md = "# One\n\n## Not a scene\n\nText.\n\n```\n# not a heading\n---\n```\n";
        let p = plan_text(md, HeadingMode::Chapters, true, false, "x");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].children.len(), 1);
        assert!(p[0].children[0].text.contains("## Not a scene") && p[0].children[0].text.contains("# not a heading"));
    }

    #[test]
    fn text_before_any_heading_goes_in_a_chapter_named_for_the_file() {
        let p = plan_text("Just prose.\n", HeadingMode::Chapters, true, false, "My draft");
        assert_eq!(titles(&p), ["My draft"]);
        assert_eq!(p[0].children[0].text, "Just prose.");
    }

    #[test]
    fn a_file_can_be_a_chapter() {
        let p = plan_text("# The Letter\n\nA.\n\n***\n\nB.\n", HeadingMode::Chapters, true, true, "file");
        assert_eq!(titles(&p), ["The Letter"]);
        assert_eq!(p[0].children.len(), 2);
        let q = plan_text("No heading.\n", HeadingMode::Chapters, true, true, "chapter 3");
        assert_eq!(titles(&q), ["chapter 3"]);
    }

    #[test]
    fn front_matter_and_line_endings_are_dealt_with() {
        let md = "---\ntitle: \"X\"\nauthor: \"Y\"\n---\r\n\r\n# One\r\n\r\nText.\r\n";
        let p = plan_text(md, HeadingMode::Chapters, true, false, "x");
        assert_eq!(titles(&p), ["One"]);
        assert_eq!(p[0].children[0].text, "Text.");
    }

    #[test]
    fn it_reads_what_export_writes() {
        let md = "# Part One\n\n## Chapter A\n\nOne.\n\n* * *\n\nTwo.\n\n## Chapter B\n\nThree.\n";
        assert_eq!(suggest_headings(md), HeadingMode::ChaptersScenes); // two levels is ambiguous: the preview lets you switch
        let p = plan_text(md, HeadingMode::PartsChaptersScenes, true, false, "x");
        assert_eq!(p[0].kind, NodeType::Part);
    }

    #[test]
    fn suggestions_follow_the_levels_in_use() {
        assert_eq!(suggest_headings("plain"), HeadingMode::Chapters);
        assert_eq!(suggest_headings("# a\n## b\n### c"), HeadingMode::PartsChaptersScenes);
        assert_eq!(suggest_headings("```\n# a\n## b\n```\n# x"), HeadingMode::Chapters);
    }

    #[test]
    fn breaks_are_recognised() {
        for b in ["* * *", "***", "---", "___", "- - -", "#", "⁂", "  ****  "] {
            assert!(is_break(b), "{b}");
        }
        for t in ["**bold**", "-- no", "--", "a * * *", "- item"] {
            assert!(!is_break(t), "{t}");
        }
    }

    #[test]
    fn plain_text_drops_the_marks() {
        assert_eq!(plain("a **bold** ==hl== =={blue}b== ~~x~~ c^[note [1]] d \\* e"), "a bold hl b x c d * e");
    }

    #[test]
    fn comments_go_to_the_scene_that_holds_their_passage() {
        let mut p = plan_text("# A\n\nOne **two** three.\n\n***\n\nFour five.\n", HeadingMode::Chapters, true, false, "x");
        let c = |passage: &str| DocComment { passage: passage.into(), author: "Al".into(), text: "hm".into() };
        let placed = place_comments(&mut p, vec![c("two three"), c("five"), c("missing")]);
        assert_eq!(placed, 2);
        assert_eq!(p[0].children[0].comments.len(), 1);
        assert_eq!(p[0].children[1].comments.len(), 1);
    }

    #[test]
    fn files_sort_the_way_people_expect() {
        let d = tempfile::tempdir().unwrap();
        for n in ["ch10.md", "ch2.md", "ch1.md", "notes.pdf", ".hidden.md", "~$tmp.docx"] {
            fs::write(d.path().join(n), "x").unwrap();
        }
        let got: Vec<String> = collect_files(&[d.path().to_path_buf()]).unwrap().iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(got, ["ch1.md", "ch2.md", "ch10.md"]);
    }

    #[test]
    fn commit_adds_to_the_end_of_the_book_and_leaves_the_rest() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path().join("book");
        project::create_project(&proj, "T").unwrap();
        let src = d.path().join("draft.md");
        fs::write(&src, "# New chapter\n\nHello there.\n\n***\n\nSecond.\n").unwrap();
        let opts = Options { headings: None, scene_breaks: true, file_as_chapter: false };
        let r = commit(&proj, &[src], &opts).unwrap();
        assert_eq!((r.chapters, r.scenes), (1, 2));
        let nodes = &r.binder.nodes;
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].title, "Chapter 1"); // what was there stays first
        assert_eq!(nodes[1].title, "New chapter");
        assert_eq!(nodes[2].kind, NodeType::Trash); // the trash stays last
        let scene = &nodes[1].children[0];
        assert_eq!(project::read_scene(&proj, &scene.id).unwrap(), "Hello there.");
        assert_eq!(r.first_scene.as_deref(), Some(scene.id.as_str()));
        assert_eq!(project::read_binder(&proj).unwrap().nodes.len(), 3);
    }
}
