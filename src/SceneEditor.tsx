// SPDX-License-Identifier: GPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Focus } from "@tiptap/extensions";
import { closeHistory } from "@tiptap/pm/history";
import Typography from "@tiptap/extension-typography";
import { Highlight } from "./Highlight";
import { Footnote } from "./Footnote";
import { CommentShortcut } from "./authorComments";
import { SmoothCaret } from "./SmoothCaret";
import { FindHighlight, SEARCH_META, SearchHighlight } from "./search";
import { AI_META, Suggestion, SuggestionControls, SuggestionOriginal } from "./Suggestion";
import { applyComments, CommentMarks } from "./Comments";
import { buildDecorations, collectBlocks, MENTIONS_META, Mentions } from "./Mentions";
import { EditorHandle, registerHandle, setActive, unregisterHandle } from "./editorRegistry";
import { acceptSuggestion, canRegenerate, insertAsSuggestion, regenerateSuggestion, rejectSuggestion } from "./aiRun";
import { useAi } from "./aiStore";
import type { Message, SceneComment } from "./ai";
import type { Mention } from "./codexTypes";
import { pendingSids, restoreRecords, stripPending, SuggestionRecord, toRecords } from "./suggestions";
import { flushBinderHistory, setFlushPending, useStore } from "./store";
import { loadStash, restoreHistory, stashHistory } from "./sceneHistory";

export { getActiveEditor } from "./editorRegistry";

const SAVE_DELAY_MS = 800;
/** Autosave waits for a pause in typing, but never longer than this while text is unsaved. */
const MAX_SAVE_WAIT_MS = 5000;
/** Unsaved text goes to the crash recovery journal this soon after an edit. */
const JOURNAL_MS = 300;
const POLL_MS = 2000;
const SCAN_DELAY_MS = 400;

/** Pending saves register here so the app can flush them before closing. */
export const flushers = new Set<() => Promise<void>>();

/** Mounted scenes write their undo history here, so it survives closing the app. */
const historySavers = new Set<() => Promise<void>>();

/** Save every open scene's undo history and the binder's. Called when leaving the project or quitting. */
export async function saveHistoryAll() {
  await Promise.all([...historySavers].map((f) => f()));
  await flushBinderHistory();
}

/** Write every unsaved scene to disk now. */
export async function flushAll() {
  await Promise.all([...flushers].map((f) => f()));
}
setFlushPending(flushAll);

/** What the scene sidecar (manuscript/<id>.meta.json) holds. */
interface Sidecar {
  version?: number;
  suggestions?: SuggestionRecord[];
  /** Suggestions that could not be re-placed after the text changed elsewhere. */
  orphans?: SuggestionRecord[];
  comments?: SceneComment[];
}

/** The scene as Markdown. Pending AI suggestions are left out; they live in the sidecar. */
function sceneMarkdown(ed: Editor): string {
  const doc = ed.state.doc;
  const serializer = (ed as unknown as { markdown?: { serialize(json: unknown): string } }).markdown;
  return pendingSids(doc).length > 0 && serializer ? serializer.serialize(stripPending(doc).toJSON()) : ed.getMarkdown();
}

