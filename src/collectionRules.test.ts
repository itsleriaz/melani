// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { Collection, defaultRule, members, Rule } from "./collectionRules";
import { addChild, newNode } from "./tree";

const scene = (id: string, extra: Partial<ReturnType<typeof newNode>> = {}) => ({ ...newNode(id, "scene", id), ...extra });
const book = () => {
  let t = [newNode("c1", "chapter", "C1"), newNode("tr", "trash", "Trash")];
  t = addChild(t, "c1", scene("a", { status: "final", keywords: ["Flashback"], fields: { pov: "Diane", Weather: "rain" } }));
  t = addChild(t, "c1", scene("b", { status: "draft", label: "blue", fields: { pov: "Marcus" } }));
  t = addChild(t, "c1", scene("c", { status: "draft" }));
  t = addChild(t, "tr", scene("gone", { status: "final" }));
  return t;
};
const facts = { words: { a: 900, b: 120, c: 0 }, mentions: { a: ["diane"], b: ["diane", "marcus"] } };
const smart = (rules: Rule[], match: "all" | "any" = "all"): Collection => ({ id: "x", name: "x", kind: "smart", ids: [], rules, match });
const ids = (c: Collection) => members(c, book(), facts).map((n) => n.id);

describe("smart collections", () => {
  it("match by status, and never include the trash", () => {
    expect(ids(smart([{ field: "status", op: "is", value: "final" }]))).toEqual(["a"]);
    expect(ids(smart([{ field: "status", op: "isNot", value: "final" }]))).toEqual(["b", "c"]);
  });
  it("match keywords without caring about case", () => {
    expect(ids(smart([{ field: "keyword", op: "has", value: "flashback" }]))).toEqual(["a"]);
    expect(ids(smart([{ field: "keyword", op: "hasNot", value: "flashback" }]))).toEqual(["b", "c"]);
  });
  it("match who a scene mentions", () => {
    expect(ids(smart([{ field: "mentions", op: "has", value: "diane" }]))).toEqual(["a", "b"]);
    expect(ids(smart([{ field: "mentions", op: "has", value: "marcus" }]))).toEqual(["b"]);
  });
  it("match fields, including custom ones and empty ones", () => {
    expect(ids(smart([{ field: "pov", op: "is", value: "marcus" }]))).toEqual(["b"]);
    expect(ids(smart([{ field: "pov", op: "isUnset", value: "" }]))).toEqual(["c"]);
    expect(ids(smart([{ field: "field:Weather", op: "contains", value: "ra" }]))).toEqual(["a"]);
  });
  it("compare word counts", () => {
    expect(ids(smart([{ field: "words", op: "gt", value: "500" }]))).toEqual(["a"]);
    expect(ids(smart([{ field: "words", op: "lt", value: "500" }]))).toEqual(["b", "c"]);
  });
  it("combine rules with all or any", () => {
    const rules: Rule[] = [{ field: "status", op: "is", value: "draft" }, { field: "pov", op: "is", value: "marcus" }];
    expect(ids(smart(rules, "all"))).toEqual(["b"]);
    expect(ids(smart(rules, "any"))).toEqual(["b", "c"]);
  });
  it("ignore rules that are not filled in yet, and hold nothing without any", () => {
    expect(ids(smart([]))).toEqual([]);
    expect(ids(smart([defaultRule("status")]))).toEqual([]);
    expect(ids(smart([defaultRule("status"), { field: "status", op: "is", value: "final" }]))).toEqual(["a"]);
  });
});

describe("manual collections", () => {
  it("keep the order they were built in and skip scenes that no longer exist", () => {
    const c: Collection = { id: "m", name: "m", kind: "manual", ids: ["c", "missing", "a"], rules: [], match: "all" };
    expect(members(c, book(), facts).map((n) => n.id)).toEqual(["c", "a"]);
  });
});
