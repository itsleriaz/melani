// SPDX-License-Identifier: GPL-3.0-only
//! Project search for the search panel: per-scene and per-entry hits with snippets,
//! match case and whole-word options, and replace-all across scenes.
use crate::codex;
use crate::project::{read_scene, write_scene, ProjectError};
use crate::snapshots;
use serde::{Deserialize, Serialize};
use std::path::Path;

type Result<T> = std::result::Result<T, ProjectError>;

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Hit {
    /// Which match this is within its scene or entry, counting from 0.
    pub index: usize,
    pub pre: String,
    #[serde(rename = "match")]
    pub matched: String,
    pub post: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Group {
    pub id: String,
    /// "scene" or "codex".
    pub kind: &'static str,
    pub count: usize,
    pub hits: Vec<Hit>,
}

/// Snippets shown per scene; the count still covers every match.
const HITS_PER_GROUP: usize = 20;
const BEFORE: usize = 40;
const AFTER: usize = 70;

fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Char ranges [start, end) of every match, left to right, non-overlapping.
pub fn find(text: &[char], query: &[char], opts: Options) -> Vec<(usize, usize)> {
    let mut out = vec![];
    if query.is_empty() || query.len() > text.len() {
        return out;
    }
    let eq = |a: char, b: char| if opts.case_sensitive { a == b } else { fold(a) == fold(b) };
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut i = 0;
    while i + query.len() <= text.len() {
        let end = i + query.len();
        let hit = (0..query.len()).all(|k| eq(text[i + k], query[k]))
            && (!opts.whole_word || ((i == 0 || !word(text[i - 1])) && (end == text.len() || !word(text[end]))));
        if hit {
            out.push((i, end));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

fn snippet(text: &[char], (s, e): (usize, usize), index: usize) -> Hit {
    // Stay on the match's line.
    let line_start = text[..s].iter().rposition(|&c| c == '\n').map_or(0, |p| p + 1);
    let line_end = text[e..].iter().position(|&c| c == '\n').map_or(text.len(), |p| e + p);
    let from = s.saturating_sub(BEFORE).max(line_start);
    let to = (e + AFTER).min(line_end);
    let mut pre: String = text[from..s].iter().collect();
    let mut post: String = text[e..to].iter().collect();
    if from > line_start {
        pre = format!("…{}", pre.trim_start());
    }
    if to < line_end {
        post = format!("{}…", post.trim_end());
    }
    Hit { index, pre, matched: text[s..e].iter().collect(), post }
}

fn group(id: &str, kind: &'static str, text: &str, query: &[char], opts: Options) -> Option<Group> {
    let chars: Vec<char> = text.chars().collect();
    let ranges = find(&chars, query, opts);
    if ranges.is_empty() {
        return None;
    }
    let hits = ranges.iter().take(HITS_PER_GROUP).enumerate().map(|(i, &r)| snippet(&chars, r, i)).collect();
    Some(Group { id: id.into(), kind, count: ranges.len(), hits })
}

/// Search the given scenes, in the order given (the binder's), then optionally the codex.
pub fn search(dir: &Path, query: &str, opts: Options, scene_ids: &[String], include_codex: bool) -> Vec<Group> {
    let q: Vec<char> = query.chars().collect();
    let mut out = vec![];
    if q.is_empty() {
        return out;
    }
    for id in scene_ids {
        if let Ok(text) = read_scene(dir, id) {
            out.extend(group(id, "scene", &text, &q, opts));
        }
    }
    if include_codex {
        for e in codex::list_entries(dir) {
            let body = codex::read_body(dir, &e.id).unwrap_or_default();
            let text = format!("{}\n{}\n{}", e.name, e.aliases.join(", "), body);
            out.extend(group(&e.id, "codex", &text, &q, opts));
        }
    }
    out
}

/// Replace every match in the given scenes. Takes one snapshot of the scenes that change
/// first, so the whole replace can be undone. Returns how many matches were replaced.
pub fn replace_all(dir: &Path, query: &str, replacement: &str, opts: Options, scene_ids: &[String]) -> Result<usize> {
    let q: Vec<char> = query.chars().collect();
    let mut changed: Vec<(String, String)> = vec![];
    let mut total = 0;
    for id in scene_ids {
        let text = read_scene(dir, id)?;
        let chars: Vec<char> = text.chars().collect();
        let ranges = find(&chars, &q, opts);
        if ranges.is_empty() {
            continue;
        }
        let mut next = String::with_capacity(text.len());
        let mut at = 0;
        for &(s, e) in &ranges {
            next.extend(&chars[at..s]);
            next.push_str(replacement);
            at = e;
        }
        next.extend(&chars[at..]);
        total += ranges.len();
        changed.push((id.clone(), next));
    }
    if changed.is_empty() {
        return Ok(0);
    }
    let ids: Vec<String> = changed.iter().map(|(id, _)| id.clone()).collect();
    let label = format!("Before replacing \u{201c}{query}\u{201d}");
    snapshots::create(dir, &ids, "Automatic: before replace all", &label, "auto")?;
    for (id, text) in changed {
        write_scene(dir, &id, &text)?;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::create_project;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn options_change_what_matches() {
        let t = chars("The tide, the Tide's turn, riptide.");
        let any = find(&t, &chars("tide"), Options::default());
        assert_eq!(any.len(), 3);
        let word = find(&t, &chars("tide"), Options { whole_word: true, ..Default::default() });
        assert_eq!(word.len(), 2); // not "riptide"
        let case = find(&t, &chars("Tide"), Options { case_sensitive: true, whole_word: true });
        assert_eq!(case, vec![(14, 18)]);
    }

    #[test]
    fn snippets_stay_on_one_line_and_mark_cuts() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        let long = "x ".repeat(40);
        write_scene(d.path(), "s1", &format!("First line.\n{long}the tide came in{long}\nLast.")).unwrap();
        write_scene(d.path(), "s2", "Nothing here.").unwrap();
        let r = search(d.path(), "TIDE", Options::default(), &["s1".into(), "s2".into()], false);
        assert_eq!(r.len(), 1);
        let h = &r[0].hits[0];
        assert_eq!(h.matched, "tide");
        assert!(h.pre.starts_with('…') && h.post.ends_with('…'));
        assert!(!h.pre.contains("First") && !h.post.contains("Last"));
    }

    #[test]
    fn finds_codex_names_aliases_and_bodies() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        let e = codex::tests::entry("e1", "Harrow Point", &["the Point"]);
        codex::save_entry(d.path(), &e, "Cut off at high tide.").unwrap();
        let r = search(d.path(), "point", Options::default(), &[], true);
        assert_eq!(r[0].kind, "codex");
        assert_eq!(r[0].count, 2);
        assert!(search(d.path(), "tide", Options::default(), &[], false).is_empty());
    }

    #[test]
    fn replace_all_snapshots_first() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", "Tide and tide and riptide.").unwrap();
        write_scene(d.path(), "s2", "No match.").unwrap();
        let n = replace_all(d.path(), "tide", "sea", Options { whole_word: true, ..Default::default() }, &["s1".into(), "s2".into()]).unwrap();
        assert_eq!(n, 2);
        assert_eq!(read_scene(d.path(), "s1").unwrap(), "sea and sea and riptide.");
        let snaps = snapshots::list(d.path());
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].scene_ids, vec!["s1".to_string()]);
        assert_eq!(snapshots::read(d.path(), &snaps[0].id, "s1").unwrap(), "Tide and tide and riptide.");
        assert_eq!(replace_all(d.path(), "zzz", "y", Options::default(), &["s1".into()]).unwrap(), 0);
        assert_eq!(snapshots::list(d.path()).len(), 1);
    }
}
