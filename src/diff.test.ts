// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { diffLines, diffSeq, diffWords, stats } from "./diff";

const apply = (ops: { type: string; value: string }[], side: "a" | "b") =>
  ops
    .filter((o) => o.type === "same" || o.type === (side === "a" ? "del" : "add"))
    .map((o) => o.value)
    .join("");

describe("diffLines", () => {
  it("reports no changes for equal text", () => {
    expect(stats(diffLines("a\nb", "a\nb"))).toEqual({ added: 0, removed: 0 });
  });
  it("finds an inserted, a removed and a changed line", () => {
    const ops = diffLines("one\ntwo\nthree\nfour", "one\n2\nthree\nfour\nfive");
    expect(stats(ops)).toEqual({ added: 2, removed: 1 });
    expect(ops.filter((o) => o.type === "del").map((o) => o.value)).toEqual(["two"]);
    expect(ops.filter((o) => o.type === "add").map((o) => o.value)).toEqual(["2", "five"]);
  });
  it("handles empty sides", () => {
    expect(stats(diffLines("", "x\ny"))).toEqual({ added: 2, removed: 0 });
    expect(stats(diffLines("x\ny", ""))).toEqual({ added: 0, removed: 2 });
    expect(diffLines("", "")).toEqual([]);
  });
});

describe("diffWords", () => {
  it("reconstructs both sides exactly", () => {
    const a = "The widow walked slowly home.";
    const b = "The old widow walked home quickly.";
    const ops = diffWords(a, b);
    expect(apply(ops, "a")).toBe(a);
    expect(apply(ops, "b")).toBe(b);
  });
});

describe("diffSeq", () => {
  it("falls back to a replaced block when the table would be huge", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    expect(stats(diffSeq(a, b))).toEqual({ added: 3000, removed: 3000 });
  });
  it("keeps common lines around a big change", () => {
    const mid = (p: string) => Array.from({ length: 3000 }, (_, i) => p + i);
    const ops = diffSeq(["top", ...mid("a"), "bottom"], ["top", ...mid("b"), "bottom"]);
    expect(ops[0]).toEqual({ type: "same", value: "top" });
    expect(ops[ops.length - 1]).toEqual({ type: "same", value: "bottom" });
  });
});
