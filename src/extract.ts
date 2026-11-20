// SPDX-License-Identifier: GPL-3.0-only
// Candidates for codex entries: from the local scan (src-tauri/src/extract.rs) and from the AI pass.
import { parseJsonArray, salvageObjects } from "./ai";
import { ENTRY_TYPES } from "./codexTypes";

export interface Candidate {
  /** Stable key for the row. */
  key: string;
  name: string;
  aliases: string[];
  kind: string;
  count: number;
  scenes: number;
  firstScene: string;
  firstTitle: string;
  examples: string[];
  summary: string;
  /** Where it came from: the local scan, the AI, or both. */
  source: "scan" | "ai" | "both";
  /** What the AI said about a scanned name: a real entry, or not (a contraction, a common word). */
  verdict?: "keep" | "drop";
}

/** What the Rust scan returns. */
export type Scanned = Omit<Candidate, "key" | "source">;

export interface AiEntry {
  name: string;
  type: string;
  aliases: string[];
  summary: string;
}

export const fromScan = (list: Scanned[]): Candidate[] => list.map((c, i) => ({ ...c, key: `scan-${i}-${c.name}`, source: "scan" }));

const low = (s: string) => s.trim().toLowerCase();

/** Entries from an AI reply. Items without a name are dropped; a reply cut off at the limit keeps what was complete. */
export function parseAiEntries(text: string): AiEntry[] | null {
  const arr = parseJsonArray(text) ?? salvageObjects(text);
  if (!arr) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      name: str(x.name),
      type: ENTRY_TYPES.includes(str(x.type).toLowerCase()) ? str(x.type).toLowerCase() : "other",
      aliases: Array.isArray(x.aliases) ? x.aliases.map(str).filter(Boolean) : [],
      summary: str(x.summary),
    }))
    .filter((e) => e.name);
}

/** Every name a candidate answers to, lower-cased. */
const namesOf = (c: { name: string; aliases: string[] }) => [c.name, ...c.aliases].map(low);

/** The candidate an AI entry is about, if it is already in the list: the same name or alias, or a one-word name that is part of it. */
function findMatch(list: Candidate[], e: AiEntry): Candidate | undefined {
  const wanted = new Set(namesOf(e));
  const direct = list.find((c) => namesOf(c).some((n) => wanted.has(n)));
  if (direct) return direct;
  // "Wren" in the scan, "Wren Callow" from the AI: the one-word name is a part of the longer one.
  const parts = new Set(low(e.name).split(/\s+/));
  const partial = list.filter((c) => !c.name.includes(" ") && parts.has(low(c.name)));
  return partial.length === 1 ? partial[0] : undefined;
}

/**
 * Fold AI entries into the list. One that is already there gains the AI's type, aliases and summary
 * (the longer name wins); one that is new is added with no counts yet.
 */
export function mergeAi(list: Candidate[], found: AiEntry[]): Candidate[] {
  const out = list.map((c) => ({ ...c, aliases: [...c.aliases] }));
  for (const e of found) {
    const hit = findMatch(out, e);
    if (!hit) {
      out.push({ key: `ai-${out.length}-${e.name}`, name: e.name, aliases: e.aliases.filter((a) => low(a) !== low(e.name)), kind: e.type, count: 0, scenes: 0, firstScene: "", firstTitle: "", examples: [], summary: e.summary, source: "ai" });
      continue;
    }
    const longer = e.name.length > hit.name.length && low(e.name).includes(low(hit.name)) ? e.name : hit.name;
    const names = [hit.name, e.name, ...hit.aliases, ...e.aliases];
    const seen = new Set<string>([low(longer)]);
    hit.aliases = names.filter((n) => n.trim() && !seen.has(low(n)) && (seen.add(low(n)), true));
    hit.name = longer;
    if (e.type !== "other" || hit.kind === "other") hit.kind = e.type !== "other" ? e.type : hit.kind;
    if (!hit.summary && e.summary) hit.summary = e.summary;
    hit.source = hit.source === "scan" ? "both" : hit.source;
  }
  return out;
}

/** Names to tell the AI not to repeat: the codex's own and everything found so far (minus what it said was not an entry), capped. */
export function knownNames(codexNames: string[], list: Candidate[], cap = 150): string[] {
  const names = [...codexNames, ...[...list].filter((c) => c.verdict !== "drop").sort((a, b) => b.count - a.count).map((c) => c.name)];
  return [...new Set(names)].slice(0, cap);
}

/** Rough cost of the AI pass: tokens in (the chunks, the instructions and the list of known names for each), and out. */
export function estimatePass(chunkTokens: number[], overheadPerChunk = 700, outPerChunk = 1500): { tokensIn: number; tokensOut: number } {
  return { tokensIn: chunkTokens.reduce((a, t) => a + t + overheadPerChunk, 0), tokensOut: chunkTokens.length * outPerChunk };
}

export interface Verdict {
  name: string;
  keep: boolean;
  type: string;
}

/** The AI's yes or no for each name it was shown. */
export function parseVerdicts(text: string): Verdict[] | null {
  const arr = parseJsonArray(text) ?? salvageObjects(text);
  if (!arr) return null;
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" && typeof (x as { keep?: unknown }).keep === "boolean")
    .map((x) => ({ name: String(x.name).trim(), keep: x.keep === true, type: ENTRY_TYPES.includes(String(x.type ?? "").toLowerCase()) ? String(x.type).toLowerCase() : "other" }));
}

/** Mark scanned names with the AI's verdict. A "keep" with a better type than the scan's guess takes it. Names it did not mention are left unjudged. */
export function applyVerdicts(list: Candidate[], verdicts: Verdict[]): Candidate[] {
  const byName = new Map(verdicts.map((v) => [low(v.name), v]));
  return list.map((c) => {
    const v = byName.get(low(c.name));
    if (!v) return c;
    return { ...c, verdict: v.keep ? "keep" : "drop", kind: v.keep && v.type !== "other" && (c.kind === "other" || c.source === "scan") ? v.type : c.kind };
  });
}

/** One line per name for the check: the name and an example of it. */
export const checkLine = (c: Candidate) => `${c.name}: "${(c.examples[0] ?? "").replace(/\s+/g, " ").slice(0, 140)}"`;

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What the check costs: about 45 tokens a name and a little per batch, with a short reply for each name. */
export function estimateCheck(names: number, batchSize = 60): { tokensIn: number; tokensOut: number } {
  const n = batches(Array.from({ length: names }), batchSize).length;
  return { tokensIn: names * 45 + n * 350, tokensOut: names * 25 };
}
