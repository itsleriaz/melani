// SPDX-License-Identifier: GPL-3.0-only
//! Tauri commands for the AI layer. All network access happens here, in the Rust core, and
//! only when the user triggers a request with a key stored in the OS keychain.
use crate::codex;
use crate::context::{self, BuildParams, BuiltContext};
use crate::mentions::MentionIndex;
use crate::openrouter::{self, AiError, AiEvent, ChatRequest, KeyInfo, ModelInfo};
use crate::project::{self, atomic_write};
use crate::templates::{self, Template};
use crate::IndexCache;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

const KEY_SERVICE: &str = "melani";
/// What the app was called before it had a name: a key saved then is moved to the new entry on first read.
const LEGACY_KEY_SERVICE: &str = "novelapp";
const KEY_USER: &str = "openrouter-api-key";

pub struct AiState {
    client: reqwest::Client,
    requests: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

impl Default for AiState {
    fn default() -> Self {
        // No overall timeout: a long generation must be able to stream. The user can cancel.
        let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(15)).build().expect("http client");
        Self { client, requests: Arc::new(Mutex::new(HashMap::new())) }
    }
}

// ---- API key (OS keychain) -------------------------------------------------------------

fn key_entry() -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| AiError::new("other", format!("Could not open the system keychain: {e}")))
}

/// The key, once read. macOS asks for permission on every keychain read, and an unsigned build is
/// asked again each time, so the key is read once per session and then kept in memory. Only the
/// outcome of a successful read is kept: a denied read asks again next time.
static KEY_CACHE: Mutex<Option<Option<String>>> = Mutex::new(None);

fn cached_key(slot: &mut Option<Option<String>>, read: impl FnOnce() -> Result<Option<String>, AiError>) -> Result<Option<String>, AiError> {
    if let Some(known) = slot {
        return Ok(known.clone());
    }
    let found = read()?;
    *slot = Some(found.clone());
    Ok(found)
}

fn get_key() -> Result<Option<String>, AiError> {
    // The lock is held while reading, so calls made together wait for one prompt instead of each raising their own.
    let mut slot = KEY_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cached_key(&mut slot, read_keychain)
}

fn read_keychain() -> Result<Option<String>, AiError> {
    match key_entry()?.get_password() {
        Ok(k) if !k.trim().is_empty() => Ok(Some(k)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(migrate_legacy_key()),
        Err(e) => Err(AiError::new("other", format!("Could not read the system keychain: {e}"))),
    }
}

/// A key saved under the old name moves to the new entry. Best effort: any failure just means no key.
fn migrate_legacy_key() -> Option<String> {
    let old = keyring::Entry::new(LEGACY_KEY_SERVICE, KEY_USER).ok()?;
    let key = old.get_password().ok().filter(|k| !k.trim().is_empty())?;
    if key_entry().ok()?.set_password(&key).is_ok() {
        let _ = old.delete_credential();
    }
    Some(key)
}

fn require_key() -> Result<String, AiError> {
    get_key()?.ok_or_else(|| AiError::new("no_key", "No OpenRouter API key is set. Add one in AI settings."))
}

#[tauri::command]
pub async fn ai_has_key() -> Result<bool, AiError> {
    Ok(get_key()?.is_some())
}

#[tauri::command]
pub async fn ai_set_key(key: String) -> Result<(), AiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::new("bad_request", "The key is empty."));
    }
    key_entry()?.set_password(key).map_err(|e| AiError::new("other", format!("Could not save to the system keychain: {e}")))?;
    *KEY_CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some(Some(key.to_string()));
    Ok(())
}

#[tauri::command]
pub async fn ai_clear_key() -> Result<(), AiError> {
    match key_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            *KEY_CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some(None);
            Ok(())
        }
        Err(e) => Err(AiError::new("other", format!("Could not remove the key from the system keychain: {e}"))),
    }
}

#[tauri::command]
pub async fn ai_key_info(state: State<'_, AiState>) -> Result<KeyInfo, AiError> {
    openrouter::key_info(&state.client, openrouter::BASE_URL, &require_key()?).await
}

