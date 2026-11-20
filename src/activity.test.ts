// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildActivity, formatSize, MAX_CODEX_TRASH, parseCodexTrash, serializeCodexTrash, timeAgo, type CodexTrashItem, type SnapshotInfo } from "./activity";
import type { BinderEntry } from "./binderHistory";
import { emptyEntry } from "./codexTypes";

const be = (label: string, at: number): BinderEntry => ({ label, nodes: [], selectedId: null, at });
const snap = (id: string, at: number, scope = "auto", note = "Automatic: before restoring this snapshot"): SnapshotInfo => ({ id, createdAt: at, note, label: "The Ferry", scope, sceneIds: ["s1"] });
const trash = (id: string, at: number): CodexTrashItem => ({ entry: emptyEntry(id, "character", `Name ${id}`), body: "text", at });

describe("activity list", () => {
  it("merges everything, newest first", () => {
    const items = buildActivity({ binderUndo: [be("Rename", 100), be("Move", 300)], binderRedo: [], codexTrash: [trash("d", 200)], snapshots: [snap("x", 250)] });
    expect(items.map((i) => i.title)).toEqual(["Move", "Before restoring this snapshot", "Deleted “Name d”", "Rename"]);
  });

  it("undoing a binder change also undoes the later ones, and says so", () => {
    const items = buildActivity({ binderUndo: [be("A", 1), be("B", 2), be("C", 3)], binderRedo: [], codexTrash: [], snapshots: [] });
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    expect(byTitle.C.action).toEqual({ kind: "binder-undo", steps: 1 });
    expect(byTitle.C.actionLabel).toBe("Undo");
    expect(byTitle.A.action).toEqual({ kind: "binder-undo", steps: 3 });
    expect(byTitle.A.actionLabel).toBe("Undo to here");
    expect(byTitle.A.detail).toBe("Undoing this also undoes 2 later binder changes");
    expect(byTitle.B.detail).toBe("Undoing this also undoes 1 later binder change");
  });

  it("lists undone changes with a redo that reaches them, the next one to redo being the last", () => {
    // Undid C then B: the redo stack is [C, B] and B is next.
    const items = buildActivity({ binderUndo: [be("A", 1)], binderRedo: [be("C", 3), be("B", 2)], codexTrash: [], snapshots: [] });
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    expect(byTitle.B.action).toEqual({ kind: "binder-redo", steps: 1 });
    expect(byTitle.C.action).toEqual({ kind: "binder-redo", steps: 2 });
    expect(byTitle.C.state).toBe("undone");
    expect(byTitle.A.state).toBe("done");
  });

  it("includes only the app's automatic snapshots, and points at the first scene", () => {
    const items = buildActivity({ binderUndo: [], binderRedo: [], codexTrash: [], snapshots: [snap("a", 1, "scene", "mine"), snap("b", 2), { ...snap("c", 3), sceneIds: [] }] });
    expect(items).toHaveLength(1);
    expect(items[0].action).toEqual({ kind: "snapshot-review", snapshotId: "b", sceneId: "s1" });
    expect(items[0].detail).toBe("The Ferry");
  });

  it("writes an automatic note in plain words", () => {
    const [i] = buildActivity({ binderUndo: [], binderRedo: [], codexTrash: [], snapshots: [snap("b", 2, "auto", "Automatic: before a save removed most of this scene's text")] });
    expect(i.title).toBe("Before a save removed most of this scene's text");
  });
});

describe("time ago", () => {
  const now = 1_000_000_000_000;
  it("reads naturally", () => {
    expect(timeAgo(now - 10_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
});

describe("saved deleted codex entries", () => {
  it("round trips and is capped", () => {
    const many = Array.from({ length: MAX_CODEX_TRASH + 5 }, (_, i) => trash(`e${i}`, i));
    const back = parseCodexTrash(serializeCodexTrash(many));
    expect(back).toHaveLength(MAX_CODEX_TRASH);
    expect(back[0].entry.id).toBe("e0");
    expect(back[0].body).toBe("text");
  });

  it("ignores damaged files and bad items", () => {
    expect(parseCodexTrash("{ nope")).toEqual([]);
    expect(parseCodexTrash(JSON.stringify({ v: 2, items: [] }))).toEqual([]);
    expect(parseCodexTrash(JSON.stringify({ v: 1, items: [{ at: 1 }, trash("ok", 5), null] }))).toHaveLength(1);
  });
});

describe("sizes", () => {
  it("reads naturally", () => {
    expect(formatSize(812)).toBe("812 B");
    expect(formatSize(14 * 1024 + 300)).toBe("14 KB");
    expect(formatSize(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(formatSize(48 * 1024 * 1024)).toBe("48 MB");
  });
});
