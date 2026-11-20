// SPDX-License-Identifier: GPL-3.0-only
// Keeps each scene's undo history alive while its editor is unmounted (switching scenes).
import type { Node } from "@tiptap/pm/model";
import type { EditorState, Plugin } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

type HistoryState = unknown;
interface Stash {
  doc: Node;
  history: HistoryState;
}

/** Oldest first; a Map keeps insertion order, so the first key is the least recently used. */
const stashes = new Map<string, Stash>();
const MAX_STASHED = 50;
const keyOf = (dir: string, id: string) => `${dir}\u0000${id}`;

/** prosemirror-history does not export its plugin key, so find the plugin by the key's name. */
function historyPlugin(state: EditorState): Plugin | undefined {
  return state.plugins.find((p) => p.spec.key && String((p.spec.key as unknown as { key: string }).key).startsWith("history$"));
}

/** Put a history state into the editor. prosemirror-history returns a transaction's `historyState` meta as is. */
function setHistory(ed: Editor, h: HistoryState) {
  const p = historyPlugin(ed.state);
  if (p) ed.view.dispatch(ed.state.tr.setMeta(p, { historyState: h }).setMeta("addToHistory", false));
}

/** Forget all undo steps. Loading a scene is not something Cmd+Z should be able to undo. */
export function resetHistory(ed: Editor) {
  const init = historyPlugin(ed.state)?.spec.state?.init;
  if (init) setHistory(ed, init.call(null, {}, ed.state));
}

/** Remember the editor's undo history for when this scene is opened again. */
export function stashHistory(dir: string, id: string, ed: Editor) {
  const h = historyPlugin(ed.state)?.getState(ed.state);
  if (h === undefined) return;
  const k = keyOf(dir, id);
  stashes.delete(k);
  stashes.set(k, { doc: ed.state.doc, history: h });
  if (stashes.size > MAX_STASHED) stashes.delete(stashes.keys().next().value as string);
}

/**
 * Bring back the stashed history, but only if the scene's text is exactly what it was when
 * the history was taken (steps from a different document would corrupt it). Otherwise start fresh.
 */
export function restoreHistory(dir: string, id: string, ed: Editor) {
  const s = stashes.get(keyOf(dir, id));
  if (s && ed.state.doc.eq(s.doc)) setHistory(ed, s.history);
  else resetHistory(ed);
}
