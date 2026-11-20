// SPDX-License-Identifier: GPL-3.0-only
//! Finding codex candidates in the book. A local scan (no AI, no network) looks for names:
//! capitalised words and phrases that keep turning up mid-sentence. The AI pass, driven from
//! the app, works on chunks of the book that this module cuts and prompts that it renders.
use crate::codex;
use crate::import::plain;
use crate::project::{self, BinderNode, NodeType, ProjectError};
use crate::templates;
use aho_corasick::{AhoCorasick, MatchKind};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

type Result<T> = std::result::Result<T, ProjectError>;

const STOP: &[&str] = &[
    "a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet", "if", "then", "than", "that", "this", "these", "those", "there", "here", "when", "where", "while", "what", "who", "whom", "whose", "which", "why", "how", "i", "me", "my", "mine", "myself", "we", "us", "our", "ours", "you", "your", "yours", "he", "him", "his", "himself", "she", "her", "hers", "herself", "it", "its", "itself", "they", "them", "their", "theirs", "themselves", "one", "someone", "everyone", "anyone", "nobody", "everything", "something", "nothing", "anything", "yes", "no", "not", "oh", "ah", "well", "now", "just", "still", "even", "only", "also", "again", "once", "after", "before", "because", "although", "though", "until", "since", "while", "as", "at", "by", "from", "in", "into", "of", "off", "on", "onto", "out", "over", "to", "toward", "towards", "under", "up", "upon", "with", "within", "without", "about", "above", "across", "against", "along", "among", "around", "behind", "below", "beneath", "beside", "between", "beyond", "down", "during", "inside", "near", "outside", "through", "throughout", "past", "is", "was", "are", "were", "be", "been", "being", "am", "do", "does", "did", "done", "have", "has", "had", "can", "could", "may", "might", "must", "shall", "should", "will", "would", "let", "come", "go", "get", "got", "see", "look", "all", "any", "both", "each", "every", "few", "many", "more", "most", "much", "other", "some", "such", "own", "same", "too", "very", "never", "always", "sometimes", "maybe", "perhaps", "please", "thank", "thanks", "sorry", "okay", "hello", "goodbye", "hey", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december", "chapter", "part", "book", "mr", "mrs", "ms", "miss", "dr", "sir", "madam", "lord", "lady", "god", "lord", "gods", "christmas", "morning", "evening", "night", "day", "later", "meanwhile", "suddenly", "finally", "first", "second", "third", "next", "last", "another",
];

const TITLES: &[&str] = &["mr", "mrs", "ms", "miss", "dr", "sir", "lord", "lady", "captain", "professor", "father", "mother", "aunt", "uncle", "doctor", "saint", "st", "madame", "mister", "king", "queen", "prince", "princess", "general", "colonel", "sergeant", "major", "inspector", "constable", "judge", "reverend", "brother", "sister", "master", "mistress"];
const ABBREVIATIONS: &[&str] = &["mr", "mrs", "ms", "dr", "st", "prof", "capt", "col", "gen", "sgt", "lt", "mt", "jr", "sr", "no", "vs"];
const CONNECTORS: &[&str] = &["of", "the", "de", "von", "van", "du", "la", "le", "del", "da", "di"];
const SPEECH: &[&str] = &[
    "said", "asked", "replied", "whispered", "shouted", "murmured", "answered", "smiled", "nodded", "laughed", "sighed", "frowned", "looked", "turned", "walked", "thought", "knew", "felt", "wanted", "grinned", "shrugged", "cried", "called", "muttered", "snapped", "stared", "paused", "hesitated", "stood", "sat", "ran", "told", "gasped", "wondered", "remembered", "hoped", "decided",
];
const PREPOSITIONS: &[&str] = &["in", "at", "on", "along", "down", "to", "from", "into", "near", "toward", "towards", "across", "through", "inside", "outside", "around", "beyond", "reached", "left", "entered", "visit", "visited"];
const PLACE_WORDS: &[&str] = &[
    "street", "road", "lane", "bridge", "hill", "square", "gate", "house", "hall", "tower", "castle", "inn", "tavern", "river", "lake", "sea", "mountain", "mountains", "forest", "wood", "woods", "gaol", "jail", "prison", "market", "city", "town", "village", "island", "bay", "harbour", "harbor", "court", "park", "garden", "gardens", "church", "abbey", "station", "alley", "quarter", "district", "valley", "coast", "shore", "port", "palace", "manor", "cathedral", "docks", "wharf", "fields", "marsh", "moor", "kingdom", "empire",
];
const FACTION_WORDS: &[&str] = &["guild", "order", "company", "brotherhood", "sisterhood", "council", "army", "society", "circle", "league", "house", "clan", "tribe", "watch", "legion", "fleet", "college", "church", "crown", "bank"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub aliases: Vec<String>,
    /// character, place, faction or other: a guess from how the name is used.
    pub kind: String,
    pub count: usize,
    pub scenes: usize,
    pub first_scene: String,
    pub first_title: String,
    pub examples: Vec<String>,
    pub summary: String,
}

