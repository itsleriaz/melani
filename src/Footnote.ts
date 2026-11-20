// SPDX-License-Identifier: GPL-3.0-only
// Footnotes: a small numbered mark in the text that carries its note. In the .md file a note is
// written inline as ^[the note], which Pandoc (and so .docx and .epub export) and Obsidian read.
import { Node } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { create } from "zustand";

/** Where the note being edited is, so the popover can sit beside it. */
export const useFootnoteUi = create<{ open: { editor: Editor; pos: number; rect: DOMRect } | null }>(() => ({ open: null }));

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: {
      insertFootnote: () => ReturnType;
    };
  }
}

/** Notes are one line of plain text: line breaks become spaces, and brackets are escaped in the file. */
export const cleanNote = (s: string) => s.replace(/\s*\n\s*/g, " ");
export const escapeNote = (s: string) => cleanNote(s).replace(/([\\[\]])/g, "\\$1");

/** Read `^[note]` from the start of `src`: the note and how much of `src` it used. */
export function readNote(src: string): { note: string; length: number } | null {
  if (!src.startsWith("^[")) return null;
  let note = "";
  let depth = 0;
  for (let i = 2; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      note += src[++i];
    } else if (ch === "\n") {
      return null;
    } else if (ch === "[") {
      depth++;
      note += ch;
    } else if (ch === "]") {
      if (depth === 0) return { note, length: i + 1 };
      depth--;
      note += ch;
    } else {
      note += ch;
    }
  }
  return null;
}

function openAt(editor: Editor, pos: number) {
  const el = editor.view.nodeDOM(pos) as HTMLElement | null;
  if (el) useFootnoteUi.setState({ open: { editor, pos, rect: el.getBoundingClientRect() } });
}

export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { note: { default: "", parseHTML: (el) => el.getAttribute("data-note") ?? "" } };
  },
  parseHTML() {
    return [{ tag: "sup[data-footnote]" }];
  },
  renderHTML({ node }) {
    const note = node.attrs.note as string;
    return ["sup", { class: "footnote", "data-footnote": "", "data-note": note, "data-tip": note || "Empty footnote. Click to write it." }];
  },
  addCommands() {
    return {
      insertFootnote: () => ({ editor, chain }) => {
        const ok = chain().insertContent({ type: "footnote", attrs: { note: "" } }).run();
        // The cursor is now just after the new mark.
        requestAnimationFrame(() => openAt(editor, editor.state.selection.from - 1));
        return ok;
      },
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Alt-f": () => this.editor.commands.insertFootnote() };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handleClickOn: (_view, _pos, node, nodePos) => {
            if (node.type.name !== "footnote") return false;
            openAt(editor, nodePos);
            return true;
          },
        },
      }),
    ];
  },
  markdownTokenName: "footnote",
  markdownTokenizer: {
    name: "footnote",
    level: "inline",
    start: (src: string) => src.indexOf("^["),
    tokenize(src) {
      const r = readNote(src);
      return r ? { type: "footnote", raw: src.slice(0, r.length), note: r.note } : undefined;
    },
  },
  parseMarkdown: (token, h) => h.createNode("footnote", { note: (token as { note?: string }).note ?? "" }),
  renderMarkdown: (node) => `^[${escapeNote((node.attrs?.note as string) ?? "")}]`,
});
