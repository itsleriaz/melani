// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./icons";
import { flushAll } from "./SceneEditor";
import { SearchQuery, useStore } from "./store";
import { scopeRoot, searchableIds, type SearchScope } from "./searchScope";
import { findNode, findParent, type BinderNode } from "./tree";

interface Hit {
  index: number;
  pre: string;
  match: string;
  post: string;
}
interface Group {
  id: string;
  kind: "scene" | "codex";
  count: number;
  hits: Hit[];
}

/** The heading a result sits under: its chapter (or part), "Notes", or "Codex". */
function heading(nodes: BinderNode[], g: Group): string {
  if (g.kind === "codex") return "Codex";
  const n = findNode(nodes, g.id);
  if (n?.type === "note") return "Notes";
  return findParent(nodes, g.id)?.title ?? "Manuscript";
}

export function SearchPanel() {
  const dir = useStore((s) => s.dir)!;
  const nodes = useStore((s) => s.nodes);
  const codex = useStore((s) => s.codex);
  const query = useStore((s) => s.search);
  const focusSeq = useStore((s) => s.searchFocus);
  const set = useStore((s) => s.set);
  const input = useRef<HTMLInputElement>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const seq = useRef(0);

  const patch = (p: Partial<SearchQuery>) => set({ search: { ...query, ...p } });
  const selectedId = useStore((s) => s.selectedId);
  const scope = query.scope;
  const root = scopeRoot(nodes, selectedId, scope);
  const ids = useMemo(() => searchableIds(nodes, query, scope, selectedId), [nodes, query, scope, selectedId]);
  // Only the ids matter to the search, so a new array with the same scenes must not search again.
  const idsKey = ids.join(",");
  const searchCodex = query.codex && scope === "project";
  const what = scope === "project" ? "the project" : scope === "chapter" ? "this chapter" : "this scene";
  const options = { caseSensitive: query.caseSensitive, wholeWord: query.wholeWord };

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSeq]);

  useEffect(() => {
    const n = ++seq.current;
    if (!query.q) return setGroups(null);
    const t = window.setTimeout(async () => {
      const r = await invoke<Group[]>("search_groups", { dir, query: query.q, options, sceneIds: ids, codex: searchCodex }).catch(() => []);
      if (n === seq.current) setGroups(r);
    }, 160);
    return () => window.clearTimeout(t);
  }, [dir, query.q, query.caseSensitive, query.wholeWord, searchCodex, idsKey, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = useMemo(() => (groups ?? []).flatMap((g) => g.hits.map((h) => ({ g, h, key: `${g.id}:${h.index}` }))), [groups]);
  const total = (groups ?? []).reduce((a, g) => a + g.count, 0);
  const sceneCount = (groups ?? []).filter((g) => g.kind === "scene").length;
  const entryCount = (groups ?? []).length - sceneCount;

  const open = (g: Group, h: Hit) => {
    setCurrent(`${g.id}:${h.index}`);
    if (g.kind === "codex") return set({ codexId: g.id });
    set({ selectedId: g.id, codexId: null, jump: { id: g.id, query, index: h.index, seq: Date.now() } });
  };
  const step = (dirn: 1 | -1) => {
    if (!flat.length) return;
    const i = flat.findIndex((f) => f.key === current);
    const next = flat[(i + dirn + flat.length) % flat.length] ?? flat[0];
    open(next.g, next.h);
  };

  const replaceAll = async () => {
    const sceneGroups = (groups ?? []).filter((g) => g.kind === "scene");
    const n = sceneGroups.reduce((a, g) => a + g.count, 0);
    if (!n) return;
    const where = sceneGroups.length === 1 ? "one scene" : `${sceneGroups.length} scenes${scope === "chapter" && root ? ` in “${root.title}”` : ""}`;
    if (!window.confirm(`Replace ${n} match${n === 1 ? "" : "es"} of “${query.q}” in ${where} with “${replacement}”? A snapshot of those scenes is taken first, so you can undo it.`)) return;
    try {
      await flushAll();
      const done = await invoke<number>("replace_all", { dir, query: query.q, replacement, options, sceneIds: sceneGroups.map((g) => g.id) });
      setMsg(`Replaced ${done} match${done === 1 ? "" : "es"}. The previous text is in Snapshots.`);
      void useStore.getState().refreshCounts();
      setRefresh((r) => r + 1);
    } catch (e) {
      setMsg(String(e));
    }
  };

  // Group consecutive results under their chapter heading.
  const sections: { title: string; groups: Group[] }[] = [];
  for (const g of groups ?? []) {
    const title = heading(nodes, g);
    const last = sections[sections.length - 1];
    if (last && last.title === title) last.groups.push(g);
    else sections.push({ title, groups: [g] });
  }
  const titleOf = (g: Group) => (g.kind === "codex" ? codex.find((e) => e.id === g.id)?.name : findNode(nodes, g.id)?.title) ?? "Untitled";
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  return (
    <div className="search-panel">
      <div className="search-form">
        <div className="search-row">
          <button className="icon-btn small" aria-label={showReplace ? "Hide replace" : "Show replace"} aria-expanded={showReplace} onClick={() => setShowReplace(!showReplace)}>
            <Icon name={showReplace ? "chevronDown" : "chevronRight"} size={14} />
          </button>
          <div className="search-field">
            <Icon name="search" size={14} />
            <input
              ref={input}
              aria-label={`Search ${what}`}
              placeholder={`Search ${what}`}
              value={query.q}
              onChange={(e) => patch({ q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.preventDefault(), step(e.shiftKey ? -1 : 1));
                if (e.key === "Escape") patch({ q: "" });
              }}
            />
            <button className={`toggle-btn ${query.caseSensitive ? "on" : ""}`} aria-pressed={query.caseSensitive} data-tip="Match case" onClick={() => patch({ caseSensitive: !query.caseSensitive })}>
              Aa
            </button>
            <button className={`toggle-btn word ${query.wholeWord ? "on" : ""}`} aria-pressed={query.wholeWord} data-tip="Whole words only" onClick={() => patch({ wholeWord: !query.wholeWord })}>
              ab
            </button>
          </div>
        </div>
        {showReplace && (
          <div className="search-row indent">
            <div className="search-field">
              <Icon name="replace" size={14} />
              <input aria-label="Replace with" placeholder="Replace with" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
            </div>
            <button className="btn" disabled={!groups?.some((g) => g.kind === "scene")} onClick={() => void replaceAll()} data-tip="Replaces in scenes and notes, not the codex. Takes a snapshot first.">
              Replace all
            </button>
          </div>
        )}
        <div className="search-row indent chips-row" role="group" aria-label="Where to search">
          {(["project", "chapter", "scene"] as const).map((k: SearchScope) => (
            <button
              key={k}
              className={`chip ${scope === k ? "on" : ""}`}
              aria-pressed={scope === k}
              data-tip={k === "project" ? "Everything in the project" : k === "chapter" ? (scopeRoot(nodes, selectedId, "chapter")?.title ?? "The chapter you are in") : (scopeRoot(nodes, selectedId, "scene")?.title ?? "The scene you are in")}
              onClick={() => patch({ scope: k })}
            >
              {k === "project" ? "Project" : k === "chapter" ? "Chapter" : "Scene"}
            </button>
          ))}
        </div>
        {scope !== "scene" && (
          <div className="search-row indent chips-row" role="group" aria-label="Search in">
            {(scope === "project" ? (["manuscript", "notes", "codex"] as const) : (["manuscript", "notes"] as const)).map((k) => (
              <button key={k} className={`chip ${query[k] ? "on" : ""}`} aria-pressed={query[k]} onClick={() => patch({ [k]: !query[k] })}>
                {k === "manuscript" ? "Manuscript" : k === "notes" ? "Notes" : "Codex"}
              </button>
            ))}
          </div>
        )}
      </div>

      {msg && (
        <div className="banner">
          {msg}
          <button className="btn small" onClick={() => setMsg(null)}>
            OK
          </button>
        </div>
      )}

      {groups && (
        <div className="search-summary">
          <span className="grow">
            {total === 0 ? (
              "No results"
            ) : (
              <>
                <strong>
                  {total.toLocaleString()} result{total === 1 ? "" : "s"}
                </strong>{" "}
                in {[sceneCount && `${sceneCount} scene${sceneCount === 1 ? "" : "s"}`, entryCount && `${entryCount} codex entr${entryCount === 1 ? "y" : "ies"}`].filter(Boolean).join(" and ")}
              </>
            )}
          </span>
          <button className="icon-btn small" aria-label="Previous result" disabled={!flat.length} onClick={() => step(-1)}>
            <Icon name="chevronUp" size={14} />
          </button>
          <button className="icon-btn small" aria-label="Next result" disabled={!flat.length} onClick={() => step(1)}>
            <Icon name="chevronDown" size={14} />
          </button>
          <button className="text-btn" disabled={!groups.length} onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(groups.map((g) => g.id)))}>
            {collapsed.size ? "Expand all" : "Collapse all"}
          </button>
        </div>
      )}

      <div className="search-results">
        {scope !== "project" && !root && <div className="empty-state small">{scope === "scene" ? "Select a scene to search in it." : "Select a scene or chapter to search in its chapter."}</div>}
        {!query.q && (scope === "project" || root) && <div className="empty-state small">{scope === "project" ? "Search scenes, notes and the codex." : `Search ${what}${root ? `: ${root.title}` : ""}.`} Enter jumps to the next result, Shift+Enter to the previous one.</div>}
        {sections.map((sec, si) => (
          <section key={si}>
            <div className={`section-label ${sec.title === "Codex" ? "accent" : ""}`}>{sec.title}</div>
            {sec.groups.map((g) => (
              <div key={g.id} className="result-group">
                <button className="result-head" aria-expanded={!collapsed.has(g.id)} onClick={() => toggle(g.id)}>
                  <Icon name={collapsed.has(g.id) ? "chevronRight" : "chevronDown"} size={13} />
                  <span className="grow">{titleOf(g)}</span>
                  <span className="count-pill">{g.count}</span>
                </button>
                {!collapsed.has(g.id) &&
                  g.hits.map((h) => (
                    <button key={h.index} className={`result-hit ${current === `${g.id}:${h.index}` ? "current" : ""}`} onClick={() => open(g, h)}>
                      {h.pre}
                      <mark>{h.match}</mark>
                      {h.post}
                    </button>
                  ))}
                {!collapsed.has(g.id) && g.count > g.hits.length && <div className="result-more">and {g.count - g.hits.length} more in this {g.kind === "codex" ? "entry" : "scene"}</div>}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
