// SPDX-License-Identifier: GPL-3.0-only
//! Prompt templates: shipped defaults plus per-project overrides in prompts/<tool>.json.
use crate::project::{atomic_write, check_id, ProjectError};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::Path};

type Result<T> = std::result::Result<T, ProjectError>;

/// Variables a template may use.
pub const VARIABLES: [&str; 9] = ["selection", "before", "after", "scene", "chapter_synopsis", "codex", "instruction", "pov", "style_notes"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    /// Tool id: rewrite, continue, brainstorm, consistency, feedback, summary.
    pub id: String,
    pub name: String,
    pub system: String,
    pub user: String,
    /// Where the result goes: suggestion, chat, findings, comments or synopsis.
    pub output: String,
    /// True when this project has its own version of the template.
    #[serde(default)]
    pub overridden: bool,
}

fn t(id: &str, name: &str, output: &str, system: &str, user: &str) -> Template {
    Template { id: id.into(), name: name.into(), system: system.into(), user: user.into(), output: output.into(), overridden: false }
}

const AUTHOR_CONTEXT: &str = "Author's style notes (voice, tense, point of view, words to avoid):\n{{style_notes}}\n\nPoint of view: {{pov}}\n\nStory reference from the author's codex:\n{{codex}}";

pub fn defaults() -> Vec<Template> {
    vec![
        t(
            "rewrite",
            "Rewrite / expand",
            "suggestion",
            &format!("You are a skilled fiction editor inside a novel-writing app. Rewrite or expand the selected passage as the author instructs. Keep the author's voice, tense and point of view, and stay consistent with the story reference. Reply with only the new passage: no commentary, headings or surrounding quotation marks.\n\n{AUTHOR_CONTEXT}"),
            "Story so far in this chapter:\n{{chapter_synopsis}}\n\nText before the passage:\n{{before}}\n\nPassage to rewrite:\n{{selection}}\n\nText after the passage:\n{{after}}\n\nInstruction: {{instruction}}",
        ),
        t(
            "continue",
            "Continue",
            "suggestion",
            &format!("You are a skilled novelist continuing the author's draft. Write the next stretch of prose in the same voice, tense and point of view, consistent with the story reference. Reply with only the new prose: no commentary or headings, and do not repeat the existing text.\n\n{AUTHOR_CONTEXT}"),
            "Story so far in this chapter:\n{{chapter_synopsis}}\n\nContinue from the end of this text:\n{{before}}\n\nDirection from the author (may be empty): {{instruction}}",
        ),
        t(
            "brainstorm",
            "Brainstorm chat",
            "chat",
            &format!("You are a thoughtful creative writing partner helping an author plan and develop their novel. Be concrete and offer options. Respect what is already established in the story reference.\n\n{AUTHOR_CONTEXT}"),
            "Attached scene (may be empty):\n{{scene}}\n\nStory so far:\n{{chapter_synopsis}}\n\n{{instruction}}",
        ),
        t(
            "consistency",
            "Consistency check",
            "findings",
            &format!("You are a meticulous continuity editor. Compare the text with the story reference and the earlier story, and report contradictions: facts, names, ages, appearances, timeline, places, abilities. Report only real conflicts with the story reference or the earlier story, not style, and not things the text itself says on purpose (a joke, an unreliable narrator). Report at most 6, the most serious first. Keep each problem to two sentences and each fix to one. Reply with only a JSON array, no prose and no code fences. Each item: {{\"passage\": exact quote from the text (a sentence or less), \"entry\": name of the conflicting codex entry or null, \"problem\": what conflicts, \"fix\": a short suggested fix}}. Reply [] if you find none.\n\n{AUTHOR_CONTEXT}"),
            "Story so far:\n{{chapter_synopsis}}\n\nText to check:\n{{selection}}\n\nFocus (may be empty): {{instruction}}",
        ),
        t(
            "feedback",
            "Line feedback",
            "comments",
            &format!("You are an experienced fiction editor giving line-level feedback: clarity, rhythm, word choice, show-versus-tell, pacing, dialogue. Be specific and kind, and comment only where it helps: at most 10 comments, each one or two sentences. Reply with only a JSON array, no prose and no code fences. Each item: {{\"passage\": exact quote from the text, \"comment\": your feedback}}. Reply [] if the text needs nothing.\n\n{AUTHOR_CONTEXT}"),
            "Text to review:\n{{selection}}\n\nFocus (may be empty): {{instruction}}",
        ),
        t(
            "extract",
            "Codex from the book",
            "entries",
            "You are helping an author build a story bible (a codex) from their novel. Read the text and list the people, places, items, factions, events and pieces of lore that matter to the story or keep coming up. Skip one-off extras, ordinary words and generic nouns. For each: \"name\" (the fullest form used), \"type\" (one of character, place, item, faction, event, lore, other), \"aliases\" (other names, nicknames or titles the text uses for the same thing), and \"summary\" (one sentence, using only what this text says). Do not repeat anything already known. Report at most 25, the most important first. Reply with only a JSON array, no prose and no code fences: [{\"name\": ..., \"type\": ..., \"aliases\": [...], \"summary\": ...}]. Reply [] if there is nothing new.",
            "Already known (do not repeat):\n{{codex}}\n\nText:\n{{selection}}",
        ),
        t(
            "extract_check",
            "Check the scan's names",
            "entries",
            "You are checking names that a simple scan pulled out of a novel. For each candidate decide whether it is a real story-bible entry: a named character, place, faction, item, event or piece of lore. Say no to contractions and fragments (I'll, I'd, Don't), ordinary words, sentence openers, interjections, titles on their own and anything generic. Reply with only a JSON array with one item per candidate, in the same order: {\"name\": the candidate exactly as given, \"keep\": true or false, \"type\": one of character, place, item, faction, event, lore, other}. No prose and no code fences.",
            "Candidates (name, then an example from the text):\n{{selection}}",
        ),
        t(
            "summary",
            "Scene summary",
            "synopsis",
            "You summarize scenes from a novel for the author's own index cards. Write 2 to 3 sentences in the present tense covering who is involved, what happens and what changes. Reply with only the summary.",
            "Scene:\n{{selection}}",
        ),
    ]
}

