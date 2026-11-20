// SPDX-License-Identifier: GPL-3.0-only
mod ai;
mod codex;
mod export;
mod extract;
mod context;
mod docx;
mod docx_out;
mod epub_out;
mod history;
mod import;
mod md;
mod mentions;
mod openrouter;
mod project;
mod recovery;
mod search;
mod snapshots;
mod templates;

use snapshots::SnapshotMeta;
use project::{Binder, OpenedProject, SearchHit};
use std::path::Path;

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

use codex::CodexEntry;
use mentions::{Mention, MentionIndex};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::State;

/// The mention index for the open project, rebuilt whenever the codex changes.
#[derive(Default)]
struct IndexCache(Mutex<Option<(String, Arc<MentionIndex>)>>);

fn index_for(dir: &str, cache: &IndexCache, rebuild: bool) -> Arc<MentionIndex> {
    let mut g = cache.0.lock().unwrap();
    if !rebuild {
        if let Some((d, idx)) = g.as_ref() {
            if d == dir {
                return idx.clone();
            }
        }
    }
    let idx = Arc::new(MentionIndex::build(&codex::list_entries(Path::new(dir))));
    *g = Some((dir.to_string(), idx.clone()));
    idx
}

fn scene_ids(dir: &str) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(Path::new(dir).join("manuscript")) else { return vec![] };
    rd.flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
        .filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().to_string()))
        .collect()
}

fn mention_counts(dir: &str, id: &str, idx: &MentionIndex) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    if let Ok(text) = project::read_scene(Path::new(dir), id) {
        for m in idx.scan(&text) {
            for e in m.entries {
                *counts.entry(e).or_default() += 1;
            }
        }
    }
    counts
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Backlink {
    scene_id: String,
    count: usize,
}

#[tauri::command]
async fn list_codex(dir: String, cache: State<'_, IndexCache>) -> Result<Vec<CodexEntry>, String> {
    index_for(&dir, &cache, true);
    Ok(codex::list_entries(Path::new(&dir)))
}
#[tauri::command]
async fn read_codex_body(dir: String, id: String) -> Result<String, String> {
    codex::read_body(Path::new(&dir), &id).map_err(s)
}
#[tauri::command]
async fn save_codex_entry(dir: String, entry: CodexEntry, body: String, cache: State<'_, IndexCache>) -> Result<(), String> {
    codex::save_entry(Path::new(&dir), &entry, &body).map_err(s)?;
    index_for(&dir, &cache, true);
    Ok(())
}
#[tauri::command]
async fn delete_codex_entry(dir: String, id: String, cache: State<'_, IndexCache>) -> Result<(), String> {
    codex::delete_entry(Path::new(&dir), &id).map_err(s)?;
    index_for(&dir, &cache, true);
    Ok(())
}
/// Scan several text blocks at once; offsets are UTF-16 units within each block.
#[tauri::command]
async fn find_mentions(dir: String, texts: Vec<String>, cache: State<'_, IndexCache>) -> Result<Vec<Vec<Mention>>, String> {
    let idx = index_for(&dir, &cache, false);
    Ok(texts.iter().map(|t| idx.scan(t)).collect())
}
/// Entry id -> number of mentions in this scene.
#[tauri::command]
async fn scene_mentions(dir: String, id: String, cache: State<'_, IndexCache>) -> Result<HashMap<String, usize>, String> {
    Ok(mention_counts(&dir, &id, &index_for(&dir, &cache, false)))
}
/// Scenes that mention an entry, from the files on disk.
#[tauri::command]
async fn entry_backlinks(dir: String, entry_id: String, cache: State<'_, IndexCache>) -> Result<Vec<Backlink>, String> {
    let idx = index_for(&dir, &cache, false);
    let mut out: Vec<Backlink> = scene_ids(&dir)
        .into_iter()
        .filter_map(|id| mention_counts(&dir, &id, &idx).get(&entry_id).map(|&count| Backlink { scene_id: id, count }))
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(out)
}

