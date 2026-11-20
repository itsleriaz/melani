// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { compilePattern, docMatches, expandReplacement, findAll, patternError, replaceMatches } from "./search";

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

describe("regular expressions", () => {
  const rx = { caseSensitive: false, wholeWord: false, regex: true };

  it("finds matches by pattern, ignoring case unless asked", () => {
    expect(findAll("Cat cot cut", "c[ao]t", rx)).toEqual([[0, 3], [4, 7]]);
    expect(findAll("Cat cot", "c[ao]t", { ...rx, caseSensitive: true })).toEqual([[4, 7]]);
  });

  it("applies whole-word to the pattern, not to its pieces", () => {
    expect(findAll("cat concat cat", "cat|con", { ...rx, wholeWord: true })).toEqual([[0, 3], [11, 14]]);
  });

  it("ignores empty matches and cannot loop on them", () => {
    expect(findAll("aaa b", "x*", rx)).toEqual([]);
    expect(findAll("a1b22", "\\d*", rx)).toEqual([[1, 2], [3, 5]]);
  });

  it("reports an invalid pattern instead of throwing", () => {
    expect(patternError("(unclosed", rx)).toBe("Invalid pattern");
    expect(patternError("(unclosed", { ...rx, regex: false })).toBeNull();
    expect(patternError("", rx)).toBeNull();
    expect(findAll("text", "(unclosed", rx)).toEqual([]);
    expect(typeof compilePattern("[", rx)).toBe("string");
  });

  it("treats the query literally when regex is off", () => {
    expect(findAll("a.c abc", "a.c", { caseSensitive: false, wholeWord: false })).toEqual([[0, 3]]);
  });

  it("expands $1, $<name>, $& and $$ in a replacement", () => {
    const m = /(\w+) (?<last>\w+)/.exec("Jane Doe")!;
    expect(expandReplacement("$2, $1", m)).toBe("Doe, Jane");
    expect(expandReplacement("$<last>!", m)).toBe("Doe!");
    expect(expandReplacement("[$&]", m)).toBe("[Jane Doe]");
    expect(expandReplacement("costs $$5", m)).toBe("costs $5");
    expect(expandReplacement("$9 and $0", m)).toBe("$9 and $0");
    expect(expandReplacement("$10", m)).toBe("Jane0");
  });

  it("replaces using capture groups, across paragraphs", () => {
    const s = state(p(["Jane Doe, John Smith."]), p(["Ann Lee."]));
    const r = replaceMatches(s, "(\\w+) (\\w+)", rx, "$2 $1")!;
    expect(r.count).toBe(3);
    expect(s.apply(r.tr).doc.textContent).toBe("Doe Jane, Smith John.Lee Ann.");
  });

  it("finds the same ranges in the document as in the text", () => {
    const s = state(p(["one 12 two"]), p(["34 three"]));
    expect(docMatches(s.doc, "\\d+", rx).map((m) => [m.from, m.to])).toEqual([[5, 7], [13, 15]]);
  });
});
