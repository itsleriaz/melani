// SPDX-License-Identifier: GPL-3.0-only
// The Activity panel's list: things you did that can be taken back, in one place. It is a view over the
// histories that already exist (the binder's undo and redo, deleted codex entries, the app's automatic
// snapshots). Typing is not listed: that is undone in the text itself.
import type { BinderEntry } from "./binderHistory";
import type { CodexEntry } from "./codexTypes";

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

export function buildActivity(o: { binderUndo: BinderEntry[]; binderRedo: BinderEntry[]; codexTrash: CodexTrashItem[]; snapshots: SnapshotInfo[] }): ActivityItem[] {
  const items: ActivityItem[] = [];
  const nu = o.binderUndo.length;
  o.binderUndo.forEach((e, i) => {
    const steps = nu - i; // this one and everything after it
    items.push({
      key: `b-undo-${i}-${e.at}`,
      at: e.at,
      title: e.label,
      detail: steps > 1 ? `Undoing this also undoes ${steps - 1} later binder change${steps === 2 ? "" : "s"}` : undefined,
      state: "done",
      actionLabel: steps > 1 ? "Undo to here" : "Undo",
      action: { kind: "binder-undo", steps },
    });
  });
  const nr = o.binderRedo.length;
  o.binderRedo.forEach((e, j) => {
    const steps = nr - j; // the last one is the next to redo
    items.push({
      key: `b-redo-${j}-${e.at}`,
      at: e.at,
      title: e.label,
      detail: "Undone",
      state: "undone",
      actionLabel: steps > 1 ? "Redo to here" : "Redo",
      action: { kind: "binder-redo", steps },
    });
  });
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
