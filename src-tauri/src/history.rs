// SPDX-License-Identifier: GPL-3.0-only
//! Undo history kept between sessions: .app/history/<name>.json
//!
//! `name` is a scene id, or "binder" for the binder's own history. The content is opaque to this
//! module (the editor decides what it means and whether it still applies), but it must be JSON so
//! a half-written or damaged file is noticed and ignored rather than handed back.
use crate::project::{atomic_write, check_id, ProjectError};
use std::{
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, ProjectError>;

fn history_dir(dir: &Path) -> PathBuf {
    dir.join(".app").join("history")
}

fn path(dir: &Path, name: &str) -> Result<PathBuf> {
    check_id(name)?;
    Ok(history_dir(dir).join(format!("{name}.json")))
}

pub fn write(dir: &Path, name: &str, content: &str) -> Result<()> {
    let p = path(dir, name)?;
    serde_json::from_str::<serde_json::Value>(content).map_err(|e| ProjectError::Json(p.display().to_string(), e))?;
    let hd = history_dir(dir);
    fs::create_dir_all(&hd).map_err(|e| ProjectError::Io(hd.display().to_string(), e))?;
    atomic_write(&p, content)
}

/// The saved history, or "" when there is none or the file is not valid JSON.
pub fn read(dir: &Path, name: &str) -> Result<String> {
    let p = path(dir, name)?;
    match fs::read_to_string(&p) {
        Ok(s) if serde_json::from_str::<serde_json::Value>(&s).is_ok() => Ok(s),
        Ok(_) => {
            let _ = fs::remove_file(&p);
            Ok(String::new())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(ProjectError::Io(p.display().to_string(), e)),
    }
}

pub fn clear(dir: &Path, name: &str) -> Result<()> {
    let _ = fs::remove_file(path(dir, name)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::create_project;

    #[test]
    fn history_round_trips_and_clears() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        assert_eq!(read(d.path(), "s1").unwrap(), "");
        write(d.path(), "s1", r#"{"v":1,"docs":[]}"#).unwrap();
        assert_eq!(read(d.path(), "s1").unwrap(), r#"{"v":1,"docs":[]}"#);
        write(d.path(), "binder", "{}").unwrap();
        clear(d.path(), "s1").unwrap();
        assert_eq!(read(d.path(), "s1").unwrap(), "");
        assert_eq!(read(d.path(), "binder").unwrap(), "{}");
    }

    #[test]
    fn damaged_files_and_bad_names_are_refused() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        assert!(write(d.path(), "s1", "not json").is_err());
        fs::create_dir_all(history_dir(d.path())).unwrap();
        fs::write(history_dir(d.path()).join("s2.json"), "{ half").unwrap();
        assert_eq!(read(d.path(), "s2").unwrap(), "");
        assert!(!history_dir(d.path()).join("s2.json").exists());
        assert!(write(d.path(), "../x", "{}").is_err());
        assert!(read(d.path(), "a/b").is_err());
    }
}
