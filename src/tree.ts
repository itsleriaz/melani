// SPDX-License-Identifier: GPL-3.0-only
// Pure, immutable helpers for the binder tree.

export type NodeType = "part" | "chapter" | "scene" | "note" | "trash";

export interface BinderNode {
  id: string;
  type: NodeType;
  title: string;
  status: string;
  label: string | null;
  synopsis: string;
  includeInExport: boolean;
  keywords?: string[];
  /** Metadata values by field name: the fixed ones (see FIXED_FIELDS) and any custom ones. */
  fields?: Record<string, string>;
  children: BinderNode[];
}

export type DropPos = "before" | "after" | "inside";

export function findNode(nodes: BinderNode[], id: string): BinderNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNode(n.children, id);
    if (f) return f;
  }
  return null;
}

export function findParent(nodes: BinderNode[], id: string): BinderNode | null {
  for (const n of nodes) {
    if (n.children.some((c) => c.id === id)) return n;
    const f = findParent(n.children, id);
    if (f) return f;
  }
  return null;
}

/** What may live where: book root > part > chapter > scene. The trash takes anything. */
export function canContain(parent: NodeType | null, child: NodeType): boolean {
  switch (parent) {
    case null:
      return child === "part" || child === "chapter" || child === "note";
    case "part":
      return child === "chapter" || child === "note";
    case "chapter":
      return child === "scene" || child === "note";
    case "trash":
      return child !== "trash";
    default:
      return false;
  }
}

export function isDescendant(root: BinderNode, id: string): boolean {
  return root.children.some((c) => c.id === id || isDescendant(c, id));
}

export function removeNode(nodes: BinderNode[], id: string): [BinderNode[], BinderNode | null] {
  let removed: BinderNode | null = null;
  const walk = (list: BinderNode[]): BinderNode[] => {
    const out: BinderNode[] = [];
    for (const n of list) {
      if (n.id === id) {
        removed = n;
        continue;
      }
      out.push(n.children.length ? { ...n, children: walk(n.children) } : n);
    }
    return out;
  };
  return [walk(nodes), removed];
}

function insertAt(nodes: BinderNode[], targetId: string, pos: DropPos, node: BinderNode): BinderNode[] {
  const out: BinderNode[] = [];
  for (const n of nodes) {
    if (n.id === targetId) {
      if (pos === "before") out.push(node, n);
      else if (pos === "after") out.push(n, node);
      else out.push({ ...n, children: [...n.children, node] });
    } else {
      out.push(n.children.length ? { ...n, children: insertAt(n.children, targetId, pos, node) } : n);
    }
  }
  return out;
}

/** Move `id` relative to `targetId`. Returns the same array if the move is invalid. */
export function moveNode(nodes: BinderNode[], id: string, targetId: string, pos: DropPos): BinderNode[] {
  if (id === targetId) return nodes;
  const moving = findNode(nodes, id);
  const target = findNode(nodes, targetId);
  if (!moving || !target) return nodes;
  if (moving.type === "trash") return nodes;
  if (isDescendant(moving, targetId)) return nodes;
  // Nothing can be placed beside the trash at root, keep it last.
  if (target.type === "trash" && pos !== "inside") return nodes;
  const newParent = pos === "inside" ? target.type : (findParent(nodes, targetId)?.type ?? null);
  if (!canContain(newParent, moving.type)) return nodes;
  const [without, removed] = removeNode(nodes, id);
  if (!removed) return nodes;
  return insertAt(without, targetId, pos, removed);
}

/** Ids in book order (depth first), trash included. */
export function orderedIds(nodes: BinderNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...orderedIds(n.children)]);
}

/**
 * The ids to act on when several are selected: in book order, without the trash, and without
 * anything that sits inside another selected item (moving a chapter already moves its scenes).
 */
export function topLevelIds(nodes: BinderNode[], ids: string[]): string[] {
  const chosen = new Set(ids);
  return orderedIds(nodes).filter((id) => {
    if (!chosen.has(id)) return false;
    const n = findNode(nodes, id);
    if (!n || n.type === "trash") return false;
    let p = findParent(nodes, id);
    while (p) {
      if (chosen.has(p.id)) return false;
      p = findParent(nodes, p.id);
    }
    return true;
  });
}

/** Move several items to one place, keeping their order. Items that cannot go there stay where they are. */
export function moveNodes(nodes: BinderNode[], ids: string[], targetId: string, pos: DropPos): BinderNode[] {
  const list = topLevelIds(nodes, ids).filter((id) => id !== targetId);
  // Dropping after something places each in turn right after it, so go backwards to keep the order.
  const seq = pos === "after" ? [...list].reverse() : list;
  return seq.reduce((acc, id) => moveNode(acc, id, targetId, pos), nodes);
}

export function addChild(nodes: BinderNode[], parentId: string | null, node: BinderNode): BinderNode[] {
  if (parentId === null) {
    // Keep the trash last.
    const i = nodes.findIndex((n) => n.type === "trash");
    if (i < 0) return [...nodes, node];
    return [...nodes.slice(0, i), node, ...nodes.slice(i)];
  }
  return nodes.map((n) =>
    n.id === parentId ? { ...n, children: [...n.children, node] } : n.children.length ? { ...n, children: addChild(n.children, parentId, node) } : n,
  );
}

export function updateNode(nodes: BinderNode[], id: string, patch: Partial<BinderNode>): BinderNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, ...patch } : n.children.length ? { ...n, children: updateNode(n.children, id, patch) } : n));
}

/** Rebuild the tree, changing each node through `fn` (return it unchanged to leave it be). */
export function mapNodes(nodes: BinderNode[], fn: (n: BinderNode) => BinderNode): BinderNode[] {
  return nodes.map((n) => {
    const next = fn(n);
    return next.children.length ? { ...next, children: mapNodes(next.children, fn) } : next;
  });
}

/** Text-bearing leaves (scenes and notes) under a node, in document order. */
export function leaves(node: BinderNode): BinderNode[] {
  if (node.type === "scene" || node.type === "note") return [node];
  return node.children.flatMap(leaves);
}

export function newNode(id: string, type: NodeType, title: string): BinderNode {
  return { id, type, title, status: "draft", label: null, synopsis: "", includeInExport: true, children: [] };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
