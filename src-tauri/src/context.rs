// SPDX-License-Identifier: GPL-3.0-only
//! Context builder: decides which codex entries and story context the model sees, and fits
//! them to the model's token budget. Pure over its inputs plus files read from the project.
use crate::codex::{self, CodexEntry};
use crate::mentions::MentionIndex;
use crate::project::{read_scene, Binder, BinderNode, NodeType};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Rough token estimate (no tokenizer is bundled): the larger of chars/4 and words*4/3.
/// Exact counts come back from OpenRouter after each call.
pub fn estimate_tokens(text: &str) -> usize {
    let chars = text.chars().count();
    let words = text.split_whitespace().count();
    ((chars + 3) / 4).max(words * 4 / 3)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    /// entry, style, scene, chapter_synopsis or summary.
    pub kind: String,
    /// Stable id used for toggling: an entry id, "style", "scene:<id>", "chapter", "summary:<id>".
    pub id: String,
    pub title: String,
    /// Why this item is here, e.g. `matched alias "the Widow"`.
    pub reason: String,
    /// "full" or "summary" (an entry that did not fit full-size).
    pub level: String,
    pub tokens: usize,
    pub included: bool,
    pub text: String,
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuiltContext {
    pub items: Vec<ContextItem>,
    pub used_tokens: usize,
    pub budget: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BuildParams {
    /// Scene the request is about, for chapter and earlier-scene context.
    pub scene_id: Option<String>,
    /// Text scanned for codex mentions (selection, scene or text before the cursor).
    pub target_text: String,
    /// Tokens available for context.
    pub budget: usize,
    pub pinned: HashSet<String>,
    pub excluded: HashSet<String>,
    pub style_notes: String,
    /// Add the current scene's full text (only when the template uses it).
    pub include_scene: bool,
    /// Entries and scenes the user attached (brainstorm chat).
    pub attach_entries: Vec<String>,
    pub attach_scenes: Vec<String>,
}

struct Cand {
    kind: &'static str,
    id: String,
    title: String,
    reason: String,
    priority: i64,
    full: String,
    short: Option<String>,
}

const PIN_BOOST: i64 = 100_000;

fn fit(mut cands: Vec<Cand>, budget: usize, pinned: &HashSet<String>, excluded: &HashSet<String>) -> BuiltContext {
    for c in &mut cands {
        if pinned.contains(&c.id) {
            c.priority += PIN_BOOST;
        }
    }
    cands.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.id.cmp(&b.id)));
    let mut remaining = budget;
    let mut used = 0;
    let mut items = vec![];
    for c in cands {
        let mut item = ContextItem { kind: c.kind.into(), id: c.id.clone(), title: c.title, reason: c.reason, level: "full".into(), tokens: 0, included: false, text: c.full.clone(), priority: c.priority };
        let full_t = estimate_tokens(&c.full);
        if excluded.contains(&c.id) {
            item.tokens = full_t;
            item.reason.push_str(" (turned off)");
        } else if pinned.contains(&c.id) || full_t <= remaining {
            item.tokens = full_t;
            item.included = true;
        } else if let Some(short) = c.short.as_ref().filter(|s| estimate_tokens(s) <= remaining) {
            item.tokens = estimate_tokens(short);
            item.text = short.clone();
            item.level = "summary".into();
            item.included = true;
        } else {
            item.tokens = full_t;
            item.reason.push_str(" (left out: over budget)");
        }
        if item.included {
            remaining = remaining.saturating_sub(item.tokens);
            used += item.tokens;
        }
        items.push(item);
    }
    BuiltContext { items, used_tokens: used, budget }
}

fn entry_texts(dir: &Path, e: &CodexEntry) -> (String, Option<String>) {
    let body = codex::read_body(dir, &e.id).unwrap_or_default();
    let mut head = format!("{} ({})", e.name, e.kind);
    if !e.aliases.is_empty() {
        head.push_str(&format!("\nAliases: {}", e.aliases.join(", ")));
    }
    let detail = if body.trim().is_empty() { e.summary.trim().to_string() } else { body.trim().to_string() };
    let full = if detail.is_empty() { head } else { format!("{head}\n{detail}") };
    let short_src = if !e.summary.trim().is_empty() { e.summary.trim().to_string() } else { body.trim().chars().take(300).collect() };
    let short = (!short_src.is_empty()).then(|| format!("{} ({}): {}", e.name, e.kind, short_src));
    (full, short)
}

