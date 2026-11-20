// SPDX-License-Identifier: GPL-3.0-only
// The Activity panel's list: things you did that can be taken back, in one place. It is a view over the
// histories that already exist (the binder's undo and redo, deleted codex entries, the app's automatic
// snapshots). Typing is not listed: that is undone in the text itself.
import type { BinderEntry } from "./binderHistory";
import type { CodexEntry } from "./codexTypes";
import type { Collection } from "./collectionRules";

/** The collections as they were before an edit, for undo. */
export interface CollectionEntry {
  label: string;
  collections: Collection[];
  at: number;
}

export interface CodexTrashItem {
  entry: CodexEntry;
  body: string;
  at: number;
}

/** A snapshot as the list sees it (the shape the backend returns). */
export interface SnapshotInfo {
  id: string;
  createdAt: number;
  note: string;
  label: string;
  scope: string;
  sceneIds: string[];
}

export type ActivityAction =
  | { kind: "binder-undo"; steps: number }
  | { kind: "binder-redo"; steps: number }
  | { kind: "collections-undo"; steps: number }
  | { kind: "collections-redo"; steps: number }
  | { kind: "codex-restore"; id: string }
  | { kind: "snapshot-review"; snapshotId: string; sceneId: string };

export interface ActivityItem {
  key: string;
  at: number;
  title: string;
  detail?: string;
  /** "undone" items are ones you already took back; their action puts them back. */
  state: "done" | "undone";
  actionLabel: string;
  action: ActivityAction;
}

export const MAX_CODEX_TRASH = 20;
const MAX_SNAPSHOTS = 30;

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** What an automatic snapshot was for, in plain words: "Automatic: before X" becomes "Before X". */
function snapshotTitle(note: string): string {
  const n = note.replace(/^Automatic:\s*/i, "").trim();
  return capital(n || "Automatic backup");
}

export function buildActivity(o: { binderUndo: BinderEntry[]; binderRedo: BinderEntry[]; codexTrash: CodexTrashItem[]; snapshots: SnapshotInfo[]; collectionsUndo?: CollectionEntry[]; collectionsRedo?: CollectionEntry[] }): ActivityItem[] {
  const items: ActivityItem[] = [];
  // Collections have their own linear history, listed the same way as the binder's.
  const stackItems = (undo: { label: string; at: number }[], redo: { label: string; at: number }[], prefix: string, what: string, kinds: { undo: "binder-undo" | "collections-undo"; redo: "binder-redo" | "collections-redo" }) => {
    undo.forEach((e, i) => {
      const steps = undo.length - i;
      items.push({ key: `${prefix}-undo-${i}-${e.at}`, at: e.at, title: e.label, detail: steps > 1 ? `Undoing this also undoes ${steps - 1} later ${what} change${steps === 2 ? "" : "s"}` : undefined, state: "done", actionLabel: steps > 1 ? "Undo to here" : "Undo", action: { kind: kinds.undo, steps } });
    });
    redo.forEach((e, j) => {
      const steps = redo.length - j; // the last one is the next to redo
      items.push({ key: `${prefix}-redo-${j}-${e.at}`, at: e.at, title: e.label, detail: "Undone", state: "undone", actionLabel: steps > 1 ? "Redo to here" : "Redo", action: { kind: kinds.redo, steps } });
    });
  };
  stackItems(o.binderUndo, o.binderRedo, "b", "binder", { undo: "binder-undo", redo: "binder-redo" });
  stackItems(o.collectionsUndo ?? [], o.collectionsRedo ?? [], "col", "collection", { undo: "collections-undo", redo: "collections-redo" });
  for (const c of o.codexTrash) {
    items.push({ key: `codex-${c.entry.id}-${c.at}`, at: c.at, title: `Deleted “${c.entry.name}”`, detail: "Codex entry", state: "done", actionLabel: "Restore", action: { kind: "codex-restore", id: c.entry.id } });
  }
  for (const s of o.snapshots.filter((x) => x.scope === "auto" && x.sceneIds.length > 0).slice(0, MAX_SNAPSHOTS)) {
    items.push({ key: `snap-${s.id}`, at: s.createdAt, title: snapshotTitle(s.note), detail: s.label, state: "done", actionLabel: "Review", action: { kind: "snapshot-review", snapshotId: s.id, sceneId: s.sceneIds[0] } });
  }
  return items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function serializeCodexTrash(items: CodexTrashItem[]): string {
  return JSON.stringify({ v: 1, items: items.slice(0, MAX_CODEX_TRASH) });
}

export function parseCodexTrash(raw: string): CodexTrashItem[] {
  try {
    const j = JSON.parse(raw) as { v?: number; items?: unknown };
    if (j.v !== 1 || !Array.isArray(j.items)) return [];
    return j.items
      .filter((i): i is CodexTrashItem => !!i && typeof i.at === "number" && typeof i.body === "string" && !!i.entry && typeof i.entry.id === "string" && typeof i.entry.name === "string")
      .slice(0, MAX_CODEX_TRASH);
  } catch {
    return [];
  }
}

/** A whole-project backup as the list sees it (the shape the backend returns). */
export interface BackupInfo {
  name: string;
  createdAt: number;
  size: number;
}

/** "812 B", "14 KB", "3.2 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
