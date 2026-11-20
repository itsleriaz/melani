// SPDX-License-Identifier: GPL-3.0-only
//! Project folder format: project.json, binder.json, manuscript/<id>.md.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("io error on {0}: {1}")]
    Io(String, std::io::Error),
    #[error("invalid json in {0}: {1}")]
    Json(String, serde_json::Error),
    #[error("project format version {0} is newer than this app supports ({FORMAT_VERSION})")]
    TooNew(u32),
    #[error("invalid id: {0}")]
    BadId(String),
    #[error("not a project folder (missing project.json): {0}")]
    NotAProject(String),
    #[error("{0}")]
    Other(String),
}
type Result<T> = std::result::Result<T, ProjectError>;

fn io<T>(p: &Path, r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| ProjectError::Io(p.display().to_string(), e))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub format_version: u32,
    pub title: String,
    #[serde(default)]
    pub author: String,
    /// Free keywords for the whole book.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// Book-level fields by name: the fixed ones (subtitle, genre, language, description) and any custom ones.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
    /// Names of the custom fields every scene can carry, in the order they are shown.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scene_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    Part,
    Chapter,
    Scene,
    Note,
    Trash,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BinderNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: NodeType,
    pub title: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub synopsis: String,
    #[serde(default = "yes")]
    pub include_in_export: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// Values by field name: the fixed ones (pov, location, when) and any custom ones.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub children: Vec<BinderNode>,
}
fn default_status() -> String {
    "draft".into()
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Binder {
    pub nodes: Vec<BinderNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub meta: ProjectMeta,
    pub binder: Binder,
    /// True when the previous session did not close cleanly.
    pub unclean_exit: bool,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub id: String,
    pub line: String,
}

pub fn new_id() -> String {
    ulid::Ulid::from_datetime(std::time::SystemTime::now()).to_string().to_lowercase()
}

/// Ids become file names, so only allow plain alphanumerics.
pub(crate) fn check_id(id: &str) -> Result<()> {
    if !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err(ProjectError::BadId(id.into()))
    }
}

pub fn atomic_write(target: &Path, content: &str) -> Result<()> {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = target.with_file_name(name);
    let res = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, target)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    io(target, res)
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<T> {
    let s = io(p, fs::read_to_string(p))?;
    serde_json::from_str(&s).map_err(|e| ProjectError::Json(p.display().to_string(), e))
}

fn write_json<T: Serialize>(p: &Path, v: &T) -> Result<()> {
    let s = serde_json::to_string_pretty(v).expect("serializable");
    atomic_write(p, &s)
}

fn lock_path(dir: &Path) -> PathBuf {
    dir.join(".app").join("session.lock")
}

pub fn create_project(dir: &Path, title: &str) -> Result<OpenedProject> {
    for sub in ["manuscript", "codex", "research", "snapshots", "prompts", ".app"] {
        io(dir, fs::create_dir_all(dir.join(sub)))?;
    }
    let meta = ProjectMeta { format_version: FORMAT_VERSION, title: title.into(), author: String::new(), keywords: vec![], fields: BTreeMap::new(), scene_fields: vec![] };
    write_json(&dir.join("project.json"), &meta)?;
    let node = |kind, title: &str, children| BinderNode {
        id: new_id(),
        kind,
        title: title.into(),
        status: "draft".into(),
        label: None,
        synopsis: String::new(),
        include_in_export: true,
        keywords: vec![],
        fields: BTreeMap::new(),
        children,
    };
    let scene = node(NodeType::Scene, "Opening scene", vec![]);
    let chapter = node(NodeType::Chapter, "Chapter 1", vec![scene]);
    let binder = Binder { nodes: vec![chapter, node(NodeType::Trash, "Trash", vec![])] };
    write_json(&dir.join("binder.json"), &binder)?;
    io(dir, fs::write(dir.join(".app").join(".gitignore"), "*\n"))?;
    open_project(dir)
}

pub fn open_project(dir: &Path) -> Result<OpenedProject> {
    let pj = dir.join("project.json");
    if !pj.exists() {
        return Err(ProjectError::NotAProject(dir.display().to_string()));
    }
    let meta: ProjectMeta = read_json(&pj)?;
    if meta.format_version > FORMAT_VERSION {
        return Err(ProjectError::TooNew(meta.format_version));
    }
    // Older versions: back up, then migrate (none exist yet).
    let binder: Binder = read_json(&dir.join("binder.json"))?;
    let lock = lock_path(dir);
    let unclean_exit = lock.exists();
    io(dir, fs::create_dir_all(dir.join(".app")))?;
    io(&lock, fs::write(&lock, "open"))?;
    Ok(OpenedProject { meta, binder, unclean_exit })
}

