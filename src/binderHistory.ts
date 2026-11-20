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
