// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
// The store reads settings from localStorage when it is created.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
vi.stubGlobal("window", { setTimeout, clearTimeout, localStorage, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} });

const { useStore } = await import("./store");
const { newNode } = await import("./tree");
const { invoke } = await import("@tauri-apps/api/core");

const tree = () => [
  { ...newNode("c1", "chapter", "One"), children: [newNode("a", "scene", "A"), newNode("b", "scene", "B")] },
  { ...newNode("c2", "chapter", "Two"), children: [] },
  { ...newNode("t", "trash", "Trash"), children: [] },
];
const ids = (n = useStore.getState().nodes) => n.map((c) => `${c.id}:${c.children.map((x) => x.id).join(",")}`).join(" ");

beforeEach(() => {
  useStore.setState({ dir: "/p", nodes: tree(), selectedId: "a", binderUndo: [], binderRedo: [], multi: [] });
  vi.mocked(invoke).mockClear();
});

describe("binder undo", () => {
  it("undoes and redoes a move", () => {
    const s = useStore.getState();
    s.move("a", "c2", "inside");
    expect(ids()).toBe("c1:b c2:a t:");
    useStore.getState().undoBinder();
    expect(ids()).toBe("c1:a,b c2: t:");
    useStore.getState().redoBinder();
    expect(ids()).toBe("c1:b c2:a t:");
  });

  it("says what was undone and redone", () => {
    useStore.getState().move("a", "c2", "inside");
    useStore.getState().undoBinder();
    expect(useStore.getState().toast?.text).toBe("Undid move");
    useStore.getState().redoBinder();
    expect(useStore.getState().toast?.text).toBe("Redid move");
  });

  it("labels moving to the trash and saves the binder on undo", () => {
    useStore.getState().trash("b");
    const undo = useStore.getState().binderUndo;
    expect(undo[undo.length - 1]?.label).toBe("Move to trash");
    useStore.getState().undoBinder();
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("save_binder", expect.objectContaining({ dir: "/p" }));
    expect(ids()).toBe("c1:a,b c2: t:");
  });

  it("a new edit clears the redo stack", () => {
    const s = useStore.getState();
    s.rename("a", "Alpha");
    useStore.getState().undoBinder();
    expect(useStore.getState().binderRedo).toHaveLength(1);
    useStore.getState().rename("b", "Beta");
    expect(useStore.getState().binderRedo).toHaveLength(0);
  });

  it("keeps the selection on something that exists", () => {
    useStore.getState().move("a", "c2", "inside");
    useStore.setState({ selectedId: "gone" });
    useStore.getState().undoBinder();
    expect(useStore.getState().selectedId).toBe("a");
  });

  it("does nothing when there is nothing to undo", () => {
    useStore.getState().undoBinder();
    useStore.getState().redoBinder();
    expect(ids()).toBe("c1:a,b c2: t:");
  });

  it("deleting forever empties the history", async () => {
    useStore.getState().trash("b");
    await useStore.getState().deleteForever(["b"]);
    expect(useStore.getState().binderUndo).toHaveLength(0);
    expect(ids()).toBe("c1:a c2: t:");
  });
});
