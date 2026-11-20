// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { applyVerdicts, batches, Candidate, checkLine, estimateCheck, estimatePass, fromScan, knownNames, mergeAi, parseAiEntries, parseVerdicts } from "./extract";

const scanned = (name: string, count: number, extra: Partial<Candidate> = {}) => ({ name, aliases: [], kind: "other", count, scenes: 1, firstScene: "s1", firstTitle: "One", examples: [], summary: "", ...extra });
const base = () => fromScan([scanned("Wren", 9, { kind: "character" }), scanned("Gallowgate", 4), scanned("Mrs. Hebble", 3, { aliases: ["Hebble"] })]);

describe("reading the AI's reply", () => {
  it("keeps named entries, fixes unknown types and drops junk", () => {
    const r = parseAiEntries('```json\n[{"name":"Wren Callow","type":"Character","aliases":["Wren","  "],"summary":"A thief."},{"name":"","type":"place"},{"name":"The Gaol","type":"prison"},7]\n```')!;
    expect(r).toEqual([
      { name: "Wren Callow", type: "character", aliases: ["Wren"], summary: "A thief." },
      { name: "The Gaol", type: "other", aliases: [], summary: "" },
    ]);
    expect(parseAiEntries("nothing")).toBeNull();
  });
  it("keeps the complete entries of a reply that was cut off", () => {
    const r = parseAiEntries('[{"name":"A","type":"place","aliases":[],"summary":"s"},{"name":"B","type":"cha')!;
    expect(r.map((e) => e.name)).toEqual(["A"]);
  });
});

describe("folding AI entries into the scan", () => {
  it("adds type, aliases and summary to one that is already there, and keeps its counts", () => {
    const out = mergeAi(base(), [{ name: "Gallowgate", type: "place", aliases: ["the Gate"], summary: "A street." }]);
    const g = out.find((c) => c.name === "Gallowgate")!;
    expect(g).toMatchObject({ kind: "place", aliases: ["the Gate"], summary: "A street.", count: 4, source: "both" });
    expect(out).toHaveLength(3);
  });
  it("takes the longer name when a one-word scan name is part of it", () => {
    const out = mergeAi(base(), [{ name: "Wren Callow", type: "character", aliases: ["Miss Callow"], summary: "The thief." }]);
    const w = out.find((c) => c.name === "Wren Callow")!;
    expect(w.aliases).toEqual(["Wren", "Miss Callow"]);
    expect(w.count).toBe(9);
    expect(out.some((c) => c.name === "Wren")).toBe(false);
  });
  it("matches by an alias the scan already knows", () => {
    const out = mergeAi(base(), [{ name: "Hebble", type: "character", aliases: [], summary: "The widow downstairs." }]);
    expect(out.find((c) => c.name === "Mrs. Hebble")).toMatchObject({ summary: "The widow downstairs.", kind: "character" });
    expect(out).toHaveLength(3);
  });
  it("adds what is new, and a second mention of it folds into the first", () => {
    let out = mergeAi(base(), [{ name: "The Notary", type: "faction", aliases: [], summary: "Keeps the ledgers." }]);
    out = mergeAi(out, [{ name: "The Notary", type: "faction", aliases: ["the Office"], summary: "Another sentence." }]);
    const n = out.filter((c) => c.name === "The Notary");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ source: "ai", count: 0, summary: "Keeps the ledgers.", aliases: ["the Office"] });
  });
  it("does not let an uncertain 'other' overwrite a good guess", () => {
    const out = mergeAi(base(), [{ name: "Wren", type: "other", aliases: [], summary: "" }]);
    expect(out.find((c) => c.name === "Wren")!.kind).toBe("character");
  });
});

describe("the AI pass", () => {
  it("tells the model what is known, codex first, without repeats and capped", () => {
    expect(knownNames(["Diane", "Wren"], base())).toEqual(["Diane", "Wren", "Gallowgate", "Mrs. Hebble"]);
    expect(knownNames([], base(), 2)).toEqual(["Wren", "Gallowgate"]);
  });
  it("estimates the tokens it will use", () => {
    expect(estimatePass([5000, 6000])).toEqual({ tokensIn: 5000 + 6000 + 1400, tokensOut: 3000 });
  });
});

describe("the AI's check of the scan", () => {
  const list = () => fromScan([scanned("I'll", 30, { examples: ["I'll go now."] }), scanned("Wren", 9, { kind: "other", examples: ["Wren ran."] }), scanned("Gallowgate", 4)]);
  it("reads yes and no answers, and drops malformed ones", () => {
    const v = parseVerdicts('```json\n[{"name":"I\'ll","keep":false,"type":"other"},{"name":"Wren","keep":true,"type":"Character"},{"name":"x"},{"keep":true},5]\n```')!;
    expect(v).toEqual([
      { name: "I'll", keep: false, type: "other" },
      { name: "Wren", keep: true, type: "character" },
    ]);
    expect(parseVerdicts("nope")).toBeNull();
  });
  it("marks each name and takes a better type, leaving unmentioned names unjudged", () => {
    const out = applyVerdicts(list(), [{ name: "i'll", keep: false, type: "other" }, { name: "Wren", keep: true, type: "character" }]);
    expect(out[0].verdict).toBe("drop");
    expect(out[1]).toMatchObject({ verdict: "keep", kind: "character" });
    expect(out[2].verdict).toBeUndefined();
  });
  it("keeps the AI from being told about names it rejected", () => {
    const out = applyVerdicts(list(), [{ name: "I'll", keep: false, type: "other" }]);
    expect(knownNames([], out)).toEqual(["Wren", "Gallowgate"]);
  });
  it("shows one line a name, in batches, with an estimate", () => {
    expect(checkLine(list()[1])).toBe('Wren: "Wren ran."');
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(estimateCheck(120)).toEqual({ tokensIn: 120 * 45 + 2 * 350, tokensOut: 120 * 25 });
  });
});
