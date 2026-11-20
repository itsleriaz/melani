// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { addChild, countWords, findNode, leaves, moveNode, moveNodes, newNode, topLevelIds } from "./tree";

const mk = () => {
  let t = [newNode("c1", "chapter", "C1"), newNode("c2", "chapter", "C2"), newNode("tr", "trash", "Trash")];
  t = addChild(t, "c1", newNode("s1", "scene", "S1"));
  t = addChild(t, "c1", newNode("s2", "scene", "S2"));
  t = addChild(t, "c2", newNode("s3", "scene", "S3"));
  return t;
};

describe("moveNode", () => {
  it("reorders within a parent", () => {
    const t = moveNode(mk(), "s2", "s1", "before");
    expect(findNode(t, "c1")!.children.map((c) => c.id)).toEqual(["s2", "s1"]);
  });
  it("moves across chapters", () => {
    const t = moveNode(mk(), "s1", "c2", "inside");
    expect(findNode(t, "c2")!.children.map((c) => c.id)).toEqual(["s3", "s1"]);
    expect(findNode(t, "c1")!.children.map((c) => c.id)).toEqual(["s2"]);
  });
  it("refuses to move a node into its own descendant", () => {
    const t = mk();
    expect(moveNode(t, "c1", "s1", "inside")).toBe(t);
  });
  it("refuses to nest inside a scene or move the trash", () => {
    const t = mk();
    expect(moveNode(t, "s1", "s2", "inside")).toBe(t);
    expect(moveNode(t, "tr", "c1", "before")).toBe(t);
  });
  it("keeps hierarchy valid: no chapter in a chapter, no scene at the root", () => {
    const t = mk();
    expect(moveNode(t, "c2", "c1", "inside")).toBe(t);
    expect(moveNode(t, "c2", "s1", "before")).toBe(t);
    expect(moveNode(t, "s1", "c2", "after")).toBe(t);
    expect(moveNode(t, "s1", "s3", "after")).not.toBe(t);
  });
  it("keeps the trash last and lets anything be trashed", () => {
    const t = moveNode(mk(), "c2", "tr", "inside");
    expect(t.map((n) => n.id)).toEqual(["c1", "tr"]);
    expect(findNode(t, "tr")!.children[0].id).toBe("c2");
    expect(addChild(t, null, newNode("c3", "chapter", "C3")).map((n) => n.id)).toEqual(["c1", "c3", "tr"]);
  });
});

describe("leaves and counts", () => {
  it("lists scenes in order", () => {
    expect(leaves(findNode(mk(), "c1")!).map((n) => n.id)).toEqual(["s1", "s2"]);
  });
  it("counts words, ignoring bare punctuation", () => {
    expect(countWords("Hello — world, it's 2 o'clock ***")).toBe(5);
  });
});

describe("moving several at once", () => {
  const book = () => {
    let t = [newNode("c1", "chapter", "C1"), newNode("c2", "chapter", "C2"), newNode("tr", "trash", "Trash")];
    for (const [c, ids] of [["c1", ["a", "b", "c"]], ["c2", ["d", "e"]]] as const) for (const id of ids) t = addChild(t, c, newNode(id, "scene", id));
    return t;
  };
  const kids = (t: ReturnType<typeof book>, id: string) => findNode(t, id)!.children.map((c) => c.id);
  it("keeps them in book order whichever order they were picked", () => {
    const t = moveNodes(book(), ["e", "a"], "c2", "inside");
    expect(kids(t, "c2")).toEqual(["d", "a", "e"]);
    expect(kids(t, "c1")).toEqual(["b", "c"]);
  });
  it("puts them before or after a target in order", () => {
    expect(kids(moveNodes(book(), ["a", "c"], "d", "before"), "c2")).toEqual(["a", "c", "d", "e"]);
    expect(kids(moveNodes(book(), ["a", "c"], "d", "after"), "c2")).toEqual(["d", "a", "c", "e"]);
  });
  it("moves a chapter with its scenes and ignores scenes picked inside it", () => {
    const t = moveNodes(book(), ["c1", "a"], "tr", "inside");
    expect(kids(t, "tr")).toEqual(["c1"]);
    expect(kids(t, "c1")).toEqual(["a", "b", "c"]);
  });
  it("leaves out what cannot go there and ignores the target itself", () => {
    // A chapter cannot live inside another chapter, so it stays; the scene goes to the end of its own chapter.
    const t = moveNodes(book(), ["c1", "d"], "c2", "inside");
    expect(t.map((n) => n.id)).toEqual(["c1", "c2", "tr"]);
    expect(kids(t, "c2")).toEqual(["e", "d"]);
    expect(topLevelIds(book(), ["tr", "a"])).toEqual(["a"]);
  });
});
