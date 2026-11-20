// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { COALESCE_MS, MAX_ENTRIES, pickSelection, pushEntry, type BinderEntry } from "./binderHistory";
import { newNode, type BinderNode } from "./tree";

const entry = (label: string, at: number, nodes: BinderNode[] = []): BinderEntry => ({ label, nodes, selectedId: null, at });

describe("binder history", () => {
  it("keeps separate steps for different edits", () => {
    const s = pushEntry(pushEntry([], entry("Move", 0)), entry("Rename", 10));
    expect(s.map((e) => e.label)).toEqual(["Move", "Rename"]);
  });

  it("merges quick repeats of the same edit, keeping the oldest tree", () => {
    const first = [newNode("a", "scene", "A")];
    let s = pushEntry([], entry("Edit details", 0, first));
    s = pushEntry(s, entry("Edit details", 300, []));
    s = pushEntry(s, entry("Edit details", 900, []));
    expect(s).toHaveLength(1);
    expect(s[0].nodes).toBe(first);
  });

  it("does not merge repeats that are far apart", () => {
    const s = pushEntry(pushEntry([], entry("Rename", 0)), entry("Rename", COALESCE_MS + 1));
    expect(s).toHaveLength(2);
  });

  it("caps the stack", () => {
    let s: BinderEntry[] = [];
    for (let i = 0; i < MAX_ENTRIES + 20; i++) s = pushEntry(s, entry(`e${i}`, i * 10_000));
    expect(s).toHaveLength(MAX_ENTRIES);
    expect(s[s.length - 1].label).toBe(`e${MAX_ENTRIES + 19}`);
  });

  it("picks a selection that still exists", () => {
    const chapter = { ...newNode("c", "chapter", "C"), children: [newNode("s1", "scene", "One"), newNode("s2", "scene", "Two")] };
    expect(pickSelection([chapter], "s2", "s1")).toBe("s2");
    expect(pickSelection([chapter], "gone", "s1")).toBe("s1");
    expect(pickSelection([chapter], "gone", "gone2")).toBe("s1");
    expect(pickSelection([], "x", null)).toBeNull();
  });
});
