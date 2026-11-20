// SPDX-License-Identifier: GPL-3.0-only
// Match rules shared by the search panel's editor highlighting. They mirror
// src-tauri/src/search.rs so the n-th match on disk is the n-th match in the editor.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { collectBlocks } from "./Mentions";
import { ORIGINAL, SUGGESTION } from "./suggestions";

export interface MatchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Treat the query as a regular expression. Only the find bar uses this: it is the one place the JS engine alone decides the matches. */
  regex?: boolean;
}

const WORD = /[\p{L}\p{N}_]/u;

/** The query as a RegExp (global, Unicode), or an error message when it is not a valid pattern. */
export function compilePattern(query: string, opts: MatchOptions): RegExp | string {
  try {
    const src = opts.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${query})(?![\\p{L}\\p{N}_])` : query;
    return new RegExp(src, opts.caseSensitive ? "gu" : "giu");
  } catch {
    return "Invalid pattern";
  }
}

/** Why the query cannot be searched, or null when it is fine (or not a regex). */
export function patternError(query: string, opts: MatchOptions): string | null {
  if (!opts.regex || !query) return null;
  const r = compilePattern(query, opts);
  return typeof r === "string" ? r : null;
}

/** Every non-empty regex match with its capture groups, left to right. */
function regexMatches(text: string, query: string, opts: MatchOptions): { start: number; end: number; m: RegExpExecArray }[] {
  const re = compilePattern(query, opts);
  const out: { start: number; end: number; m: RegExpExecArray }[] = [];
  if (typeof re === "string") return out;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") re.lastIndex++; // a pattern that can match nothing must not loop forever
    else out.push({ start: m.index, end: m.index + m[0].length, m });
  }
  return out;
}

/** The replacement text for one regex match: $1, $<name>, $& and $$ work as in JavaScript. */
export function expandReplacement(replacement: string, m: RegExpExecArray): string {
  return replacement.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (all, tok: string, name?: string) => {
    if (tok === "$") return "$";
    if (tok === "&") return m[0];
    if (name !== undefined) return m.groups?.[name] ?? "";
    const n = Number(tok);
    if (tok.length === 2 && n >= m.length) {
      // "$10" with fewer than ten groups is group 1 followed by a 0.
      const first = Number(tok[0]);
      return first > 0 && first < m.length ? (m[first] ?? "") + tok[1] : all;
    }
    return n > 0 && n < m.length ? (m[n] ?? "") : all;
  });
}

/** [start, end) offsets of every match, left to right, non-overlapping. */
export function findAll(text: string, query: string, opts: MatchOptions): [number, number][] {
  if (opts.regex) return query ? regexMatches(text, query, opts).map((r) => [r.start, r.end]) : [];
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

/** Document ranges of every match (with the regex match, when the query is one, for its capture groups). */
export function docMatches(doc: PMNode, query: string, opts: MatchOptions): { from: number; to: number; m?: RegExpExecArray }[] {
  const out: { from: number; to: number; m?: RegExpExecArray }[] = [];
  for (const b of collectBlocks(doc)) {
    if (opts.regex) for (const r of query ? regexMatches(b.text, query, opts) : []) out.push({ from: b.pos + r.start, to: b.pos + r.end, m: r.m });
    else for (const [s, e] of findAll(b.text, query, opts)) out.push({ from: b.pos + s, to: b.pos + e });
  }
  return out;
}

/**
 * One transaction that replaces matches with `replacement`: only the match at `index` when given, else all
 * of them. Matches inside a pending AI suggestion are left alone (those are accepted or rejected, not edited)
 * and counted as `skipped`. Null when there is nothing to replace.
 */
export function replaceMatches(state: EditorState, query: string, opts: MatchOptions, replacement: string, index?: number): { tr: Transaction; count: number; skipped: number } | null {
  const all = docMatches(state.doc, query, opts);
  const picked = index === undefined ? all : all[index] ? [all[index]] : [];
  const inSuggestion = (m: { from: number; to: number }) => [ORIGINAL, SUGGESTION].some((name) => state.schema.marks[name] && state.doc.rangeHasMark(m.from, m.to, state.schema.marks[name]));
  const todo = picked.filter((m) => !inSuggestion(m));
  if (!todo.length) return picked.length ? { tr: state.tr, count: 0, skipped: picked.length } : null;
  const tr = state.tr;
  // Back to front, so earlier positions are not shifted by later edits.
  for (let i = todo.length - 1; i >= 0; i--) tr.insertText(opts.regex && todo[i].m ? expandReplacement(replacement, todo[i].m!) : replacement, todo[i].from, todo[i].to);
  return { tr, count: todo.length, skipped: picked.length - todo.length };
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
