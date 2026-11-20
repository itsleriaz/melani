// SPDX-License-Identifier: GPL-3.0-only
export type Op<T = string> = { type: "same" | "add" | "del"; value: T };

/** Above this many table cells the middle is shown as one replaced block instead of diffed. */
const MAX_CELLS = 4_000_000;

/** Longest-common-subsequence diff of two sequences. */
export function diffSeq<T>(a: T[], b: T[]): Op<T>[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: Op<T>[] = a.slice(0, start).map((value) => ({ type: "same", value }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);

  if (ma.length * mb.length > MAX_CELLS) {
    ma.forEach((value) => out.push({ type: "del", value }));
    mb.forEach((value) => out.push({ type: "add", value }));
  } else if (ma.length === 0 || mb.length === 0) {
    ma.forEach((value) => out.push({ type: "del", value }));
    mb.forEach((value) => out.push({ type: "add", value }));
  } else {
    // lcs[i][j] = length of the LCS of ma[i..] and mb[j..]
    const w = mb.length + 1;
    const lcs = new Uint32Array((ma.length + 1) * w);
    for (let i = ma.length - 1; i >= 0; i--) {
      for (let j = mb.length - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < ma.length && j < mb.length) {
      if (ma[i] === mb[j]) {
        out.push({ type: "same", value: ma[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        out.push({ type: "del", value: ma[i++] });
      } else {
        out.push({ type: "add", value: mb[j++] });
      }
    }
    while (i < ma.length) out.push({ type: "del", value: ma[i++] });
    while (j < mb.length) out.push({ type: "add", value: mb[j++] });
  }
  for (const value of a.slice(endA)) out.push({ type: "same", value });
  return out;
}

export function diffLines(a: string, b: string): Op[] {
  const split = (s: string) => (s === "" ? [] : s.split("\n"));
  return diffSeq(split(a), split(b));
}

/** Word-level diff that keeps whitespace, so the pieces join back into the original text. */
export function diffWords(a: string, b: string): Op[] {
  const tok = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];
  return diffSeq(tok(a), tok(b));
}

export function stats(ops: Op[]): { added: number; removed: number } {
  return {
    added: ops.filter((o) => o.type === "add").length,
    removed: ops.filter((o) => o.type === "del").length,
  };
}
