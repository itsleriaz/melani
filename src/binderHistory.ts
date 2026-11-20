// SPDX-License-Identifier: GPL-3.0-only
// Undo and redo for the binder: each entry is the whole tree as it was before an edit.
import { findNode, leaves, type BinderNode } from "./tree";

export interface BinderEntry {
  /** What the edit was, for the tooltip: "Move", "Rename"… */
  label: string;
  nodes: BinderNode[];
  selectedId: string | null;
  at: number;
}

export const MAX_ENTRIES = 100;
/** Edits of the same kind this close together (typing in a field) count as one step. */
export const COALESCE_MS = 1500;

/** Add an entry on top of the stack, merging it into the top one when it is a quick repeat. */
export function pushEntry(stack: BinderEntry[], entry: BinderEntry): BinderEntry[] {
  const top = stack[stack.length - 1];
  if (top && top.label === entry.label && entry.at - top.at < COALESCE_MS) return [...stack.slice(0, -1), { ...top, at: entry.at }];
  return [...stack, entry].slice(-MAX_ENTRIES);
}

/** Keep what is on screen if it still exists, else go back to what was selected then, else the first scene. */
export function pickSelection(nodes: BinderNode[], current: string | null, saved: string | null): string | null {
  for (const id of [current, saved]) if (id && findNode(nodes, id)) return id;
  return nodes.flatMap(leaves)[0]?.id ?? null;
}

/** What is kept between sessions: this many steps each way. */
export const SAVED_STEPS = 30;

/** A short fingerprint of a binder, to tell whether it is still the one the history was recorded against. */
export function fingerprint(nodes: BinderNode[]): string {
  const s = JSON.stringify(nodes);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${s.length}:${h.toString(16)}`;
}

export function serializeBinderHistory(undo: BinderEntry[], redo: BinderEntry[], nodes: BinderNode[]): string {
  return JSON.stringify({ v: 1, fp: fingerprint(nodes), undo: undo.slice(-SAVED_STEPS), redo: redo.slice(-SAVED_STEPS) });
}

const isEntry = (e: unknown): e is BinderEntry => {
  const x = e as BinderEntry | null;
  return !!x && typeof x.label === "string" && Array.isArray(x.nodes) && typeof x.at === "number" && (x.selectedId === null || typeof x.selectedId === "string");
};

/** The saved stacks, but only if the binder is exactly as it was when they were saved (else it changed outside the app). */
export function parseBinderHistory(raw: string, nodes: BinderNode[]): { undo: BinderEntry[]; redo: BinderEntry[] } | null {
  try {
    const j = JSON.parse(raw) as { v?: number; fp?: string; undo?: unknown; redo?: unknown };
    if (j.v !== 1 || j.fp !== fingerprint(nodes) || !Array.isArray(j.undo) || !Array.isArray(j.redo)) return null;
    if (!j.undo.every(isEntry) || !j.redo.every(isEntry)) return null;
    return { undo: j.undo, redo: j.redo };
  } catch {
    return null;
  }
}