#[tauri::command]
pub async fn ai_models(state: State<'_, AiState>) -> Result<Vec<ModelInfo>, AiError> {
    openrouter::list_models(&state.client, openrouter::BASE_URL, &require_key()?).await
}

// ---- Streaming -------------------------------------------------------------------------

/// Start a streamed completion. Events arrive on `on_event`; the call returns at once.
#[tauri::command]
pub async fn ai_start(request_id: String, request: ChatRequest, on_event: Channel<AiEvent>, state: State<'_, AiState>) -> Result<(), AiError> {
    let key = require_key()?; // without a key nothing is sent anywhere
    let client = state.client.clone();
    let requests = state.requests.clone();
    let id = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        openrouter::stream_chat(&client, openrouter::BASE_URL, &key, &request, |e| {
            let _ = on_event.send(e);
        })
        .await;
        requests.lock().unwrap().remove(&id);
    });
    state.requests.lock().unwrap().insert(request_id, handle);
    Ok(())
}

#[tauri::command]
pub async fn ai_cancel(request_id: String, state: State<'_, AiState>) -> Result<(), AiError> {
    if let Some(h) = state.requests.lock().unwrap().remove(&request_id) {
        h.abort();
    }
    Ok(())
}

// ---- Templates and project AI settings -------------------------------------------------

#[tauri::command]
pub async fn ai_templates(dir: String) -> Vec<Template> {
    templates::load_all(Path::new(&dir))
}

/// Saves a project-level override and returns any unknown variables as a warning.
#[tauri::command]
pub async fn ai_save_template(dir: String, template: Template) -> Result<Vec<String>, String> {
    templates::save_override(Path::new(&dir), &template).map_err(|e| e.to_string())?;
    Ok(unknown(&template))
}

fn unknown(t: &Template) -> Vec<String> {
    let mut u = templates::unknown_vars(&t.system);
    for v in templates::unknown_vars(&t.user) {
        if !u.contains(&v) {
            u.push(v);
        }
    }
    u
}

#[tauri::command]
pub async fn ai_check_template(system: String, user: String) -> Vec<String> {
    unknown(&Template { id: String::new(), name: String::new(), system, user, output: String::new(), overridden: false })
}

#[tauri::command]
pub async fn ai_reset_template(dir: String, id: String) -> Result<(), String> {
    templates::reset(Path::new(&dir), &id).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectAi {
    /// Voice, tense, POV, banned words: available to every template as {{style_notes}}.
    pub style_notes: String,
    pub pov: String,
}

fn read_project_ai(dir: &Path) -> ProjectAi {
    std::fs::read_to_string(dir.join("ai.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[tauri::command]
pub async fn ai_project_settings(dir: String) -> ProjectAi {
    read_project_ai(Path::new(&dir))
}

#[tauri::command]
pub async fn ai_save_project_settings(dir: String, settings: ProjectAi) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&settings).expect("serializable");
    atomic_write(&Path::new(&dir).join("ai.json"), &json).map_err(|e| e.to_string())
}

// ---- Preparing a request ---------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrepareParams {
    pub tool: String,
    pub scene_id: Option<String>,
    pub selection: String,
    pub before: String,
    pub after: String,
    pub instruction: String,
    /// The chosen model's context window in tokens (0 if unknown).
    pub model_context: u32,
    /// Tokens reserved for the reply.
    pub max_output: u32,
    pub pinned: Vec<String>,
    pub excluded: Vec<String>,
    pub attach_entries: Vec<String>,
    pub attach_scenes: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub tool: String,
    pub output: String,
    pub system: String,
    pub user: String,
    pub context: BuiltContext,
    /// Estimated tokens in the rendered prompt (system + user).
    pub prompt_tokens: usize,
}

fn find_node<'a>(nodes: &'a [project::BinderNode], id: &str) -> Option<&'a project::BinderNode> {
    nodes.iter().find_map(|n| if n.id == id { Some(n) } else { find_node(&n.children, id) })
}

