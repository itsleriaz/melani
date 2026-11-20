// SPDX-License-Identifier: GPL-3.0-only
// The author's own comments on passages. They share storage with the AI's line feedback
// (the scene's sidecar file), and never change the text.
import { Extension } from "@tiptap/core";
import type { SceneComment } from "./ai";
import { useAi } from "./aiStore";
import { getActive } from "./editorRegistry";
import { useStore } from "./store";

/** A comment is the author's own when it was not written by an AI tool. */
export const isAuthor = (c: SceneComment) => c.tool === "author";

/** Start a comment on the selected text: it appears in the Comments panel, ready to type in. */
export function addCommentFromSelection(): boolean {
  const h = getActive();
  if (!h) return false;
  const { from, to } = h.editor.state.selection;
  const passage = h.editor.state.doc.textBetween(from, to, " ").trim();
  if (!passage) {
    useStore.getState().set({ error: "Select the words you want to comment on first." });
    return false;
  }
  const ai = useAi.getState();
  const c: SceneComment = { id: crypto.randomUUID(), passage, comment: "", tool: "author", model: "", at: from, created: Date.now() };
  ai.setSceneComments(h.id, [...(ai.comments[h.id] ?? []), c]);
  ai.set({ focusComment: c.id });
  useStore.getState().set({ rightTab: "comments", error: null });
  return true;
}

/** Change one comment in a scene. */
export function updateComment(sceneId: string, id: string, patch: Partial<SceneComment>) {
  const ai = useAi.getState();
  ai.setSceneComments(sceneId, (ai.comments[sceneId] ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

export function removeComment(sceneId: string, id: string) {
  const ai = useAi.getState();
  ai.setSceneComments(sceneId, (ai.comments[sceneId] ?? []).filter((c) => c.id !== id));
}

/** Cmd/Ctrl+Alt+M comments on the selection, as in Word and Google Docs. */
export const CommentShortcut = Extension.create({
  name: "commentShortcut",
  addKeyboardShortcuts() {
    return { "Mod-Alt-m": () => addCommentFromSelection() };
  },
});
