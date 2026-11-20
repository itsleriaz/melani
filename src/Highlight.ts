// SPDX-License-Identifier: GPL-3.0-only
// Highlights: a coloured mark over a passage. In the .md file a yellow one is ==text==, and the
// others are =={blue}text==, so the words still count the same and the file stays readable anywhere.
import { Mark, mergeAttributes } from "@tiptap/core";

export const HIGHLIGHTS = ["yellow", "green", "blue", "pink", "orange"] as const;
export type HighlightColor = (typeof HIGHLIGHTS)[number];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    highlight: {
      setHighlight: (color?: HighlightColor) => ReturnType;
      toggleHighlight: (color?: HighlightColor) => ReturnType;
      unsetHighlight: () => ReturnType;
    };
  }
}

const SYNTAX = new RegExp(`^==(?:\\{(${HIGHLIGHTS.join("|")})\\})?(?=[^\\s=])([^\\n]*?[^\\s=])==(?!=)`);

export const Highlight = Mark.create({
  name: "highlight",
  inclusive: false,
  addAttributes() {
    return {
      color: {
        default: "yellow",
        parseHTML: (el) => el.getAttribute("data-color") || "yellow",
        renderHTML: (attrs) => ({ "data-color": attrs.color }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "mark" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setHighlight: (color = "yellow") => ({ commands }) => commands.setMark(this.name, { color }),
      toggleHighlight: (color = "yellow") => ({ commands, editor }) => (editor.isActive(this.name, { color }) ? commands.unsetMark(this.name) : commands.setMark(this.name, { color })),
      unsetHighlight: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Shift-h": () => this.editor.commands.toggleHighlight() };
  },
  markdownTokenName: "highlight",
  markdownTokenizer: {
    name: "highlight",
    level: "inline",
    start: (src: string) => src.indexOf("=="),
    tokenize(src, _tokens, lexer) {
      const m = SYNTAX.exec(src);
      if (!m) return undefined;
      return { type: "highlight", raw: m[0], color: m[1] ?? "yellow", text: m[2], tokens: lexer.inlineTokens(m[2]) };
    },
  },
  parseMarkdown: (token, h) => h.applyMark("highlight", h.parseInline(token.tokens || []), { color: (token as { color?: string }).color ?? "yellow" }),
  renderMarkdown: (node, h) => {
    const color = node.attrs?.color as string | undefined;
    return `==${color && color !== "yellow" ? `{${color}}` : ""}${h.renderChildren(node)}==`;
  },
});
