// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { cleanNote, escapeNote, readNote } from "./Footnote";

describe("footnote syntax", () => {
  it("reads a note and says how much of the text it used", () => {
    expect(readNote("^[See chapter 2.] and more")).toEqual({ note: "See chapter 2.", length: 17 });
  });
  it("allows balanced brackets and escaped ones inside a note", () => {
    expect(readNote("^[a [b] c]x")?.note).toBe("a [b] c");
    expect(readNote("^[a \\] b]x")?.note).toBe("a ] b");
  });
  it("is not a footnote without a close, or across a line", () => {
    expect(readNote("^[never closed")).toBeNull();
    expect(readNote("^[two\nlines]")).toBeNull();
    expect(readNote("[not a note]")).toBeNull();
    expect(readNote("^ [x]")).toBeNull();
  });
  it("writes what it reads, whatever is in the note", () => {
    for (const note of ["plain", "with [brackets] and ] stray", "back\\slash", "a\nb"]) {
      const out = `^[${escapeNote(note)}]`;
      expect(readNote(out)).toEqual({ note: cleanNote(note), length: out.length });
    }
  });
});
