// SPDX-License-Identifier: GPL-3.0-only
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findPassage } from "./suggestions";

const key = new PluginKey<DecorationSet>("comments");

export interface CommentMarksOptions {
  onClick: (id: string) => void;
}

/**
 * Highlights passages that have line-feedback comments. Comments are anchored by their quoted
 * text, so they follow edits in the session and are re-found by search after a reload.
 */
export const CommentMarks = Extension.create<CommentMarksOptions>({
  name: "commentMarks",
  addOptions() {
    return { onClick: () => {} };
  },
  addProseMirrorPlugins() {
    const { onClick } = this.options;
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old) => (tr.getMeta(key) as DecorationSet | undefined) ?? old.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (s) => key.getState(s),
          handleDOMEvents: {
            click: (_v, e) => {
              const el = (e.target as HTMLElement | null)?.closest?.(".comment-mark") as HTMLElement | null;
              if (el?.dataset.comment) onClick(el.dataset.comment);
              return false;
            },
          },
        },
      }),
    ];
  },
});

/** Rebuild the highlights from the current comments. */
export function applyComments(editor: Editor, comments: { id: string; passage: string; comment: string; at?: number; resolved?: boolean }[]): void {
  const doc = editor.state.doc;
  const decos = comments.filter((c) => !c.resolved).flatMap((c) => {
    const r = findPassage(doc, c.passage, c.at ?? 0);
    return r ? [Decoration.inline(r.from, r.to, { class: "comment-mark", "data-comment": c.id, title: c.comment }, { id: c.id })] : [];
  });
  editor.view.dispatch(editor.state.tr.setMeta(key, DecorationSet.create(doc, decos)).setMeta("addToHistory", false));
}

/** Select the commented passage and scroll to it. Returns false if it can no longer be found. */
export function jumpToPassage(editor: Editor, passage: string, at?: number): boolean {
  const r = findPassage(editor.state.doc, passage, at ?? editor.state.selection.head);
  if (!r) return false;
  editor.chain().setTextSelection({ from: r.from, to: r.to }).scrollIntoView().run();
  return true;
}
