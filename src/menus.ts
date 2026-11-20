// SPDX-License-Identifier: GPL-3.0-only
// What the context menus offer for binder items and codex entries.
import { invoke } from "@tauri-apps/api/core";
import type { MenuEntry } from "./ContextMenu";
import type { CodexEntry } from "./codexTypes";
import { LABELS, STATUSES } from "./Inspector";
import { flushAll } from "./SceneEditor";
import { useStore } from "./store";
import { BinderNode, canContain, findNode, findParent, isDescendant, leaves, NodeType, topLevelIds } from "./tree";

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function nodeMenu(node: BinderNode): MenuEntry[] {
  const s = useStore.getState();
  const trash = s.nodes.find((n) => n.type === "trash");
  const inTrash = !!trash && trash.id !== node.id && isDescendant(trash, node.id);
  if (node.type === "trash") return [{ label: "Trash is emptied by deleting files in the project folder", onSelect: () => {}, disabled: true }];
  if (inTrash)
    return [
      { label: "Open", icon: "scene", onSelect: () => s.select(node.id) },
      { separator: true },
      { label: "Restore", icon: "restore", onSelect: () => s.restore(node.id) },
    ];

  const add = (type: NodeType, label: string): MenuEntry[] => (canContain(node.type, type) ? [{ label, icon: "plus", onSelect: () => void s.addNode(type, node.id) }] : []);
  const isText = node.type === "scene" || node.type === "note";
  const snapshot = async () => {
    const ids = isText ? [node.id] : leaves(node).map((l) => l.id);
    if (!ids.length || !s.dir) return;
    try {
      await flushAll();
      await invoke("create_snapshot", { dir: s.dir, sceneIds: ids, note: "", label: node.title, scope: isText ? "scene" : "chapter" });
      useStore.getState().set({ rightTab: "snapshots" });
    } catch (e) {
      useStore.getState().set({ error: String(e) });
    }
  };
  const parent = findParent(s.nodes, node.id);
  // Put this scene (or every scene in this chapter or part) into a manual collection.
  const sceneIds = isText ? [node.id] : leaves(node).map((l) => l.id);
  const manual = s.collections.filter((c) => c.kind === "manual");
  const collect: MenuEntry[] = sceneIds.length
    ? [
        { separator: true },
        { heading: "Add to collection" },
        ...manual.map((c) => ({ label: c.name, icon: "outline" as const, checked: sceneIds.every((id) => c.ids.includes(id)), onSelect: () => s.addToCollection(c.id, sceneIds) })),
        {
          label: "New collection…",
          icon: "plus" as const,
          onSelect: () => {
            const id = s.newCollection("manual", { name: node.title, ids: sceneIds });
            s.set({ leftTab: "collections", collectionId: id, bookOutline: false, codexId: null });
          },
        },
      ]
    : [];
  return [
    { label: "Open", icon: isText ? "scene" : "folder", onSelect: () => s.select(node.id) },
    ...(!isText
      ? [
          { label: "Open as corkboard", icon: "grid" as const, onSelect: () => (s.select(node.id), s.set({ view: "corkboard" as const })) },
          { label: "Open as outline", icon: "outline" as const, onSelect: () => (s.select(node.id), s.set({ view: "outliner" as const })) },
        ]
      : []),
    { separator: true },
    ...add("part", "New part inside"),
    ...add("chapter", "New chapter inside"),
    ...add("scene", "New scene inside"),
    ...(isText && parent && canContain(parent.type, node.type) ? [{ label: `New ${node.type} after this`, icon: "plus" as const, onSelect: () => void s.addNode(node.type, parent.id) }] : []),
    { label: "Rename", icon: "pen", onSelect: () => s.set({ renamingId: node.id, leftTab: "binder" }) },
    { label: "Duplicate", icon: "scene", onSelect: () => void s.duplicate(node.id) },
    { label: "Take a snapshot", icon: "history", onSelect: () => void snapshot() },
    ...(node.type === "chapter" || node.type === "part" ? [{ label: `Export this ${node.type}…`, icon: "external" as const, onSelect: () => s.set({ exportOpen: true, exportRoot: node.id }) }] : []),
    { separator: true },
    { heading: "Status" },
    ...[...new Set([...STATUSES, node.status])].map((st) => ({ label: cap(st), checked: node.status === st, onSelect: () => s.patch(node.id, { status: st }) })),
    { colors: LABELS, value: node.label, onPick: (label: string | null) => s.patch(node.id, { label }) },
    { label: "Include in export", checked: node.includeInExport, onSelect: () => s.patch(node.id, { includeInExport: !node.includeInExport }) },
    ...collect,
    { separator: true },
    { label: "Move to trash", icon: "trash", danger: true, onSelect: () => s.trash(node.id) },
  ];
}

