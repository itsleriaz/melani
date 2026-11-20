// SPDX-License-Identifier: GPL-3.0-only
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Mention } from "./codexTypes";

const key = new PluginKey<DecorationSet>("mentions");

export interface MentionsOptions {
  onOpen: (entries: string[]) => void;
  onHover: (entries: string[] | null, rect?: DOMRect) => void;
}

export interface Block {
  /** Document position of the first character inside the block. */
  pos: number;
  text: string;
}

/** Text of every textblock. Leaf nodes (hard breaks) count as one "\n" so offsets line up. */
export function collectBlocks(doc: PMNode): Block[] {
  const out: Block[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push({ pos: pos + 1, text: node.textBetween(0, node.content.size, undefined, "\n") });
      return false;
    }
    return true;
  });
  return out;
}

export function buildDecorations(doc: PMNode, blocks: Block[], results: Mention[][]): DecorationSet {
  const decos: Decoration[] = [];
  blocks.forEach((b, i) => {
    for (const m of results[i] ?? []) {
      decos.push(
        Decoration.inline(b.pos + m.start, b.pos + m.end, {
          class: m.ambiguous ? "mention ambiguous" : "mention",
          "data-entries": m.entries.join(","),
        }),
      );
    }
  });
  return DecorationSet.create(doc, decos);
}

export const MENTIONS_META = key;

export const Mentions = Extension.create<MentionsOptions>({
  name: "mentions",
  addOptions() {
    return { onOpen: () => {}, onHover: () => {} };
  },
  addProseMirrorPlugins() {
    const { onOpen, onHover } = this.options;
    const entriesOf = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.(".mention") as HTMLElement | null;
      return el ? { el, ids: (el.dataset.entries ?? "").split(",").filter(Boolean) } : null;
    };
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const next = tr.getMeta(key) as DecorationSet | undefined;
            return next ?? old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => key.getState(state),
          handleDOMEvents: {
            mouseover: (_v, e) => {
              const hit = entriesOf(e);
              if (hit) onHover(hit.ids, hit.el.getBoundingClientRect());
              return false;
            },
            mouseout: (_v, e) => {
              if (entriesOf(e)) onHover(null);
              return false;
            },
            click: (_v, e) => {
              const hit = entriesOf(e);
              if (hit && (e.ctrlKey || e.metaKey)) {
                onOpen(hit.ids);
                return true;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});
