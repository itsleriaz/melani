// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { history, undo, undoDepth } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/core";
import { resetHistory, restoreHistory, stashHistory } from "./sceneHistory";

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
});
const para = (t: string) => schema.node("paragraph", null, t ? [schema.text(t)] : []);
const doc = (t: string) => schema.node("doc", null, [para(t)]);

/** Just enough of an Editor for sceneHistory: a state that dispatch updates. */
function fakeEditor(d = doc("")) {
  const ed = { state: EditorState.create({ doc: d, plugins: [history()] }), view: { dispatch: (tr: Transaction) => void (ed.state = ed.state.apply(tr)) } };
  return ed as unknown as Editor & { state: EditorState };
}
const type = (ed: ReturnType<typeof fakeEditor>, text: string) => ed.view.dispatch(ed.state.tr.insertText(text, 1));
const load = (ed: ReturnType<typeof fakeEditor>, t: string) => ed.view.dispatch(ed.state.tr.replaceWith(0, ed.state.doc.content.size, doc(t).content));

describe("scene history", () => {
  it("loading a scene is not undoable once the history is reset", () => {
    const ed = fakeEditor();
    load(ed, "Loaded text");
    expect(undoDepth(ed.state)).toBe(1);
    resetHistory(ed);
    expect(undoDepth(ed.state)).toBe(0);
    expect(ed.state.doc.textContent).toBe("Loaded text");
  });

  it("undo steps survive closing and reopening a scene with unchanged text", () => {
    const a = fakeEditor();
    load(a, "World");
    resetHistory(a);
    type(a, "Hello ");
    stashHistory("/p", "s1", a);

    const b = fakeEditor();
    load(b, "Hello World");
    restoreHistory("/p", "s1", b);
    expect(undoDepth(b.state)).toBe(1);
    undo(b.state, (tr) => void (b.state = b.state.apply(tr)));
    expect(b.state.doc.textContent).toBe("World");
  });

  it("starts fresh when the text changed outside the app", () => {
    const a = fakeEditor();
    load(a, "World");
    resetHistory(a);
    type(a, "Hello ");
    stashHistory("/p", "s2", a);

    const b = fakeEditor();
    load(b, "Something else entirely");
    restoreHistory("/p", "s2", b);
    expect(undoDepth(b.state)).toBe(0);
  });

  it("keeps scenes and projects apart", () => {
    const a = fakeEditor();
    load(a, "x");
    resetHistory(a);
    type(a, "y");
    stashHistory("/p", "s3", a);
    const b = fakeEditor();
    load(b, "yx");
    restoreHistory("/other", "s3", b);
    expect(undoDepth(b.state)).toBe(0);
  });
});
