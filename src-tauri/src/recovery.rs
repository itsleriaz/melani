// SPDX-License-Identifier: GPL-3.0-only
//! Crash recovery journal: .app/recovery/<scene-id>.json
//!
//! The editor writes a scene's unsaved text here a fraction of a second after each
//! edit, long before the debounced autosave writes the real scene file. A clean save
//! removes the journal. Anything left on the next open that differs from the scene
//! file is text the author typed but the app never saved, and is offered back.
use crate::project::{check_id, read_scene, write_scene, ProjectError};
use crate::snapshots;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, ProjectError>;

fn io<T>(p: &Path, r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| ProjectError::Io(p.display().to_string(), e))
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    text: String,
    /// Milliseconds since the Unix epoch when the text was journaled.
    at: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recovered {
    pub id: String,
    /// The unsaved text from the journal.
    pub text: String,
    /// What the scene file holds now.
    pub disk: String,
    pub at: u64,
}

fn rec_dir(dir: &Path) -> PathBuf {
    dir.join(".app").join("recovery")
}

fn journal_path(dir: &Path, id: &str) -> Result<PathBuf> {
    check_id(id)?;
    Ok(rec_dir(dir).join(format!("{id}.json")))
}

/// Write the journal for one scene. Temp file plus rename, so a crash mid-write leaves
/// the previous journal intact. No fsync: this guards against the app dying, not the
/// OS, and it runs several times a second while typing.
pub fn write(dir: &Path, id: &str, text: &str, at: u64) -> Result<()> {
    let p = journal_path(dir, id)?;
    let rd = rec_dir(dir);
    io(&rd, fs::create_dir_all(&rd))?;
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string(&Journal { text: text.into(), at }).expect("serializable");
    let res = (|| -> std::io::Result<()> {
        fs::File::create(&tmp)?.write_all(body.as_bytes())?;
        fs::rename(&tmp, &p)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    io(&p, res)
}

pub fn clear(dir: &Path, id: &str) -> Result<()> {
    let _ = fs::remove_file(journal_path(dir, id)?);
    Ok(())
}

/// Journals whose text differs from the scene file, oldest first. Journals that match
/// the file (the save landed) or cannot be read are removed.
pub fn list(dir: &Path) -> Vec<Recovered> {
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(rec_dir(dir)) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            let _ = fs::remove_file(&p); // stray temp file from a crash mid-write
            continue;
        }
        let id = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let parsed = check_id(&id)
            .ok()
            .and_then(|_| fs::read_to_string(&p).ok())
            .and_then(|s| serde_json::from_str::<Journal>(&s).ok());
        let Some(j) = parsed else {
            let _ = fs::remove_file(&p);
            continue;
        };
        let disk = read_scene(dir, &id).unwrap_or_default();
        if disk == j.text {
            let _ = fs::remove_file(&p);
            continue;
        }
        out.push(Recovered { id, text: j.text, disk, at: j.at });
    }
    out.sort_by_key(|r| r.at);
    out
}

/// Put the journaled text back into the scene file. The current file is snapshotted
/// first so the restore can be undone from the Snapshots tab.
pub fn restore(dir: &Path, id: &str, label: &str) -> Result<()> {
    let p = journal_path(dir, id)?;
    let s = io(&p, fs::read_to_string(&p))?;
    let j: Journal = serde_json::from_str(&s).map_err(|e| ProjectError::Json(p.display().to_string(), e))?;
    snapshots::create(dir, &[id.to_string()], "Automatic: before restoring unsaved text after a crash", label, "auto")?;
    write_scene(dir, id, &j.text)?;
    clear(dir, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::create_project;

    #[test]
    fn unsaved_text_survives_and_is_offered() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", "Saved text.").unwrap();
        // Typing continues past the last autosave, then the app is killed.
        write(d.path(), "s1", "Saved text. And more", 10).unwrap();
        write(d.path(), "s1", "Saved text. And more words", 20).unwrap();
        let r = list(d.path());
        assert_eq!(r, vec![Recovered { id: "s1".into(), text: "Saved text. And more words".into(), disk: "Saved text.".into(), at: 20 }]);
        // Listing again offers it again until the author decides.
        assert_eq!(list(d.path()).len(), 1);
    }

    #[test]
    fn journal_matching_disk_is_dropped() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write(d.path(), "s1", "Same", 1).unwrap();
        write_scene(d.path(), "s1", "Same").unwrap();
        assert!(list(d.path()).is_empty());
        assert!(!d.path().join(".app/recovery/s1.json").exists());
    }

    #[test]
    fn restore_snapshots_then_writes_and_clears() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", "Old").unwrap();
        write(d.path(), "s1", "Old and new", 5).unwrap();
        restore(d.path(), "s1", "Opening scene").unwrap();
        assert_eq!(read_scene(d.path(), "s1").unwrap(), "Old and new");
        assert!(list(d.path()).is_empty());
        let snaps = snapshots::list(d.path());
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].scope, "auto");
        assert_eq!(snapshots::read(d.path(), &snaps[0].id, "s1").unwrap(), "Old");
    }

    #[test]
    fn clear_discards_and_bad_files_are_cleaned_up() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write(d.path(), "s1", "Unsaved", 1).unwrap();
        clear(d.path(), "s1").unwrap();
        assert!(list(d.path()).is_empty());
        fs::write(d.path().join(".app/recovery/s2.json"), "not json").unwrap();
        fs::write(d.path().join(".app/recovery/s3.json.tmp"), "half").unwrap();
        assert!(list(d.path()).is_empty());
        assert!(fs::read_dir(d.path().join(".app/recovery")).unwrap().next().is_none());
        assert!(write(d.path(), "../x", "t", 1).is_err());
    }
}
