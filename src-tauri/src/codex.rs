// SPDX-License-Identifier: GPL-3.0-only
//! Codex (story bible) storage: codex/<id>.json (fields) + codex/<id>.md (body).
use crate::project::{atomic_write, check_id, ProjectError};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

type Result<T> = std::result::Result<T, ProjectError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    #[serde(default)]
    pub relation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    /// Match on word boundaries (default). Turn off to allow substring matches.
    #[serde(default = "yes")]
    pub whole_word: bool,
    /// Names/aliases that must never match, e.g. "Mark" the verb.
    #[serde(default)]
    pub ignore: Vec<String>,
}
fn yes() -> bool {
    true
}
impl Default for MatchOptions {
    fn default() -> Self {
        Self { case_sensitive: false, whole_word: true, ignore: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(rename = "type", default = "other")]
    pub kind: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub always_include: bool,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub match_options: MatchOptions,
}
fn other() -> String {
    "other".into()
}

/// All entries, sorted by name. Unreadable or malformed files are skipped so a bad
/// hand edit never blocks the project from opening.
pub fn list_entries(dir: &Path) -> Vec<CodexEntry> {
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(dir.join("codex")) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(s) = fs::read_to_string(&p) else { continue };
        if let Ok(entry) = serde_json::from_str::<CodexEntry>(&s) {
            if check_id(&entry.id).is_ok() {
                out.push(entry);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

pub fn read_body(dir: &Path, id: &str) -> Result<String> {
    check_id(id)?;
    let p = dir.join("codex").join(format!("{id}.md"));
    if !p.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&p).map_err(|e| ProjectError::Io(p.display().to_string(), e))
}

pub fn save_entry(dir: &Path, entry: &CodexEntry, body: &str) -> Result<()> {
    check_id(&entry.id)?;
    fs::create_dir_all(dir.join("codex")).map_err(|e| ProjectError::Io(dir.display().to_string(), e))?;
    let json = serde_json::to_string_pretty(entry).expect("serializable");
    atomic_write(&dir.join("codex").join(format!("{}.json", entry.id)), &json)?;
    atomic_write(&dir.join("codex").join(format!("{}.md", entry.id)), body)
}

pub fn delete_entry(dir: &Path, id: &str) -> Result<()> {
    check_id(id)?;
    for ext in ["json", "md"] {
        let _ = fs::remove_file(dir.join("codex").join(format!("{id}.{ext}")));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn entry(id: &str, name: &str, aliases: &[&str]) -> CodexEntry {
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

    #[test]
    fn save_list_delete() {
        let d = tempfile::tempdir().unwrap();
        save_entry(d.path(), &entry("b1", "Bea", &["B"]), "Body text").unwrap();
        save_entry(d.path(), &entry("a1", "Ann", &[]), "").unwrap();
        let list = list_entries(d.path());
        assert_eq!(list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Ann", "Bea"]);
        assert_eq!(read_body(d.path(), "b1").unwrap(), "Body text");
        // A malformed hand edit is skipped, not fatal.
        fs::write(d.path().join("codex/zz.json"), "{ not json").unwrap();
        assert_eq!(list_entries(d.path()).len(), 2);
        delete_entry(d.path(), "b1").unwrap();
        assert_eq!(list_entries(d.path()).len(), 1);
        assert!(save_entry(d.path(), &entry("../x", "X", &[]), "").is_err());
    }
}
