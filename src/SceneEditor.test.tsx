// @vitest-environment happy-dom
// SPDX-License-Identifier: GPL-3.0-only
// The real scene editor, mounted the way the app mounts it (React StrictMode), against a pretend disk.
// These cover bugs that only show up in the component's lifecycle: saves racing loads, and history across remounts.
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The pretend disk behind the Tauri commands the editor uses. */
const disk = {
  scenes: new Map<string, string>(),
  meta: new Map<string, string>(),
  history: new Map<string, string>(),
  mtime: new Map<string, number>(),
  /** Every write_scene call, in order. */
  writes: [] as { id: string; content: string }[],
};
const touch = (id: string) => disk.mtime.set(id, (disk.mtime.get(id) ?? 1) + 1);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown> = {}) => {
    const id = a.id as string;
    switch (cmd) {
      case "read_scene":
        return disk.scenes.get(id) ?? "";
      case "scene_modified":
        return disk.mtime.get(id) ?? 1;
      case "read_scene_meta":
        return disk.meta.get(id) ?? "{}";
      case "write_scene":
        disk.writes.push({ id, content: a.content as string });
        disk.scenes.set(id, a.content as string);
        touch(id);
        return;
      case "write_scene_meta":
        disk.meta.set(id, a.content as string);
        return;
      case "find_mentions":
        return (a.texts as string[]).map(() => []);
      case "read_history":
        return disk.history.get(a.name as string) ?? "";
      case "write_history":
        disk.history.set(a.name as string, a.content as string);
        return;
      case "clear_history":
        disk.history.delete(a.name as string);
        return;
      case "word_counts":
        return {};
      default:
        return undefined; // write_recovery, clear_recovery, ...
    }
  }),
}));

// The store and the editor read settings from localStorage when they load.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no layout, which ProseMirror and the smooth caret ask about.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getBoundingClientRect = () => rect as DOMRect;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
(document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

const { SceneEditor } = await import("./SceneEditor");
const { useStore } = await import("./store");
const { useAi } = await import("./aiStore");
const { getHandle } = await import("./editorRegistry");

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

/** Wait until the scene's text has loaded into its editor. */
async function ready(id: string) {
  for (let i = 0; i < 100; i++) {
    if (getHandle(id)?.ready()) return getHandle(id)!;
    await wait(10);
  }
  throw new Error(`scene ${id} never finished loading`);
}

const roots: Root[] = [];
async function mount(id: string) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => root.render(<StrictMode><SceneEditor id={id} /></StrictMode>));
  const h = await ready(id);
  return {
    h,
    editor: h.editor,
    text: () => h.editor.state.doc.textContent,
    /** What switching to another scene does to this one. */
    unmount: async () => {
      await act(async () => root.unmount());
      await wait(30); // the unmount flush and the history write are async
    },
  };
}

/** Type at the end of the scene, as one undo step. */
function typeAtEnd(m: Awaited<ReturnType<typeof mount>>, text: string) {
  const e = m.editor;
  act(() => {
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    e.commands.insertContent(text);
  });
}

/** A scene id of its own for each test: the app remembers undo history per scene, in memory, for the whole session. */
let sid = "";
let counter = 0;

beforeEach(() => {
  sid = `scene${++counter}`;
  disk.scenes.clear();
  disk.meta.clear();
  disk.history.clear();
  disk.mtime.clear();
  disk.writes.length = 0;
  useStore.setState({ dir: "/p" });
  useAi.getState().setSceneComments(sid, []);
});

afterEach(async () => {
  for (const r of roots.splice(0)) {
    try {
      await act(async () => r.unmount());
    } catch {
      /* already unmounted by the test */
    }
  }
  document.body.innerHTML = "";
});

describe("opening a scene", () => {
  it("loads its text and writes nothing", async () => {
    disk.scenes.set(sid, "The ferry left at dawn.");
    const m = await mount(sid);
    expect(m.text()).toBe("The ferry left at dawn.");
    await m.unmount();
    expect(disk.writes).toEqual([]);
  });

  it("does not let Cmd+Z undo the load itself", async () => {
    disk.scenes.set(sid, "The ferry left at dawn.");
    const m = await mount(sid);
    expect(m.editor.can().undo()).toBe(false);
    act(() => void m.editor.commands.undo());
    expect(m.text()).toBe("The ferry left at dawn.");
  });
});

