// SPDX-License-Identifier: GPL-3.0-only
// Keeps each scene's undo history alive while its editor is unmounted (switching scenes).
//
// Every Tiptap editor builds its own ProseMirror schema, so history steps from one editor cannot be
// applied in another. The history is therefore stashed as plain document JSON (one snapshot per undo
// event) and replayed into the new editor as minimal replace steps, which rebuilds a real history.
import { Node } from "@tiptap/pm/model";
import type { EditorState, Plugin } from "@tiptap/pm/state";
import { closeHistory, redo, undo } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/core";

type Json = Record<string, unknown>;
interface Stash {
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

/** Remember the editor's undo history for when this scene is opened again. */
export function stashHistory(dir: string, id: string, ed: Editor) {
  const snap = snapshotHistory(ed.state);
  if (!snap) return;
  const k = keyOf(dir, id);
  stashes.delete(k);
  if (snap.docs.length > 1) stashes.set(k, snap);
  if (stashes.size > MAX_STASHED) stashes.delete(stashes.keys().next().value as string);
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
export function restoreHistory(dir: string, id: string, ed: Editor) {
  const s = stashes.get(keyOf(dir, id));
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
