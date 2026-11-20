// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { formatCost, parseComments, parseFindings, parseJsonArray, plainError, salvageObjects } from "./ai";

describe("parseJsonArray", () => {
  it("reads plain arrays, fenced arrays and arrays wrapped in prose", () => {
    expect(parseJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseJsonArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(parseJsonArray('Here you go:\n[{"a":1}]\nHope that helps!')).toEqual([{ a: 1 }]);
    expect(parseJsonArray("[]")).toEqual([]);
  });
  it("returns null when there is no usable array", () => {
    expect(parseJsonArray("no json here")).toBeNull();
    expect(parseJsonArray("[not json]")).toBeNull();
    expect(parseJsonArray('{"a":1}')).toBeNull();
  });
});

describe("parseFindings and parseComments", () => {
  it("keeps well-formed items and drops junk", () => {
    const f = parseFindings('[{"passage":"her green eyes","entry":"Diane","problem":"Diane has brown eyes","fix":"brown"},{"problem":""},7,{"passage":"x","entry":null,"problem":"p"}]');
    expect(f).toEqual([
      { passage: "her green eyes", entry: "Diane", problem: "Diane has brown eyes", fix: "brown" },
      { passage: "x", entry: null, problem: "p", fix: "" },
    ]);
    expect(parseComments('[{"passage":"slowly walked","comment":"Try a stronger verb."},{"passage":"y"}]')).toEqual([{ passage: "slowly walked", comment: "Try a stronger verb." }]);
    expect(parseFindings("oops")).toBeNull();
  });
});

describe("plainError", () => {
  it("turns each failure kind into a plain message", () => {
    expect(plainError({ kind: "auth", message: "x" })).toContain("API key");
    expect(plainError({ kind: "credit", message: "x" })).toContain("out of credit");
    expect(plainError({ kind: "rate_limit", message: "x" })).toContain("rate limiting");
    expect(plainError({ kind: "model", message: "gone" })).toContain("gone");
    expect(plainError({ kind: "network", message: "Could not reach OpenRouter." })).toBe("Could not reach OpenRouter.");
    expect(plainError("plain string")).toBe("plain string");
  });
});

describe("formatCost", () => {
  it("formats small, normal and unknown costs", () => {
    expect(formatCost(0.0004)).toBe("$0.0004");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(null)).toBe("cost unknown");
  });
});

describe("a reply cut off by the output limit", () => {
  const cut = '```json\n[\n  {"passage":"a \\"quoted\\" bit","entry":null,"problem":"First { brace } problem.","fix":"f1"},\n  {"passage":"b","entry":"Diane","problem":"Second.","fix":"f2"},\n  {"passage":"c","entry":null,"problem":"The third was cut o';
  it("keeps the complete items and drops the broken last one", () => {
    expect(parseJsonArray(cut)).toBeNull();
    expect(salvageObjects(cut)).toHaveLength(2);
    const f = parseFindings(cut)!;
    expect(f.map((x) => x.problem)).toEqual(["First { brace } problem.", "Second."]);
    expect(f[0].passage).toBe('a "quoted" bit');
    expect(parseComments('[{"passage":"p","comment":"ok"},{"passage":"q","comm')).toEqual([{ passage: "p", comment: "ok" }]);
  });
  it("finds nothing in a reply with no complete item", () => {
    expect(parseFindings('[{"passage":"a","problem":"cut')).toBeNull();
    expect(salvageObjects("no array")).toBeNull();
  });
});