export function SceneEditor({ id }: { id: string }) {
  const dir = useStore((s) => s.dir)!;
  const typewriter = useStore((s) => s.typewriter);
  const smartTypography = useStore((s) => s.smartTypography);
  const spellcheck = useStore((s) => s.spellcheck);
  const search = useStore((s) => s.search);
  const searchActive = useStore((s) => s.leftTab === "search" && s.leftOpen);
  const jump = useStore((s) => s.jump);
  const applySearchRef = useRef<() => void>(() => {});
  const currentHit = useRef<{ key: string; index: number } | null>(null);
  const dirty = useRef(false);
  /** When the text first became unsaved, for MAX_SAVE_WAIT_MS. */
  const dirtySince = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const journalTimer = useRef<number | undefined>(undefined);
  /** Journal writes and clears run in order, so a slow write never lands after a clear. */
  const journalChain = useRef<Promise<unknown>>(Promise.resolve());
  const scanTimer = useRef<number | undefined>(undefined);
  const scanSeq = useRef(0);
  const scanRef = useRef<() => Promise<void>>(async () => {});
  const mentionsOn = useStore((s) => s.mentionsOn);
  const codexVersion = useStore((s) => s.codexVersion);
  const mtime = useRef(0);
  const loading = useRef(true);
  /** The text as last read from or written to the file, to tell a real outside change from our own save. */
  const lastText = useRef<string | null>(null);
  const loadedOnce = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const typewriterRef = useRef(typewriter);
  typewriterRef.current = typewriter;

  // AI state for this scene.
  const handleRef = useRef<EditorHandle | null>(null);
  const messages = useRef(new Map<string, Message[]>());
  const streaming = useRef(new Set<string>());
  const orphansRef = useRef<SuggestionRecord[]>([]);
  const [orphans, setOrphans] = useState<SuggestionRecord[]>([]);
  const lastMeta = useRef("");
  const lastComments = useRef("[]");
  const comments = useAi((s) => s.comments[id]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown,
      Highlight,
      Footnote,
      CommentShortcut,
      Suggestion,
      SuggestionOriginal,
      SuggestionControls.configure({
        onAccept: (sid) => handleRef.current && void acceptSuggestion(handleRef.current, sid),
        onReject: (sid) => handleRef.current && rejectSuggestion(handleRef.current, sid),
        onRegenerate: (sid) => handleRef.current && regenerateSuggestion(handleRef.current, sid),
        isStreaming: (sid) => handleRef.current?.streaming.has(sid) ?? false,
        canRegenerate: (sid) => !!handleRef.current && canRegenerate(handleRef.current, sid),
      }),
      CommentMarks.configure({
        onClick: (cid) => {
          useAi.getState().set({ focusComment: cid });
          useStore.getState().set({ rightTab: "comments" });
        },
      }),
      Focus.configure({ className: "has-focus", mode: "deepest" }),
      SearchHighlight,
      FindHighlight,
      SmoothCaret,
      ...(smartTypography ? [Typography] : []),
      Mentions.configure({
        onOpen: (ids) => useStore.getState().set({ refId: ids[0], rightTab: "reference", hover: null }),
        onHover: (ids, rect) => useStore.getState().set({ hover: ids && rect ? { ids, rect } : null }),
      }),
    ],
    content: "",
    contentType: "markdown",
    editorProps: { attributes: { spellcheck: String(useStore.getState().spellcheck), class: "prose" } },
    onFocus: () => handleRef.current && setActive(handleRef.current),
    onUpdate: () => {
      if (loading.current) return;
      markDirtyRef.current();
      window.clearTimeout(scanTimer.current);
      scanTimer.current = window.setTimeout(() => void scanRef.current(), SCAN_DELAY_MS);
    },
    onSelectionUpdate: ({ editor }) => {
      if (!typewriterRef.current || !editor.isFocused) return;
      const view = editor.view;
      const scroller = view.dom.closest(".editor-scroll") as HTMLElement | null;
      if (!scroller) return;
      const c = view.coordsAtPos(view.state.selection.head);
      const box = scroller.getBoundingClientRect();
      scroller.scrollTop += c.top - (box.top + box.height / 2);
    },
  }, [smartTypography]);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const journal = useCallback(
    (op: () => Promise<unknown>) => {
      journalChain.current = journalChain.current.then(op).catch(() => {
        /* the journal is best effort; autosave is the real save */
      });
    },
    [],
  );

  const saveNow = useCallback(async () => {
    window.clearTimeout(timer.current);
    const ed = editorRef.current;
    // Never write before the scene's text has loaded: the editor is still empty and would wipe the file.
    if (!ed || ed.isDestroyed || !dirty.current || loading.current) return;
    dirty.current = false;
    try {
      const doc = ed.state.doc;
      const md = sceneMarkdown(ed);
      await invoke("write_scene", { dir, id, content: md });
      lastText.current = md;
      // Saved, and nothing typed meanwhile: the journal is no longer needed.
      if (!dirty.current) {
        window.clearTimeout(journalTimer.current);
        journalTimer.current = undefined;
        journal(() => invoke("clear_recovery", { dir, id }));
      }

      const suggestions = toRecords(doc, (sid) => messages.current.get(sid));
      const list = useAi.getState().comments[id] ?? [];
      const meta = suggestions.length || orphansRef.current.length || list.length ? JSON.stringify({ version: 1, suggestions, orphans: orphansRef.current, comments: list }) : "";
      if (meta !== lastMeta.current) {
        await invoke("write_scene_meta", { dir, id, content: meta });
        lastMeta.current = meta;
      }
      mtime.current = await invoke<number>("scene_modified", { dir, id });
      setSaveError(null);
      void useStore.getState().refreshCounts();
    } catch (e) {
      dirty.current = true;
      setSaveError(String(e));
    }
  }, [dir, id, journal]);

  /** Text changed: schedule the autosave and the recovery journal. */
  const markDirty = useCallback(() => {
    const now = Date.now();
    if (!dirty.current) dirtySince.current = now;
    dirty.current = true;
    window.clearTimeout(timer.current);
    const wait = Math.max(0, Math.min(SAVE_DELAY_MS, dirtySince.current + MAX_SAVE_WAIT_MS - now));
    timer.current = window.setTimeout(() => void saveNow(), wait);
    if (journalTimer.current === undefined) {
      journalTimer.current = window.setTimeout(() => {
        journalTimer.current = undefined;
        const ed = editorRef.current;
        if (!ed || ed.isDestroyed || !dirty.current || loading.current) return;
        const text = sceneMarkdown(ed);
        const at = Date.now();
        journal(() => invoke("write_recovery", { dir, id, text, at }));
      }, JOURNAL_MS);
    }
  }, [dir, id, saveNow, journal]);
  const markDirtyRef = useRef(markDirty);
  markDirtyRef.current = markDirty;

  /** Call after any change to suggestions: refresh the pending count and save. */
  const changed = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    useAi.getState().setPending(id, pendingSids(ed.state.doc).length);
    markDirty();
  }, [id, markDirty]);

  // Let the AI tools drive this editor.
  useEffect(() => {
    if (!editor) return;
    const h: EditorHandle = { id, dir, editor, messages: messages.current, streaming: streaming.current, ready: () => !loading.current, saveNow, changed };
    handleRef.current = h;
    registerHandle(h);
    return () => {
      unregisterHandle(id);
      handleRef.current = null;
    };
  }, [editor, id, dir, saveNow, changed]);

  /** Ask the Rust core for codex mentions in each text block and underline them. */
  const scan = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const n = ++scanSeq.current;
    const doc = ed.state.doc;
    const blocks = collectBlocks(doc);
    const results = useStore.getState().codex.length
      ? await invoke<Mention[][]>("find_mentions", { dir, texts: blocks.map((b) => b.text) }).catch(() => null)
      : blocks.map(() => []);
    if (!results || n !== scanSeq.current || ed.isDestroyed || ed.state.doc !== doc) return;
    ed.view.dispatch(ed.state.tr.setMeta(MENTIONS_META, buildDecorations(doc, blocks, results)));
  }, [dir]);
  scanRef.current = scan;

  // Rescan when the codex changes.
  useEffect(() => {
    if (editor) void scan();
  }, [editor, scan, codexVersion]);
  useEffect(() => () => {
    window.clearTimeout(scanTimer.current);
    window.clearTimeout(journalTimer.current);
  }, []);

  const reload = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    // Loading the disk version over unsaved edits discards them, so drop their journal too.
    const hadEdits = dirty.current;
    if (hadEdits) journal(() => invoke("clear_recovery", { dir, id }));
    const [text, m, metaRaw, stash] = await Promise.all([
      invoke<string>("read_scene", { dir, id }),
      invoke<number>("scene_modified", { dir, id }),
      invoke<string>("read_scene_meta", { dir, id }).catch(() => "{}"),
      loadStash(dir, id),
    ]);
    let meta: Sidecar = {};
    try {
      meta = JSON.parse(metaRaw) as Sidecar;
    } catch {
      /* a damaged sidecar is ignored; the text is what matters */
    }
    // The file holds what the editor already has (our own save, or a second load racing the first): nothing to do.
    if (loadedOnce.current && !hadEdits && text === lastText.current) {
      mtime.current = m;
      setConflict(false);
      return;
    }
    // After the first load, new text comes from outside (a snapshot restore, replace all, another program):
    // it goes in as one step that Cmd+Z can take back, instead of wiping the undo history.
    const external = loadedOnce.current;
    loading.current = true;
    if (external) ed.view.dispatch(closeHistory(ed.state.tr));
    ed.commands.setContent(text, { emitUpdate: false, contentType: "markdown" });
    lastText.current = text;

    // Put pending suggestions back; any that cannot be placed become orphans.
    const records = meta.suggestions ?? [];
    const orphaned = [...(meta.orphans ?? [])];
    if (records.length) {
      const r = restoreRecords(ed.state, records);
      if (r.tr) ed.view.dispatch(r.tr.setMeta(AI_META, true).setMeta("addToHistory", false));
      orphaned.push(...r.orphans);
      for (const rec of records) if (rec.messages) messages.current.set(rec.sid, rec.messages);
    }
    orphansRef.current = orphaned;
    setOrphans(orphaned);
    const comments = meta.comments ?? [];
    lastComments.current = JSON.stringify(comments);
    useAi.getState().setSceneComments(id, comments);
    applyComments(ed, comments);
    useAi.getState().setPending(id, pendingSids(ed.state.doc).length);
    // The first load must not be undoable; bring back this scene's earlier undo steps if its text is unchanged.
    if (!external) restoreHistory(stash, ed);
    loadedOnce.current = true;
    loading.current = false;

    lastMeta.current = metaRaw.trim() === "{}" ? "" : metaRaw;
    mtime.current = m;
    dirty.current = orphaned.length !== (meta.orphans ?? []).length; // persist newly orphaned suggestions
    if (dirty.current) timer.current = window.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
    setConflict(false);
    void scanRef.current();
    applySearchRef.current();
  }, [dir, id, saveNow, journal]);

  useEffect(() => {
    editor?.view.dom.setAttribute("spellcheck", String(spellcheck));
  }, [editor, spellcheck]);

  // Search panel: highlight its query here, and select a match it jumped to.
  const applySearch = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed || loading.current) return;
    const j = useStore.getState().jump;
    const mine = j && j.id === id ? j : null;
    const q = mine ? mine.query : search;
    // Keep the jumped-to match marked until the query itself changes.
    const qKey = `${q.q}\u0000${q.caseSensitive}\u0000${q.wholeWord}`;
    if (mine) currentHit.current = { key: qKey, index: mine.index };
    else if (j) currentHit.current = null; // the jump went to another scene
    const current = currentHit.current?.key === qKey ? currentHit.current.index : -1;
    const state = (searchActive || mine) && q.q ? { query: q.q, opts: { caseSensitive: q.caseSensitive, wholeWord: q.wholeWord }, current } : null;
    ed.view.dispatch(ed.state.tr.setMeta(SEARCH_META, state).setMeta("addToHistory", false));
    if (mine) {
      (ed.view.dom.querySelector(".search-hit.current") as HTMLElement | null)?.scrollIntoView({ block: "center" });
      useStore.getState().set({ jump: null });
    }
  }, [id, search, searchActive]);
  applySearchRef.current = applySearch;
  useEffect(() => {
    applySearch();
  }, [editor, applySearch, jump]);

  // Initial load.
  useEffect(() => {
    if (editor) void reload();
  }, [editor, reload]);

  // Comments changed elsewhere (deleted in the panel, or a new feedback run): redraw and save.
  useEffect(() => {
    const ed = editorRef.current;
    // Comments are applied by reload() once the text is in; marking the scene dirty before that saves an empty editor.
    if (!ed || ed.isDestroyed || comments === undefined || loading.current) return;
    const json = JSON.stringify(comments);
    if (json === lastComments.current) return;
    lastComments.current = json;
    applyComments(ed, comments);
    changed();
  }, [comments, changed]);

  // Register for flush-on-close; flush on unmount (e.g. switching scenes).
  useEffect(() => {
    flushers.add(saveNow);
    const saveHistory = async () => {
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed && !loading.current) await stashHistory(dir, id, ed);
    };
    historySavers.add(saveHistory);
    return () => {
      flushers.delete(saveNow);
      historySavers.delete(saveHistory);
      // Keep the undo steps for when the scene is opened again (not from a half-loaded editor).
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed && !loading.current) stashHistory(dir, id, ed);
      void saveNow();
    };
  }, [saveNow, dir, id]);

  // Detect edits made outside the app (external editor, file-sync tool).
  useEffect(() => {
    const t = window.setInterval(async () => {
      try {
        const m = await invoke<number>("scene_modified", { dir, id });
        if (m === mtime.current || m === 0) return;
        if (dirty.current) setConflict(true);
        else await reload();
      } catch {
        /* ignore transient errors */
      }
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [dir, id, reload]);

  const dropOrphan = (sid: string) => {
    orphansRef.current = orphansRef.current.filter((o) => o.sid !== sid);
    setOrphans(orphansRef.current);
    changed();
  };

  if (!editor) return null;
  return (
    <div className={`scene ${mentionsOn ? "" : "no-mentions"}`}>
      {conflict && (
        <div className="banner warn">
          This scene changed on disk while you have unsaved edits.
          <button onClick={() => void reload()}>Load disk version</button>
          <button
            onClick={async () => {
              mtime.current = await invoke<number>("scene_modified", { dir, id });
              setConflict(false);
              dirty.current = true;
              void saveNow();
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      {saveError && <div className="banner warn">Save failed: {saveError}</div>}
      {orphans.map((o) => (
        <div key={o.sid} className="banner warn orphan">
          <span>
            An AI suggestion could not be placed because the surrounding text changed: <em>“{o.text.slice(0, 120)}
            {o.text.length > 120 ? "…" : ""}”</em>
          </span>
          <button
            onClick={() => {
              if (handleRef.current) insertAsSuggestion(handleRef.current, o.text, o.tool, o.model, o.messages);
              dropOrphan(o.sid);
            }}
          >
            Insert at cursor
          </button>
          <button onClick={() => dropOrphan(o.sid)}>Discard</button>
        </div>
      ))}
      <EditorContent editor={editor} />
    </div>
  );
}
