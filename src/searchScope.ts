// SPDX-License-Identifier: GPL-3.0-only
// Which scenes the search panel looks in: the whole project, or the chapter or scene you are on.
import { findNode, findParent, type BinderNode } from "./tree";

export type SearchScope = "project" | "chapter" | "scene";

/**
 * The node a narrower scope is about. A scene (or note) is its own "scene"; its "chapter" is the chapter
 * or part that holds it, and a selected chapter or part is its own. Null when there is nothing to scope to:
 * no selection, a scene in the trash, a top-level note.
 */
export function scopeRoot(nodes: BinderNode[], selectedId: string | null, scope: SearchScope): BinderNode | null {
  if (scope === "project") return null;
  const sel = selectedId ? findNode(nodes, selectedId) : null;
  if (!sel || sel.type === "trash") return null;
  const isLeaf = sel.type === "scene" || sel.type === "note";
  if (scope === "scene") return isLeaf ? sel : null;
  const root = isLeaf ? findParent(nodes, sel.id) : sel;
  return root && root.type !== "trash" ? root : null;
}

/** Scenes and notes in binder order, outside the trash, for the chosen scope and the Manuscript/Notes toggles. */
export function searchableIds(nodes: BinderNode[], q: { manuscript: boolean; notes: boolean }, scope: SearchScope = "project", selectedId: string | null = null): string[] {
  const root = scopeRoot(nodes, selectedId, scope);
  if (scope !== "project" && !root) return [];
  // One scene is searched whatever the toggles say: you asked for exactly that one.
  if (scope === "scene") return [root!.id];
  const out: string[] = [];
  const walk = (list: BinderNode[]) => {
    for (const n of list) {
      if (n.type === "trash") continue;
      if ((n.type === "scene" && q.manuscript) || (n.type === "note" && q.notes)) out.push(n.id);
      walk(n.children);
    }
  };
  walk(root ? root.children : nodes);
  return out;
}
