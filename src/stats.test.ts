// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { dailyNeeded, dayKey, daysLeft, emptyStats, heatLevel, heatmap, heatmapWeeks, lastDays, parseStats, projection, recordTotal, streaks, summarize, weeklyTotals, wordsOn, Stats } from "./stats";

describe("daily history", () => {
  it("uses the first total of the day as the baseline", () => {
    let s = recordTotal(emptyStats(), 1000, "2026-11-20");
    s = recordTotal(s, 1350, "2026-11-20");
    expect(wordsOn(s, "2026-11-20")).toBe(350);
    s = recordTotal(s, 1300, "2026-11-20");
    expect(wordsOn(s, "2026-11-20")).toBe(300);
    // A new day starts from where the last one ended.
    s = recordTotal(s, 1300, "2026-11-21");
    expect(wordsOn(s, "2026-11-21")).toBe(0);
  });
  it("returns the same object when nothing changed", () => {
    const s = recordTotal(emptyStats(), 10, "2026-11-20");
    expect(recordTotal(s, 10, "2026-11-20")).toBe(s);
  });
  it("lists the last days across a month boundary, oldest first", () => {
    const s = recordTotal(emptyStats(), 5, "2026-12-01");
    const days = lastDays(s, 3, "2026-12-01");
    expect(days.map((d) => d.day)).toEqual(["2026-11-29", "2026-11-30", "2026-12-01"]);
  });
  it("formats local dates with zero padding", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("deadline maths", () => {
  it("counts days left", () => {
    expect(daysLeft("2026-11-30", "2026-11-20")).toBe(10);
    expect(daysLeft("2026-11-20", "2026-11-20")).toBe(0);
    expect(daysLeft(undefined)).toBeNull();
    expect(daysLeft("soon")).toBeNull();
  });
  it("works out the daily words needed, counting today", () => {
    expect(dailyNeeded({ projectWords: 10_000, deadline: "2026-11-29" }, 5_000, "2026-11-20")).toBe(500);
    expect(dailyNeeded({ projectWords: 10_000, deadline: "2026-11-29" }, 12_000, "2026-11-20")).toBe(0);
    expect(dailyNeeded({ projectWords: 10_000, deadline: "2026-11-01" }, 0, "2026-11-20")).toBeNull();
    expect(dailyNeeded({ projectWords: 10_000 }, 0)).toBeNull();
  });
});

describe("parseStats", () => {
  it("tolerates missing or malformed files", () => {
    expect(parseStats("{}")).toEqual(emptyStats());
    expect(parseStats("not json")).toEqual(emptyStats());
    expect(parseStats('{"goals":{"dailyWords":500}}').goals.dailyWords).toBe(500);
  });
});

const hist = (days: Record<string, number>): Stats => ({ goals: {}, history: Object.fromEntries(Object.entries(days).map(([d, w]) => [d, { baseline: 0, total: w }])) });

describe("streaks", () => {
  it("count days in a row, and stay alive until the day ends", () => {
    const s = hist({ "2026-11-17": 100, "2026-11-18": 50, "2026-11-19": 10 });
    expect(streaks(s, "2026-11-19")).toEqual({ current: 3, longest: 3 });
    // Nothing yet today: yesterday's streak is still alive.
    expect(streaks(s, "2026-11-20")).toEqual({ current: 3, longest: 3 });
    // A missed day breaks it.
    expect(streaks(s, "2026-11-21")).toEqual({ current: 0, longest: 3 });
  });
  it("find the longest run, not the latest", () => {
    const s = hist({ "2026-10-01": 5, "2026-10-02": 5, "2026-10-03": 5, "2026-10-04": 5, "2026-11-19": 5 });
    expect(streaks(s, "2026-11-19")).toEqual({ current: 1, longest: 4 });
  });
  it("ignore days that lost words", () => {
    expect(streaks({ goals: {}, history: { "2026-11-19": { baseline: 500, total: 400 } } }, "2026-11-19").current).toBe(0);
  });
});

describe("summaries", () => {
  const s = hist({ "2026-11-02": 300, "2026-11-16": 500, "2026-11-18": 200, "2026-10-30": 1000 });
  it("total, best day and average over days written", () => {
    const x = summarize(s, "2026-11-20");
    expect(x.totalWritten).toBe(2000);
    expect(x.daysWritten).toBe(4);
    expect(x.best).toEqual({ day: "2026-10-30", words: 1000 });
    expect(x.averagePerDay).toBe(500);
  });
  it("this week starts on Monday and this month on the 1st", () => {
    // 2026-11-20 is a Friday: the week is 16th to 20th.
    const x = summarize(s, "2026-11-20");
    expect(x.week).toBe(700);
    expect(x.month).toBe(1000);
  });
  it("total words per week, oldest first", () => {
    const w = weeklyTotals(s, 3, "2026-11-20");
    expect(w.map((x) => x.start)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(w.map((x) => x.words)).toEqual([300, 0, 700]);
  });
});

describe("heatmap", () => {
  it("is weeks of Monday to Sunday ending with this week, and blanks the future", () => {
    const g = heatmap(hist({ "2026-11-20": 400 }), 4, "2026-11-20");
    expect(g).toHaveLength(4);
    expect(g.every((c) => c.length === 7)).toBe(true);
    const last = g[3];
    expect(last[0].day).toBe("2026-11-16"); // Monday
    expect(last[4]).toMatchObject({ day: "2026-11-20", words: 400, future: false });
    expect(last[5].future).toBe(true);
  });
  it("buckets a day against the scale", () => {
    expect([0, 10, 30, 60, 100, 500].map((w) => heatLevel(w, 100))).toEqual([0, 1, 2, 3, 4, 4]);
    expect(heatLevel(5, 0)).toBe(0);
  });
});

describe("heatmapWeeks", () => {
  const today = "2026-11-20"; // a Friday
  it("starts at the first recorded day and never shrinks below the minimum", () => {
    expect(heatmapWeeks(emptyStats(), today)).toBe(12);
    expect(heatmapWeeks(hist({ "2026-11-18": 5 }), today)).toBe(12);
    expect(heatmapWeeks(hist({ "2025-11-20": 5 }), today)).toBe(53);
    expect(heatmapWeeks(hist({ "2024-11-20": 5 }), today)).toBeGreaterThan(104);
  });
  it("lets a start date override it, and ignores a bad or future one", () => {
    const s = hist({ "2025-11-20": 5 });
    expect(heatmapWeeks({ ...s, goals: { startDate: "2025-01-01" } }, today)).toBe(heatmapWeeks(hist({ "2025-01-01": 1 }), today));
    expect(heatmapWeeks({ ...s, goals: { startDate: "2027-01-01" } }, today)).toBe(12);
    expect(heatmapWeeks({ ...s, goals: { startDate: "soon" } }, today)).toBe(53);
  });
});

describe("projection", () => {
  it("uses the last two weeks to say when the target is reached", () => {
    const s = hist({ "2026-11-15": 700, "2026-11-19": 700 }); // 100 a day over 14 days
    const p = projection({ projectWords: 10_000, deadline: "2026-12-20" }, 9_000, s, "2026-11-20")!;
    expect(Math.round(p.pace)).toBe(100);
    expect(p.finish).toBe("2026-11-30"); // 10 days at 100/day
    expect(p.daysLate).toBe(10 - 30); // 20 days to spare
  });
  it("has nothing to say without a target, a pace, or when the target is met", () => {
    expect(projection({}, 0, emptyStats())).toBeNull();
    expect(projection({ projectWords: 100 }, 0, emptyStats(), "2026-11-20")).toMatchObject({ finish: null });
    expect(projection({ projectWords: 100 }, 150, hist({ "2026-11-19": 50 }), "2026-11-20")).toMatchObject({ finish: null });
  });
});