struct Scene {
    id: String,
    title: String,
    text: String,
}

fn collect_scenes(nodes: &[BinderNode], out: &mut Vec<Scene>, dir: &Path) {
    for n in nodes {
        match n.kind {
            NodeType::Trash | NodeType::Note => {}
            NodeType::Scene => {
                let md = project::read_scene(dir, &n.id).unwrap_or_default();
                out.push(Scene { id: n.id.clone(), title: n.title.clone(), text: plain(&md) });
            }
            _ => collect_scenes(&n.children, out, dir),
        }
    }
}

fn scenes(dir: &Path) -> Result<Vec<Scene>> {
    let binder = project::read_binder(dir)?;
    let mut out = vec![];
    collect_scenes(&binder.nodes, &mut out, dir);
    Ok(out)
}

#[derive(Debug, Clone)]
struct Tok {
    text: String,
    start: usize,
    end: usize,
    cap: bool,
    /// What lies between this token and the one before it.
    gap: String,
}

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c == '\'' || c == '\u{2019}' || c == '-'
}

fn tokenize(text: &str) -> Vec<Tok> {
    let mut toks: Vec<Tok> = vec![];
    let mut gap_start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some(&(i, c)) = chars.peek() {
        if c.is_alphabetic() {
            let mut end = i;
            while let Some(&(j, d)) = chars.peek() {
                if is_word_char(d) {
                    end = j + d.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
            let raw = &text[i..end];
            let trimmed = raw.trim_matches(|c: char| c == '\'' || c == '\u{2019}' || c == '-');
            // "Wren's" is "Wren".
            let base = trimmed.strip_suffix("'s").or_else(|| trimmed.strip_suffix("\u{2019}s")).unwrap_or(trimmed);
            // Contractions are not names: "I'll" and "She'd" are "I" and "She"; "Don't" is not a name at all.
            let mut contraction = false;
            let mut base = base;
            if let Some(at) = base.find(['\'', '\u{2019}']) {
                let (pre, suf) = (&base[..at], base[at..].trim_start_matches(['\'', '\u{2019}']).to_lowercase());
                if ["ll", "d", "ve", "re", "m", "em", "s"].contains(&suf.as_str()) {
                    base = pre;
                } else if suf == "t" && pre.to_lowercase().ends_with('n') {
                    contraction = true;
                }
            }
            // "Debtors' Night": a plural possessive keeps its apostrophe.
            let plural_possessive = base.ends_with('s') && (trimmed.len() < raw.trim_matches('-').len()) && raw.trim_matches('-').ends_with(['\'', '\u{2019}']);
            let base = if plural_possessive { format!("{base}'") } else { base.to_string() };
            let base = base.as_str();
            let first = base.chars().next();
            let letters = base.chars().filter(|c| c.is_alphabetic()).count();
            let all_caps = letters > 1 && base.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());
            let cap = first.is_some_and(|c| c.is_uppercase()) && letters >= 2 && !all_caps && !contraction;
            toks.push(Tok { text: base.to_string(), start: i, end, cap, gap: text[gap_start..i].to_string() });
            gap_start = end;
        } else {
            chars.next();
        }
    }
    toks
}

/// Whether a gap before a token starts a sentence, given the token before the gap.
fn sentence_start(prev: Option<&Tok>, gap: &str) -> bool {
    let Some(prev) = prev else { return true };
    if gap.contains('\n') {
        return true;
    }
    let ends = gap.contains('.') || gap.contains('!') || gap.contains('?') || gap.contains('\u{2026}');
    let abbreviation = ABBREVIATIONS.contains(&prev.text.to_lowercase().as_str());
    let opens_quote = gap.contains('"') || gap.contains('\u{201c}') || gap.contains('\u{2018}');
    (ends && !abbreviation) || opens_quote
}

#[derive(Default, Clone)]
struct Stat {
    display: String,
    count: usize,
    scenes: BTreeSet<usize>,
    examples: Vec<String>,
    person: usize,
    place: usize,
}

fn snippet(text: &str, start: usize, end: usize) -> String {
    let mut a = start.saturating_sub(70);
    while !text.is_char_boundary(a) {
        a -= 1;
    }
    let mut b = (end + 70).min(text.len());
    while !text.is_char_boundary(b) {
        b += 1;
    }
    let s: String = text[a..b].split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{}{}", if a > 0 { "…" } else { "" }, s, if b < text.len() { "…" } else { "" })
}

fn is_title(w: &str) -> bool {
    TITLES.contains(&w.to_lowercase().as_str())
}

fn record(map: &mut HashMap<String, Stat>, key: &str, display: &str, scene: usize, snip: impl FnOnce() -> String, person: bool, place: bool) {
    let s = map.entry(key.to_string()).or_default();
    if s.display.is_empty() {
        s.display = display.to_string();
    }
    s.count += 1;
    s.scenes.insert(scene);
    if s.examples.len() < 2 {
        s.examples.push(snip());
    }
    s.person += usize::from(person);
    s.place += usize::from(place);
}

/// Find name-like phrases in the book, most mentioned first. Names the codex already has are left out.
pub fn scan(dir: &Path, min_mentions: usize) -> Result<Vec<Candidate>> {
    let scenes = scenes(dir)?;
    let mut mid: HashMap<String, Stat> = HashMap::new();
    let mut start_only: HashMap<String, Stat> = HashMap::new();
    let mut lower: HashMap<String, usize> = HashMap::new();

    for (si, scene) in scenes.iter().enumerate() {
        let toks = tokenize(&scene.text);
        for t in &toks {
            if t.text.chars().next().is_some_and(|c| c.is_lowercase()) && t.text.len() >= 2 {
                *lower.entry(t.text.to_lowercase()).or_default() += 1;
            }
        }
        let mut i = 0;
        while i < toks.len() {
            if !toks[i].cap {
                i += 1;
                continue;
            }
            let at_start = sentence_start(i.checked_sub(1).map(|p| &toks[p]), &toks[i].gap);
            // Extend over following capitalised words, and "of the"-style connectors between them.
            let mut j = i;
            while j + 1 < toks.len() && j - i < 5 {
                let next = &toks[j + 1];
                let abbreviated = ABBREVIATIONS.contains(&toks[j].text.to_lowercase().as_str());
                let joined = next.gap == " " || (abbreviated && next.gap == ". ");
                if !joined {
                    break;
                }
                if next.cap {
                    j += 1;
                    continue;
                }
                // Small words inside a name: "Order of the Ash".
                let mut k = j + 1;
                while k < toks.len() && k - j <= 2 && !toks[k].cap && CONNECTORS.contains(&toks[k].text.as_str()) && toks[k].gap == " " {
                    k += 1;
                }
                if k > j + 1 && k < toks.len() && toks[k].cap && toks[k].gap == " " {
                    j = k;
                } else {
                    break;
                }
            }
            let mut first = i;
            // Leading small words ("The Notary", "But Wren") are not part of the name.
            while first < j && STOP.contains(&toks[first].text.to_lowercase().as_str()) && !is_title(&toks[first].text) {
                first += 1;
            }
            let stripped = first > i;
            let words: Vec<&Tok> = toks[first..=j].iter().collect();
            let single = words.len() == 1;
            let only_title = words.iter().all(|w| is_title(&w.text));
            let lead_stop = single && STOP.contains(&words[0].text.to_lowercase().as_str());
            if !only_title && !lead_stop {
                let mut name = String::new();
                for (k, w) in words.iter().enumerate() {
                    if k > 0 {
                        name.push(' ');
                    }
                    name.push_str(&w.text);
                    if ABBREVIATIONS.contains(&w.text.to_lowercase().as_str()) && scene.text[w.end..].starts_with('.') {
                        name.push('.');
                    }
                }
                let key = name.to_lowercase();
                let prev1 = first.checked_sub(1).map(|p| toks[p].text.to_lowercase());
                let prev2 = first.checked_sub(2).map(|p| toks[p].text.to_lowercase());
                let next = toks.get(j + 1).map(|t| t.text.to_lowercase());
                let person = is_title(&words[0].text) || next.as_deref().is_some_and(|n| SPEECH.contains(&n));
                let place = !(at_start && !stripped) && [&prev1, &prev2].iter().any(|p| p.as_deref().is_some_and(|p| PREPOSITIONS.contains(&p)));
                let (s, e) = (words[0].start, words[words.len() - 1].end);
                let target = if single && at_start && !stripped { &mut start_only } else { &mut mid };
                record(target, &key, &name, si, || snippet(&scene.text, s, e), person, place);
            }
            i = j + 1;
        }
    }

    // A word that only ever starts sentences counts if it is also capitalised mid-sentence, or is never written in lower case.
    for (key, st) in start_only {
        let mids = mid.get(&key).map_or(0, |m| m.count);
        let low = lower.get(&key).copied().unwrap_or(0);
        if mids >= 2 || (low == 0 && st.count >= min_mentions.max(2)) {
            let m = mid.entry(key).or_default();
            if m.display.is_empty() {
                m.display = st.display.clone();
            }
            m.count += st.count;
            m.scenes.extend(st.scenes);
            for e in st.examples {
                if m.examples.len() < 2 {
                    m.examples.push(e);
                }
            }
            m.person += st.person;
            m.place += st.place;
        }
    }

    // Single words that are mostly written in lower case elsewhere are ordinary words ("Spring", "Will").
    mid.retain(|key, st| {
        if key.contains(' ') {
            return true;
        }
        if STOP.contains(&key.as_str()) {
            return false;
        }
        let low = lower.get(key).copied().unwrap_or(0) as f64;
        low <= 0.25 * st.count as f64
    });

    // A surname or first name that belongs to exactly one longer name is an alias of it.
    let multi: Vec<String> = mid.keys().filter(|k| k.contains(' ')).cloned().collect();
    let mut owner: HashMap<String, Vec<String>> = HashMap::new();
    for m in &multi {
        for part in m.split(' ') {
            let part = part.trim_end_matches('.');
            if !is_title(part) && !CONNECTORS.contains(&part) {
                owner.entry(part.to_string()).or_default().push(m.clone());
            }
        }
    }
    let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
    let singles: Vec<String> = mid.keys().filter(|k| !k.contains(' ')).cloned().collect();
    for s in singles {
        if let Some(owners) = owner.get(&s).filter(|o| o.len() == 1) {
            let st = mid.remove(&s).unwrap();
            let o = mid.get_mut(&owners[0]).unwrap();
            o.count += st.count;
            o.scenes.extend(st.scenes);
            o.person += st.person;
            o.place += st.place;
            aliases.entry(owners[0].clone()).or_default().push(st.display);
        }
    }

    let known: HashSet<String> = codex::list_entries(dir).iter().flat_map(|e| std::iter::once(e.name.to_lowercase()).chain(e.aliases.iter().map(|a| a.to_lowercase()))).collect();
    let kept: Vec<(String, Stat)> = mid
        .into_iter()
        .filter(|(key, st)| st.count >= min_mentions && !known.contains(key) && !aliases.get(key).is_some_and(|a| a.iter().any(|x| known.contains(&x.to_lowercase()))))
        .collect();
    let mut out: Vec<Candidate> = kept
        .into_iter()
        .map(|(key, st)| {
            let words: Vec<&str> = key.split(' ').collect();
            let last = words.last().copied().unwrap_or("").trim_end_matches('.');
            let kind = if FACTION_WORDS.contains(&last) && words.len() > 1 {
                "faction"
            } else if PLACE_WORDS.contains(&last) && words.len() > 1 {
                "place"
            } else if st.person >= 2 && st.person >= st.place {
                "character"
            } else if st.place >= 2 {
                "place"
            } else if st.person >= 1 {
                "character"
            } else {
                "other"
            };
            let first = st.scenes.iter().next().copied().unwrap_or(0);
            let mut al = aliases.remove(&key).unwrap_or_default();
            al.sort();
            Candidate { name: st.display, aliases: al, kind: kind.into(), count: st.count, scenes: st.scenes.len(), first_scene: scenes[first].id.clone(), first_title: scenes[first].title.clone(), examples: st.examples, summary: String::new() }
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.cmp(&b.name)));
    out.truncate(300);
    Ok(out)
}

// ---- Chunks of the book for the AI pass ---------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub index: usize,
    pub text: String,
    /// A rough count: characters over four.
    pub tokens: usize,
    pub scenes: usize,
}