#[tauri::command]
async fn create_snapshot(dir: String, scene_ids: Vec<String>, note: String, label: String, scope: String) -> Result<SnapshotMeta, String> {
    snapshots::create(Path::new(&dir), &scene_ids, &note, &label, &scope).map_err(s)
}
#[tauri::command]
async fn list_snapshots(dir: String) -> Vec<SnapshotMeta> {
    snapshots::list(Path::new(&dir))
}
#[tauri::command]
async fn read_snapshot_scene(dir: String, snapshot: String, scene: String) -> Result<String, String> {
    snapshots::read(Path::new(&dir), &snapshot, &scene).map_err(s)
}
#[tauri::command]
async fn restore_snapshot(dir: String, snapshot: String, scene_ids: Vec<String>) -> Result<SnapshotMeta, String> {
    snapshots::restore(Path::new(&dir), &snapshot, &scene_ids).map_err(s)
}
#[tauri::command]
async fn delete_snapshot(dir: String, snapshot: String) -> Result<(), String> {
    snapshots::delete(Path::new(&dir), &snapshot).map_err(s)
}
#[tauri::command]
async fn read_stats(dir: String) -> Result<String, String> {
    project::read_stats(Path::new(&dir)).map_err(s)
}
#[tauri::command]
async fn export_docx(dir: String, options: export::Options, target: String) -> Result<export::Written, String> {
    export::write_docx(Path::new(&dir), &options, Path::new(&target)).map_err(s)
}
#[tauri::command]
async fn export_epub(dir: String, options: export::Options, target: String) -> Result<export::Written, String> {
    export::write_epub(Path::new(&dir), &options, Path::new(&target)).map_err(s)
}
#[tauri::command]
async fn extract_scan(dir: String, min_mentions: usize) -> Result<Vec<extract::Candidate>, String> {
    extract::scan(Path::new(&dir), min_mentions).map_err(s)
}
#[tauri::command]
async fn extract_chunks(dir: String, max_tokens: usize) -> Result<Vec<extract::Chunk>, String> {
    extract::chunks(Path::new(&dir), max_tokens).map_err(s)
}
#[tauri::command]
async fn extract_prompt(dir: String, text: String, known: Vec<String>) -> Result<extract::Prompt, String> {
    extract::prompt(Path::new(&dir), &text, &known).map_err(s)
}
#[tauri::command]
async fn extract_check_prompt(dir: String, lines: String) -> Result<extract::Prompt, String> {
    extract::check_prompt(Path::new(&dir), &lines).map_err(s)
}
#[tauri::command]
async fn extract_stats(dir: String, groups: Vec<Vec<String>>) -> Result<Vec<extract::TermStats>, String> {
    extract::term_stats(Path::new(&dir), &groups).map_err(s)
}
#[tauri::command]
async fn import_preview(paths: Vec<String>, options: import::Options) -> Result<import::Preview, String> {
    let paths: Vec<_> = paths.into_iter().map(std::path::PathBuf::from).collect();
    import::plan(&paths, &options).map(|p| p.preview).map_err(s)
}
#[tauri::command]
async fn import_commit(dir: String, paths: Vec<String>, options: import::Options) -> Result<import::Imported, String> {
    let paths: Vec<_> = paths.into_iter().map(std::path::PathBuf::from).collect();
    import::commit(Path::new(&dir), &paths, &options).map_err(s)
}
#[tauri::command]
async fn read_collections(dir: String) -> Result<String, String> {
    project::read_collections(Path::new(&dir)).map_err(s)
}
#[tauri::command]
async fn write_collections(dir: String, content: String) -> Result<(), String> {
    project::write_collections(Path::new(&dir), &content).map_err(s)
}
#[tauri::command]
async fn write_stats(dir: String, content: String) -> Result<(), String> {
    project::write_stats(Path::new(&dir), &content).map_err(s)
}

