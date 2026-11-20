// SPDX-License-Identifier: GPL-3.0-only
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ORIGINAL, pendingSids, sidRanges, SUGGESTION } from "./suggestions";

/** Set on every transaction that adds or resolves a suggestion, so controls are recomputed. */
export const AI_META = "aiSuggestion";

const attrs = { sid: { default: "" }, tool: { default: "" }, model: { default: "" } };

/** New text proposed by the AI: tint plus a left bar. Not saved in the Markdown. */
export const Suggestion = Mark.create({
  name: SUGGESTION,
  inclusive: false,
  addAttributes() {
    return attrs;
  },
  parseHTML() {
    return [{ tag: "span[data-suggestion]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "suggestion", "data-suggestion": "", "data-sid": HTMLAttributes.sid, title: `AI suggestion (${HTMLAttributes.tool || "ai"}, ${HTMLAttributes.model || "model"})` }), 0];
  },
});

/** Text a replace-suggestion would replace, shown struck through next to the new text. */
export const SuggestionOriginal = Mark.create({
  name: ORIGINAL,
  inclusive: false,
  addAttributes() {
    return { sid: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-suggestion-original]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "suggestion-original", "data-suggestion-original": "", "data-sid": HTMLAttributes.sid }), 0];
  },
});

export interface SuggestionControlsOptions {
  onAccept: (sid: string) => void;
  onReject: (sid: string) => void;
  onRegenerate: (sid: string) => void;
  /** Controls are hidden while a suggestion is still streaming in. */
  isStreaming: (sid: string) => boolean;
  canRegenerate: (sid: string) => boolean;
}

const key = new PluginKey<DecorationSet>("suggestionControls");

/** Accept / Reject / Regenerate buttons after each pending suggestion. */
export const SuggestionControls = Extension.create<SuggestionControlsOptions>({
  name: "suggestionControls",
  addOptions() {
    return { onAccept: () => {}, onReject: () => {}, onRegenerate: () => {}, isStreaming: () => false, canRegenerate: () => false };
  },
  addProseMirrorPlugins() {
    const o = this.options;
    const build = (doc: Parameters<typeof pendingSids>[0]) => {
      const decos: Decoration[] = [];
      for (const sid of pendingSids(doc)) {
        const { added } = sidRanges(doc, sid);
        if (!added || o.isStreaming(sid)) continue;
        decos.push(
          Decoration.widget(
            added.to,
            () => {
              const bar = document.createElement("span");
              bar.className = "suggestion-controls";
              bar.contentEditable = "false";
              const btn = (label: string, cls: string, run: () => void) => {
                const b = document.createElement("button");
                b.textContent = label;
                b.className = cls;
                b.type = "button";
                b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor selection
                b.addEventListener("click", (e) => (e.preventDefault(), run()));
                bar.appendChild(b);
              };
              btn("Accept", "accept", () => o.onAccept(sid));
              btn("Reject", "reject", () => o.onReject(sid));
              if (o.canRegenerate(sid)) btn("Regenerate", "regen", () => o.onRegenerate(sid));
              return bar;
            },
            { side: 1, key: `ctl-${sid}` },
          ),
        );
      }
      return DecorationSet.create(doc, decos);
    };
    return [
      new Plugin({
        key,
        state: {
          init: (_c, state) => build(state.doc),
          apply(tr, old) {
            if (!tr.docChanged) return tr.getMeta(AI_META) ? build(tr.doc) : old;
            // Recompute only when a suggestion could have appeared or changed; otherwise follow the edits.
            if (tr.getMeta(AI_META) || tr.getMeta("history$")) return build(tr.doc);
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
