// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { Node as PMNode, Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { acceptTr, findPassage, pendingSids, rejectTr, restoreRecords, sidRanges, stripPending, toRecords } from "./suggestions";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true, selectable: false },
  },
  marks: {
    strong: {},
    suggestion: { attrs: { sid: { default: "" }, tool: { default: "" }, model: { default: "" } }, excludes: "" },
    suggestionOriginal: { attrs: { sid: { default: "" } }, excludes: "" },
  },
});

type Seg = string | [string, "orig" | "new" | "strong"] | "br-new";
const SID = "s1";
function seg(s: Seg): PMNode {
  if (s === "br-new") return schema.nodes.hardBreak.create(null, null, [schema.marks.suggestion.create({ sid: SID, tool: "rewrite", model: "m" })]);
  if (typeof s === "string") return schema.text(s);
  const [text, kind] = s;
  const mark = kind === "orig" ? schema.marks.suggestionOriginal.create({ sid: SID }) : kind === "new" ? schema.marks.suggestion.create({ sid: SID, tool: "rewrite", model: "m" }) : schema.marks.strong.create();
  return schema.text(text, [mark]);
}
const para = (...segs: Seg[]) => schema.node("paragraph", null, segs.map(seg));
const docOf = (...paras: PMNode[]) => schema.node("doc", null, paras);
const stateOf = (d: PMNode) => EditorState.create({ doc: d, schema });
const texts = (d: PMNode) => d.content.content.map((p) => p.textContent);
const marksIn = (d: PMNode) => {
  const names = new Set<string>();
  d.descendants((n) => n.marks.forEach((m) => names.add(m.type.name)));
  return [...names].sort();
};

describe("stripPending", () => {
  it("removes suggested text and restores the original", () => {
    const d = docOf(para("Hello ", ["world", "orig"], ["planet", "new"], "!"));
    const clean = stripPending(d);
    expect(texts(clean)).toEqual(["Hello world!"]);
    expect(marksIn(clean)).toEqual([]);
    expect(pendingSids(d)).toEqual([SID]);
    expect(pendingSids(clean)).toEqual([]);
  });
  it("drops an insert-only suggestion entirely and keeps other formatting", () => {
    const d = docOf(para(["Bold", "strong"], " text", ["added", "new"]));
    const clean = stripPending(d);
    expect(texts(clean)).toEqual(["Bold text"]);
    expect(marksIn(clean)).toEqual(["strong"]);
  });
  it("drops suggested hard breaks too", () => {
    const d = docOf(para("a", ["b", "new"], "br-new", ["c", "new"]));
    expect(texts(stripPending(d))).toEqual(["a"]);
  });
});

describe("accept and reject", () => {
  const d = () => docOf(para("Hello ", ["world", "orig"], ["planet", "new"], "!"));
  it("accept swaps in the new text as one transaction", () => {
    const tr = acceptTr(stateOf(d()), SID)!;
    expect(texts(tr.doc)).toEqual(["Hello planet!"]);
    expect(marksIn(tr.doc)).toEqual([]);
    expect(tr.steps.length).toBeGreaterThan(0);
  });
  it("reject removes the suggestion and leaves the original untouched", () => {
    const tr = rejectTr(stateOf(d()), SID)!;
    expect(texts(tr.doc)).toEqual(["Hello world!"]);
    expect(marksIn(tr.doc)).toEqual([]);
  });
  it("accepting suggested line breaks splits paragraphs", () => {
    const state = stateOf(docOf(para("x", ["A", "new"], "br-new", ["B", "new"], "br-new", ["C", "new"], "y")));
    expect(texts(acceptTr(state, SID)!.doc)).toEqual(["xA", "B", "Cy"]);
  });
  it("returns null for an unknown suggestion", () => {
    expect(acceptTr(stateOf(d()), "nope")).toBeNull();
    expect(rejectTr(stateOf(d()), "nope")).toBeNull();
    expect(sidRanges(d(), "nope")).toEqual({ added: null, original: null });
  });
});

describe("saving and restoring", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  it("a replace suggestion survives a save and reload", () => {
    const pending = docOf(para("One."), para("Hello ", ["world", "orig"], ["planet", "new"], " again."));
    const records = toRecords(pending, () => messages);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "replace", text: "planet", originalText: "world", tool: "rewrite", model: "m", messages });
    const saved = stripPending(pending);
    const { tr, orphans } = restoreRecords(stateOf(saved), JSON.parse(JSON.stringify(records)));
    expect(orphans).toEqual([]);
    expect(tr!.doc.eq(pending)).toBe(true);
  });
  it("an insert suggestion survives a save and reload", () => {
    const pending = docOf(para("The rain fell all night."), para("Dawn came.", ["Then silence.", "new"]));
    const records = toRecords(pending);
    expect(records[0].kind).toBe("insert");
    const { tr, orphans } = restoreRecords(stateOf(stripPending(pending)), records);
    expect(orphans).toEqual([]);
    expect(tr!.doc.eq(pending)).toBe(true);
  });
  it("finds a suggestion again after the text moved", () => {
    const pending = docOf(para("Hello ", ["world", "orig"], ["planet", "new"], "."));
    const records = toRecords(pending);
    // The writer added a sentence before it in another editor.
    const edited = docOf(para("Brand new opening. Hello world."));
    const { tr, orphans } = restoreRecords(stateOf(edited), records);
    expect(orphans).toEqual([]);
    expect(texts(stripPending(tr!.doc))).toEqual(["Brand new opening. Hello world."]);
    expect(sidRanges(tr!.doc, SID).added).not.toBeNull();
  });
  it("returns an orphan when the anchor text is gone", () => {
    const pending = docOf(para("Hello ", ["world", "orig"], ["planet", "new"], "."));
    const records = toRecords(pending);
    const { tr, orphans } = restoreRecords(stateOf(docOf(para("Completely rewritten."))), records);
    expect(tr).toBeNull();
    expect(orphans.map((o) => o.sid)).toEqual([SID]);
  });
  it("ignores a run that was interrupted before any text arrived", () => {
    expect(toRecords(docOf(para("Hello ", ["world", "orig"])))).toEqual([]);
  });
});

describe("finding a passage a model quoted", () => {
  const doc = schema.node("doc", null, [para("She said, \u201cDon\u2019t go\u201d \u2014 and left."), para("Second paragraph, with a long enough sentence to quote partly and then wander off.")]);
  const text = (r: { from: number; to: number } | null) => (r ? doc.textBetween(r.from, r.to) : null);
  it("finds an exact quote", () => {
    expect(text(findPassage(doc, "Second paragraph", 0))).toBe("Second paragraph");
  });
  it("ignores curly quotes, dashes, case and line breaks", () => {
    expect(text(findPassage(doc, "she said, \"Don't go\" - and left.", 0))).toBe("She said, \u201cDon\u2019t go\u201d \u2014 and left.");
    expect(text(findPassage(doc, "SECOND  paragraph,\nwith a long", 0))).toBe("Second paragraph, with a long");
  });
  it("falls back to the start of a quote that goes wrong at the end", () => {
    const r = findPassage(doc, "Second paragraph, with a long enough sentence to quote partly and then something else entirely", 0);
    expect(text(r)?.startsWith("Second paragraph, with a long enough")).toBe(true);
  });
  it("finds nothing for a quote that is not there, or is too short to trust", () => {
    expect(findPassage(doc, "This is not in the scene at all, sorry.", 0)).toBeNull();
    expect(findPassage(doc, "GO", 0)).toBe(null);
  });
});
