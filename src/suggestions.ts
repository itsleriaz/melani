// SPDX-License-Identifier: GPL-3.0-only
// Pending AI suggestions live in the editor as two marks and are never part of the saved Markdown.
//   suggestion          the new text (tint plus a left bar)
//   suggestionOriginal  the text a "replace" suggestion would replace (struck through)
// Both carry the same `sid`. Everything here is pure ProseMirror so it can be unit tested.
import { Fragment, Node as PMNode, Schema } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Message } from "./ai";

export const SUGGESTION = "suggestion";
export const ORIGINAL = "suggestionOriginal";

export interface Range {
  from: number;
  to: number;
}

export interface SuggestionAttrs {
  sid: string;
  tool: string;
  model: string;
}

const isPendingNode = (n: PMNode) => n.isInline && n.marks.some((m) => m.type.name === SUGGESTION);

/** The document as it should be saved: new suggestion text removed, original text restored. */
export function stripPending(doc: PMNode): PMNode {
  const map = (frag: Fragment): Fragment => {
    const out: PMNode[] = [];
    frag.forEach((child) => {
      if (isPendingNode(child)) return;
      if (child.isText) {
        out.push(child.marks.some((m) => m.type.name === ORIGINAL) ? child.mark(child.marks.filter((m) => m.type.name !== ORIGINAL)) : child);
      } else if (child.isLeaf) {
        out.push(child.marks.some((m) => m.type.name === ORIGINAL) ? child.mark(child.marks.filter((m) => m.type.name !== ORIGINAL)) : child);
      } else {
        out.push(child.copy(map(child.content)));
      }
    });
    return Fragment.fromArray(out); // also merges adjacent text nodes with equal marks
  };
  return doc.copy(map(doc.content));
}

export function pendingSids(doc: PMNode): string[] {
  const sids: string[] = [];
  doc.descendants((n) => {
    for (const m of n.marks) if ((m.type.name === SUGGESTION || m.type.name === ORIGINAL) && !sids.includes(m.attrs.sid)) sids.push(m.attrs.sid);
  });
  return sids;
}

export function sidRanges(doc: PMNode, sid: string): { added: Range | null; original: Range | null } {
  let added: Range | null = null;
  let original: Range | null = null;
  const widen = (r: Range | null, from: number, to: number): Range => (r ? { from: Math.min(r.from, from), to: Math.max(r.to, to) } : { from, to });
  doc.descendants((n, pos) => {
    if (!n.isInline) return;
    for (const m of n.marks) {
      if (m.attrs.sid !== sid) continue;
      if (m.type.name === SUGGESTION) added = widen(added, pos, pos + n.nodeSize);
      if (m.type.name === ORIGINAL) original = widen(original, pos, pos + n.nodeSize);
    }
  });
  return { added, original };
}

/** Text and hard breaks for `text` (newline runs become one hard break), all marked as a suggestion. */
export function buildSuggestionNodes(schema: Schema, text: string, attrs: SuggestionAttrs): PMNode[] {
  const mark = schema.marks[SUGGESTION].create(attrs);
  const nodes: PMNode[] = [];
  text
    .replace(/\r/g, "")
    .replace(/^\n+|\n+$/g, "")
    .split(/\n+/)
    .forEach((part, i) => {
      if (i > 0) nodes.push(schema.nodes.hardBreak.create(null, null, [mark]));
      if (part) nodes.push(schema.text(part, [mark]));
    });
  return nodes;
}

/** Replace [start,end] with the suggestion text so far. Returns the new end position. */
export function replaceStream(tr: Transaction, start: number, end: number, text: string, attrs: SuggestionAttrs): number {
  const nodes = buildSuggestionNodes(tr.doc.type.schema, text, attrs);
  if (nodes.length === 0) {
    if (end > start) tr.delete(start, end);
    return start;
  }
  tr.replaceWith(start, end, Fragment.fromArray(nodes));
  return start + nodes.reduce((a, n) => a + n.nodeSize, 0);
}