/// Text-bearing nodes in manuscript order, skipping the trash.
fn leaves(nodes: &[BinderNode]) -> Vec<&BinderNode> {
    let mut out = vec![];
    for n in nodes {
        match n.kind {
            NodeType::Trash => {}
            NodeType::Scene | NodeType::Note => out.push(n),
            _ => out.extend(leaves(&n.children)),
        }
    }
    out
}

fn find<'a>(nodes: &'a [BinderNode], id: &str) -> Option<&'a BinderNode> {
    nodes.iter().find_map(|n| if n.id == id { Some(n) } else { find(&n.children, id) })
}

fn parent_of<'a>(nodes: &'a [BinderNode], id: &str) -> Option<&'a BinderNode> {
    nodes.iter().find_map(|n| if n.children.iter().any(|c| c.id == id) { Some(n) } else { parent_of(&n.children, id) })
}

pub fn build(dir: &Path, p: &BuildParams, index: &MentionIndex, entries: &[CodexEntry], binder: &Binder) -> BuiltContext {
    let by_id: HashMap<&str, &CodexEntry> = entries.iter().map(|e| (e.id.as_str(), e)).collect();
    // Best role per entry: (priority, reason).
    let mut roles: HashMap<String, (i64, String)> = HashMap::new();
    let mut set = |id: &str, prio: i64, reason: String| {
        if roles.get(id).map_or(true, |(p, _)| prio > *p) {
            roles.insert(id.to_string(), (prio, reason));
        }
    };

    // 2. Entries named in the target text.
    let mut direct: Vec<String> = vec![];
    for m in index.scan(&p.target_text) {
        for id in &m.entries {
            let Some(e) = by_id.get(id.as_str()) else { continue };
            let how = if m.text.to_lowercase() == e.name.to_lowercase() { "name" } else { "alias" };
            let reason = if m.ambiguous { format!("ambiguous match \"{}\" (could be {} entries)", m.text, m.entries.len()) } else { format!("matched {how} \"{}\"", m.text) };
            set(id, 3000 + e.priority as i64, reason);
            if !direct.contains(id) {
                direct.push(id.clone());
            }
        }
    }
    // 3. Entries linked to matched ones, at lower priority.
    for id in &direct {
        let e = by_id[id.as_str()];
        for l in &e.links {
            if let Some(t) = by_id.get(l.id.as_str()) {
                let rel = l.relation.as_deref().map(|r| format!(": {r}")).unwrap_or_default();
                set(&t.id, 1000 + t.priority as i64, format!("linked from {}{rel}", e.name));
            }
        }
    }
    // 4. Always-include entries and anything the user attached.
    for e in entries.iter().filter(|e| e.always_include) {
        set(&e.id, 5000 + e.priority as i64, "always included".into());
    }
    for id in &p.attach_entries {
        if let Some(e) = by_id.get(id.as_str()) {
            set(&e.id, 4000 + e.priority as i64, "attached by you".into());
        }
    }

    let mut cands: Vec<Cand> = vec![];
    for (id, (priority, reason)) in roles {
        let e = by_id[id.as_str()];
        let (full, short) = entry_texts(dir, e);
        cands.push(Cand { kind: "entry", id, title: e.name.clone(), reason, priority, full, short });
    }
    if !p.style_notes.trim().is_empty() {
        cands.push(Cand { kind: "style", id: "style".into(), title: "Style notes".into(), reason: "project style guide".into(), priority: 6000, full: p.style_notes.trim().into(), short: None });
    }

    // 5. Surrounding story: current scene, chapter synopsis, earlier scene summaries.
    let nodes = &binder.nodes;
    if let Some(sid) = &p.scene_id {
        if p.include_scene {
            let title = find(nodes, sid).map(|n| n.title.clone()).unwrap_or_else(|| "Current scene".into());
            let text = read_scene(dir, sid).unwrap_or_default();
            if !text.trim().is_empty() {
                cands.push(Cand { kind: "scene", id: format!("scene:{sid}"), title, reason: "current scene".into(), priority: 900, full: text, short: None });
            }
        }
        if let Some(ch) = parent_of(nodes, sid).filter(|c| matches!(c.kind, NodeType::Chapter) && !c.synopsis.trim().is_empty()) {
            cands.push(Cand { kind: "chapter_synopsis", id: "chapter".into(), title: ch.title.clone(), reason: "chapter synopsis".into(), priority: 800, full: ch.synopsis.trim().into(), short: None });
        }
        let all = leaves(nodes);
        if let Some(pos) = all.iter().position(|n| &n.id == sid) {
            for (i, n) in all[..pos].iter().rev().filter(|n| !n.synopsis.trim().is_empty()).take(12).enumerate() {
                cands.push(Cand { kind: "summary", id: format!("summary:{}", n.id), title: n.title.clone(), reason: "earlier scene summary".into(), priority: 700 - i as i64, full: n.synopsis.trim().into(), short: None });
            }
        }
    }
    for sid in &p.attach_scenes {
        if let Some(n) = find(nodes, sid) {
            let text = read_scene(dir, sid).unwrap_or_default();
            cands.push(Cand { kind: "scene", id: format!("scene:{sid}"), title: n.title.clone(), reason: "attached by you".into(), priority: 4000, full: text, short: None });
        }
    }

    fit(cands, p.budget, &p.pinned, &p.excluded)
}

