// SPDX-License-Identifier: GPL-3.0-only
//! Whole-project backups: .app/backups/backup-<unix ms>.zip
//!
//! Snapshots protect one scene from one bad change. A backup protects the whole project from a damaged
//! folder or a sync tool gone wrong: the manuscript, codex, prompts, research notes and the project's own
//! files, as one zip you can open with any tool. One is taken when a project opens if the last is old
//! enough, the newest few are kept, and restoring always writes a new folder next to the project, never
//! over it.
use crate::project::ProjectError;
use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, ProjectError>;

/// A new backup is taken on open when the newest is older than this.
const DUE_AFTER_MS: u64 = 20 * 60 * 60 * 1000;
/// How many backups are kept.
pub const KEEP: usize = 14;
/// Folders that go into a backup, and the largest single file taken (a stray video does not belong here).
const FOLDERS: [&str; 4] = ["manuscript", "codex", "prompts", "research"];
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// The file name, which is what the other commands take.
    pub name: String,
    pub created_at: u64,
    pub size: u64,
}

fn io<T>(p: &Path, r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| ProjectError::Io(p.display().to_string(), e))
}

fn backups_dir(dir: &Path) -> PathBuf {
    dir.join(".app").join("backups")
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn name_for(ms: u64) -> String {
    format!("backup-{ms}.zip")
}

fn ms_from(name: &str) -> Option<u64> {
    name.strip_prefix("backup-")?.strip_suffix(".zip")?.parse().ok()
}

/// Newest first. Anything in the folder that is not one of ours is ignored.
pub fn list(dir: &Path) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = vec![];
    let Ok(rd) = fs::read_dir(backups_dir(dir)) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let (Some(created_at), Ok(md)) = (ms_from(&name), e.metadata()) {
            out.push(BackupInfo { name, created_at, size: md.len() });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Files to include as (path inside the zip, path on disk): the project's own top-level files, then the folders.
fn collect(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_file() && !name.starts_with('.') && e.metadata().map(|m| m.len() <= MAX_FILE_BYTES).unwrap_or(false) {
                out.push((name, e.path()));
            }
        }
    }
    fn walk(base: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
        let Ok(rd) = fs::read_dir(base) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // Leftovers of an interrupted save are not part of the project.
            if name.starts_with('.') || name.ends_with(".tmp") {
                continue;
            }
            let path = e.path();
            let inner = format!("{rel}/{name}");
            if path.is_dir() {
                walk(&path, &inner, out);
            } else if e.metadata().map(|m| m.len() <= MAX_FILE_BYTES).unwrap_or(false) {
                out.push((inner, path));
            }
        }
    }
    for f in FOLDERS {
        walk(&dir.join(f), f, &mut out);
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Write a backup now, then drop the oldest beyond `KEEP`.
pub fn create_at(dir: &Path, now: u64) -> Result<BackupInfo> {
    let bd = backups_dir(dir);
    io(&bd, fs::create_dir_all(&bd))?;
    let name = name_for(now);
    let target = bd.join(&name);
    let tmp = bd.join(format!("{name}.tmp"));
    let res = (|| -> std::io::Result<()> {
        let mut z = zip::ZipWriter::new(fs::File::create(&tmp)?);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (inner, path) in collect(dir) {
            // A file that vanishes or cannot be read is skipped: a backup of the rest beats none.
            let Ok(bytes) = fs::read(&path) else { continue };
            z.start_file(inner, opts).map_err(std::io::Error::other)?;
            z.write_all(&bytes)?;
        }
        z.finish().map_err(std::io::Error::other)?.sync_all()?;
        fs::rename(&tmp, &target)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    io(&target, res)?;
    prune(dir, KEEP);
    let size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Ok(BackupInfo { name, created_at: now, size })
}

pub fn create(dir: &Path) -> Result<BackupInfo> {
    create_at(dir, now_ms())
}

/// Take a backup if the newest is old enough (or there is none). Returns it when one was taken.
pub fn create_if_due_at(dir: &Path, now: u64) -> Result<Option<BackupInfo>> {
    match list(dir).first() {
        Some(b) if now.saturating_sub(b.created_at) < DUE_AFTER_MS => Ok(None),
        _ => create_at(dir, now).map(Some),
    }
}

pub fn create_if_due(dir: &Path) -> Result<Option<BackupInfo>> {
    create_if_due_at(dir, now_ms())
}

/// Keep the newest `keep` backups.
fn prune(dir: &Path, keep: usize) {
    for b in list(dir).into_iter().skip(keep) {
        let _ = fs::remove_file(backups_dir(dir).join(b.name));
    }
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((yoe + era * 400) + i64::from(m <= 2), m, d)
}

/// "2026-11-20 14.05" (UTC): safe in a folder name on every platform.
fn stamp(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02} {:02}.{:02}", rem / 3600, rem % 3600 / 60)
}

/// Unpack a backup into a new folder next to the project and return its path. The project itself is never touched.
pub fn restore_copy(dir: &Path, name: &str) -> Result<PathBuf> {
    let ms = ms_from(name).ok_or_else(|| ProjectError::BadId(name.into()))?;
    let src = backups_dir(dir).join(name);
    let bytes = io(&src, fs::read(&src))?;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| ProjectError::Io(src.display().to_string(), std::io::Error::other(e)))?;
    let parent = dir.parent().unwrap_or(dir);
    let title = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Project".into());
    let base = format!("{title} (backup {})", stamp(ms));
    let mut target = parent.join(&base);
    let mut n = 2;
    while target.exists() {
        target = parent.join(format!("{base} {n}"));
        n += 1;
    }
    io(&target, fs::create_dir_all(&target))?;
    let res = (|| -> std::io::Result<()> {
        for i in 0..z.len() {
            let mut f = z.by_index(i).map_err(std::io::Error::other)?;
            // A name that climbs out of the folder (or is absolute) is refused, not followed.
            let Some(rel) = f.enclosed_name() else { return Err(std::io::Error::other("unsafe path in backup")) };
            if f.is_dir() {
                continue;
            }
            let out = target.join(rel);
            if let Some(p) = out.parent() {
                fs::create_dir_all(p)?;
            }
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            fs::write(&out, buf)?;
        }
        Ok(())
    })();
    if let Err(e) = res {
        let _ = fs::remove_dir_all(&target);
        return Err(ProjectError::Io(target.display().to_string(), e));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{create_project, open_project, read_scene, write_scene};

    fn project() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("My Novel");
        fs::create_dir_all(&dir).unwrap();
        create_project(&dir, "My Novel").unwrap();
        write_scene(&dir, "s1", "The ferry left at dawn.").unwrap();
        fs::create_dir_all(dir.join("codex")).unwrap();
        fs::write(dir.join("codex/diane.md"), "Diane is proud.").unwrap();
        (t, dir)
    }

    fn names(dir: &Path, b: &BackupInfo) -> Vec<String> {
        let bytes = fs::read(backups_dir(dir).join(&b.name)).unwrap();
        let z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut v: Vec<String> = z.file_names().map(String::from).collect();
        v.sort();
        v
    }

    #[test]
    fn a_backup_holds_the_project_and_leaves_out_app_state_and_snapshots() {
        let (_t, dir) = project();
        fs::create_dir_all(dir.join("snapshots/x")).unwrap();
        fs::write(dir.join("snapshots/x/s1.md"), "old").unwrap();
        fs::write(dir.join("manuscript/s1.md.tmp"), "half").unwrap();
        let b = create_at(&dir, 1_000).unwrap();
        let n = names(&dir, &b);
        assert!(n.contains(&"project.json".to_string()) && n.contains(&"binder.json".to_string()));
        assert!(n.contains(&"manuscript/s1.md".to_string()) && n.contains(&"codex/diane.md".to_string()));
        assert!(!n.iter().any(|f| f.starts_with("snapshots") || f.starts_with(".app") || f.ends_with(".tmp")), "{n:?}");
    }

    #[test]
    fn one_backup_per_day_unless_asked() {
        let (_t, dir) = project();
        let day = 24 * 60 * 60 * 1000;
        assert!(create_if_due_at(&dir, 5 * day).unwrap().is_some());
        assert!(create_if_due_at(&dir, 5 * day + 60_000).unwrap().is_none());
        assert!(create_if_due_at(&dir, 5 * day + 19 * 60 * 60 * 1000).unwrap().is_none());
        assert!(create_if_due_at(&dir, 6 * day + 1000).unwrap().is_some());
        assert_eq!(list(&dir).len(), 2);
        // Asking for one always makes one.
        create_at(&dir, 6 * day + 2000).unwrap();
        assert_eq!(list(&dir).len(), 3);
    }

    #[test]
    fn only_the_newest_are_kept() {
        let (_t, dir) = project();
        for i in 0..(KEEP as u64 + 4) {
            create_at(&dir, 1_000 + i).unwrap();
        }
        let l = list(&dir);
        assert_eq!(l.len(), KEEP);
        assert_eq!(l[0].created_at, 1_000 + KEEP as u64 + 3);
        assert_eq!(l.last().unwrap().created_at, 1_000 + 4);
    }

    #[test]
    fn restoring_makes_a_new_openable_folder_and_leaves_the_project_alone() {
        let (t, dir) = project();
        let b = create_at(&dir, 1_700_000_000_000).unwrap();
        write_scene(&dir, "s1", "Changed afterwards.").unwrap();
        let copy = restore_copy(&dir, &b.name).unwrap();
        assert_eq!(copy.parent().unwrap(), t.path());
        assert_eq!(copy.file_name().unwrap().to_string_lossy(), "My Novel (backup 2023-11-14 22.13)");
        assert_eq!(read_scene(&copy, "s1").unwrap(), "The ferry left at dawn.");
        assert_eq!(fs::read_to_string(copy.join("codex/diane.md")).unwrap(), "Diane is proud.");
        assert!(open_project(&copy).is_ok());
        assert_eq!(read_scene(&dir, "s1").unwrap(), "Changed afterwards.");
        // Restoring twice does not overwrite the first copy.
        let again = restore_copy(&dir, &b.name).unwrap();
        assert_ne!(again, copy);
    }

    #[test]
    fn a_backup_that_tries_to_escape_the_folder_is_refused() {
        let (t, dir) = project();
        let bd = backups_dir(&dir);
        fs::create_dir_all(&bd).unwrap();
        let mut z = zip::ZipWriter::new(fs::File::create(bd.join("backup-5.zip")).unwrap());
        z.start_file("../evil.txt", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"x").unwrap();
        z.finish().unwrap();
        assert!(restore_copy(&dir, "backup-5.zip").is_err());
        assert!(!t.path().join("evil.txt").exists());
        // Nothing half-made is left behind either.
        assert_eq!(fs::read_dir(t.path()).unwrap().count(), 1);
    }

    #[test]
    fn bad_names_and_strangers_in_the_folder_are_ignored() {
        let (_t, dir) = project();
        create_at(&dir, 10).unwrap();
        fs::write(backups_dir(&dir).join("notes.txt"), "hi").unwrap();
        assert_eq!(list(&dir).len(), 1);
        assert!(restore_copy(&dir, "../backup-10.zip").is_err());
        assert!(restore_copy(&dir, "backup-999.zip").is_err());
    }

    #[test]
    fn dates_in_folder_names_are_right() {
        assert_eq!(stamp(0), "1970-01-01 00.00");
        assert_eq!(stamp(1_709_164_800_000 + 3_660_000), "2024-02-29 01.01"); // a leap day
    }
}