export function markOriginal(tr: Transaction, from: number, to: number, sid: string): void {
  tr.addMark(from, to, tr.doc.type.schema.marks[ORIGINAL].create({ sid }));
}

/** One transaction (one undo step): the new text becomes normal prose and the original goes. */
export function acceptTr(state: EditorState, sid: string): Transaction | null {
  const { added, original } = sidRanges(state.doc, sid);
  if (!added && !original) return null;
  const { schema } = state;
  const tr = state.tr;
  if (added) {
    const breaks: number[] = [];
    state.doc.nodesBetween(added.from, added.to, (n, pos) => {
      if (n.type.name === "hardBreak") breaks.push(pos);
    });
    tr.removeMark(added.from, added.to, schema.marks[SUGGESTION]);
    // Hard breaks inside suggested text mean paragraph breaks. Work back to front.
    for (const pos of breaks.reverse()) {
      tr.delete(pos, pos + 1);
      tr.split(pos);
    }
  }
  if (original) tr.delete(original.from, original.to);
  return tr;
}

/** One transaction: the suggestion disappears with no trace and the original is untouched. */
export function rejectTr(state: EditorState, sid: string): Transaction | null {
  const { added, original } = sidRanges(state.doc, sid);
  if (!added && !original) return null;
  const tr = state.tr;
  if (added) tr.delete(added.from, added.to);
  if (original) tr.removeMark(original.from, original.to, state.schema.marks[ORIGINAL]);
  return tr;
}

export function suggestionText(doc: PMNode, range: Range): string {
  return doc.textBetween(range.from, range.to, "\n", "\n");
}

// ---- Persistence in the scene sidecar ---------------------------------------------------

export interface SuggestionRecord {
  sid: string;
  tool: string;
  model: string;
  kind: "replace" | "insert";
  /** The suggested text; "\n" marks paragraph breaks. */
  text: string;
  /** Replace only: the text being replaced and where it sits in the saved document. */
  originalText: string;
  originalFrom: number;
  originalTo: number;
  /** Where the suggestion goes in the saved document (the end of the original for replace). */
  at: number;
  /** Fingerprint: up to 24 characters of saved text before `at`. */
  before: string;
  messages?: Message[];
}

const FINGERPRINT = 24;

/** Records for every pending suggestion, with positions expressed in the *saved* document. */
export function toRecords(doc: PMNode, messages: (sid: string) => Message[] | undefined = () => undefined): SuggestionRecord[] {
  // Spans of suggested text, in editor positions, to subtract when mapping to saved positions.
  const spans: Range[] = [];
  doc.descendants((n, pos) => {
    if (isPendingNode(n)) spans.push({ from: pos, to: pos + n.nodeSize });
  });
  const clean = (p: number) => p - spans.filter((s) => s.to <= p).reduce((a, s) => a + (s.to - s.from), 0);
  const saved = stripPending(doc);
  return pendingSids(doc).flatMap((sid) => {
    const { added, original } = sidRanges(doc, sid);
    if (!added) return []; // an original with no new text yet (an interrupted run) has nothing to restore
    const at = clean(added.from);
    const meta = doc.nodeAt(added.from)?.marks.find((m) => m.type.name === SUGGESTION)?.attrs ?? {};
    const anchor = original ? clean(original.from) : at;
    return [
      {
        sid,
        tool: meta.tool ?? "",
        model: meta.model ?? "",
        kind: original ? ("replace" as const) : ("insert" as const),
        text: suggestionText(doc, added),
        originalText: original ? saved.textBetween(clean(original.from), clean(original.to), "\n", "\n") : "",
        originalFrom: original ? clean(original.from) : at,
        originalTo: original ? clean(original.to) : at,
        at,
        before: saved.textBetween(Math.max(0, anchor - FINGERPRINT), anchor, "\n", "\n"),
        messages: messages(sid),
      },
    ];
  });
}

/** Position of `needle` inside a single block, closest to `near`. */
export function findText(doc: PMNode, needle: string, near: number): Range | null {
  if (!needle) return null;
  let best: Range | null = null;
  doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    const text = n.textBetween(0, n.content.size, undefined, "\n");
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
      const from = pos + 1 + i;
      if (!best || Math.abs(from - near) < Math.abs(best.from - near)) best = { from, to: from + needle.length };
    }
    return false;
  });
  return best;
}