/// The book's text in pieces of about `max_tokens`, cut between scenes (or paragraphs, for a very long scene).
pub fn chunks(dir: &Path, max_tokens: usize) -> Result<Vec<Chunk>> {
    let max_chars = max_tokens.max(500) * 4;
    let mut out: Vec<Chunk> = vec![];
    let mut cur = String::new();
    let mut n_scenes = 0;
    let flush = |cur: &mut String, n: &mut usize, out: &mut Vec<Chunk>| {
        if !cur.trim().is_empty() {
            out.push(Chunk { index: out.len(), tokens: cur.chars().count() / 4, text: std::mem::take(cur).trim().to_string(), scenes: *n });
        }
        cur.clear();
        *n = 0;
    };
    for s in scenes(dir)? {
        if s.text.trim().is_empty() {
            continue;
        }
        let len = s.text.chars().count();
        if len > max_chars {
            flush(&mut cur, &mut n_scenes, &mut out);
            let mut piece = String::new();
            for para in s.text.split("\n\n") {
                if piece.chars().count() + para.chars().count() > max_chars && !piece.is_empty() {
                    out.push(Chunk { index: out.len(), tokens: piece.chars().count() / 4, text: piece.trim().to_string(), scenes: 1 });
                    piece.clear();
                }
                piece.push_str(para);
                piece.push_str("\n\n");
            }
            if !piece.trim().is_empty() {
                out.push(Chunk { index: out.len(), tokens: piece.chars().count() / 4, text: piece.trim().to_string(), scenes: 1 });
            }
            continue;
        }
        if cur.chars().count() + len > max_chars {
            flush(&mut cur, &mut n_scenes, &mut out);
        }
        if !cur.is_empty() {
            cur.push_str("\n\n* * *\n\n");
        }
        cur.push_str(s.text.trim());
        n_scenes += 1;
    }
    flush(&mut cur, &mut n_scenes, &mut out);
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub system: String,
    pub user: String,
}