/// The point of view the prompt states: the scene's own when it has one, else the book's.
pub fn effective_pov(project: &str, scene: &str) -> String {
    let (project, scene) = (project.trim(), scene.trim());
    if scene.is_empty() {
        project.to_string()
    } else {
        format!("{scene} (this scene)")
    }
}

/// Characters of text before/after the target that are scanned for names.
const SCAN_TAIL: usize = 3000;

pub fn prepare(dir: &Path, p: &PrepareParams, index: &MentionIndex) -> Result<Prepared, String> {
    let tpl = templates::get(dir, &p.tool).ok_or_else(|| format!("Unknown tool: {}", p.tool))?;
    let entries = codex::list_entries(dir);
    let binder = project::read_binder(dir).map_err(|e| e.to_string())?;
    let mut settings = read_project_ai(dir);
    let scene_pov = p.scene_id.as_deref().and_then(|id| find_node(&binder.nodes, id)).and_then(|n| n.fields.get("pov")).map(String::as_str).unwrap_or("");
    settings.pov = effective_pov(&settings.pov, scene_pov);
    let tail: String = {
        let n = p.before.chars().count();
        p.before.chars().skip(n.saturating_sub(SCAN_TAIL)).collect()
    };
    let head: String = p.after.chars().take(SCAN_TAIL / 4).collect();
    // Names in the selection, nearby text, or the instruction itself ("make Diane angrier").
    let target = format!("{}\n{}\n{}\n{}", p.selection, tail, head, p.instruction);

    // What the rendered prompt costs without any codex or story context.
    let bare = context::variables(&BuiltContext { items: vec![], used_tokens: 0, budget: 0 }, &settings.style_notes, &settings.pov, &p.selection, &p.before, &p.after, &p.instruction);
    let fixed = context::estimate_tokens(&templates::render(&tpl.system, &bare)) + context::estimate_tokens(&templates::render(&tpl.user, &bare));
    let window = if p.model_context == 0 { 8000 } else { p.model_context as usize };
    let reserve = p.max_output as usize + window / 20 + 200; // reply, plus a margin for estimate error
    let budget = window.saturating_sub(reserve).saturating_sub(fixed);

    let ctx = context::build(
        dir,
        &BuildParams {
            scene_id: p.scene_id.clone(),
            target_text: target,
            budget,
            pinned: p.pinned.iter().cloned().collect::<HashSet<_>>(),
            excluded: p.excluded.iter().cloned().collect::<HashSet<_>>(),
            style_notes: settings.style_notes.clone(),
            include_scene: templates::uses(&tpl.system, "scene") || templates::uses(&tpl.user, "scene"),
            attach_entries: p.attach_entries.clone(),
            attach_scenes: p.attach_scenes.clone(),
        },
        index,
        &entries,
        &binder,
    );
    let vars = context::variables(&ctx, &settings.style_notes, &settings.pov, &p.selection, &p.before, &p.after, &p.instruction);
    let system = templates::render(&tpl.system, &vars);
    let user = templates::render(&tpl.user, &vars);
    let prompt_tokens = context::estimate_tokens(&system) + context::estimate_tokens(&user);
    Ok(Prepared { tool: tpl.id, output: tpl.output, system, user, context: ctx, prompt_tokens })
}

#[tauri::command]
pub async fn ai_prepare(dir: String, params: PrepareParams, cache: State<'_, IndexCache>) -> Result<Prepared, String> {
    let index = crate::index_for(&dir, &cache, false);
    prepare(Path::new(&dir), &params, &index)
}

// ---- Usage and cost --------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Usage {
    pub calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Total USD, counting only calls where the cost was known.
    pub cost: f64,
    /// Calls with no cost information (tokens are still counted).
    pub unpriced_calls: u64,
}

impl Usage {
    pub fn add(&mut self, prompt: u64, completion: u64, cost: Option<f64>) {
        self.calls += 1;
        self.prompt_tokens += prompt;
        self.completion_tokens += completion;
        match cost {
            Some(c) => self.cost += c,
            None => self.unpriced_calls += 1,
        }
    }
}