/// Template variables from a built context plus the request's own text.
pub fn variables(ctx: &BuiltContext, style_notes: &str, pov: &str, selection: &str, before: &str, after: &str, instruction: &str) -> HashMap<String, String> {
    let included = |kind: &str| ctx.items.iter().filter(move |i| i.included && i.kind == kind).collect::<Vec<_>>();
    let codex = included("entry").iter().map(|i| i.text.as_str()).collect::<Vec<_>>().join("\n\n");
    let mut story = String::new();
    for i in included("chapter_synopsis") {
        story.push_str(&i.text);
    }
    let summaries = included("summary");
    if !summaries.is_empty() {
        if !story.is_empty() {
            story.push_str("\n\n");
        }
        story.push_str("Earlier scenes:\n");
        // Oldest first reads naturally; items are ordered most recent first.
        for i in summaries.iter().rev() {
            story.push_str(&format!("- {}: {}\n", i.title, i.text));
        }
    }
    let scene = included("scene").iter().map(|i| i.text.as_str()).collect::<Vec<_>>().join("\n\n");
    let v = |s: &str| s.to_string();
    HashMap::from([
        (v("codex"), codex),
        (v("chapter_synopsis"), story.trim_end().to_string()),
        (v("scene"), scene),
        (v("style_notes"), style_notes.trim().to_string()),
        (v("pov"), pov.trim().to_string()),
        (v("selection"), v(selection)),
        (v("before"), v(before)),
        (v("after"), v(after)),
        (v("instruction"), instruction.trim().to_string()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::{save_entry, Link, MatchOptions};

    fn entry(id: &str, name: &str, aliases: &[&str], summary: &str) -> CodexEntry {
        CodexEntry {
            id: id.into(),
            name: name.into(),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            kind: "character".into(),
            tags: vec![],
            links: vec![],
            always_include: false,
            priority: 0,
            summary: summary.into(),
            match_options: MatchOptions::default(),
        }
    }

    fn node(id: &str, kind: NodeType, title: &str, synopsis: &str, children: Vec<BinderNode>) -> BinderNode {
        BinderNode { id: id.into(), kind, title: title.into(), status: "draft".into(), label: None, synopsis: synopsis.into(), include_in_export: true, keywords: vec![], fields: Default::default(), children }
    }

    struct World {
        dir: tempfile::TempDir,
        entries: Vec<CodexEntry>,
        binder: Binder,
    }

    fn world() -> World {
        let dir = tempfile::tempdir().unwrap();
        let mut diane = entry("diane", "Diane Marsh", &["Diane", "the Widow"], "A widow in her sixties.");
        diane.links = vec![Link { id: "sister".into(), relation: Some("sister of".into()) }, Link { id: "house".into(), relation: None }];
        let mut house = entry("house", "Marsh House", &[], "The family home by the sea.");
        house.kind = "place".into();
        let mut king = entry("king", "The Order", &[], "A secret society.");
        king.always_include = true;
        let entries = vec![diane, entry("sister", "Rose", &[], "Diane's younger sister."), house, king, entry("bob", "Bob", &[], "Unrelated.")];
        for e in &entries {
            save_entry(dir.path(), e, &format!("Long body about {}. {}", e.name, "More detail. ".repeat(50))).unwrap();
        }
        std::fs::create_dir_all(dir.path().join("manuscript")).unwrap();
        crate::project::write_scene(dir.path(), "s2", "Scene two full text.").unwrap();
        let binder = Binder {
            nodes: vec![
                node("c1", NodeType::Chapter, "Chapter 1", "Diane returns home.", vec![node("s1", NodeType::Scene, "Arrival", "Diane arrives in the rain.", vec![]), node("s2", NodeType::Scene, "Dinner", "", vec![])]),
                node("tr", NodeType::Trash, "Trash", "", vec![node("s9", NodeType::Scene, "Cut", "Ignore me.", vec![])]),
            ],
        };
        World { dir, entries, binder }
    }

    fn run(w: &World, p: &BuildParams) -> BuiltContext {
        build(w.dir.path(), p, &MentionIndex::build(&w.entries), &w.entries, &w.binder)
    }

    fn get<'a>(c: &'a BuiltContext, id: &str) -> &'a ContextItem {
        c.items.iter().find(|i| i.id == id).unwrap_or_else(|| panic!("no item {id}"))
    }

    #[test]
    fn a_name_in_the_text_pulls_in_the_entry_with_the_reason() {
        let w = world();
        let c = run(&w, &BuildParams { target_text: "The Widow watched the rain.".into(), budget: 10_000, ..Default::default() });
        let d = get(&c, "diane");
        assert!(d.included);
        assert_eq!(d.reason, "matched alias \"The Widow\"");
        assert!(d.text.contains("Diane Marsh") && d.text.contains("Aliases:"));
        assert!(c.items.iter().all(|i| i.id != "bob"), "unrelated entries stay out");
        let c = run(&w, &BuildParams { target_text: "Diane Marsh sighed.".into(), budget: 10_000, ..Default::default() });
        assert_eq!(get(&c, "diane").reason, "matched name \"Diane Marsh\"");
    }

    #[test]
    fn linked_and_always_included_entries_come_in_at_the_right_priority() {
        let w = world();
        let c = run(&w, &BuildParams { target_text: "Diane sat down.".into(), budget: 10_000, ..Default::default() });
        assert_eq!(get(&c, "sister").reason, "linked from Diane Marsh: sister of");
        assert_eq!(get(&c, "house").reason, "linked from Diane Marsh");
        assert_eq!(get(&c, "king").reason, "always included");
        let p = |id: &str| get(&c, id).priority;
        assert!(p("king") > p("diane") && p("diane") > p("sister"));
        // Always-included entries appear even when nothing is matched.
        let c = run(&w, &BuildParams { target_text: "Nothing named here.".into(), budget: 10_000, ..Default::default() });
        assert_eq!(c.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["king"]);
    }

    #[test]
    fn tight_budgets_fall_back_to_summaries_then_drop_lowest_priority() {
        let w = world();
        let big = BuildParams { target_text: "Diane sat down.".into(), budget: 100_000, ..Default::default() };
        let full = run(&w, &big);
        let full_diane = get(&full, "diane").tokens;
        assert!(full_diane > 100);

        // Room for summaries but not full bodies.
        let c = run(&w, &BuildParams { budget: 120, ..big.clone() });
        let d = get(&c, "diane");
        assert!(d.included && d.level == "summary", "{d:?}");
        assert!(d.text.contains("A widow in her sixties."));
        assert!(c.used_tokens <= 120);

        // Almost no room: highest priority (always-included, then the matched entry) survive.
        let c = run(&w, &BuildParams { budget: 25, ..big.clone() });
        assert!(c.used_tokens <= 25);
        assert!(get(&c, "king").included);
        let dropped = c.items.iter().filter(|i| !i.included).collect::<Vec<_>>();
        assert!(!dropped.is_empty() && dropped.iter().all(|i| i.reason.ends_with("(left out: over budget)")));
        let min_kept = c.items.iter().filter(|i| i.included).map(|i| i.priority).min().unwrap();
        assert!(dropped.iter().all(|i| i.priority <= min_kept || i.tokens > 25), "lower-priority items go first");
    }

    #[test]
    fn toggles_exclude_and_pin() {
        let w = world();
        let base = BuildParams { target_text: "Diane sat down.".into(), budget: 100_000, ..Default::default() };
        let c = run(&w, &BuildParams { excluded: ["sister".to_string()].into(), ..base.clone() });
        let s = get(&c, "sister");
        assert!(!s.included && s.reason.ends_with("(turned off)"));
        // A pinned entry stays in even when it does not fit.
        let c = run(&w, &BuildParams { budget: 5, pinned: ["bob".to_string(), "diane".to_string()].into(), ..base });
        assert!(get(&c, "diane").included);
        assert!(c.items.iter().filter(|i| i.included).all(|i| i.id == "diane"), "only the pinned entry fits");
    }

    #[test]
    fn story_context_uses_the_chapter_and_earlier_scenes_but_never_the_trash() {
        let w = world();
        let p = BuildParams { target_text: "x".into(), budget: 10_000, scene_id: Some("s2".into()), include_scene: true, style_notes: "Close third, past tense.".into(), ..Default::default() };
        let c = run(&w, &p);
        assert_eq!(get(&c, "scene:s2").text, "Scene two full text.");
        assert_eq!(get(&c, "chapter").text, "Diane returns home.");
        assert_eq!(get(&c, "summary:s1").text, "Diane arrives in the rain.");
        assert!(c.items.iter().all(|i| i.id != "summary:s9"));
        assert!(get(&c, "style").included);

        let v = variables(&c, &p.style_notes, "close third", "SEL", "BEFORE", "AFTER", "tighten");
        assert!(v["chapter_synopsis"].starts_with("Diane returns home.") && v["chapter_synopsis"].contains("- Arrival: Diane arrives in the rain."));
        assert_eq!(v["scene"], "Scene two full text.");
        assert_eq!((v["selection"].as_str(), v["before"].as_str(), v["after"].as_str(), v["instruction"].as_str()), ("SEL", "BEFORE", "AFTER", "tighten"));

        // The scene is only added when the template asks for it.
        let c = run(&w, &BuildParams { include_scene: false, ..p });
        assert!(c.items.iter().all(|i| i.kind != "scene"));
    }

    #[test]
    fn attachments_and_empty_defaults() {
        let w = world();
        let c = run(&w, &BuildParams { target_text: String::new(), budget: 10_000, attach_entries: vec!["bob".into()], attach_scenes: vec!["s2".into()], ..Default::default() });
        assert_eq!(get(&c, "bob").reason, "attached by you");
        assert_eq!(get(&c, "scene:s2").reason, "attached by you");
        let empty = BuiltContext { items: vec![], used_tokens: 0, budget: 0 };
        let v = variables(&empty, "", "", "", "", "", "");
        assert_eq!((v["codex"].as_str(), v["pov"].as_str(), v["instruction"].as_str(), v["scene"].as_str()), ("", "", "", ""));
    }

    #[test]
    fn token_estimate_is_sane() {
        assert_eq!(estimate_tokens(""), 0);
        assert!(estimate_tokens("hello world") >= 2);
        let words = "word ".repeat(1000);
        assert!((1000..2000).contains(&estimate_tokens(&words)));
    }
}