/// The extraction prompt for one chunk; `known` are names not to repeat.
pub fn prompt(dir: &Path, text: &str, known: &[String]) -> Result<Prompt> {
    let tpl = templates::get(dir, "extract").ok_or_else(|| ProjectError::Other("The extraction template is missing.".into()))?;
    let mut vars: HashMap<String, String> = templates::VARIABLES.iter().map(|v| (v.to_string(), String::new())).collect();
    vars.insert("selection".into(), text.to_string());
    vars.insert("codex".into(), known.iter().map(|k| format!("- {k}")).collect::<Vec<_>>().join("\n"));
    Ok(Prompt { system: templates::render(&tpl.system, &vars), user: templates::render(&tpl.user, &vars) })
}

/// The prompt that asks the model which scanned names are really entries. `lines` is one candidate per line.
pub fn check_prompt(dir: &Path, lines: &str) -> Result<Prompt> {
    let tpl = templates::get(dir, "extract_check").ok_or_else(|| ProjectError::Other("The name-check template is missing.".into()))?;
    let mut vars: HashMap<String, String> = templates::VARIABLES.iter().map(|v| (v.to_string(), String::new())).collect();
    vars.insert("selection".into(), lines.to_string());
    Ok(Prompt { system: templates::render(&tpl.system, &vars), user: templates::render(&tpl.user, &vars) })
}