fn read_usage(dir: &Path) -> Usage {
    std::fs::read_to_string(dir.join("usage.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[tauri::command]
pub async fn ai_usage(dir: String) -> Usage {
    read_usage(Path::new(&dir))
}

#[tauri::command]
pub async fn ai_usage_add(dir: String, prompt_tokens: u64, completion_tokens: u64, cost: Option<f64>) -> Result<Usage, String> {
    let d = Path::new(&dir);
    let mut u = read_usage(d);
    u.add(prompt_tokens, completion_tokens, cost);
    atomic_write(&d.join("usage.json"), &serde_json::to_string_pretty(&u).expect("serializable")).map_err(|e| e.to_string())?;
    Ok(u)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::{save_entry, CodexEntry, MatchOptions};
    use crate::project::{create_project, write_scene};

    fn project_with_diane() -> (tempfile::TempDir, String, MentionIndex) {
        let d = tempfile::tempdir().unwrap();
        let p = create_project(d.path(), "T").unwrap();
        let scene_id = p.binder.nodes[0].children[0].id.clone();
        write_scene(d.path(), &scene_id, "Diane walked home.").unwrap();
        let e = CodexEntry {
            id: "diane".into(),
            name: "Diane Marsh".into(),
            aliases: vec!["Diane".into(), "the Widow".into()],
            kind: "character".into(),
            tags: vec![],
            links: vec![],
            always_include: false,
            priority: 0,
            summary: "A widow.".into(),
            match_options: MatchOptions::default(),
        };
        save_entry(d.path(), &e, &format!("Diane is proud. {}", "Backstory. ".repeat(400))).unwrap();
        let idx = MentionIndex::build(&codex::list_entries(d.path()));
        (d, scene_id, idx)
    }

    fn params(tool: &str, scene: &str) -> PrepareParams {
        PrepareParams { tool: tool.into(), scene_id: Some(scene.into()), selection: "Diane looked away.".into(), before: "It was late. ".into(), after: "Then silence.".into(), instruction: "more tension".into(), model_context: 100_000, max_output: 1000, ..Default::default() }
    }

    #[test]
    fn a_paragraph_naming_diane_sends_her_entry() {
        let (d, scene, idx) = project_with_diane();
        let r = prepare(d.path(), &params("rewrite", &scene), &idx).unwrap();
        let diane = r.context.items.iter().find(|i| i.id == "diane").expect("Diane is in the context");
        assert!(diane.included && diane.reason.contains("matched"));
        // The codex goes in the system prompt, the passage and instruction in the user prompt.
        assert!(r.system.contains("Diane Marsh (character)") && r.system.contains("Diane is proud."));
        assert!(r.user.contains("Diane looked away.") && r.user.contains("more tension") && r.user.contains("Then silence."));
        assert_eq!(r.output, "suggestion");
        assert!(r.prompt_tokens > 100);
    }

    #[test]
    fn the_keychain_is_read_once_and_a_failed_read_is_retried() {
        let mut slot = None;
        let mut reads = 0;
        let mut read = |r: Result<Option<String>, AiError>| {
            reads += 1;
            r
        };
        // A denied read is not remembered.
        assert!(cached_key(&mut slot, || read(Err(AiError::new("other", "denied")))).is_err());
        assert_eq!(cached_key(&mut slot, || read(Ok(Some("sk-1".into())))).unwrap(), Some("sk-1".into()));
        // After that the keychain is not touched again.
        assert_eq!(cached_key(&mut slot, || panic!("read again")).unwrap(), Some("sk-1".into()));
        assert_eq!(reads, 2);
        // "No key" is remembered too.
        let mut none = None;
        assert_eq!(cached_key(&mut none, || Ok(None)).unwrap(), None);
        assert_eq!(cached_key(&mut none, || panic!("read again")).unwrap(), None);
    }

    #[test]
    fn effective_pov_prefers_the_scene() {
        assert_eq!(effective_pov("Diane, close third", ""), "Diane, close third");
        assert_eq!(effective_pov("", "Marcus"), "Marcus (this scene)");
        assert_eq!(effective_pov("", ""), "");
        // The book's is not repeated beside a scene's own: it would only confuse the model.
        assert_eq!(effective_pov("Diane, close third", "Marcus"), "Marcus (this scene)");
    }

    #[test]
    fn a_scenes_own_pov_reaches_the_prompt() {
        let (d, scene, idx) = project_with_diane();
        std::fs::write(d.path().join("ai.json"), r#"{"pov":"Diane, close third"}"#).unwrap();
        // No scene POV yet: the book's applies.
        let r = prepare(d.path(), &params("continue", &scene), &idx).unwrap();
        assert!(r.system.contains("Diane, close third") && !r.system.contains("(this scene)"));
        // Give the scene its own.
        let mut binder = project::read_binder(d.path()).unwrap();
        binder.nodes[0].children[0].fields.insert("pov".into(), "Marcus".into());
        project::save_binder(d.path(), &binder).unwrap();
        let r = prepare(d.path(), &params("continue", &scene), &idx).unwrap();
        assert!(r.system.contains("Marcus (this scene)") && !r.system.contains("Diane, close third"));
    }

    #[test]
    fn a_name_only_in_the_instruction_still_counts() {
        let (d, scene, idx) = project_with_diane();
        let mut p = params("rewrite", &scene);
        p.selection = "She looked away.".into();
        p.before = String::new();
        p.after = String::new();
        p.instruction = "make the Widow angrier".into();
        let r = prepare(d.path(), &p, &idx).unwrap();
        assert!(r.context.items.iter().any(|i| i.id == "diane" && i.included));
    }

    #[test]
    fn small_context_windows_shrink_entries_to_their_summary() {
        let (d, scene, idx) = project_with_diane();
        let mut p = params("rewrite", &scene);
        p.model_context = 1500;
        p.max_output = 500;
        let r = prepare(d.path(), &p, &idx).unwrap();
        let diane = r.context.items.iter().find(|i| i.id == "diane").unwrap();
        assert_eq!(diane.level, "summary");
        assert!(r.context.used_tokens <= r.context.budget);
        assert!(r.prompt_tokens + 500 < 1500, "prompt plus reply fits the window");
    }

    #[test]
    fn project_style_notes_reach_every_template_and_overrides_apply() {
        let (d, scene, idx) = project_with_diane();
        std::fs::write(d.path().join("ai.json"), r#"{"styleNotes":"Past tense. No adverbs.","pov":"Diane, close third"}"#).unwrap();
        let r = prepare(d.path(), &params("continue", &scene), &idx).unwrap();
        assert!(r.system.contains("Past tense. No adverbs.") && r.system.contains("Diane, close third"));
        let mut t = templates::get(d.path(), "continue").unwrap();
        t.user = "CUSTOM {{instruction}} / {{selection}}".into();
        templates::save_override(d.path(), &t).unwrap();
        let r = prepare(d.path(), &params("continue", &scene), &idx).unwrap();
        assert_eq!(r.user, "CUSTOM more tension / Diane looked away.");
    }

    #[test]
    fn brainstorm_sees_attached_scenes_and_unknown_tools_fail() {
        let (d, scene, idx) = project_with_diane();
        let mut p = params("brainstorm", &scene);
        p.attach_scenes = vec![scene.clone()];
        let r = prepare(d.path(), &p, &idx).unwrap();
        assert_eq!(r.output, "chat");
        assert!(r.user.contains("Diane walked home."));
        p.tool = "nonsense".into();
        assert!(prepare(d.path(), &p, &idx).is_err());
    }

    #[test]
    fn usage_totals_accumulate_and_track_unpriced_calls() {
        let mut u = Usage::default();
        u.add(100, 50, Some(0.002));
        u.add(10, 5, None);
        assert_eq!((u.calls, u.prompt_tokens, u.completion_tokens, u.unpriced_calls), (2, 110, 55, 1));
        assert!((u.cost - 0.002).abs() < 1e-12);
    }
}
