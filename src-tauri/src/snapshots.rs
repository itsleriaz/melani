// SPDX-License-Identifier: GPL-3.0-only
//! Snapshots: full copies of scene text under snapshots/<id>/, as plain files.
//!   snapshots/<id>/meta.json
//!   snapshots/<id>/<scene-id>.md
use crate::project::{atomic_write, check_id, new_id, read_binder, read_scene, write_scene, BinderNode, ProjectError};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, ProjectError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
    pub note: String,
    /// What was captured, e.g. the scene or chapter title.
    pub label: String,
    /// "scene", "chapter", "project", or "auto" (taken by the app before a restore or accept).
    pub scope: String,
    pub scene_ids: Vec<String>,
}

fn snap_dir(dir: &Path, id: &str) -> Result<PathBuf> {
    check_id(id)?;
    Ok(dir.join("snapshots").join(id))
}

fn io<T>(p: &Path, r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| ProjectError::Io(p.display().to_string(), e))
}

pub fn create(dir: &Path, scene_ids: &[String], note: &str, label: &str, scope: &str) -> Result<SnapshotMeta> {
    for s in scene_ids {
        check_id(s)?;
    }
    let id = new_id();
    let sd = snap_dir(dir, &id)?;
    io(&sd, fs::create_dir_all(&sd))?;
    for s in scene_ids {
        atomic_write(&sd.join(format!("{s}.md")), &read_scene(dir, s)?)?;
    }
    let created_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let meta = SnapshotMeta { id, created_at, note: note.into(), label: label.into(), scope: scope.into(), scene_ids: scene_ids.to_vec() };
    atomic_write(&sd.join("meta.json"), &serde_json::to_string_pretty(&meta).expect("serializable"))?;
    Ok(meta)
}

/// A save that removes this much of a scene is snapshotted first. Small scenes are left out: there is
/// little to lose, and clearing a stub is routine.
const GUARD_MIN_WORDS: usize = 30;
/// Cutting a long scene to less than half is guarded too, but at most once in this long per scene.
const GUARD_HALVING_MIN_WORDS: usize = 200;
const GUARD_COOLDOWN_MS: u64 = 10 * 60 * 1000;
const GUARD_NOTE: &str = "Automatic: before a save removed most of this scene's text";

fn words(s: &str) -> usize {
    s.split_whitespace().count()
}

/// Whether saving `new` over `old` removes enough text that the old text should be kept first.
pub fn shrinks_sharply(old: &str, new: &str) -> bool {
    let (o, n) = (words(old), words(new));
    o >= GUARD_MIN_WORDS && (n == 0 || (o >= GUARD_HALVING_MIN_WORDS && n * 2 < o))
}