#[tauri::command]
async fn new_id() -> String {
    project::new_id()
}
#[tauri::command]
async fn create_project(dir: String, title: String) -> Result<OpenedProject, String> {
    project::create_project(Path::new(&dir), &title).map_err(s)
}
#[tauri::command]
async fn open_project(dir: String) -> Result<OpenedProject, String> {
    project::open_project(Path::new(&dir)).map_err(s)
}
#[tauri::command]
async fn close_project(dir: String) -> Result<(), String> {
    project::close_project(Path::new(&dir)).map_err(s)
}
#[tauri::command]
async fn save_binder(dir: String, binder: Binder) -> Result<(), String> {
    project::save_binder(Path::new(&dir), &binder).map_err(s)
}
#[tauri::command]
async fn save_project_meta(dir: String, meta: project::ProjectMeta) -> Result<(), String> {
    project::save_project_meta(Path::new(&dir), &meta).map_err(s)
}
#[tauri::command]
async fn read_scene(dir: String, id: String) -> Result<String, String> {
    project::read_scene(Path::new(&dir), &id).map_err(s)
}
#[tauri::command]
async fn write_scene(dir: String, id: String, content: String) -> Result<(), String> {
    project::write_scene(Path::new(&dir), &id, &content).map_err(s)
}
#[tauri::command]
async fn read_scene_meta(dir: String, id: String) -> Result<String, String> {
    project::read_scene_meta(Path::new(&dir), &id).map_err(s)
}
#[tauri::command]
async fn write_scene_meta(dir: String, id: String, content: String) -> Result<(), String> {
    project::write_scene_meta(Path::new(&dir), &id, &content).map_err(s)
}
#[tauri::command]
async fn scene_modified(dir: String, id: String) -> Result<u64, String> {
    project::scene_modified(Path::new(&dir), &id).map_err(s)
}
#[tauri::command]
async fn write_recovery(dir: String, id: String, text: String, at: u64) -> Result<(), String> {
    recovery::write(Path::new(&dir), &id, &text, at).map_err(s)
}
#[tauri::command]
async fn delete_scenes(dir: String, ids: Vec<String>) -> Result<(), String> {
    for id in &ids {
        project::delete_scene(Path::new(&dir), id).map_err(s)?;
        recovery::clear(Path::new(&dir), id).map_err(s)?;
        history::clear(Path::new(&dir), id).map_err(s)?;
    }
    Ok(())
}
#[tauri::command]
async fn write_history(dir: String, name: String, content: String) -> Result<(), String> {
    history::write(Path::new(&dir), &name, &content).map_err(s)
}
#[tauri::command]
async fn read_history(dir: String, name: String) -> Result<String, String> {
    history::read(Path::new(&dir), &name).map_err(s)
}
#[tauri::command]
async fn clear_history(dir: String, name: String) -> Result<(), String> {
    history::clear(Path::new(&dir), &name).map_err(s)
}
#[tauri::command]
async fn clear_recovery(dir: String, id: String) -> Result<(), String> {
    recovery::clear(Path::new(&dir), &id).map_err(s)
}
#[tauri::command]
async fn list_recovery(dir: String) -> Vec<recovery::Recovered> {
    recovery::list(Path::new(&dir))
}
#[tauri::command]
async fn restore_recovery(dir: String, id: String, label: String) -> Result<(), String> {
    recovery::restore(Path::new(&dir), &id, &label).map_err(s)
}
#[tauri::command]
async fn search_groups(dir: String, query: String, options: search::Options, scene_ids: Vec<String>, codex: bool) -> Vec<search::Group> {
    search::search(Path::new(&dir), &query, options, &scene_ids, codex)
}
#[tauri::command]
async fn replace_all(dir: String, query: String, replacement: String, options: search::Options, scene_ids: Vec<String>) -> Result<usize, String> {
    search::replace_all(Path::new(&dir), &query, &replacement, options, &scene_ids).map_err(s)
}
/// What an export would contain, and whether pending suggestions block it.
#[tauri::command]
async fn export_summary(dir: String, options: export::Options) -> Result<export::Summary, String> {
    export::collect(Path::new(&dir), &options).map(|(_, s)| s).map_err(s)
}
#[tauri::command]
async fn export_markdown(dir: String, options: export::Options, target: String) -> Result<export::Written, String> {
    export::write(Path::new(&dir), &options, Path::new(&target)).map_err(s)
}
#[tauri::command]
async fn word_counts(dir: String) -> Result<std::collections::HashMap<String, usize>, String> {
    project::word_counts(Path::new(&dir)).map_err(s)
}
#[tauri::command]
async fn search_project(dir: String, query: String) -> Result<Vec<SearchHit>, String> {
    project::search(Path::new(&dir), &query, 200).map_err(s)
}

/// Swaps the window (and Windows taskbar) icon. The bundled executable icon is fixed at build time.
#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, variant: String) -> Result<(), String> {
    use tauri::Manager;
    let bytes: &[u8] = match variant.as_str() {
        "light" => include_bytes!("../icons/app-light.png"),
        _ => include_bytes!("../icons/app-dark.png"),
    };
    let icon = tauri::image::Image::from_bytes(bytes).map_err(s)?;
    let win = app.get_webview_window("main").ok_or("no main window")?;
    win.set_icon(icon).map_err(s)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(IndexCache::default())
        .manage(ai::AiState::default())
        .invoke_handler(tauri::generate_handler![
            set_app_icon,
            read_scene_meta,
            write_scene_meta,
            write_recovery,
            clear_recovery,
            write_history,
            read_history,
            clear_history,
            delete_scenes,
            list_recovery,
            restore_recovery,
            search_groups,
            export_summary,
            export_markdown,
            export_docx,
            export_epub,
            replace_all,
            ai::ai_has_key,
            ai::ai_set_key,
            ai::ai_clear_key,
            ai::ai_key_info,
            ai::ai_models,
            ai::ai_start,
            ai::ai_cancel,
            ai::ai_templates,
            ai::ai_save_template,
            ai::ai_check_template,
            ai::ai_reset_template,
            ai::ai_project_settings,
            ai::ai_save_project_settings,
            ai::ai_prepare,
            ai::ai_usage,
            ai::ai_usage_add,
            create_snapshot,
            list_snapshots,
            read_snapshot_scene,
            restore_snapshot,
            delete_snapshot,
            read_stats,
            write_stats,
            extract_scan,
            extract_chunks,
            extract_prompt,
            extract_check_prompt,
            extract_stats,
            import_preview,
            import_commit,
            read_collections,
            write_collections,
            list_codex,
            read_codex_body,
            save_codex_entry,
            delete_codex_entry,
            find_mentions,
            scene_mentions,
            entry_backlinks,
            new_id,
            create_project,
            open_project,
            close_project,
            save_binder,
            save_project_meta,
            read_scene,
            write_scene,
            scene_modified,
            search_project,
            word_counts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