pub fn close_project(dir: &Path) -> Result<()> {
    let _ = fs::remove_file(lock_path(dir));
    Ok(())
}

/// Replace project.json's contents. The format version always stays the current one.
pub fn save_project_meta(dir: &Path, meta: &ProjectMeta) -> Result<()> {
    let mut meta = meta.clone();
    meta.format_version = FORMAT_VERSION;
    write_json(&dir.join("project.json"), &meta)
}

pub fn read_binder(dir: &Path) -> Result<Binder> {
    read_json(&dir.join("binder.json"))
}

pub fn save_binder(dir: &Path, binder: &Binder) -> Result<()> {
    write_json(&dir.join("binder.json"), binder)
}

fn scene_path(dir: &Path, id: &str) -> Result<PathBuf> {
    check_id(id)?;
    Ok(dir.join("manuscript").join(format!("{id}.md")))
}

pub fn read_scene(dir: &Path, id: &str) -> Result<String> {
    let p = scene_path(dir, id)?;
    if !p.exists() {
        return Ok(String::new());
    }
    io(&p, fs::read_to_string(&p))
}

pub fn write_scene(dir: &Path, id: &str, content: &str) -> Result<()> {
    atomic_write(&scene_path(dir, id)?, content)
}

/// Sidecar next to a scene (manuscript/<id>.meta.json): pending AI suggestions and comments.
/// Returns "{}" when there is none.
pub fn read_scene_meta(dir: &Path, id: &str) -> Result<String> {
    check_id(id)?;
    let p = dir.join("manuscript").join(format!("{id}.meta.json"));
    if !p.exists() {
        return Ok("{}".into());
    }
    io(&p, fs::read_to_string(&p))
}

/// Writes the sidecar, or removes it when `content` is empty so a scene with nothing
/// pending leaves no stray file behind.
pub fn write_scene_meta(dir: &Path, id: &str, content: &str) -> Result<()> {
    check_id(id)?;
    let p = dir.join("manuscript").join(format!("{id}.meta.json"));
    if content.trim().is_empty() {
        let _ = fs::remove_file(&p);
        return Ok(());
    }
    serde_json::from_str::<serde_json::Value>(content).map_err(|e| ProjectError::Json(p.display().to_string(), e))?;
    atomic_write(&p, content)
}

/// Removes a scene's text and its sidecar (comments, pending suggestions). Snapshots keep their own copies.
pub fn delete_scene(dir: &Path, id: &str) -> Result<()> {
    check_id(id)?;
    for name in [format!("{id}.md"), format!("{id}.meta.json")] {
        let p = dir.join("manuscript").join(name);
        match fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(ProjectError::Io(p.display().to_string(), e)),
        }
    }
    Ok(())
}

/// Modification time in ms since epoch (0 if the scene file does not exist).
pub fn scene_modified(dir: &Path, id: &str) -> Result<u64> {
    let p = scene_path(dir, id)?;
    match fs::metadata(&p) {
        Ok(m) => Ok(m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)),
        Err(_) => Ok(0),
    }
}

/// Writing goals and daily history live in stats.json at the project root.
pub fn read_stats(dir: &Path) -> Result<String> {
    let p = dir.join("stats.json");
    if !p.exists() {
        return Ok("{}".into());
    }
    io(&p, fs::read_to_string(&p))
}

pub fn write_stats(dir: &Path, content: &str) -> Result<()> {
    let p = dir.join("stats.json");
    serde_json::from_str::<serde_json::Value>(content).map_err(|e| ProjectError::Json(p.display().to_string(), e))?;
    atomic_write(&p, content)
}

pub fn read_collections(dir: &Path) -> Result<String> {
    let p = dir.join("collections.json");
    if !p.exists() {
        return Ok("[]".into());
    }
    io(&p, fs::read_to_string(&p))
}

pub fn write_collections(dir: &Path, content: &str) -> Result<()> {
    let p = dir.join("collections.json");
    serde_json::from_str::<serde_json::Value>(content).map_err(|e| ProjectError::Json(p.display().to_string(), e))?;
    atomic_write(&p, content)
}

/// Word count per scene file id (whitespace-separated tokens containing a letter or digit).
pub fn word_counts(dir: &Path) -> Result<std::collections::HashMap<String, usize>> {
    let mut out = std::collections::HashMap::new();
    let Ok(rd) = fs::read_dir(dir.join("manuscript")) else { return Ok(out) };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let id = p.file_stem().unwrap().to_string_lossy().to_string();
        let Ok(text) = fs::read_to_string(&p) else { continue };
        let n = text.split_whitespace().filter(|w| w.chars().any(|c| c.is_alphanumeric())).count();
        out.insert(id, n);
    }
    Ok(out)
}

