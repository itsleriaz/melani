// SPDX-License-Identifier: GPL-3.0-only
//! Mention matching: finds codex names and aliases in text.
//!
//! Terms are case- and diacritic-folded and matched with an Aho-Corasick automaton. Each
//! candidate is then checked against the original text (word boundaries, possessives,
//! case-sensitive entries). Overlaps resolve longest-first. A term shared by several entries
//! yields one match listing all of them, flagged ambiguous.
use crate::codex::CodexEntry;
use aho_corasick::{AhoCorasick, MatchKind};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

struct Owner {
    entry: usize,
    term: String,
    case_sensitive: bool,
    whole_word: bool,
}

pub struct MentionIndex {
    ac: Option<AhoCorasick>,
    owners: Vec<Vec<Owner>>,
    ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Mention {
    /// UTF-16 code unit offsets into the scanned text (what JavaScript uses).
    pub start: usize,
    pub end: usize,
    /// Entry ids matching this span. More than one means ambiguous.
    pub entries: Vec<String>,
    pub ambiguous: bool,
    /// The text as written, e.g. "Diane's" is reported as "Diane".
    pub text: String,
}

/// Lowercase and strip diacritics. `map[i]` is the byte offset in `text` of the character
/// that produced folded byte `i`; `map[folded.len()]` is `text.len()`.
fn fold(text: &str) -> (String, Vec<usize>) {
    let mut out = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len() + 1);
    for (i, c) in text.char_indices() {
        for lc in c.to_lowercase() {
            for d in std::iter::once(lc).nfd() {
                if is_combining_mark(d) {
                    continue;
                }
                let before = out.len();
                out.push(d);
                for _ in before..out.len() {
                    map.push(i);
                }
            }
        }
    }
    map.push(text.len());
    (out, map)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_apostrophe(c: char) -> bool {
    c == '\'' || c == '\u{2019}'
}

/// Word-boundary check on the original text, allowing a trailing possessive ('s or s').
fn boundary_ok(text: &str, s: usize, e: usize) -> bool {
    if text[..s].chars().next_back().is_some_and(is_word) {
        return false;
    }
    let mut after = text[e..].chars();
    match after.next() {
        None => true,
        Some(c) if is_word(c) => false,
        Some(c) if is_apostrophe(c) => match after.next() {
            None => true,
            Some(n) if n == 's' || n == 'S' => !after.next().is_some_and(is_word),
            Some(n) => !is_word(n),
        },
        Some(_) => true,
    }
}

impl MentionIndex {
    pub fn build(entries: &[CodexEntry]) -> Self {
        let mut pattern_of: HashMap<String, usize> = HashMap::new();
        let mut patterns: Vec<String> = vec![];
        let mut owners: Vec<Vec<Owner>> = vec![];
        for (ei, e) in entries.iter().enumerate() {
            let ignored: Vec<String> = e.match_options.ignore.iter().map(|t| fold(t.trim()).0).collect();
            let names = std::iter::once(&e.name).chain(e.aliases.iter());
            for term in names {
                let term = term.trim();
                let (f, _) = fold(term);
                if f.is_empty() || ignored.contains(&f) {
                    continue;
                }
                let pi = *pattern_of.entry(f.clone()).or_insert_with(|| {
                    patterns.push(f);
                    owners.push(vec![]);
                    patterns.len() - 1
                });
                if owners[pi].iter().any(|o| o.entry == ei && o.term == term) {
                    continue;
                }
                owners[pi].push(Owner { entry: ei, term: term.to_string(), case_sensitive: e.match_options.case_sensitive, whole_word: e.match_options.whole_word });
            }
        }
        let ac = if patterns.is_empty() { None } else { AhoCorasick::builder().match_kind(MatchKind::Standard).build(&patterns).ok() };
        Self { ac, owners, ids: entries.iter().map(|e| e.id.clone()).collect() }
    }