describe("the wipe bug: a scene with comments reopened after switching away", () => {
  const comment = { id: "c1", passage: "ferry", comment: "Which ferry?", tool: "feedback", model: "m" } as const;

  it("never saves an empty editor over the text", async () => {
    disk.scenes.set(sid, "The ferry left at dawn.");
    // Line feedback has put comments for this scene in the store, as it does after a run.
    useAi.getState().setSceneComments(sid, [comment]);

    const first = await mount(sid);
    await first.unmount();
    const second = await mount(sid); // clicking back onto the scene
    await second.unmount();

    expect(disk.writes.filter((w) => w.content === "")).toEqual([]);
    expect(disk.scenes.get(sid)).toBe("The ferry left at dawn.");
  });

  it("still saves the comments' scene normally after an edit", async () => {
    disk.scenes.set(sid, "The ferry left at dawn.");
    useAi.getState().setSceneComments(sid, [comment]);
    const m = await mount(sid);
    typeAtEnd(m, " Rain fell.");
    await m.unmount();
    expect(disk.scenes.get(sid)).toBe("The ferry left at dawn. Rain fell.");
  });
});

describe("undo history across switching scenes", () => {
  it("is still there when the scene is opened again", async () => {
    disk.scenes.set(sid, "One");
    const a = await mount(sid);
    typeAtEnd(a, " two");
    await a.unmount();
    expect(disk.scenes.get(sid)).toBe("One two");

    const b = await mount(sid);
    expect(b.text()).toBe("One two");
    expect(b.editor.can().undo()).toBe(true);
    act(() => void b.editor.commands.undo());
    expect(b.text()).toBe("One");
    act(() => void b.editor.commands.redo());
    expect(b.text()).toBe("One two");
  });

  it("is written to disk, so it survives a restart", async () => {
    disk.scenes.set(sid, "One");
    const a = await mount(sid);
    typeAtEnd(a, " two");
    await a.unmount();
    expect(disk.history.has(sid)).toBe(true);

    // A new session: nothing is remembered in memory, only the file.
    vi.resetModules();
    const fresh = await import("./SceneEditor");
    const reg = await import("./editorRegistry");
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    roots.push(root);
    await act(async () => root.render(<StrictMode><fresh.SceneEditor id={sid} /></StrictMode>));
    for (let i = 0; i < 100 && !reg.getHandle(sid)?.ready(); i++) await wait(10);
    const editor = reg.getHandle(sid)!.editor;
    expect(editor.state.doc.textContent).toBe("One two");
    act(() => void editor.commands.undo());
    expect(editor.state.doc.textContent).toBe("One");
  });
});

describe("text that changes outside the editor", () => {
  it("is one undoable step while the scene is open", async () => {
    disk.scenes.set(sid, "Original text.");
    const m = await mount(sid);
    typeAtEnd(m, " Typed.");
    await wait(900); // autosave
    expect(disk.scenes.get(sid)).toBe("Original text. Typed.");

    // A snapshot restore or replace all rewrites the file; the editor notices on its next poll.
    disk.scenes.set(sid, "Replaced by search.");
    touch(sid);
    await wait(2300);
    expect(m.text()).toBe("Replaced by search.");

    act(() => void m.editor.commands.undo());
    expect(m.text()).toBe("Original text. Typed.");
    act(() => void m.editor.commands.undo());
    expect(m.text()).toBe("Original text.");
  }, 15_000);

  it("is one undoable step when the scene was closed at the time", async () => {
    disk.scenes.set(sid, "Original text.");
    const a = await mount(sid);
    typeAtEnd(a, " Typed.");
    await a.unmount();

    disk.scenes.set(sid, "Replaced while closed.");
    touch(sid);

    const b = await mount(sid);
    expect(b.text()).toBe("Replaced while closed.");
    act(() => void b.editor.commands.undo());
    expect(b.text()).toBe("Original text. Typed.");
    act(() => void b.editor.commands.undo());
    expect(b.text()).toBe("Original text.");
  });

  it("does not add a step when the file only matches what the editor already saved", async () => {
    disk.scenes.set(sid, "Same text.");
    const m = await mount(sid);
    typeAtEnd(m, " More.");
    await wait(900);
    const before = m.text();
    touch(sid); // the file's time changed (our own save), the text did not
    await wait(2300);
    expect(m.text()).toBe(before);
    act(() => void m.editor.commands.undo());
    expect(m.text()).toBe("Same text."); // one undo step took back the typing, not a phantom reload
  }, 15_000);
});
