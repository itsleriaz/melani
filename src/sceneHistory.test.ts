// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { closeHistory, history, redo, undo, undoDepth } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/core";
import { resetHistory, restoreHistory, stashHistory } from "./sceneHistory";

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

describe("scene history", () => {
  it("loading a scene is not undoable once the history is reset", () => {
    const ed = fakeEditor("Loaded");
    type(ed, "!");
    resetHistory(ed);
    expect(undoDepth(ed.state)).toBe(0);
    expect(text(ed)).toBe("Loaded!");
  });

  it("undo steps survive closing and reopening a scene, even though the new editor has its own schema", () => {
    const a = fakeEditor("One");
    type(a, " two");
    type(a, " three");
    stashHistory("/p", "s1", a);

    const b = fakeEditor("One two three");
    restoreHistory("/p", "s1", b);
    expect(undoDepth(b.state)).toBe(2);
    doUndo(b);
    expect(text(b)).toBe("One two");
    doUndo(b);
    expect(text(b)).toBe("One");
    expect(doUndo(b)).toBe(false);
  });

  it("keeps the redo stack too", () => {
    const a = fakeEditor("A");
    type(a, "B");
    type(a, "C");
    doUndo(a);
    expect(text(a)).toBe("AB");
    stashHistory("/p", "s2", a);

    const b = fakeEditor("AB");
    restoreHistory("/p", "s2", b);
    expect(text(b)).toBe("AB");
    doRedo(b);
    expect(text(b)).toBe("ABC");
    doUndo(b);
    doUndo(b);
    expect(text(b)).toBe("A");
  });

  it("starts fresh when the text changed outside the app", () => {
    const a = fakeEditor("World");
    type(a, "!");
    stashHistory("/p", "s3", a);

    const b = fakeEditor("Something else entirely");
    restoreHistory("/p", "s3", b);
    expect(undoDepth(b.state)).toBe(0);
    expect(text(b)).toBe("Something else entirely");
  });

  it("keeps scenes and projects apart", () => {
    const a = fakeEditor("x");
    type(a, "y");
    stashHistory("/p", "s4", a);
    const b = fakeEditor("xy");
    restoreHistory("/other", "s4", b);
    expect(undoDepth(b.state)).toBe(0);
  });
});
