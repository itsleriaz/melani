// SPDX-License-Identifier: GPL-3.0-only
// Keeps each scene's undo history alive while its editor is unmounted (switching scenes).
//
// Every Tiptap editor builds its own ProseMirror schema, so history steps from one editor cannot be
// applied in another. The history is therefore stashed as plain document JSON (one snapshot per undo
// event) and replayed into the new editor as minimal replace steps, which rebuilds a real history.
import { Node } from "@tiptap/pm/model";
import type { EditorState, Plugin } from "@tiptap/pm/state";
import { closeHistory, redo, undo } from "@tiptap/pm/history";
import { invoke } from "@tauri-apps/api/core";
import type { Editor } from "@tiptap/core";

type Json = Record<string, unknown>;
export interface Stash {
  /** The document after each undo event, oldest first; docs[0] is the state before any undoable edit. */
  docs: Json[];
  /** Which snapshot is on screen; earlier edits that were undone sit after it (the redo stack). */
  at: number;
}

/** Oldest first; a Map keeps insertion order, so the first key is the least recently used. */
const stashes = new Map<string, Stash>();
const MAX_STASHED = 50;
const keyOf = (dir: string, id: string) => `${dir}\u0000${id}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** prosemirror-history does not export its plugin key, so find the plugin by the key's name. */
function historyPlugin(state: EditorState): Plugin | undefined {
  return state.plugins.find((p) => p.spec.key && String((p.spec.key as unknown as { key: string }).key).startsWith("history$"));
}

/** Forget all undo steps. Loading a scene is not something Cmd+Z should be able to undo. */
export function resetHistory(ed: Editor) {
  const p = historyPlugin(ed.state);
  const init = p?.spec.state?.init;
  if (p && init) ed.view.dispatch(ed.state.tr.setMeta(p, { historyState: init.call(null, {}, ed.state) }).setMeta("addToHistory", false));
}

/** What is kept between sessions: this many undo steps, and this much text, per scene. */
export const SAVED_STEPS = 30;
export const SAVED_BYTES = 1_500_000;

/** Trim a stash to the steps nearest the current one, and to a size that is fine to write on every scene switch. */
export function capStash(s: Stash, steps = SAVED_STEPS, bytes = SAVED_BYTES): Stash {
  let from = Math.max(0, s.at - steps);
  let to = Math.min(s.docs.length - 1, s.at + steps);
  let size = s.docs.slice(from, to + 1).reduce((n, d) => n + JSON.stringify(d).length, 0);
  // Over budget: drop the oldest steps first, then the furthest redo steps.
  while (size > bytes && to > from) {
    const drop = from < s.at ? from++ : to--;
    size -= JSON.stringify(s.docs[drop]).length;
  }
  return { docs: s.docs.slice(from, to + 1), at: s.at - from };
}

/** The text a saved file holds, or null when it is not a usable history. */
export function parseStash(raw: string): Stash | null {
  try {
    const j = JSON.parse(raw) as { v?: number; docs?: unknown; at?: unknown };
    if (j.v !== 1 || !Array.isArray(j.docs) || typeof j.at !== "number" || !Number.isInteger(j.at)) return null;
    if (j.at < 0 || j.at >= j.docs.length || j.docs.length < 2) return null;
    if (!j.docs.every((d) => d && typeof d === "object" && (d as Json).type === "doc")) return null;
    return { docs: j.docs as Json[], at: j.at };
  } catch {
    return null;
  }
}

/** Snapshot the editor's undo and redo stacks as documents. */
export function snapshotHistory(state: EditorState): Stash | null {
  if (!historyPlugin(state)) return null;
  const step = (cmd: typeof undo, s: EditorState) => {
    let next = s;
    const ok = cmd(s, (tr) => void (next = s.apply(tr)));
    return ok ? next : null;
  };
  let s = state;
  let redone = 0;
  for (let n = step(redo, s); n; n = step(redo, s)) (s = n), redone++;
  const docs: Json[] = [s.doc.toJSON()];
  for (let n = step(undo, s); n; n = step(undo, s)) (s = n), docs.unshift(s.doc.toJSON());
  return { docs, at: docs.length - 1 - redone };
}

/**
 * Remember the editor's undo history for when this scene is opened again, in memory and on disk
 * (so it also survives closing the app). Resolves once the file is written.
 */
export function stashHistory(dir: string, id: string, ed: Editor): Promise<void> {
  const snap = snapshotHistory(ed.state);
  if (!snap) return Promise.resolve();
  const k = keyOf(dir, id);
  stashes.delete(k);
  if (snap.docs.length < 2) return invoke<void>("clear_history", { dir, name: id }).catch(() => {});
  const kept = capStash(snap);
  stashes.set(k, kept);
  if (stashes.size > MAX_STASHED) stashes.delete(stashes.keys().next().value as string);
  return invoke<void>("write_history", { dir, name: id, content: JSON.stringify({ v: 1, ...kept }) }).catch(() => {
    /* history is a convenience; failing to save it must never get in the way of the text */
  });
}

/** The stash for a scene: from memory if it was opened this session, else from the file. */
export async function loadStash(dir: string, id: string): Promise<Stash | null> {
  const mem = stashes.get(keyOf(dir, id));
  if (mem) return mem;
  try {
    const raw = await invoke<string>("read_history", { dir, name: id });
    return raw ? parseStash(raw) : null;
  } catch {
    return null;
  }
}

/** Replace what changed between the current document and `next`, as one undo event. */
function replayTo(ed: Editor, next: Node) {
  const cur = ed.state.doc;
  const start = cur.content.findDiffStart(next.content);
  if (start == null) return;
  const end = cur.content.findDiffEnd(next.content);
  if (!end) return;
  let { a: endA, b: endB } = end;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) (endA += overlap), (endB += overlap);
  ed.view.dispatch(closeHistory(ed.state.tr.replace(start, endA, next.slice(start, endB))));
}

function replaceAll(ed: Editor, doc: Node) {
  ed.view.dispatch(ed.state.tr.replaceWith(0, ed.state.doc.content.size, doc.content).setMeta("addToHistory", false));
}

/**
 * Bring back the stashed history, but only if the scene's text is exactly what it was when
 * the history was taken. Otherwise start fresh.
 */
export function restoreHistory(s: Stash | null, ed: Editor) {
  const loaded = ed.state.doc;
  resetHistory(ed);
  if (!s || !same(s.docs[s.at], loaded.toJSON())) return;
  try {
    const schema = ed.state.schema;
    const docs = s.docs.map((d) => Node.fromJSON(schema, d));
    replaceAll(ed, docs[0]);
    resetHistory(ed);
    for (let i = 1; i < docs.length; i++) replayTo(ed, docs[i]);
    for (let i = docs.length - 1; i > s.at; i--) undo(ed.state, ed.view.dispatch);
    if (same(ed.state.doc.toJSON(), loaded.toJSON())) return;
  } catch {
    /* fall through: put the loaded text back */
  }
  replaceAll(ed, loaded);
  resetHistory(ed);
}
