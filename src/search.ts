// SPDX-License-Identifier: GPL-3.0-only
// Match rules shared by the search panel's editor highlighting. They mirror
// src-tauri/src/search.rs so the n-th match on disk is the n-th match in the editor.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { collectBlocks } from "./Mentions";

export interface MatchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

const WORD = /[\p{L}\p{N}_]/u;

/** [start, end) offsets of every match, left to right, non-overlapping. */
export function findAll(text: string, query: string, opts: MatchOptions): [number, number][] {
  const out: [number, number][] = [];
  if (!query || query.length > text.length) return out;
  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  // toLowerCase can change length for a few characters; fall back to exact matching then.
  const folded = hay.length === text.length && needle.length === query.length;
  const h = folded ? hay : text;
  const n = folded ? needle : query;
  let i = h.indexOf(n);
  while (i !== -1) {
    const end = i + n.length;
    const ok = !opts.wholeWord || ((i === 0 || !WORD.test(text[i - 1])) && (end === text.length || !WORD.test(text[end])));
    if (ok) {
      out.push([i, end]);
      i = h.indexOf(n, end);
    } else {
      i = h.indexOf(n, i + 1);
    }
  }
  return out;
}

/** Document ranges of every match. */
export function docMatches(doc: PMNode, query: string, opts: MatchOptions): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const b of collectBlocks(doc)) for (const [s, e] of findAll(b.text, query, opts)) out.push({ from: b.pos + s, to: b.pos + e });
  return out;
}

export interface HighlightState {
  query: string;
  opts: MatchOptions;
  /** Index of the current match, or -1. */
  current: number;
}

export const SEARCH_META = "searchHighlight";
export const FIND_META = "findHighlight";
type PluginValue = { state: HighlightState | null; deco: DecorationSet };

function build(doc: PMNode, s: HighlightState | null): DecorationSet {
  if (!s || !s.query) return DecorationSet.empty;
  const decos = docMatches(doc, s.query, s.opts).map((m, i) => Decoration.inline(m.from, m.to, { class: i === s.current ? "search-hit current" : "search-hit" }));
  return DecorationSet.create(doc, decos);
}

/** Highlights a query in the editor, driven by a transaction meta. Each instance needs its own name and meta. */
function highlighter(name: string, meta: string) {
  const key = new PluginKey<PluginValue>(name);
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [
        new Plugin<PluginValue>({
          key,
          state: {
            init: (): PluginValue => ({ state: null, deco: DecorationSet.empty }),
            apply(tr, prev): PluginValue {
              const m = tr.getMeta(meta) as HighlightState | null | undefined;
              if (m !== undefined) return { state: m, deco: build(tr.doc, m) };
              if (tr.docChanged && prev.state) return { state: prev.state, deco: build(tr.doc, prev.state) };
              return prev;
            },
          },
          props: { decorations: (state) => key.getState(state)?.deco },
        }),
      ];
    },
  });
}

/** The search panel's query. */
export const SearchHighlight = highlighter("searchHighlight", SEARCH_META);
/** The find bar's query (Ctrl+F), kept apart so the two never overwrite each other. */
export const FindHighlight = highlighter("findHighlight", FIND_META);