// ---- Counting names in the book -----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermStats {
    pub count: usize,
    pub scenes: usize,
    pub first_scene: String,
    pub first_title: String,
}

fn boundary(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
    let after = text[end..].chars().next().is_none_or(|c| !c.is_alphanumeric());
    before && after
}

/// For each group of names (a name and its aliases), how often the book mentions them, and where first.
pub fn term_stats(dir: &Path, groups: &[Vec<String>]) -> Result<Vec<TermStats>> {
    let mut terms: Vec<String> = vec![];
    let mut owner: Vec<usize> = vec![];
    for (g, names) in groups.iter().enumerate() {
        for n in names.iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()) {
            terms.push(n);
            owner.push(g);
        }
    }
    let mut out = vec![TermStats::default(); groups.len()];
    if terms.is_empty() {
        return Ok(out);
    }
    let ac = AhoCorasick::builder().match_kind(MatchKind::LeftmostLongest).build(&terms).map_err(|e| ProjectError::Other(e.to_string()))?;
    let mut seen: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); groups.len()];
    for (si, s) in scenes(dir)?.iter().enumerate() {
        let lower = s.text.to_lowercase();
        // Lower-casing can change byte lengths for a few scripts; fall back to the original text then.
        let hay = if lower.len() == s.text.len() { &lower } else { &s.text };
        for m in ac.find_iter(hay.as_str()) {
            if !boundary(hay, m.start(), m.end()) {
                continue;
            }
            let g = owner[m.pattern().as_usize()];
            out[g].count += 1;
            if seen[g].insert(si) && out[g].first_scene.is_empty() {
                out[g].first_scene = s.id.clone();
                out[g].first_title = s.title.clone();
            }
        }
    }
    for (g, s) in seen.iter().enumerate() {
        out[g].scenes = s.len();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::{save_entry, CodexEntry, MatchOptions};
    use crate::project::{create_project, write_scene};

    fn book(texts: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("b");
        let p = create_project(&dir, "T").unwrap();
        let mut binder = p.binder.clone();
        let chapter = &mut binder.nodes[0];
        chapter.children.clear();
        for (i, t) in texts.iter().enumerate() {
            let id = format!("s{i}");
            write_scene(&dir, &id, t).unwrap();
            chapter.children.push(BinderNode { id, kind: NodeType::Scene, title: format!("Scene {}", i + 1), status: "draft".into(), label: None, synopsis: String::new(), include_in_export: true, keywords: vec![], fields: Default::default(), children: vec![] });
        }
        project::save_binder(&dir, &binder).unwrap();
        (d, dir)
    }
    fn names(c: &[Candidate]) -> Vec<&str> {
        c.iter().map(|c| c.name.as_str()).collect()
    }

    const STORY: &str = "Wren Callow climbed the stairs. \"Where is the ticket?\" Wren asked. Mrs. Hebble smiled. Hebble always smiled. The flat sat above the Glove Shop, in Gallowgate. Wren said nothing; Callow never did. She walked to Gallowgate again, then to the Gaol Road. Mrs. Hebble nodded. Spring had come. The spring rain fell. Wren knew it.";

    #[test]
    fn it_finds_people_and_places_that_keep_turning_up() {
        let (_d, dir) = book(&[STORY, "Wren waited. Mrs. Hebble laughed at Wren. In Gallowgate the bells rang. Gallowgate was loud."]);
        let c = scan(&dir, 3).unwrap();
        let n = names(&c);
        assert!(n.contains(&"Wren Callow") || n.contains(&"Wren"), "{n:?}");
        assert!(n.contains(&"Mrs. Hebble"), "{n:?}");
        assert!(n.contains(&"Gallowgate"), "{n:?}");
        // Ordinary words that only start sentences are not names, nor is "The".
        assert!(!n.contains(&"Spring") && !n.contains(&"The") && !n.contains(&"She") && !n.contains(&"Where"), "{n:?}");
    }

    #[test]
    fn a_surname_joins_the_one_longer_name_it_belongs_to() {
        let (_d, dir) = book(&[STORY, "Wren Callow again. Wren and Callow met Hebble. Mrs. Hebble waved. Mrs. Hebble left."]);
        let c = scan(&dir, 2).unwrap();
        let wren = c.iter().find(|c| c.name == "Wren Callow").expect("Wren Callow");
        assert!(wren.aliases.contains(&"Wren".to_string()) && wren.aliases.contains(&"Callow".to_string()), "{:?}", wren.aliases);
        let hebble = c.iter().find(|c| c.name == "Mrs. Hebble").expect("Mrs. Hebble");
        assert!(hebble.aliases.contains(&"Hebble".to_string()));
        assert!(!c.iter().any(|c| c.name == "Wren" || c.name == "Callow" || c.name == "Hebble"));
    }

    #[test]
    fn it_guesses_the_kind_and_says_where_each_first_appears() {
        let (_d, dir) = book(&["Quiet scene.", STORY, "Wren asked. Wren said. Wren smiled. Gallowgate again. In Gallowgate. To Gallowgate."]);
        let c = scan(&dir, 3).unwrap();
        let w = c.iter().find(|c| c.name.starts_with("Wren")).unwrap();
        assert_eq!(w.kind, "character");
        assert_eq!((w.first_scene.as_str(), w.first_title.as_str()), ("s1", "Scene 2"));
        assert!(w.scenes >= 2 && !w.examples.is_empty() && w.examples[0].contains("Wren"));
        assert_eq!(c.iter().find(|c| c.name == "Gallowgate").unwrap().kind, "place");
        assert_eq!(c.iter().find(|c| c.name == "Gaol Road").map(|c| c.kind.as_str()).unwrap_or("place"), "place");
    }

    #[test]
    fn names_already_in_the_codex_are_left_out_and_rare_ones_are_cut() {
        let (_d, dir) = book(&["Marcus ran. Marcus hid. Marcus fell. Zed came. Zed went."]);
        assert_eq!(names(&scan(&dir, 3).unwrap()), ["Marcus"]);
        let e = CodexEntry { id: "m".into(), name: "Marcus".into(), aliases: vec![], kind: "character".into(), tags: vec![], links: vec![], always_include: false, priority: 0, summary: String::new(), match_options: MatchOptions::default() };
        save_entry(&dir, &e, "").unwrap();
        assert!(scan(&dir, 3).unwrap().is_empty());
        assert_eq!(names(&scan(&dir, 2).unwrap()), ["Zed"]);
    }

    #[test]
    fn contractions_are_not_names() {
        let (_d, dir) = book(&["I'll go. I'd go. I've gone. She'd go. They're here. Don't go. Can't go. We're gone. I'll stay. I'd stay. I'll see. Don't. Don't. Can't. Marcus ran. Marcus hid. Marcus fell."]);
        assert_eq!(names(&scan(&dir, 2).unwrap()), ["Marcus"]);
        // Names with an apostrophe in them survive.
        let (_d2, dir2) = book(&["O'Neil came. O'Neil sat. O'Neil left."]);
        assert_eq!(names(&scan(&dir2, 3).unwrap()), ["O'Neil"]);
    }

    #[test]
    fn a_plural_possessive_keeps_its_apostrophe() {
        let (_d, dir) = book(&["Debtors' Night came. Debtors' Night ended. On Debtors' Night they sang."]);
        assert_eq!(names(&scan(&dir, 3).unwrap()), ["Debtors' Night"]);
    }

    #[test]
    fn multi_word_names_with_small_words_and_possessives() {
        let (_d, dir) = book(&["The Order of the Ash met. Order of the Ash again. The Order of the Ash left. Wren's hat. Wren's coat. Wren's cat."]);
        let c = scan(&dir, 3).unwrap();
        let n = names(&c);
        assert!(n.contains(&"Order of the Ash"), "{n:?}");
        assert!(n.contains(&"Wren"), "{n:?}");
    }

    #[test]
    fn chunks_split_between_scenes_and_cover_everything() {
        let long = "word ".repeat(300);
        let (_d, dir) = book(&[&long, &long, &long, "short"]);
        let c = chunks(&dir, 600).unwrap();
        assert!(c.len() >= 2 && c.iter().all(|c| c.tokens <= 700), "{:?}", c.iter().map(|c| c.tokens).collect::<Vec<_>>());
        assert_eq!(c.iter().map(|c| c.scenes).sum::<usize>(), 4);
        assert!(c.last().unwrap().text.ends_with("short"));
        // One scene longer than a chunk is cut at paragraph breaks.
        let para = "alpha beta gamma. ".repeat(80);
        let (_d2, dir2) = book(&[&format!("{para}\n\n{para}\n\n{para}")]);
        assert!(chunks(&dir2, 500).unwrap().len() >= 2);
    }

    #[test]
    fn the_prompt_lists_known_names_and_leaves_out_an_empty_list() {
        let (_d, dir) = book(&["x"]);
        let p = prompt(&dir, "The text.", &["Wren".into(), "Diane".into()]).unwrap();
        assert!(p.user.contains("- Wren\n- Diane") && p.user.contains("The text.") && p.system.contains("JSON array"));
        let q = prompt(&dir, "The text.", &[]).unwrap();
        assert!(!q.user.contains("Already known") && q.user.contains("The text."));
    }

    #[test]
    fn the_name_check_prompt_carries_the_candidates() {
        let (_d, dir) = book(&["x"]);
        let p = check_prompt(&dir, "Wren: \"Wren ran.\"\nI'll: \"I'll go.\"").unwrap();
        assert!(p.user.contains("Wren: \"Wren ran.\"") && p.user.contains("I'll") && p.system.contains("\"keep\""));
    }

    #[test]
    fn term_stats_count_whole_words_across_scenes() {
        let (_d, dir) = book(&["Wren met Diane. Wren left.", "Nothing here.", "Diane's hat; the Wrens sang. Wren."]);
        let s = term_stats(&dir, &[vec!["Wren".into(), "Miss Callow".into()], vec!["diane".into()], vec!["Nobody".into()]]).unwrap();
        assert_eq!((s[0].count, s[0].scenes, s[0].first_scene.as_str()), (3, 2, "s0"));
        assert_eq!((s[1].count, s[1].scenes, s[1].first_title.as_str()), (2, 2, "Scene 1"));
        assert_eq!(s[2], TermStats::default());
    }
}
