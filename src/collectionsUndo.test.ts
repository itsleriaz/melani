// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
vi.stubGlobal("window", { setTimeout, clearTimeout, localStorage, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} });

const { useStore } = await import("./store");
const { invoke } = await import("@tauri-apps/api/core");

const names = () => useStore.getState().collections.map((c) => c.name);

beforeEach(() => {
  useStore.setState({ dir: "/p", collections: [], collectionsUndo: [], collectionsRedo: [], toast: null });
  vi.mocked(invoke).mockClear();
});

describe("collections undo", () => {
  it("undoes and redoes creating, renaming and deleting", () => {
    const id = useStore.getState().newCollection("manual");
    useStore.getState().patchCollection(id, { name: "Flashbacks" });
    useStore.getState().deleteCollection(id);
    expect(names()).toEqual([]);
    expect(useStore.getState().collectionsUndo.map((e) => e.label)).toEqual(["New collection", "Edit collection", "Delete collection"]);

    useStore.getState().undoCollections(1);
    expect(names()).toEqual(["Flashbacks"]);
    useStore.getState().undoCollections(2);
    expect(names()).toEqual([]);
    expect(useStore.getState().collectionsRedo).toHaveLength(3);

    useStore.getState().redoCollections(2);
    expect(names()).toEqual(["Flashbacks"]);
    expect(useStore.getState().toast?.text).toBe("Redid 2 changes");
  });

  it("writes the collections to disk on undo", () => {
    useStore.getState().newCollection("manual");
    vi.mocked(invoke).mockClear();
    useStore.getState().undoCollections(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("write_collections", { dir: "/p", content: "[]" });
  });

  it("a new edit clears the redo stack, and extra steps are ignored", () => {
    useStore.getState().newCollection("manual");
    useStore.getState().undoCollections(5);
    expect(useStore.getState().collectionsRedo).toHaveLength(1);
    useStore.getState().newCollection("smart");
    expect(useStore.getState().collectionsRedo).toHaveLength(0);
    expect(useStore.getState().collectionsUndo[0].label).toBe("New smart collection");
  });
});
