// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { scopeRoot, searchableIds } from "./searchScope";
import { newNode, type BinderNode } from "./tree";

const parent = (id: string, type: BinderNode["type"], children: BinderNode[]): BinderNode => ({ ...newNode(id, type, id), children });
const nodes = [
  parent("part1", "part", [parent("c1", "chapter", [newNode("s1", "scene", "s1"), newNode("s2", "scene", "s2")]), parent("c2", "chapter", [newNode("s3", "scene", "s3")])]),
  newNode("n1", "note", "n1"),
  parent("c3", "chapter", [newNode("s4", "scene", "s4"), newNode("n2", "note", "n2")]),
  parent("trash", "trash", [newNode("s9", "scene", "s9")]),
];
const all = { manuscript: true, notes: true };

describe("search scope", () => {
  it("searches everything outside the trash for the project", () => {
    expect(searchableIds(nodes, all)).toEqual(["s1", "s2", "s3", "n1", "s4", "n2"]);
    expect(searchableIds(nodes, { manuscript: true, notes: false })).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("limits a chapter scope to the chapter holding the selected scene", () => {
    expect(searchableIds(nodes, all, "chapter", "s2")).toEqual(["s1", "s2"]);
    expect(searchableIds(nodes, all, "chapter", "s4")).toEqual(["s4", "n2"]);
    expect(searchableIds(nodes, { manuscript: true, notes: false }, "chapter", "s4")).toEqual(["s4"]);
  });

  it("uses a selected chapter or part as it is", () => {
    expect(searchableIds(nodes, all, "chapter", "c2")).toEqual(["s3"]);
    expect(searchableIds(nodes, all, "chapter", "part1")).toEqual(["s1", "s2", "s3"]);
  });

  it("searches exactly the selected scene or note, whatever the toggles, even one open from the trash", () => {
    expect(searchableIds(nodes, all, "scene", "s9")).toEqual(["s9"]);
    expect(searchableIds(nodes, { manuscript: false, notes: false }, "scene", "s3")).toEqual(["s3"]);
    expect(searchableIds(nodes, all, "scene", "n2")).toEqual(["n2"]);
  });

  it("has nothing to search when there is nothing to scope to", () => {
    expect(searchableIds(nodes, all, "scene", null)).toEqual([]);
    expect(searchableIds(nodes, all, "scene", "c1")).toEqual([]); // a chapter is not a scene
    expect(searchableIds(nodes, all, "chapter", "n1")).toEqual([]); // a top-level note has no chapter
    expect(searchableIds(nodes, all, "chapter", "s9")).toEqual([]); // the trash is not a chapter
    expect(scopeRoot(nodes, "gone", "chapter")).toBeNull();
  });
});
