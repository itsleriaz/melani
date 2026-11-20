// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { replaceMatches } from "./search";

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
  marks: { strong: {}, suggestion: {}, suggestionOriginal: {} },
});
const p = (...kids: [string, string?][]) => schema.node("paragraph", null, kids.map(([t, m]) => schema.text(t, m ? [schema.marks[m].create()] : [])));
const state = (...paras: ReturnType<typeof p>[]) => EditorState.create({ doc: schema.node("doc", null, paras) });
const opts = { caseSensitive: false, wholeWord: false };
const apply = (s: EditorState, r: NonNullable<ReturnType<typeof replaceMatches>>) => s.apply(r.tr).doc.textContent;

describe("replaceMatches", () => {
  it("replaces every match in one transaction, across paragraphs", () => {
    const s = state(p(["The cat sat. The cat left."]), p(["Another cat."]));
    const r = replaceMatches(s, "cat", opts, "dog")!;
    expect(r.count).toBe(3);
    expect(apply(s, r)).toBe("The dog sat. The dog left.Another dog.");
  });

  it("replaces just the match at an index", () => {
    const s = state(p(["cat cat cat"]));
    const r = replaceMatches(s, "cat", opts, "dog", 1)!;
    expect(r.count).toBe(1);
    expect(apply(s, r)).toBe("cat dog cat");
  });

  it("can delete, and respects case and whole word", () => {
    const s = state(p(["Cat cat concat"]));
    expect(apply(s, replaceMatches(s, "cat", { caseSensitive: true, wholeWord: true }, "")!)).toBe("Cat  concat");
    expect(replaceMatches(s, "cat", { caseSensitive: false, wholeWord: true }, "x")!.count).toBe(2);
  });

  it("keeps the formatting of the text around a match", () => {
    const s = state(p(["a "], ["cat", "strong"], [" b"]));
    const out = s.apply(replaceMatches(s, "cat", opts, "dog")!.tr).doc;
    expect(out.textContent).toBe("a dog b");
    expect(out.rangeHasMark(3, 6, schema.marks.strong)).toBe(true);
  });

  it("leaves matches inside pending AI suggestions alone", () => {
    const s = state(p(["cat "], ["cat", "suggestionOriginal"], [" cat", "suggestion"]));
    const r = replaceMatches(s, "cat", opts, "dog")!;
    expect(r.count).toBe(1);
    expect(r.skipped).toBe(2);
    expect(apply(s, r)).toBe("dog cat cat");
  });

  it("returns null with nothing to replace", () => {
    expect(replaceMatches(state(p(["hello"])), "zzz", opts, "x")).toBeNull();
    expect(replaceMatches(state(p(["hello"])), "", opts, "x")).toBeNull();
    expect(replaceMatches(state(p(["hello"])), "hello", opts, "x", 5)).toBeNull();
  });

  it("reports when every match was inside a suggestion", () => {
    const s = state(p(["cat", "suggestion"]));
    expect(replaceMatches(s, "cat", opts, "dog")).toMatchObject({ count: 0, skipped: 1 });
  });
});
