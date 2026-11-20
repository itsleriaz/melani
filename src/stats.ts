// SPDX-License-Identifier: GPL-3.0-only
// Writing goals and daily history (stored in stats.json). Pure helpers, easy to test.

export interface Goals {
  projectWords?: number;
  /** YYYY-MM-DD */
  deadline?: string;
  dailyWords?: number;
  /** YYYY-MM-DD. Where the stats heatmap begins; defaults to the first day with recorded history. */
  startDate?: string;
}

/** Per day: the manuscript total when first seen that day, and the latest total. */
export interface Stats {
  goals: Goals;
  history: Record<string, { baseline: number; total: number }>;
}

export const emptyStats = (): Stats => ({ goals: {}, history: {} });

export function parseStats(raw: string): Stats {
  try {
    const v = JSON.parse(raw);
    return { goals: typeof v?.goals === "object" && v.goals ? v.goals : {}, history: typeof v?.history === "object" && v.history ? v.history : {} };
  } catch {
    return emptyStats();
  }
}

/** Local date as YYYY-MM-DD. */
export function dayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Returns the same object when nothing changed, so callers can skip saving. */
export function recordTotal(stats: Stats, total: number, today: string = dayKey()): Stats {
  const cur = stats.history[today];
  if (cur && cur.total === total) return stats;
  const entry = cur ? { ...cur, total } : { baseline: total, total };
  return { ...stats, history: { ...stats.history, [today]: entry } };
}

/** Net words written on a day (can be negative if the writer cut more than they wrote). */
export function wordsOn(stats: Stats, day: string): number {
  const h = stats.history[day];
  return h ? h.total - h.baseline : 0;
}

export function lastDays(stats: Stats, n: number, today: string = dayKey()): { day: string; words: number }[] {
  const [y, m, d] = today.split("-").map(Number);
  const out: { day: string; words: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = dayKey(new Date(y, m - 1, d - i));
    out.push({ day, words: wordsOn(stats, day) });
  }
  return out;
}

/** Whole days from `today` to the deadline, or null when there is none or it is malformed. */
export function daysLeft(deadline: string | undefined, today: string = dayKey()): number | null {
  if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return null;
  const t = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(deadline) - t(today)) / 86_400_000);
}

/** Words per day needed to hit the project target by the deadline (counting today). */
export function dailyNeeded(goals: Goals, total: number, today: string = dayKey()): number | null {
  const left = daysLeft(goals.deadline, today);
  if (left === null || !goals.projectWords || left < 0) return null;
  return Math.max(0, Math.ceil((goals.projectWords - total) / (left + 1)));
}

// ---- For the stats view -----------------------------------------------------------------

const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (day: string, n: number) => {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return dayKey(d);
};
/** Words written on a day for charts: a day that lost words counts as nothing. */
export const writtenOn = (stats: Stats, day: string) => Math.max(0, wordsOn(stats, day));
/** 0 = Monday … 6 = Sunday. */
const weekdayOf = (day: string) => (parseDay(day).getDay() + 6) % 7;

export interface HeatCell {
  day: string;
  words: number;
  /** After today, so drawn blank. */
  future: boolean;
}

/** `weeks` columns of seven days, Monday to Sunday, the last column holding today. */
export function heatmap(stats: Stats, weeks = 53, today: string = dayKey()): HeatCell[][] {
  const lastMonday = addDays(today, -weekdayOf(today));
  const start = addDays(lastMonday, -(weeks - 1) * 7);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const day = addDays(start, w * 7 + d);
      const future = day > today;
      return { day, words: future ? 0 : writtenOn(stats, day), future };
    }),
  );
}

const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Columns the heatmap needs to run from the start date (or the first recorded day) to today, never fewer than `minWeeks`. */
export function heatmapWeeks(stats: Stats, today: string = dayKey(), minWeeks = 12): number {
  const first = Object.keys(stats.history).filter(isDay).sort()[0];
  let start = isDay(stats.goals.startDate) ? stats.goals.startDate : (first ?? today);
  if (start > today) start = today;
  const monday = (d: string) => addDays(d, -weekdayOf(d));
  const days = daysLeft(monday(today), monday(start)) ?? 0;
  return Math.max(minWeeks, Math.round(days / 7) + 1);
}

/** 0 (nothing) to 4, against the daily goal when there is one, else the busiest day shown. */
export function heatLevel(words: number, scale: number): 0 | 1 | 2 | 3 | 4 {
  if (words <= 0 || scale <= 0) return 0;
  const r = words / scale;
  return r < 0.25 ? 1 : r < 0.5 ? 2 : r < 1 ? 3 : 4;
}

/** Days in a row with words written. A streak is still alive on a day you have not written yet. */
export function streaks(stats: Stats, today: string = dayKey()): { current: number; longest: number } {
  const days = Object.keys(stats.history).filter((d) => writtenOn(stats, d) > 0).sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of days) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  let d = writtenOn(stats, today) > 0 ? today : addDays(today, -1);
  while (writtenOn(stats, d) > 0) {
    current++;
    d = addDays(d, -1);
  }
  return { current, longest };
}

export interface Summary {
  totalWritten: number;
  daysWritten: number;
  best: { day: string; words: number } | null;
  averagePerDay: number;
  week: number;
  month: number;
}

/** Totals over all the history; "week" runs from Monday, "month" from the 1st. */
export function summarize(stats: Stats, today: string = dayKey()): Summary {
  const days = Object.keys(stats.history).filter((d) => d <= today);
  let totalWritten = 0;
  let daysWritten = 0;
  let best: Summary["best"] = null;
  for (const d of days) {
    const w = writtenOn(stats, d);
    if (w <= 0) continue;
    totalWritten += w;
    daysWritten++;
    if (!best || w > best.words) best = { day: d, words: w };
  }
  const monday = addDays(today, -weekdayOf(today));
  const first = today.slice(0, 8) + "01";
  const sum = (from: string) => days.filter((d) => d >= from).reduce((a, d) => a + writtenOn(stats, d), 0);
  return { totalWritten, daysWritten, best, averagePerDay: daysWritten ? Math.round(totalWritten / daysWritten) : 0, week: sum(monday), month: sum(first) };
}

/** Words per week for the last `n` weeks, oldest first; each week starts on a Monday. */
export function weeklyTotals(stats: Stats, n: number, today: string = dayKey()): { start: string; words: number }[] {
  const thisMonday = addDays(today, -weekdayOf(today));
  return Array.from({ length: n }, (_, i) => {
    const start = addDays(thisMonday, -(n - 1 - i) * 7);
    let words = 0;
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, d);
      if (day <= today) words += writtenOn(stats, day);
    }
    return { start, words };
  });
}

export interface Projection {
  /** Words a day over the last two weeks. */
  pace: number;
  /** When the target is reached at that pace, or null when it is already met or there is no pace. */
  finish: string | null;
  /** Days the finish falls after (positive) or before (negative) the deadline, when there is one. */
  daysLate: number | null;
}

export function projection(goals: Goals, total: number, stats: Stats, today: string = dayKey()): Projection | null {
  if (!goals.projectWords) return null;
  const recent = lastDays(stats, 14, today).reduce((a, d) => a + Math.max(0, d.words), 0);
  const pace = recent / 14;
  const left = goals.projectWords - total;
  if (left <= 0 || pace <= 0) return { pace, finish: null, daysLate: null };
  const finish = addDays(today, Math.ceil(left / pace));
  const dl = daysLeft(goals.deadline, today);
  const daysLate = dl === null ? null : Math.ceil(left / pace) - dl;
  return { pace, finish, daysLate };
}