/** Text as the model is likely to quote it: straight quotes and dashes, one space between words, no case. */
function loose(text: string): { s: string; map: number[] } {
  let s = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if (/\s/.test(c)) {
      if (lastSpace || s === "") continue;
      c = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
      c = c.replace(/[\u2018\u2019\u201b]/, "'").replace(/[\u201c\u201d]/, '"').replace(/[\u2013\u2014]/, "-").replace("\u2026", ".");
    }
    s += c.toLowerCase();
    map.push(i);
  }
  return { s, map };
}

/**
 * Find a passage a model quoted. First exactly; then ignoring case, curly versus straight quotes
 * and line breaks; then by the start of it, which is usually what a long quote gets wrong last.
 */
export function findPassage(doc: PMNode, passage: string, near: number): Range | null {
  const exact = findText(doc, passage.trim(), near);
  if (exact) return exact;
  const want = loose(passage.trim()).s.trim();
  if (want.length < 8) return null;
  let best: (Range & { len: number }) | null = null;
  doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    const { s, map } = loose(n.textBetween(0, n.content.size, undefined, "\n"));
    // The whole quote, then shorter beginnings of it (never under 24 characters or half of it).
    const floor = Math.max(24, Math.ceil(want.length / 2));
    for (let len = want.length; len >= Math.min(want.length, floor); len -= Math.max(1, Math.floor(want.length / 8))) {
      const part = want.slice(0, len);
      for (let i = s.indexOf(part); i >= 0; i = s.indexOf(part, i + 1)) {
        const from = pos + 1 + map[i];
        const to = pos + 1 + map[i + part.length - 1] + 1;
        if (!best || len > best.len || (len === best.len && Math.abs(from - near) < Math.abs(best.from - near))) best = { from, to, len };
      }
      if (best && best.len === len) break;
    }
    return false;
  });
  return best ? { from: (best as Range).from, to: (best as Range).to } : null;
}

/**
 * Re-apply saved suggestions to a freshly loaded document. A suggestion whose anchor text no
 * longer matches (the scene was edited elsewhere) is looked for nearby; if it can't be placed
 * it is returned as an orphan for the user to re-place or discard.
 */
export function restoreRecords(state: EditorState, records: SuggestionRecord[]): { tr: Transaction | null; orphans: SuggestionRecord[] } {
  const doc = state.doc;
  const tr = state.tr;
  const orphans: SuggestionRecord[] = [];
  const text = (a: number, b: number) => (a >= 0 && b <= doc.content.size && a <= b ? doc.textBetween(a, b, "\n", "\n") : null);
  let applied = 0;

  for (const r of [...records].sort((a, b) => b.at - a.at)) {
    let at = r.at;
    let from = r.originalFrom;
    let to = r.originalTo;
    let ok: boolean;
    if (r.kind === "replace") {
      ok = text(from, to) === r.originalText;
      if (!ok) {
        const f = findText(doc, r.originalText, from);
        if (f) (from = f.from), (to = f.to), (at = to), (ok = true);
      }
    } else {
      ok = text(Math.max(0, at - FINGERPRINT), at) === r.before && at <= doc.content.size;
      if (!ok && r.before.length >= 8) {
        const f = findText(doc, r.before, at - r.before.length);
        if (f) (at = f.to), (ok = true);
      }
    }
    // The point must be inside a block that can hold inline content.
    if (ok && !doc.resolve(at).parent.inlineContent) ok = false;
    if (!ok) {
      orphans.push(r);
      continue;
    }
    const nodes = buildSuggestionNodes(state.schema, r.text, { sid: r.sid, tool: r.tool, model: r.model });
    if (nodes.length) tr.insert(at, Fragment.fromArray(nodes));
    if (r.kind === "replace") markOriginal(tr, from, to, r.sid);
    applied++;
  }
  return { tr: applied ? tr : null, orphans };
}
