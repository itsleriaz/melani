// SPDX-License-Identifier: GPL-3.0-only
// The writing stats page: today, streaks, a year of days, progress towards the target, and where the words are.
import { useEffect, useMemo, useRef, useState } from "react";
import { openSettings } from "./Settings";
import { Icon, Ring } from "./icons";
import { nodeWords, useStore } from "./store";
import { dailyNeeded, dayKey, daysLeft, heatLevel, heatmap, heatmapWeeks, lastDays, projection, streaks, summarize, weeklyTotals, wordsOn } from "./stats";
import { allScenes } from "./collectionRules";
import { BinderNode } from "./tree";

const fmt = (n: number) => n.toLocaleString();
const longDay = (day: string) => new Date(day + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDay = (day: string) => new Date(day + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });

function Tile({ label, value, sub, children }: { label: string; value: React.ReactNode; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="st-tile">
      <span className="st-label">{label}</span>
      <strong>{value}</strong>
      {sub && <span className="st-sub">{sub}</span>}
      {children}
    </div>
  );
}

function Heatmap() {
  const stats = useStore((s) => s.stats);
  const goal = stats.goals.dailyWords;
  const weeks = useMemo(() => heatmap(stats, heatmapWeeks(stats)), [stats]);
  const scroller = useRef<HTMLDivElement>(null);
  // A long history overflows to the left; open on today, at the right edge.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length]);
  const busiest = Math.max(1, ...weeks.flat().map((c) => c.words));
  const scale = goal || busiest;
  // A month's name goes over the first week that starts in it.
  const months = weeks.map((w, i) => {
    const m = new Date(w[0].day + "T00:00:00").getMonth();
    const prev = i > 0 ? new Date(weeks[i - 1][0].day + "T00:00:00").getMonth() : -1;
    return m !== prev ? new Date(w[0].day + "T00:00:00").toLocaleDateString(undefined, { month: "short" }) : "";
  });
  // Labels are about three columns wide; when two would collide (a month that only shows one week at the left edge), keep the later one.
  months.forEach((m, i) => {
    if (m && months.slice(i + 1, i + 3).some(Boolean)) months[i] = "";
  });
  const year = weeks.flat().reduce((a, c) => a + c.words, 0);
  return (
    <section className="st-card" aria-label="Daily writing">
      <header>
        <h3>Daily writing</h3>
        <span className="muted">{fmt(year)} words</span>
      </header>
      <div className="hm-scroll" ref={scroller}>
        <div className="hm">
          <div className="hm-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, 13px)` }} aria-hidden="true">
            {months.map((m, i) => (
              <span key={i}>{m}</span>
            ))}
          </div>
          <div className="hm-body">
            <div className="hm-days" aria-hidden="true">
              <span>Mon</span>
              <span />
              <span>Wed</span>
              <span />
              <span>Fri</span>
              <span />
              <span />
            </div>
            <div className="hm-grid">
              {weeks.map((w, wi) => (
                <div key={wi} className="hm-col">
                  {w.map((c) => (
                    <span
                      key={c.day}
                      className={`hm-cell ${c.future ? "future" : `l${heatLevel(c.words, scale)}`} ${c.day === dayKey() ? "today" : ""}`}
                      data-tip={c.future ? undefined : `${c.words ? fmt(c.words) + " words" : "Nothing written"} · ${longDay(c.day)}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <footer className="hm-legend">
        <span className="muted">{goal ? `Darkest is your daily target of ${fmt(goal)}` : "Darkest is your busiest day"}</span>
        <span className="grow" />
        <span className="muted">Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`hm-cell l${l}`} />
        ))}
        <span className="muted">More</span>
      </footer>
    </section>
  );
}

function Chart() {
  const stats = useStore((s) => s.stats);
  const [by, setBy] = useState<"days" | "weeks">("days");
  const goal = stats.goals.dailyWords;
  const bars =
    by === "days"
      ? lastDays(stats, 30).map((d) => ({ key: d.day, words: Math.max(0, d.words), label: longDay(d.day), axis: shortDay(d.day) }))
      : weeklyTotals(stats, 12).map((w) => ({ key: w.start, words: w.words, label: `Week of ${shortDay(w.start)}`, axis: shortDay(w.start) }));
  const target = by === "days" ? goal : goal ? goal * 7 : undefined;
  const max = Math.max(1, target ?? 0, ...bars.map((b) => b.words));
  return (
    <section className="st-card" aria-label="Words written">
      <header>
        <h3>Words written</h3>
        <div className="segmented" role="radiogroup" aria-label="Chart range">
          <button role="radio" aria-checked={by === "days"} className={by === "days" ? "on" : ""} onClick={() => setBy("days")}>
            30 days
          </button>
          <button role="radio" aria-checked={by === "weeks"} className={by === "weeks" ? "on" : ""} onClick={() => setBy("weeks")}>
            12 weeks
          </button>
        </div>
      </header>
      <div className="st-bars">
        {target ? <span className="st-goal" style={{ bottom: `${(target / max) * 100}%` }} data-tip={`${by === "days" ? "Daily" : "Weekly"} target ${fmt(target)}`} /> : null}
        {bars.map((b) => (
          <span key={b.key} className="st-bar-slot" data-tip={`${fmt(b.words)} words · ${b.label}`}>
            <span className={`st-bar ${target && b.words >= target ? "hit" : ""}`} style={{ height: `${(b.words / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="st-axis">
        <span>{bars[0].axis}</span>
        <span>{bars[bars.length - 1].axis}</span>
      </div>
    </section>
  );
}

function Progress({ total }: { total: number }) {
  const stats = useStore((s) => s.stats);
  const set = useStore((s) => s.set);
  const { goals } = stats;
  const left = daysLeft(goals.deadline);
  const need = dailyNeeded(goals, total);
  const proj = projection(goals, total, stats);
  const pct = goals.projectWords ? Math.min(100, (total / goals.projectWords) * 100) : 0;
  return (
    <section className="st-card" aria-label="Progress towards the target">
      <header>
        <h3>The book</h3>
        <button className="link-btn" onClick={() => openSettings("project-goals")}>
          Edit goals
        </button>
      </header>
      {goals.projectWords ? (
        <>
          <div className="st-big">
            {fmt(total)} <span className="muted">of {fmt(goals.projectWords)} words · {Math.floor(pct)}%</span>
          </div>
          <div className="st-meter" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </div>
          <ul className="st-facts">
            {goals.deadline && left !== null && <li>{left >= 0 ? `${left} day${left === 1 ? "" : "s"} until ${shortDay(goals.deadline)}` : `The deadline, ${shortDay(goals.deadline)}, was ${-left} day${left === -1 ? "" : "s"} ago`}</li>}
            {need !== null && <li>{need > 0 ? `${fmt(need)} words a day to make it` : "You have already written enough to hit the target"}</li>}
            {proj && proj.finish && (
              <li>
                At {fmt(Math.round(proj.pace))} words a day you would finish around {longDay(proj.finish)}
                {proj.daysLate !== null && (proj.daysLate > 0 ? `, ${proj.daysLate} day${proj.daysLate === 1 ? "" : "s"} after the deadline` : `, ${-proj.daysLate} day${proj.daysLate === -1 ? "" : "s"} before the deadline`)}.
              </li>
            )}
            {proj && !proj.finish && total < goals.projectWords && <li>Write a little over the next two weeks and a finish date will appear here.</li>}
            {total >= goals.projectWords && <li>Target reached.</li>}
          </ul>
        </>
      ) : (
        <div className="st-empty">
          <p className="muted">Set a word target for the book (and, if you like, a deadline) to see progress and a finish date.</p>
          <button className="btn small" onClick={() => (openSettings("project-goals"), set({}))}>
            Set goals
          </button>
        </div>
      )}
    </section>
  );
}

interface Slice {
  name: string;
  words: number;
}

function Breakdowns() {
  const nodes = useStore((s) => s.nodes);
  const counts = useStore((s) => s.counts);
  const select = useStore((s) => s.select);
  const { chapters, status, pov } = useMemo(() => {
    const top = nodes.filter((n) => (n.type === "chapter" || n.type === "part") && n.type !== ("trash" as string));
    const chapters: (Slice & { id: string })[] = top.map((n: BinderNode) => ({ id: n.id, name: n.title, words: nodeWords(counts, n.id, nodes) }));
    const scenes = allScenes(nodes);
    const by = (key: (n: BinderNode) => string) => {
      const m = new Map<string, number>();
      for (const s of scenes) m.set(key(s), (m.get(key(s)) ?? 0) + (counts[s.id] ?? 0));
      return [...m].map(([name, words]) => ({ name, words })).sort((a, b) => b.words - a.words);
    };
    return { chapters, status: by((n) => n.status), pov: by((n) => n.fields?.pov?.trim() || "") };
  }, [nodes, counts]);
  const maxCh = Math.max(1, ...chapters.map((c) => c.words));
  const totalStatus = status.reduce((a, s) => a + s.words, 0) || 1;
  const povShown = pov.filter((p) => p.name);
  const noPov = pov.find((p) => !p.name)?.words ?? 0;
  const maxPov = Math.max(1, ...pov.map((p) => p.words));
  return (
    <div className="st-two">
      <section className="st-card" aria-label="Words by chapter">
        <header>
          <h3>By chapter</h3>
        </header>
        {chapters.length === 0 ? (
          <p className="muted">No chapters yet.</p>
        ) : (
          <ul className="st-rows">
            {chapters.map((c) => (
              <li key={c.id}>
                <button className="st-row" onClick={() => select(c.id)}>
                  <span className="st-row-name">{c.name}</span>
                  <span className="st-row-bar">
                    <span style={{ width: `${(c.words / maxCh) * 100}%` }} />
                  </span>
                  <span className="st-row-num">{fmt(c.words)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="st-card" aria-label="Words by status and point of view">
        <header>
          <h3>By status</h3>
        </header>
        <div className="st-stack" role="img" aria-label={status.map((s) => `${s.name} ${fmt(s.words)} words`).join(", ")}>
          {status.map((s) => (
            <span key={s.name} className={`st-seg status-${s.name}`} style={{ flexGrow: s.words || 0.0001 }} data-tip={`${s.name[0].toUpperCase() + s.name.slice(1)}: ${fmt(s.words)} words`} />
          ))}
        </div>
        <ul className="st-key">
          {status.map((s) => (
            <li key={s.name}>
              <span className={`st-swatch status-${s.name}`} />
              {s.name[0].toUpperCase() + s.name.slice(1)} <span className="muted">{Math.round((s.words / totalStatus) * 100)}%</span>
            </li>
          ))}
        </ul>
        <header className="st-sub-head">
          <h3>By point of view</h3>
        </header>
        {povShown.length === 0 ? (
          <p className="muted">Give scenes a point of view in their details and the words per character will show up here.</p>
        ) : (
          <ul className="st-rows">
            {povShown.map((p) => (
              <li key={p.name} className="st-row static">
                <span className="st-row-name">{p.name}</span>
                <span className="st-row-bar">
                  <span style={{ width: `${(p.words / maxPov) * 100}%` }} />
                </span>
                <span className="st-row-num">{fmt(p.words)}</span>
              </li>
            ))}
            {noPov > 0 && <li className="muted st-row static"><span className="st-row-name">No point of view set</span><span className="st-row-bar" /><span className="st-row-num">{fmt(noPov)}</span></li>}
          </ul>
        )}
      </section>
    </div>
  );
}

export function StatsView() {
  const stats = useStore((s) => s.stats);
  const nodes = useStore((s) => s.nodes);
  const counts = useStore((s) => s.counts);
  const total = nodes.filter((n) => n.type !== "trash").reduce((a, n) => a + nodeWords(counts, n.id, nodes), 0);
  const today = wordsOn(stats, dayKey());
  const goal = stats.goals.dailyWords;
  const st = streaks(stats);
  const sum = summarize(stats);
  return (
    <div className="doc wide stats-doc">
      <p className="eyebrow">Writing</p>
      <h1 className="chapter-title">Your stats</h1>
      <div className="st-tiles">
        <Tile label="Today" value={<>{today < 0 ? "−" : ""}{fmt(Math.abs(today))}</>} sub={goal ? `of ${fmt(goal)} words` : "words"}>
          {goal ? <Ring value={today / goal} size={34} /> : null}
        </Tile>
        <Tile label="Streak" value={<>{st.current} <small>day{st.current === 1 ? "" : "s"}</small></>} sub={`Longest ${st.longest}`} />
        <Tile label="This week" value={fmt(sum.week)} sub="words since Monday" />
        <Tile label="This month" value={fmt(sum.month)} sub="words" />
        <Tile label="Best day" value={sum.best ? fmt(sum.best.words) : "–"} sub={sum.best ? shortDay(sum.best.day) : "No days yet"} />
        <Tile label="Usual day" value={fmt(sum.averagePerDay)} sub={`over ${sum.daysWritten} day${sum.daysWritten === 1 ? "" : "s"} written`} />
      </div>
      <Heatmap />
      <div className="st-two">
        <Chart />
        <Progress total={total} />
      </div>
      <Breakdowns />
      <p className="muted st-note">
        <Icon name="info" size={13} /> Days count the net change in the book's word total, so cutting more than you write shows as nothing. History starts the day you first opened this project with stats on.
      </p>
    </div>
  );
}