/// Case-insensitive substring search across scene files.
pub fn search(dir: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let q = query.to_lowercase();
    let mut hits = vec![];
    if q.is_empty() {
        return Ok(hits);
    }
    let Ok(rd) = fs::read_dir(dir.join("manuscript")) else { return Ok(hits) };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let id = p.file_stem().unwrap().to_string_lossy().to_string();
        let Ok(text) = fs::read_to_string(&p) else { continue };
        for line in text.lines() {
            if line.to_lowercase().contains(&q) {
                hits.push(SearchHit { id: id.clone(), line: line.chars().take(200).collect() });
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_open_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let p = create_project(d.path(), "Test").unwrap();
        assert_eq!(p.meta.title, "Test");
        assert!(!p.unclean_exit);
        assert_eq!(p.binder.nodes.len(), 2);
        // Opened but not closed => next open reports unclean exit.
        let p2 = open_project(d.path()).unwrap();
        assert!(p2.unclean_exit);
        close_project(d.path()).unwrap();
        assert!(!open_project(d.path()).unwrap().unclean_exit);
    }

    #[test]
    fn metadata_roundtrips_and_old_files_still_load() {
        let d = tempfile::tempdir().unwrap();
        // A project.json and binder.json from before metadata existed.
        fs::write(d.path().join("project.json"), r#"{"formatVersion":1,"title":"Old"}"#).unwrap();
        fs::write(d.path().join("binder.json"), r#"{"nodes":[{"id":"s1","type":"scene","title":"A"}]}"#).unwrap();
        let p = open_project(d.path()).unwrap();
        assert!(p.meta.keywords.is_empty() && p.meta.fields.is_empty() && p.meta.scene_fields.is_empty());
        assert!(p.binder.nodes[0].keywords.is_empty() && p.binder.nodes[0].fields.is_empty());

        let mut meta = p.meta.clone();
        meta.keywords = vec!["noir".into()];
        meta.fields.insert("genre".into(), "Mystery".into());
        meta.scene_fields = vec!["Weather".into()];
        save_project_meta(d.path(), &meta).unwrap();
        let mut binder = p.binder.clone();
        binder.nodes[0].keywords = vec!["flashback".into()];
        binder.nodes[0].fields.insert("pov".into(), "Diane".into());
        save_binder(d.path(), &binder).unwrap();

        let again = open_project(d.path()).unwrap();
        assert_eq!(again.meta.fields["genre"], "Mystery");
        assert_eq!(again.meta.scene_fields, vec!["Weather"]);
        assert_eq!(again.binder.nodes[0].fields["pov"], "Diane");
        assert_eq!(again.binder.nodes[0].keywords, vec!["flashback"]);
        // Empty metadata is left out of the files, so they stay tidy.
        let raw = fs::read_to_string(d.path().join("binder.json")).unwrap();
        assert!(raw.contains("flashback"));
        let plain = BinderNode { id: "x".into(), kind: NodeType::Scene, title: "t".into(), status: "draft".into(), label: None, synopsis: String::new(), include_in_export: true, keywords: vec![], fields: BTreeMap::new(), children: vec![] };
        assert!(!serde_json::to_string(&plain).unwrap().contains("fields"));
    }

    #[test]
    fn collections_roundtrip_and_reject_bad_json() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        assert_eq!(read_collections(d.path()).unwrap(), "[]");
        write_collections(d.path(), r#"[{"id":"c1","name":"Flashbacks"}]"#).unwrap();
        assert!(read_collections(d.path()).unwrap().contains("Flashbacks"));
        assert!(write_collections(d.path(), "nope").is_err());
        assert!(read_collections(d.path()).unwrap().contains("Flashbacks"));
    }

    #[test]
    fn scene_io_and_external_edit() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        assert_eq!(read_scene(d.path(), "abc").unwrap(), "");
        write_scene(d.path(), "abc", "Hello Diane").unwrap();
        assert_eq!(read_scene(d.path(), "abc").unwrap(), "Hello Diane");
        // External editor changes the file; we read the new content.
        fs::write(d.path().join("manuscript/abc.md"), "Edited").unwrap();
        assert_eq!(read_scene(d.path(), "abc").unwrap(), "Edited");
        assert!(scene_modified(d.path(), "abc").unwrap() > 0);
        assert!(!d.path().join("manuscript/abc.md.tmp").exists());
    }

    #[test]
    fn delete_scene_removes_text_and_sidecar() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        write_scene(d.path(), "s1", "text").unwrap();
        write_scene_meta(d.path(), "s1", r#"{"a":1}"#).unwrap();
        write_scene(d.path(), "s2", "other").unwrap();
        delete_scene(d.path(), "s1").unwrap();
        assert!(!d.path().join("manuscript/s1.md").exists());
        assert!(!d.path().join("manuscript/s1.meta.json").exists());
        assert_eq!(read_scene(d.path(), "s2").unwrap(), "other");
        delete_scene(d.path(), "s1").unwrap(); // already gone is fine
        assert!(delete_scene(d.path(), "../x").is_err());
    }

    #[test]
    fn scene_sidecar_roundtrip_and_cleanup() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        assert_eq!(read_scene_meta(d.path(), "s1").unwrap(), "{}");
        write_scene_meta(d.path(), "s1", r#"{"suggestions":[]}"#).unwrap();
        assert_eq!(read_scene_meta(d.path(), "s1").unwrap(), r#"{"suggestions":[]}"#);
        assert!(write_scene_meta(d.path(), "s1", "not json").is_err());
        assert!(write_scene_meta(d.path(), "../x", "{}").is_err());
        // Empty content removes the file.
        write_scene_meta(d.path(), "s1", "").unwrap();
        assert!(!d.path().join("manuscript/s1.meta.json").exists());
        // The sidecar is not mistaken for a scene by search or word counts.
        write_scene_meta(d.path(), "s1", r#"{"a":"widow"}"#).unwrap();
        write_scene(d.path(), "s1", "text").unwrap();
        assert!(search(d.path(), "widow", 10).unwrap().is_empty());
        assert_eq!(word_counts(d.path()).unwrap().len(), 1);
    }

    #[test]
    fn rejects_path_traversal() {
        let d = tempfile::tempdir().unwrap();
        create_project(d.path(), "T").unwrap();
        assert!(write_scene(d.path(), "../evil", "x").is_err());
        assert!(read_scene(d.path(), "a/b").is_err());
    }

    #[test]
    fn rejects_newer_format_and_non_projects() {
        let d = tempfile::tempdir().unwrap();
        assert!(matches!(open_project(d.path()), Err(ProjectError::NotAProject(_))));
        fs::write(d.path().join("project.json"), r#"{"formatVersion":99,"title":"x"}"#).unwrap();
        assert!(matches!(open_project(d.path()), Err(ProjectError::TooNew(99))));
    }

    /// M1 acceptance: a 100k-word, 60-scene project opens in under 2 seconds.
    #[test]
    fn large_project_opens_fast() {
        let d = tempfile::tempdir().unwrap();
        let mut p = create_project(d.path(), "Big").unwrap();
        close_project(d.path()).unwrap();
        let para = "the widow walked slowly through rain soaked streets while Diane remembered her sister ".repeat(12);
        let scene_text = std::iter::repeat(para.as_str()).take(14).collect::<Vec<_>>().join("\n\n"); // ~1,700 words
        let chapter = &mut p.binder.nodes[0];
        chapter.children.clear();
        for i in 0..60 {
            let id = format!("scene{i:03}");
            write_scene(d.path(), &id, &scene_text).unwrap();
            let mut n = chapter.clone();
            n.id = id;
            n.kind = NodeType::Scene;
            n.children.clear();
            chapter.children.push(n);
        }
        save_binder(d.path(), &p.binder).unwrap();

        let t = std::time::Instant::now();
        let o = open_project(d.path()).unwrap();
        let counts = word_counts(d.path()).unwrap();
        let elapsed = t.elapsed();
        let total: usize = counts.values().sum();
        assert_eq!(o.binder.nodes[0].children.len(), 60);
        assert!(total >= 100_000, "total words {total}");
        assert!(elapsed.as_secs_f64() < 2.0, "took {elapsed:?}");
        println!("opened 60 scenes / {total} words in {elapsed:?}");
    }

    #[test]
    fn binder_roundtrip_and_search() {
        let d = tempfile::tempdir().unwrap();
        let p = create_project(d.path(), "T").unwrap();
        save_binder(d.path(), &p.binder).unwrap();
        assert_eq!(open_project(d.path()).unwrap().binder, p.binder);
        write_scene(d.path(), "s1", "The Widow walked.\nNothing here.").unwrap();
        let hits = search(d.path(), "widow", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "s1");
    }
}