fn title_of(nodes: &[BinderNode], id: &str) -> Option<String> {
    nodes.iter().find_map(|n| if n.id == id { Some(n.title.clone()) } else { title_of(&n.children, id) })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Save a scene, but first snapshot the old text if this save would wipe out most of it. That is what an
/// author does on purpose now and then, and also what a bug in the editor looks like, and the app cannot
/// tell them apart. The snapshot shows up in the Snapshots tab as automatic. A failure to snapshot does
/// not block the save: what the author typed is the truth.
pub fn write_scene_guarded(dir: &Path, id: &str, content: &str) -> Result<()> {
    check_id(id)?;
    let old = read_scene(dir, id)?;
    if shrinks_sharply(&old, content) {
        let emptied = words(content) == 0;
        // Emptying happens once per full scene, so it is always kept; halving is rate limited.
        let recent = !emptied && list(dir).iter().any(|m| m.scope == "auto" && m.note == GUARD_NOTE && m.scene_ids.iter().any(|s| s == id) && now_ms().saturating_sub(m.created_at) < GUARD_COOLDOWN_MS);
        if !recent {
            let label = read_binder(dir).ok().and_then(|b| title_of(&b.nodes, id)).unwrap_or_else(|| "Scene".into());
            let _ = create(dir, &[id.to_string()], GUARD_NOTE, &label, "auto");
        }
    }
    write_scene(dir, id, content)
}

/// Newest first. Folders without a readable meta.json are ignored.
pub fn list(dir: &Path) -> Vec<SnapshotMeta> {
    let mut out: Vec<SnapshotMeta> = vec![];
    let Ok(rd) = fs::read_dir(dir.join("snapshots")) else { return out };
    for e in rd.flatten() {
        if let Ok(s) = fs::read_to_string(e.path().join("meta.json")) {
            if let Ok(m) = serde_json::from_str::<SnapshotMeta>(&s) {
                out.push(m);
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    out
}

pub fn read(dir: &Path, snap: &str, scene: &str) -> Result<String> {
    check_id(scene)?;
    let p = snap_dir(dir, snap)?.join(format!("{scene}.md"));
    io(&p, fs::read_to_string(&p))
}

/// Restore scenes from a snapshot. The current text of those scenes is snapshotted first
/// (scope "auto") so a restore can always be undone; that snapshot is returned.
pub fn restore(dir: &Path, snap: &str, scene_ids: &[String]) -> Result<SnapshotMeta> {
    let meta: SnapshotMeta = {
        let p = snap_dir(dir, snap)?.join("meta.json");
        let s = io(&p, fs::read_to_string(&p))?;
        serde_json::from_str(&s).map_err(|e| ProjectError::Json(p.display().to_string(), e))?
    };
    for s in scene_ids {
        if !meta.scene_ids.contains(s) {
            return Err(ProjectError::BadId(s.clone()));
        }
    }
    // Read everything first so a failure cannot leave a half-restored project.
    let texts: Vec<String> = scene_ids.iter().map(|s| read(dir, snap, s)).collect::<Result<_>>()?;
    let auto = create(dir, scene_ids, "Automatic: taken before restoring a snapshot", &meta.label, "auto")?;
    for (s, t) in scene_ids.iter().zip(texts) {
        write_scene(dir, s, &t)?;
    }
    Ok(auto)
}

pub fn delete(dir: &Path, snap: &str) -> Result<()> {
    let sd = snap_dir(dir, snap)?;
    if sd.exists() {
        io(&sd, fs::remove_dir_all(&sd))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::create_project;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn create_list_read() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", "one").unwrap();
        write_scene(d.path(), "s2", "two").unwrap();
        let a = create(d.path(), &ids(&["s1"]), "first", "Scene 1", "scene").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = create(d.path(), &ids(&["s1", "s2"]), "", "Chapter", "chapter").unwrap();
        let list = list(d.path());
        assert_eq!(list.iter().map(|m| m.id.clone()).collect::<Vec<_>>(), vec![b.id.clone(), a.id.clone()]);
        assert_eq!(read(d.path(), &b.id, "s2").unwrap(), "two");
        assert!(read(d.path(), &a.id, "s2").is_err());
    }

    #[test]
    fn restore_takes_automatic_snapshot_first() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", "old text").unwrap();
        let snap = create(d.path(), &ids(&["s1"]), "", "S", "scene").unwrap();
        write_scene(d.path(), "s1", "new text").unwrap();
        let auto = restore(d.path(), &snap.id, &ids(&["s1"])).unwrap();
        assert_eq!(read_scene(d.path(), "s1").unwrap(), "old text");
        assert_eq!(auto.scope, "auto");
        // The text from before the restore is recoverable.
        assert_eq!(read(d.path(), &auto.id, "s1").unwrap(), "new text");
        // Restoring a scene the snapshot does not contain is refused and changes nothing.
        assert!(restore(d.path(), &snap.id, &ids(&["s9"])).is_err());
        assert_eq!(read_scene(d.path(), "s1").unwrap(), "old text");
    }

    #[test]
    fn delete_and_bad_ids() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        let m = create(d.path(), &[], "", "Empty", "project").unwrap();
        delete(d.path(), &m.id).unwrap();
        assert!(list(d.path()).is_empty());
        assert!(delete(d.path(), "../x").is_err());
        assert!(create(d.path(), &ids(&["../x"]), "", "", "scene").is_err());
    }

    fn text(n: usize) -> String {
        "word ".repeat(n)
    }

    #[test]
    fn emptying_a_real_scene_keeps_the_old_text() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", &text(120)).unwrap();
        write_scene_guarded(d.path(), "s1", "").unwrap();
        assert_eq!(read_scene(d.path(), "s1").unwrap(), "");
        let snaps = list(d.path());
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].scope, "auto");
        assert_eq!(read(d.path(), &snaps[0].id, "s1").unwrap(), text(120));
        // Saving again over the now empty scene adds nothing.
        write_scene_guarded(d.path(), "s1", "a bit").unwrap();
        assert_eq!(list(d.path()).len(), 1);
    }

    #[test]
    fn halving_a_long_scene_is_guarded_once_per_cooldown() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", &text(500)).unwrap();
        write_scene_guarded(d.path(), "s1", &text(200)).unwrap();
        assert_eq!(list(d.path()).len(), 1);
        write_scene(d.path(), "s1", &text(500)).unwrap();
        write_scene_guarded(d.path(), "s1", &text(100)).unwrap();
        assert_eq!(list(d.path()).len(), 1, "a second halving within the cooldown reuses the first snapshot");
    }

    #[test]
    fn ordinary_edits_and_small_scenes_are_not_snapshotted() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", &text(500)).unwrap();
        write_scene_guarded(d.path(), "s1", &text(300)).unwrap(); // cut by 40 percent
        write_scene(d.path(), "s2", &text(20)).unwrap();
        write_scene_guarded(d.path(), "s2", "").unwrap(); // a stub
        write_scene_guarded(d.path(), "s3", &text(50)).unwrap(); // a new scene
        assert!(list(d.path()).is_empty());
        assert!(!shrinks_sharply(&text(100), &text(60)));
        assert!(shrinks_sharply(&text(100), "   \n "));
    }

    #[test]
    fn the_snapshot_is_labelled_with_the_scene_title() {
        use crate::project::{save_binder, Binder};
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        let mut b: Binder = read_binder(d.path()).unwrap();
        let id = b.nodes[0].children[0].id.clone();
        b.nodes[0].children[0].title = "The Ferry".into();
        save_binder(d.path(), &b).unwrap();
        write_scene(d.path(), &id, &text(80)).unwrap();
        write_scene_guarded(d.path(), &id, "").unwrap();
        assert_eq!(list(d.path())[0].label, "The Ferry");
    }
}