/// Every `{{name}}` in `text` as (start, end, name), in order.
fn scan(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = vec![];
    let mut from = 0;
    while let Some(i) = text[from..].find("{{") {
        let start = from + i;
        let Some(j) = text[start + 2..].find("}}") else { break };
        let end = start + 2 + j + 2;
        let name = text[start + 2..end - 2].trim();
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            out.push((start, end, name.to_string()));
        }
        from = end;
    }
    out
}

/// Whether `text` references the variable `name`.
pub fn uses(text: &str, name: &str) -> bool {
    scan(text).iter().any(|(_, _, n)| n == name)
}

/// Variables in `text` that are not in [`VARIABLES`], without duplicates. Shown as a warning when saving.
pub fn unknown_vars(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for (_, _, n) in scan(text) {
        if !VARIABLES.contains(&n.as_str()) && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

fn fill(text: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (s, e, n) in scan(text) {
        out.push_str(&text[last..s]);
        out.push_str(vars.get(&n).map(String::as_str).unwrap_or(""));
        last = e;
    }
    out.push_str(&text[last..]);
    out
}

/// Substitute known variables; unknown ones render as empty text. Substituted values are
/// not rescanned, so text containing "{{...}}" is never expanded.
///
/// A paragraph (text between blank lines) that uses variables, all of which are empty, is left
/// out altogether, so a project with no style notes, say, does not send an empty "Style notes:" heading.
pub fn render(text: &str, vars: &HashMap<String, String>) -> String {
    let kept: Vec<String> = text
        .split("\n\n")
        .filter(|chunk| {
            let names = scan(chunk);
            names.is_empty() || names.iter().any(|(_, _, n)| vars.get(n).is_some_and(|v| !v.trim().is_empty()))
        })
        .map(|chunk| fill(chunk, vars))
        .collect();
    kept.join("\n\n").trim().to_string()
}

/// Defaults with any project overrides applied. Malformed override files are ignored.
pub fn load_all(dir: &Path) -> Vec<Template> {
    defaults()
        .into_iter()
        .map(|d| {
            let p = dir.join("prompts").join(format!("{}.json", d.id));
            match fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<Template>(&s).ok()) {
                Some(mut o) if o.id == d.id => {
                    o.overridden = true;
                    o.name = d.name;
                    o.output = d.output;
                    o
                }
                _ => d,
            }
        })
        .collect()
}

pub fn get(dir: &Path, id: &str) -> Option<Template> {
    load_all(dir).into_iter().find(|t| t.id == id)
}

pub fn save_override(dir: &Path, tpl: &Template) -> Result<()> {
    check_id(&tpl.id)?;
    if !defaults().iter().any(|d| d.id == tpl.id) {
        return Err(ProjectError::BadId(tpl.id.clone()));
    }
    fs::create_dir_all(dir.join("prompts")).map_err(|e| ProjectError::Io(dir.display().to_string(), e))?;
    let json = serde_json::to_string_pretty(tpl).expect("serializable");
    atomic_write(&dir.join("prompts").join(format!("{}.json", tpl.id)), &json)
}

pub fn reset(dir: &Path, id: &str) -> Result<()> {
    check_id(id)?;
    let _ = fs::remove_file(dir.join("prompts").join(format!("{id}.json")));
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn paragraphs_with_only_empty_variables_are_left_out() {
        let vars: HashMap<String, String> = [("a", "A text"), ("b", ""), ("c", "   ")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let tpl = "Fixed line.\n\nHeading:\n{{b}}\n\nWith both: {{a}} and {{b}}\n\nOnly blanks: {{c}} {{b}}\n\nTail.";
        assert_eq!(render(tpl, &vars), "Fixed line.\n\nWith both: A text and \n\nTail.");
        // Nothing but empty variables leaves nothing.
        assert_eq!(render("{{b}}", &vars), "");
    }

    #[test]
    fn a_project_with_no_notes_sends_no_empty_sections() {
        let vars: HashMap<String, String> = ["style_notes", "pov", "codex", "chapter_synopsis", "before", "instruction"].iter().map(|k| (k.to_string(), String::new())).chain([("selection".to_string(), "Text.".to_string())]).collect();
        for t in defaults().iter().filter(|t| t.id == "rewrite" || t.id == "consistency") {
            let sys = render(&t.system, &vars);
            assert!(!sys.contains("Author's style notes") && !sys.contains("Point of view:") && !sys.contains("Story reference from") && !sys.contains("(none)"), "{}: {sys}", t.id);
            let user = render(&t.user, &vars);
            assert!(user.contains("Text.") && !user.contains("(none)") && !user.contains("Focus"), "{}: {user}", t.id);
        }
    }

    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn renders_known_variables_and_blanks_unknown() {
        let out = render("A {{selection}} B {{ instruction }} C {{nope}} D", &vars(&[("selection", "text"), ("instruction", "tighten")]));
        assert_eq!(out, "A text B tighten C  D");
    }

    #[test]
    fn does_not_expand_variables_inside_values() {
        let out = render("{{selection}}", &vars(&[("selection", "{{codex}}"), ("codex", "SECRET")]));
        assert_eq!(out, "{{codex}}");
    }

    #[test]
    fn flags_unknown_variables_once() {
        assert_eq!(unknown_vars("{{selection}} {{tone}} {{tone}} {{ mood }}"), vec!["tone", "mood"]);
        assert!(unknown_vars("{ {selection} } and {{not valid!}}").is_empty());
    }

    #[test]
    fn every_default_template_uses_only_known_variables() {
        for d in defaults() {
            assert!(unknown_vars(&d.system).is_empty(), "{} system: {:?}", d.id, unknown_vars(&d.system));
            assert!(unknown_vars(&d.user).is_empty(), "{} user: {:?}", d.id, unknown_vars(&d.user));
        }
        assert_eq!(defaults().len(), 8);
    }

    #[test]
    fn project_overrides_replace_and_reset() {
        let d = tempfile::tempdir().unwrap();
        assert!(!get(d.path(), "rewrite").unwrap().overridden);
        let mut mine = get(d.path(), "rewrite").unwrap();
        mine.user = "Just do: {{instruction}} to {{selection}}".into();
        save_override(d.path(), &mine).unwrap();
        let got = get(d.path(), "rewrite").unwrap();
        assert!(got.overridden);
        assert_eq!(got.user, "Just do: {{instruction}} to {{selection}}");
        reset(d.path(), "rewrite").unwrap();
        assert!(!get(d.path(), "rewrite").unwrap().overridden);
        // Unknown tool ids and bad ids are refused; malformed files fall back to the default.
        let mut bad = mine.clone();
        bad.id = "../x".into();
        assert!(save_override(d.path(), &bad).is_err());
        bad.id = "custom".into();
        assert!(save_override(d.path(), &bad).is_err());
        fs::create_dir_all(d.path().join("prompts")).unwrap();
        fs::write(d.path().join("prompts/continue.json"), "{ broken").unwrap();
        assert!(!get(d.path(), "continue").unwrap().overridden);
    }
}
