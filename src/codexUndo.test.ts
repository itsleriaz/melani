// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "read_codex_body" ? "Diane is proud." : cmd === "list_codex" ? [] : undefined)),
}));
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
vi.stubGlobal("window", { setTimeout, clearTimeout, localStorage, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} });

const { useStore } = await import("./store");
const { emptyEntry } = await import("./codexTypes");
const { invoke } = await import("@tauri-apps/api/core");

const diane = emptyEntry("diane", "character", "Diane Marsh");

beforeEach(() => {
  useStore.setState({ dir: "/p", codex: [diane], codexId: "diane", toast: null });
  vi.mocked(invoke).mockClear();
});

describe("deleting a codex entry", () => {
  it("offers an undo that puts back the entry and its text", async () => {
    await useStore.getState().deleteEntry("diane");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("delete_codex_entry", { dir: "/p", id: "diane" });
    const t = useStore.getState().toast;
    expect(t?.text).toBe("Deleted “Diane Marsh”");
    expect(t?.action?.label).toBe("Undo");
    t!.action!.run();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("save_codex_entry", { dir: "/p", entry: diane, body: "Diane is proud." });
    expect(useStore.getState().toast).toBeNull();
  });

  it("offers no undo for an entry it does not know", async () => {
    await useStore.getState().deleteEntry("nobody");
    expect(useStore.getState().toast).toBeNull();
  });
});
