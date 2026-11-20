// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { closeHistory, history, redo, undo, undoDepth } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/core";
import { capStash, loadStash, parseStash, resetHistory, restoreHistory, stashHistory, type Stash } from "./sceneHistory";

/** A pretend disk for the history commands. */
const disk = new Map<string, string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: { dir: string; name: string; content?: string }) => {
    const k = `${a.dir}/${a.name}`;
    if (cmd === "write_history") disk.set(k, a.content ?? "");
    else if (cmd === "clear_history") disk.delete(k);
    else if (cmd === "read_history") return disk.get(k) ?? "";
  }),
}));
beforeEach(() => disk.clear());
const stashed = (id: string) => loadStash("/p", id);

/** Each editor gets its own schema object, as Tiptap does: nodes from one never match another's. */
const newSchema = () =>
  new Schema({
    nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
    marks: { strong: {} },
  });

type Fake = Editor & { state: EditorState };
function fakeEditor(text = ""): Fake {
  const schema = newSchema();
  const para = schema.node("paragraph", null, text ? [schema.text(text)] : []);
  const ed = {
    state: EditorState.create({ doc: schema.node("doc", null, [para]), plugins: [history()] }),
    view: { dispatch: (tr: Transaction) => void (ed.state = ed.state.apply(tr)) },
  };
  return ed as unknown as Fake;
}
/** Append text as its own undo event. */
const type = (ed: Fake, text: string) => {
  const end = ed.state.doc.content.size - 1;
  ed.view.dispatch(closeHistory(ed.state.tr.insertText(text, end)));
};
const text = (ed: Fake) => ed.state.doc.textContent;
const doUndo = (ed: Fake) => undo(ed.state, ed.view.dispatch);
const doRedo = (ed: Fake) => redo(ed.state, ed.view.dispatch);

describe("scene history", async () => {
  it("loading a scene is not undoable once the history is reset", () => {
    const ed = fakeEditor("Loaded");
    type(ed, "!");
    resetHistory(ed);
    expect(undoDepth(ed.state)).toBe(0);
    expect(text(ed)).toBe("Loaded!");
  });

  it("undo steps survive closing and reopening a scene, even though the new editor has its own schema", async () => {
    const a = fakeEditor("One");
    type(a, " two");
    type(a, " three");
    await stashHistory("/p", "s1", a);

    const b = fakeEditor("One two three");
    restoreHistory(await stashed("s1"), b);
    expect(undoDepth(b.state)).toBe(2);
    doUndo(b);
    expect(text(b)).toBe("One two");
    doUndo(b);
    expect(text(b)).toBe("One");
    expect(doUndo(b)).toBe(false);
  });

  it("keeps the redo stack too", async () => {
    const a = fakeEditor("A");
    type(a, "B");
    type(a, "C");
    doUndo(a);
    expect(text(a)).toBe("AB");
    await stashHistory("/p", "s2", a);

    const b = fakeEditor("AB");
    restoreHistory(await stashed("s2"), b);
    expect(text(b)).toBe("AB");
    doRedo(b);
    expect(text(b)).toBe("ABC");
    doUndo(b);
    doUndo(b);
    expect(text(b)).toBe("A");
  });

  it("starts fresh when the text changed outside the app", async () => {
    const a = fakeEditor("World");
    type(a, "!");
    await stashHistory("/p", "s3", a);

    const b = fakeEditor("Something else entirely");
    restoreHistory(await stashed("s3"), b);
    expect(undoDepth(b.state)).toBe(0);
    expect(text(b)).toBe("Something else entirely");
  });

  it("keeps scenes and projects apart", async () => {
    const a = fakeEditor("x");
    type(a, "y");
    await stashHistory("/p", "s4", a);
    const b = fakeEditor("xy");
    restoreHistory(await loadStash("/other", "s4"), b);
    expect(undoDepth(b.state)).toBe(0);
  });

  it("survives a restart: the history is read back from disk", async () => {
    const a = fakeEditor("One");
    type(a, " two");
    type(a, " three");
    await stashHistory("/p", "s5", a);
    expect(disk.size).toBe(1);

    vi.resetModules();
    const fresh = await import("./sceneHistory");
    const b = fakeEditor("One two three");
    fresh.restoreHistory(await fresh.loadStash("/p", "s5"), b);
    doUndo(b);
    expect(text(b)).toBe("One two");
    doUndo(b);
    expect(text(b)).toBe("One");
  });

  it("writes nothing for a scene with no history, and clears an old file", async () => {
    const a = fakeEditor("Plain");
    await stashHistory("/p", "s6", a);
    expect(disk.size).toBe(0);
    disk.set("/p/s6", "{}");
    await stashHistory("/p", "s6", a);
    expect(disk.size).toBe(0);
  });
});

describe("saved history files", () => {
  const doc = (t: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
  const stash = (n: number, at = n - 1): Stash => ({ docs: Array.from({ length: n }, (_, i) => doc(`v${i}`)), at });

  it("keeps the steps nearest the current one and re-bases the position", () => {
    const c = capStash(stash(100, 90), 10, 1e9);
    expect(c.docs).toHaveLength(20); // steps 80 to 99: ten before the current one, nine after
    expect(c.docs[c.at]).toEqual(doc("v90"));
    expect(c.docs[0]).toEqual(doc("v80"));
  });

  it("drops the oldest steps first when over the size budget", () => {
    const c = capStash(stash(10, 6), 30, JSON.stringify(doc("v0")).length * 4);
    expect(c.docs.length).toBeLessThanOrEqual(4);
    expect(c.docs[c.at]).toEqual(doc("v6"));
  });

  it("only accepts well-formed files", () => {
    const ok = JSON.stringify({ v: 1, ...stash(3) });
    expect(parseStash(ok)?.docs).toHaveLength(3);
    expect(parseStash("{ nope")).toBeNull();
    expect(parseStash(JSON.stringify({ v: 2, ...stash(3) }))).toBeNull();
    expect(parseStash(JSON.stringify({ v: 1, docs: [doc("a")], at: 0 }))).toBeNull();
    expect(parseStash(JSON.stringify({ v: 1, ...stash(3), at: 7 }))).toBeNull();
    expect(parseStash(JSON.stringify({ v: 1, docs: ["x", "y"], at: 0 }))).toBeNull();
  });
});