    pub fn scan(&self, text: &str) -> Vec<Mention> {
        let Some(ac) = &self.ac else { return vec![] };
        let (folded, map) = fold(text);

        // Candidate spans: (start, end, entry indices), in original byte offsets.
        let mut cands: Vec<(usize, usize, Vec<usize>)> = vec![];
        for m in ac.find_overlapping_iter(&folded) {
            let s = map[m.start()];
            let last = map[m.end() - 1];
            let e = last + text[last..].chars().next().map_or(0, char::len_utf8);
            let orig = &text[s..e];
            let mut hit: Vec<usize> = vec![];
            for o in &self.owners[m.pattern().as_usize()] {
                if o.case_sensitive && orig != o.term {
                    continue;
                }
                if o.whole_word && !boundary_ok(text, s, e) {
                    continue;
                }
                if !hit.contains(&o.entry) {
                    hit.push(o.entry);
                }
            }
            if !hit.is_empty() {
                cands.push((s, e, hit));
            }
        }

        // Longest match wins; ties go to the earlier one.
        cands.sort_by(|a, b| (b.1 - b.0).cmp(&(a.1 - a.0)).then(a.0.cmp(&b.0)));
        let mut picked: BTreeMap<usize, (usize, Vec<usize>)> = BTreeMap::new();
        for (s, e, hit) in cands {
            let before = picked.range(..e).next_back().is_some_and(|(_, (pe, _))| *pe > s);
            if !before {
                picked.insert(s, (e, hit));
            }
        }

        // Convert byte offsets to UTF-16 offsets in one forward pass.
        let (mut byte, mut u16pos) = (0usize, 0usize);
        let mut advance = |to: usize| -> usize {
            u16pos += text[byte..to].encode_utf16().count();
            byte = to;
            u16pos
        };
        picked
            .into_iter()
            .map(|(s, (e, hit))| {
                let (us, ue) = (advance(s), advance(e));
                let entries: Vec<String> = hit.iter().map(|&i| self.ids[i].clone()).collect();
                Mention { start: us, end: ue, ambiguous: entries.len() > 1, entries, text: text[s..e].to_string() }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::MatchOptions;

    fn entry(id: &str, name: &str, aliases: &[&str]) -> CodexEntry {
        CodexEntry {
            id: id.into(),
            name: name.into(),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            kind: "character".into(),
            tags: vec![],
            links: vec![],
            always_include: false,
            priority: 0,
            summary: String::new(),
            match_options: MatchOptions::default(),
        }
    }

    fn found(idx: &MentionIndex, text: &str) -> Vec<(String, Vec<String>)> {
        idx.scan(text).into_iter().map(|m| (m.text, m.entries)).collect()
    }

    #[test]
    fn matches_name_and_aliases_case_insensitively() {
        let idx = MentionIndex::build(&[entry("d", "Diane Marsh", &["Diane", "Mrs. Marsh", "the Widow"])]);
        let got = found(&idx, "Diane met the widow. Mrs. Marsh smiled.");
        assert_eq!(got.iter().map(|g| g.0.as_str()).collect::<Vec<_>>(), ["Diane", "the widow", "Mrs. Marsh"]);
        assert!(got.iter().all(|g| g.1 == vec!["d".to_string()]));
    }

    #[test]
    fn respects_word_boundaries() {
        let idx = MentionIndex::build(&[entry("a", "Dian", &[]), entry("m", "Mark", &[])]);
        assert!(found(&idx, "Diane went to the marketplace.").is_empty());
        assert_eq!(found(&idx, "Then Mark left, and Dian too.").len(), 2);
        assert!(found(&idx, "snark_Mark2 Markus").is_empty());
    }

    #[test]
    fn handles_possessives() {
        let idx = MentionIndex::build(&[entry("d", "Diane", &[])]);
        for t in ["Diane's coat", "Diane\u{2019}s coat", "the Dianes' coat is not it", "James and Diane' friends"] {
            let n = found(&idx, t).len();
            assert_eq!(n, if t.starts_with("the Dianes") { 0 } else { 1 }, "{t}");
        }
        assert!(found(&idx, "Diane'll go").is_empty());
    }

    #[test]
    fn longest_match_wins_and_shorter_survives_failed_boundary() {
        let idx = MentionIndex::build(&[entry("d", "Diane", &[]), entry("dm", "Diane Marsh", &[])]);
        assert_eq!(found(&idx, "Diane Marsh smiled"), vec![("Diane Marsh".into(), vec!["dm".to_string()])]);
        // "Diane Marsh" fails its boundary in "Marshall", so the shorter name still matches.
        assert_eq!(found(&idx, "Diane Marshall smiled"), vec![("Diane".into(), vec!["d".to_string()])]);
    }

    #[test]
    fn shared_term_is_ambiguous() {
        let idx = MentionIndex::build(&[entry("a1", "Anna Fox", &["Anna"]), entry("a2", "Anna Lee", &["Anna"])]);
        let m = idx.scan("Anna waved.");
        assert_eq!(m.len(), 1);
        assert!(m[0].ambiguous);
        assert_eq!(m[0].entries, vec!["a1", "a2"]);
        let m = idx.scan("Anna Lee waved.");
        assert!(!m[0].ambiguous);
        assert_eq!(m[0].entries, vec!["a2"]);
    }

    #[test]
    fn ignore_and_case_sensitive_options() {
        let mut mark = entry("m", "Marcus Hale", &["Mark", "Hale"]);
        mark.match_options.ignore = vec!["mark".into()];
        let idx = MentionIndex::build(&[mark]);
        assert!(found(&idx, "I will mark the spot.").is_empty());
        assert_eq!(found(&idx, "Hale agreed.").len(), 1);

        let mut cs = entry("w", "Will", &[]);
        cs.match_options.case_sensitive = true;
        let idx = MentionIndex::build(&[cs]);
        assert!(found(&idx, "I will go.").is_empty());
        assert_eq!(found(&idx, "Will went.").len(), 1);
    }

    #[test]
    fn folds_diacritics() {
        let idx = MentionIndex::build(&[entry("z", "Zoë", &["Jose"])]);
        assert_eq!(found(&idx, "Zoe and José and ZOË").len(), 3);
    }

    #[test]
    fn offsets_are_utf16_code_units() {
        let idx = MentionIndex::build(&[entry("d", "Diane", &[])]);
        // The emoji is 2 UTF-16 units (4 bytes in UTF-8); "é" is 1 unit (2 bytes).
        let text = "\u{1F600}é Diane!";
        let m = idx.scan(text);
        let units: Vec<u16> = text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[m[0].start..m[0].end]).unwrap(), "Diane");
    }

    #[test]
    fn empty_index_and_blank_terms() {
        assert!(MentionIndex::build(&[]).scan("anything").is_empty());
        assert!(MentionIndex::build(&[entry("x", "  ", &[""])]).scan("anything").is_empty());
    }

    /// M2 acceptance: a 300-entry codex scans a 5,000-word scene in under 50 ms.
    #[test]
    fn performance_300_entries_5000_words() {
        let entries: Vec<CodexEntry> = (0..300)
            .map(|i| entry(&format!("e{i}"), &format!("Name{i} Surname{i}"), &[&format!("Nick{i}"), &format!("the Person{i}")]))
            .collect();
        let idx = MentionIndex::build(&entries);
        let words = ["the", "rain", "fell", "on", "Nick7", "while", "Name42", "Surname42", "walked", "home", "and", "Nick250's", "dog", "barked"];
        let text: String = (0..5000).map(|i| words[i % words.len()]).collect::<Vec<_>>().join(" ");
        let t = std::time::Instant::now();
        let m = idx.scan(&text);
        let elapsed = t.elapsed();
        println!("scanned 5,000 words / 300 entries in {elapsed:?}, {} mentions", m.len());
        assert!(!m.is_empty());
        // The target applies to release builds; debug builds are several times slower.
        if !cfg!(debug_assertions) {
            assert!(elapsed.as_millis() < 50, "took {elapsed:?}");
        }
    }
}
