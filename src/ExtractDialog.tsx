// SPDX-License-Identifier: GPL-3.0-only
// Find people, places and more in the book and add the ones you pick to the codex.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatCost, Message } from "./ai";
import { useAi } from "./aiStore";
import { collect } from "./aiTools";
import { ENTRY_TYPES, emptyEntry, splitList } from "./codexTypes";
import { applyVerdicts, batches, Candidate, checkLine, estimateCheck, estimatePass, fromScan, knownNames, mergeAi, parseAiEntries, parseVerdicts, Scanned, AiEntry } from "./extract";
import { Icon } from "./icons";
import { TextField } from "./Metadata";
import { ModelPicker } from "./Settings";
import { useStore } from "./store";
import { useEscape } from "./useEscape";

interface Chunk {
  index: number;
  text: string;
  tokens: number;
  scenes: number;
}
interface Stats {
  count: number;
  scenes: number;
  firstScene: string;
  firstTitle: string;
}

const CHUNK_TOKENS = 5000;
const CHECK_BATCH = 60;
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function ExtractDialog() {
  const dir = useStore((s) => s.dir)!;
  const codex = useStore((s) => s.codex);
  const set = useStore((s) => s.set);
  const hasKey = useAi((s) => s.hasKey) === true;
  const models = useAi((s) => s.models);
  const loadModels = useAi((s) => s.loadModels);
  const [minMentions, setMinMentions] = useState(3);
  const [list, setList] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The AI pass.
  const [model, setModel] = useState(() => useAi.getState().modelFor("extract"));
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [running, setRunning] = useState(false);
  const aiFound = useRef<AiEntry[]>([]);
  const stopped = useRef(false);
  const close = () => {
    stopped.current = true;
    useAi.getState().running?.stop();
    set({ extractOpen: false });
  };
  useEscape(close);
  useEffect(() => void loadModels(), [loadModels]);

  /** Counts for every candidate (and the AI's, which have none yet); drop AI ones the book never mentions. */
  const withStats = async (items: Candidate[]): Promise<Candidate[]> => {
    if (items.length === 0) return items;
    const stats = await invoke<Stats[]>("extract_stats", { dir, groups: items.map((c) => [c.name, ...c.aliases]) });
    const out: Candidate[] = [];
    let missing = 0;
    items.forEach((c, i) => {
      const s = stats[i];
      if (c.source === "ai" && s.count === 0) return void missing++;
      out.push(s.count > 0 ? { ...c, count: s.count, scenes: s.scenes, firstScene: s.firstScene, firstTitle: s.firstTitle } : c);
    });
    if (missing) setNote(`${plural(missing, "suggestion")} from the AI ${missing === 1 ? "is" : "are"} not in the text and ${missing === 1 ? "was" : "were"} left out.`);
    return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  const scan = async () => {
    setError(null);
    setList(null);
    try {
      const scanned = await invoke<Scanned[]>("extract_scan", { dir, minMentions });
      let items = fromScan(scanned);
      if (aiFound.current.length) items = await withStats(mergeAi(items, aiFound.current));
      setList(items);
      setPicked((p) => (p.size ? p : new Set(items.filter((c) => c.count >= 5).map((c) => c.key))));
    } catch (e) {
      setError(String(e));
      setList([]);
    }
  };
  useEffect(() => void scan(), [minMentions]); // eslint-disable-line react-hooks/exhaustive-deps

  // The cost of the AI pass, once we know how big the book is.
  useEffect(() => {
    if (hasKey) void invoke<Chunk[]>("extract_chunks", { dir, maxTokens: CHUNK_TOKENS }).then(setChunks).catch(() => setChunks([]));
  }, [dir, hasKey]);
  const info = models.find((m) => m.id === model);
  const scanned = (list ?? []).filter((c) => c.source === "scan").length;
  const estimate = useMemo(() => {
    if (!chunks || chunks.length === 0) return null;
    const read = estimatePass(chunks.map((c) => c.tokens));
    const check = estimateCheck(scanned, CHECK_BATCH);
    const tokensIn = read.tokensIn + check.tokensIn;
    const tokensOut = read.tokensOut + check.tokensOut;
    const cost = info && info.promptPrice !== null && info.completionPrice !== null ? (tokensIn * info.promptPrice + tokensOut * info.completionPrice) / 1_000_000 : null;
    return { tokensIn, tokensOut, cost };
  }, [chunks, info, scanned]);

  const runAi = async () => {
    if (!chunks || !model || !list) return;
    setRunning(true);
    setError(null);
    setNote(null);
    stopped.current = false;
    aiFound.current = [];
    let current: Candidate[] = list.map((c) => ({ ...c, verdict: undefined }));
    const toCheck = batches(current.filter((c) => c.source === "scan"), CHECK_BATCH);
    const total = toCheck.length + chunks.length;
    let done = 0;
    const ask = async (p: { system: string; user: string }) => {
      const messages: Message[] = [
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ];
      return collect("extract", model, messages);
    };
    let judged = false;
    try {
      // First: which of the scan's names are really entries (not "I'll" or "Where").
      for (const batch of toCheck) {
        if (stopped.current) break;
        setProgress({ done, total, label: "Checking the scan’s names" });
        const p = await invoke<{ system: string; user: string }>("extract_check_prompt", { dir, lines: batch.map(checkLine).join("\n") });
        const r = await ask(p);
        if (r.cancelled || stopped.current) break;
        if (r.error) {
          setError(`${r.error} Stopped while checking the scan’s names.`);
          stopped.current = true;
          break;
        }
        const verdicts = parseVerdicts(r.text);
        if (verdicts?.length) {
          judged = true;
          current = applyVerdicts(current, verdicts);
          setList(current);
        }
        setProgress({ done: ++done, total, label: "Checking the scan’s names" });
      }
      // Then: read the book for types, aliases and summaries, and for names the scan missed.
      for (const chunk of chunks) {
        if (stopped.current) break;
        setProgress({ done, total, label: `Reading part ${chunk.index + 1} of ${chunks.length}` });
        const known = knownNames(codex.map((c) => c.name), current);
        const p = await invoke<{ system: string; user: string }>("extract_prompt", { dir, text: chunk.text, known });
        const r = await ask(p);
        if (r.cancelled || stopped.current) break;
        if (r.error) {
          setError(`${r.error} Stopped after part ${chunk.index} of ${chunks.length}; what was found so far is kept.`);
          break;
        }
        const entries = parseAiEntries(r.text);
        if (entries?.length) {
          aiFound.current.push(...entries);
          current = mergeAi(current, entries);
          setList(current);
        } else if (!entries && !r.truncated) setNote(`Part ${chunk.index + 1} came back in a format that could not be read, so it was skipped.`);
        setProgress({ done: ++done, total, label: `Reading part ${chunk.index + 1} of ${chunks.length}` });
      }
      const merged = await withStats(current);
      setList(merged);
      // Tick what the AI vouches for: scanned names it kept, and names it found itself that the book really uses.
      setPicked((p) => (judged ? new Set(merged.filter((c) => c.verdict !== "drop" && (c.verdict === "keep" || c.source !== "scan") && c.count >= 2).map((c) => c.key)) : new Set([...p, ...merged.filter((c) => c.source !== "scan" && c.count >= 2).map((c) => c.key)])));
      if (judged) setNote(`${merged.filter((c) => c.verdict === "drop").length} names the scan found are not entries (contractions, ordinary words) and are unticked at the bottom. Tick any you want anyway.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const update = (key: string, patch: Partial<Candidate>) => setList((l) => l && l.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const shown = [...(list ?? [])].sort((a, b) => Number(a.verdict === "drop") - Number(b.verdict === "drop")).filter((c) => !filter.trim() || [c.name, ...c.aliases, c.summary].join(" ").toLowerCase().includes(filter.trim().toLowerCase()));
  const chosen = (list ?? []).filter((c) => picked.has(c.key) && c.name.trim());
  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const add = async () => {
    setAdding(true);
    try {
      let first: string | null = null;
      for (const c of chosen) {
        const id = await invoke<string>("new_id");
        const entry = { ...emptyEntry(id, c.kind, c.name.trim()), aliases: c.aliases, summary: c.summary };
        const body = c.summary;
        await invoke("save_codex_entry", { dir, entry, body });
        first ??= id;
      }
      await useStore.getState().loadCodex();
      set({ extractOpen: false, leftTab: "codex", codexId: first, error: null });
    } catch (e) {
      setError(String(e));
      setAdding(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog extract" role="dialog" aria-modal="true" aria-labelledby="extract-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="run-head">
          <span className="run-icon">
            <Icon name="codexAdd" size={17} />
          </span>
          <div className="grow">
            <strong id="extract-title">Find codex entries in the book</strong>
            <div className="muted">Names that keep turning up. Pick the ones you want; nothing is added until you say so.</div>
          </div>
          <button className="icon-btn" aria-label="Close" data-tip="Close" data-tip-kbd="esc" onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="ext-ai">
          {hasKey ? (
            <>
              <div className="ext-ai-text">
                <strong>
                  <Icon name="sparkle" size={13} className="accent-icon" /> Refine with AI
                </strong>
                <span className="muted">
                  {estimate && chunks ? `Checks which of the scan’s names are really entries (and unticks the rest), then reads the whole book in ${plural(chunks.length, "part")} to fill in types, aliases and one-line summaries and find names the scan missed. About ${estimate.tokensIn.toLocaleString()} tokens in${estimate.cost !== null ? `, up to ${formatCost(estimate.cost)}` : ""}.` : chunks && chunks.length === 0 ? "There is no text to read yet." : "Working out the size of the book…"}
                </span>
              </div>
              <div className="ext-ai-model">
                <ModelPicker label="Model for finding entries" value={model} onChange={setModel} />
              </div>
              {running ? (
                <button className="btn" onClick={() => ((stopped.current = true), useAi.getState().running?.stop())}>
                  Stop
                </button>
              ) : (
                <button className="btn primary" disabled={!model || !estimate || !list} onClick={() => void runAi()}>
                  {aiFound.current.length ? "Run again" : "Refine"}
                </button>
              )}
            </>
          ) : (
            <span className="muted">Add an OpenRouter key in Settings and AI can also fill in types, aliases and summaries. The scan below needs no AI and sends nothing anywhere.</span>
          )}
          {progress && (
            <div className="ext-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
              <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              <em>
                {progress.label}
              </em>
            </div>
          )}
        </div>

        <div className="ext-bar">
          <div className="search-field">
            <Icon name="search" size={14} />
            <input aria-label="Filter candidates" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <label className="ext-min">
            Seen at least
            <select className="cell-select" value={minMentions} disabled={running} onChange={(e) => setMinMentions(Number(e.target.value))}>
              {[2, 3, 5, 8, 12].map((n) => (
                <option key={n} value={n}>
                  {n} times
                </option>
              ))}
            </select>
          </label>
          <span className="grow" />
          <button className="link-btn" onClick={() => setPicked(new Set((list ?? []).map((c) => c.key)))}>
            Select all
          </button>
          <button className="link-btn" onClick={() => setPicked(new Set((list ?? []).filter((c) => c.count >= 5).map((c) => c.key)))}>
            Seen 5+ times
          </button>
          <button className="link-btn" onClick={() => setPicked(new Set())}>
            None
          </button>
        </div>
        {error && <div className="banner warn">{error}</div>}
        {note && !error && <div className="banner">{note}</div>}

        <div className="ext-body">
          {list === null ? (
            <div className="empty-state small">Reading the book…</div>
          ) : list.length === 0 ? (
            <div className="empty-state small">Nothing turned up {minMentions} or more times that the codex does not already have. Try a lower number.</div>
          ) : (
            <table className="ext-table">
              <thead>
                <tr>
                  <th className="x-pick" />
                  <th className="x-name">Name</th>
                  <th className="x-type">Type</th>
                  <th className="x-alias">Also called</th>
                  <th className="x-seen">Seen</th>
                  <th className="x-sum">Summary</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.key} className={`${picked.has(c.key) ? "on" : ""} ${c.verdict === "drop" ? "dropped" : ""}`}>
                    <td className="x-pick">
                      <input type="checkbox" className="check" aria-label={`Add ${c.name}`} checked={picked.has(c.key)} onChange={() => toggle(c.key)} />
                    </td>
                    <td className="x-name">
                      <TextField id={`x-n-${c.key}`} value={c.name} onSave={(v) => update(c.key, { name: v || c.name })} />
                      {c.examples[0] && (
                        <span className="x-example" data-tip={c.examples.join("\n")}>
                          {c.examples[0]}
                        </span>
                      )}
                    </td>
                    <td className="x-type">
                      <select className="cell-select" aria-label={`Type of ${c.name}`} value={c.kind} onChange={(e) => update(c.key, { kind: e.target.value })}>
                        {[...new Set([...ENTRY_TYPES, c.kind])].map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td className="x-alias">
                      <TextField id={`x-a-${c.key}`} value={c.aliases.join(", ")} hint="none" onSave={(v) => update(c.key, { aliases: splitList(v) })} />
                    </td>
                    <td className="x-seen">
                      <strong>{c.count.toLocaleString()}</strong>
                      <span className="muted">{plural(c.scenes, "scene")}</span>
                    </td>
                    <td className="x-sum">
                      <TextField id={`x-s-${c.key}`} value={c.summary} hint="A line about it" onSave={(v) => update(c.key, { summary: v })} />
                      {c.verdict === "drop" ? <span className="badge" data-tip="The AI does not think this is a story entry">not an entry</span> : c.source !== "scan" || c.verdict === "keep" ? <span className="badge auto">AI</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="diff-foot">
          <span className="muted">{list ? `${chosen.length} of ${plural(list.length, "candidate")} selected` : ""}</span>
          <span className="grow" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={adding || running || chosen.length === 0} onClick={() => void add()}>
            {adding ? "Adding…" : `Add ${plural(chosen.length, "entry", "entries")}`}
          </button>
        </div>
      </div>
    </div>
  );
}