/** A smart collection of every scene that mentions this codex entry. */
export function makeMentionCollection(entry: CodexEntry) {
  const s = useStore.getState();
  const id = s.newCollection("smart", { name: `Scenes with ${entry.name}`, rules: [{ field: "mentions", op: "has", value: entry.id }] });
  s.set({ leftTab: "collections", collectionId: id, bookOutline: false, codexId: null });
}

/** What the context menu offers when several binder items are picked. */
export function multiMenu(picked: string[]): MenuEntry[] {
  const s = useStore.getState();
  const ids = topLevelIds(s.nodes, picked);
  const nodes = ids.map((id) => findNode(s.nodes, id)).filter((n): n is BinderNode => !!n);
  const sceneIds = nodes.flatMap((n) => leaves(n).map((l) => l.id));
  const same = <T,>(f: (n: BinderNode) => T) => nodes.every((n) => f(n) === f(nodes[0])) ? f(nodes[0]) : undefined;
  const manual = s.collections.filter((c) => c.kind === "manual");
  const inTrash = nodes.every((n) => {
    const trash = s.nodes.find((x) => x.type === "trash");
    return !!trash && isDescendant(trash, n.id);
  });
  return [
    { heading: `${nodes.length} items` },
    { heading: "Status" },
    ...[...STATUSES].map((st) => ({ label: cap(st), checked: same((n) => n.status) === st, onSelect: () => s.patchMany(ids, { status: st }) })),
    { colors: LABELS, value: same((n) => n.label) ?? null, onPick: (label: string | null) => s.patchMany(ids, { label }) },
    { label: "Include in export", checked: same((n) => n.includeInExport) === true, onSelect: () => s.patchMany(ids, { includeInExport: same((n) => n.includeInExport) !== true }) },
    ...(sceneIds.length
      ? [
          { separator: true } as MenuEntry,
          { heading: "Add to collection" } as MenuEntry,
          ...manual.map((c): MenuEntry => ({ label: c.name, icon: "outline", checked: sceneIds.every((id) => c.ids.includes(id)), onSelect: () => s.addToCollection(c.id, sceneIds) })),
          {
            label: "New collection…",
            icon: "plus",
            onSelect: () => {
              const id = s.newCollection("manual", { name: `${nodes.length} items`, ids: sceneIds });
              s.set({ leftTab: "collections", collectionId: id, bookOutline: false, codexId: null });
            },
          } as MenuEntry,
        ]
      : []),
    { separator: true },
    ...(inTrash ? [] : [{ label: `Move ${nodes.length} items to trash`, icon: "trash", danger: true, onSelect: () => s.trashMany(ids) } as MenuEntry]),
  ];
}

export function entryMenu(entry: CodexEntry): MenuEntry[] {
  const s = useStore.getState();
  return [
    { label: "Open", icon: "codex", onSelect: () => s.set({ codexId: entry.id }) },
    { label: "Show in reference pane", icon: "sidebarRight", onSelect: () => s.set({ refId: entry.id, rightTab: "reference" }) },
    { label: "Find in project", icon: "search", onSelect: () => s.openSearch(entry.name) },
    { label: "Collection of scenes with this entry", icon: "filter", onSelect: () => makeMentionCollection(entry) },
    { separator: true },
    {
      label: "Delete entry…",
      icon: "trash",
      danger: true,
      onSelect: () => {
        if (window.confirm(`Delete "${entry.name}"? You can undo it for a few seconds afterwards.`)) void s.deleteEntry(entry.id);
      },
    },
  ];
}
