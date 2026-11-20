// SPDX-License-Identifier: GPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CodexEntry, ENTRY_TYPES } from "./codexTypes";
import { openMenu } from "./ContextMenu";
import { Icon } from "./icons";
import { Switch } from "./Inspector";
import { TagInput } from "./Metadata";
import { entryMenu, makeMentionCollection } from "./menus";
import { MOD } from "./platform";
import { useStore } from "./store";
import { findNode } from "./tree";

/** A stable colour per entry type, for chips and dots. */
export const TYPE_COLORS: Record<string, string> = {
  character: "#3b6fd8",
  place: "#3e9a5c",
  item: "#e08a2e",
  faction: "#8a5cc9",
  event: "#d0574f",
  lore: "#2e9a9a",
};

/** Left sidebar tab: the list of entries, grouped by type. */
export function CodexPanel() {
  const codex = useStore((s) => s.codex);
  const codexId = useStore((s) => s.codexId);
  const createEntry = useStore((s) => s.createEntry);
  const set = useStore((s) => s.set);
  const [q, setQ] = useState("");
  const [type, setType] = useState("character");
  const shown = codex.filter((e) => (e.name + " " + e.aliases.join(" ")).toLowerCase().includes(q.toLowerCase()));
  const types = [...new Set([...ENTRY_TYPES, ...shown.map((e) => e.type)])].filter((t) => shown.some((e) => e.type === t));

  const add = async () => {
    const id = await createEntry(type, "New " + type);
    set({ codexId: id });
  };
  return (
    <>
      <div className="panel-head">
        <span className="section-label grow">Codex</span>
        <select className="mini-select" aria-label="Type for a new entry" value={type} onChange={(e) => setType(e.target.value)}>
          {ENTRY_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <button className="icon-btn small" aria-label="Find entries in the book" data-tip="Find entries in the book" onClick={() => set({ extractOpen: true })}>
          <Icon name="zoomPlus" size={15} />
        </button>
        <button className="icon-btn small" data-tip={`New ${type}`} aria-label={`New ${type}`} onClick={() => void add()}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div className="panel-filter">
        <Icon name="filter" size={14} />
        <input aria-label="Filter entries" placeholder="Filter entries" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
    <nav className="binder codex-list" aria-label="Codex entries">
      {codex.length === 0 && (
        <div className="empty-state small">
          No entries yet. Add characters, places and more; their names get underlined in your scenes.
          <br />
          <button className="link-btn" onClick={() => set({ extractOpen: true })}>
            Or find them in your book
          </button>
        </div>
      )}
      {types.map((t) => (
        <div key={t}>
          <div className="group">{t}</div>
          <ul>
            {shown
              .filter((e) => e.type === t)
              .map((e) => (
                <li key={e.id}>
                  <div className={`row ${codexId === e.id ? "sel" : ""}`} onClick={() => set({ codexId: e.id })} onContextMenu={(ev) => openMenu(ev, entryMenu(e))}>
                    <span className="twisty" />
                    <span className="dot" style={{ background: TYPE_COLORS[e.type] ?? "#8a8a84" }} />
                    <span className="title">{e.name}</span>
                    <span className="actions">
                      <button className="icon-btn small" data-tip="Show in reference pane" aria-label="Show in reference pane" onClick={(ev) => (ev.stopPropagation(), set({ refId: e.id, rightTab: "reference" }))}>
                        <Icon name="sidebarRight" size={14} />
                      </button>
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
    </>
  );
}

/**
 * Edits one entry. Changes autosave after a short pause. `compact` is the reference pane
 * version: the fields a writer glances at, without links and match options.
 */
export function CodexEditor({ id, compact = false }: { id: string; compact?: boolean }) {
  const dir = useStore((s) => s.dir)!;
  const stored = useStore((s) => s.codex.find((e) => e.id === id));
  const all = useStore((s) => s.codex);
  const nodes = useStore((s) => s.nodes);
  const saveEntry = useStore((s) => s.saveEntry);
  const deleteEntry = useStore((s) => s.deleteEntry);
  const set = useStore((s) => s.set);
  const [draft, setDraft] = useState<{ entry: CodexEntry; body: string } | null>(null);
  const [backlinks, setBacklinks] = useState<{ sceneId: string; count: number }[]>([]);
  const latest = useRef<{ entry: CodexEntry; body: string } | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const loadedFor = useRef<string | null>(null);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (dirty.current && latest.current) {
      dirty.current = false;
      void saveEntry(latest.current.entry, latest.current.body);
    }
  }, [saveEntry]);

  // Load when the id changes (and the entry exists); save anything pending first.
  useEffect(() => {
    if (!stored || loadedFor.current === id) return;
    loadedFor.current = id;
    void invoke<string>("read_codex_body", { dir, id }).then((body) => {
      if (loadedFor.current !== id) return; // switched away while loading
      const d = { entry: stored, body };
      latest.current = d;
      setDraft(d);
    });
  }, [id, stored, dir]);
  useEffect(
    () => () => {
      flush();
      loadedFor.current = null;
    },
    [id, flush],
  );

  useEffect(() => {
    void invoke<{ sceneId: string; count: number }[]>("entry_backlinks", { dir, entryId: id }).then(setBacklinks).catch(() => setBacklinks([]));
  }, [dir, id, stored]);

  if (!draft) return <div className="empty-state small">Loading…</div>;
  const { entry, body } = draft;
  const edit = (patch: Partial<CodexEntry>, newBody?: string) => {
    const d = { entry: { ...entry, ...patch }, body: newBody ?? body };
    latest.current = d;
    dirty.current = true;
    setDraft(d);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 600);
  };
  const others = all.filter((e) => e.id !== id && !entry.links.some((l) => l.id === e.id));

  return (
    <div className={compact ? "codex-editor compact" : "doc codex-editor"}>
      <header className="ce-head">
        <input className="name-input" aria-label="Name" value={entry.name} onChange={(e) => edit({ name: e.target.value })} placeholder="Name" />
        <div className="ce-meta">
          <input className="type-pill" aria-label="Type" list="entry-types" value={entry.type} onChange={(e) => edit({ type: e.target.value })} />
          <datalist id="entry-types">
            {ENTRY_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <span className="ce-count">{backlinks.length === 0 ? "Not in any scene yet" : `In ${backlinks.length} scene${backlinks.length === 1 ? "" : "s"}, ${backlinks.reduce((a, b) => a + b.count, 0).toLocaleString()} mentions`}</span>
        </div>
      </header>

      <section className="ce-card">
        <div className="ce-field">
          <label htmlFor="ce-summary" className="field-label">
            Summary
          </label>
          <textarea id="ce-summary" className="input serif" rows={2} value={entry.summary} onChange={(e) => edit({ summary: e.target.value })} />
          <span className="ce-hint">A line or two. It stands in for the full entry when space is tight in an AI request.</span>
        </div>
        <div className="ce-field">
          <span className="field-label">Also called</span>
          <TagInput label="Aliases" value={entry.aliases} placeholder="Add a name, nickname or title" onChange={(v) => edit({ aliases: v })} />
        </div>
        {!compact && (
          <div className="ce-field">
            <span className="field-label">Tags</span>
            <TagInput label="Tags" value={entry.tags} placeholder="Add a tag" onChange={(v) => edit({ tags: v })} />
          </div>
        )}
      </section>

      <section className="ce-card">
        <label htmlFor="ce-body" className="field-label">
          Details
        </label>
        <textarea id="ce-body" className="input serif body" rows={compact ? 10 : 14} value={body} onChange={(e) => edit({}, e.target.value)} />
      </section>

      {!compact && (
        <>
          <section className="ce-card">
            <h4>Links</h4>
            {entry.links.length === 0 && <p className="ce-hint">Connect this to other entries: a sister, a home, an enemy.</p>}
            <ul className="ce-links">
              {entry.links.map((l) => (
                <li key={l.id}>
                  <a href="#" onClick={(e) => (e.preventDefault(), set({ codexId: l.id }))}>
                    {all.find((x) => x.id === l.id)?.name ?? "(deleted)"}
                  </a>
                  <input
                    className="input"
                    aria-label={`How ${entry.name} relates to ${all.find((x) => x.id === l.id)?.name ?? "it"}`}
                    placeholder="relation, e.g. sister of"
                    value={l.relation ?? ""}
                    onChange={(e) => edit({ links: entry.links.map((x) => (x.id === l.id ? { ...x, relation: e.target.value || null } : x)) })}
                  />
                  <button className="icon-btn small" aria-label="Remove link" data-tip="Remove link" onClick={() => edit({ links: entry.links.filter((x) => x.id !== l.id) })}>
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {others.length > 0 && (
              <select className="input ce-add-link" aria-label="Link to another entry" value="" onChange={(e) => e.target.value && edit({ links: [...entry.links, { id: e.target.value, relation: null }] })}>
                <option value="">Link to an entry…</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
          </section>

          <section className="ce-card">
            <h4>How it is found in your text</h4>
            <Switch label="Match case" hint="“Mark” would not match “mark”." checked={entry.matchOptions.caseSensitive} onChange={(v) => edit({ matchOptions: { ...entry.matchOptions, caseSensitive: v } })} />
            <Switch label="Whole words only" hint="So “Dian” is not found inside “Diane”." checked={entry.matchOptions.wholeWord} onChange={(v) => edit({ matchOptions: { ...entry.matchOptions, wholeWord: v } })} />
            <div className="ce-field">
              <span className="field-label">Never match these</span>
              <TagInput label="Names to ignore" value={entry.matchOptions.ignore} placeholder="A name or alias that is also a common word" onChange={(v) => edit({ matchOptions: { ...entry.matchOptions, ignore: v } })} />
            </div>
          </section>

          <section className="ce-card">
            <h4>For AI</h4>
            <Switch label="Always include in AI requests" hint="Sent with every request in this project, whether or not it is mentioned." checked={entry.alwaysInclude} onChange={(v) => edit({ alwaysInclude: v })} />
            <div className="ce-row">
              <div>
                <label htmlFor="ce-priority" className="switch-label">
                  Priority
                </label>
                <span className="ce-hint">Higher is kept first when a request has to be trimmed.</span>
              </div>
              <input id="ce-priority" className="input narrow" type="number" value={entry.priority} onChange={(e) => edit({ priority: parseInt(e.target.value, 10) || 0 })} />
            </div>
          </section>
        </>
      )}

      <section className="ce-card">
        <div className="ce-card-head">
          <h4 className="grow">Appears in</h4>
          {stored && (
            <button className="link-btn" data-tip="Save this as a collection that keeps itself up to date" onClick={() => makeMentionCollection(stored)}>
              <Icon name="filter" size={12} />
              Make a collection
            </button>
          )}
        </div>
        {backlinks.length === 0 ? (
          <p className="ce-hint">No scenes mention this entry yet.</p>
        ) : (
          <ul className="ce-links appears">
            {backlinks.map((b) => (
              <li key={b.sceneId}>
                <a href="#" onClick={(e) => (e.preventDefault(), set({ selectedId: b.sceneId, codexId: null, leftTab: "binder" }))}>
                  {findNode(nodes, b.sceneId)?.title ?? "(unlinked file)"}
                </a>
                <span className="ce-times">×{b.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!compact && (
        <button
          className="btn danger-btn"
          onClick={() => {
            if (window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) {
              dirty.current = false;
              void deleteEntry(id);
            }
          }}
        >
          <Icon name="trash" size={14} />
          Delete entry
        </button>
      )}
    </div>
  );
}

export function ReferencePane() {
  const refId = useStore((s) => s.refId);
  const exists = useStore((s) => s.codex.some((e) => e.id === refId));
  const set = useStore((s) => s.set);
  if (!refId || !exists) return <div className="empty-state small">{MOD}-click a highlighted name in your text, or a chip under Details, to keep its codex entry open here while you write.</div>;
  return (
    <div>
      <div className="ref-bar">
        <button className="btn small" onClick={() => set({ codexId: refId })}>
          <Icon name="external" size={13} />
          Open full editor
        </button>
        <span className="grow" />
        <button className="icon-btn small" aria-label="Close reference" data-tip="Close" onClick={() => set({ refId: null })}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <CodexEditor key={refId} id={refId} compact />
    </div>
  );
}

/** Codex entries mentioned in the selected scene, as chips that open the reference pane. */
export function MentionChips() {
  const dir = useStore((s) => s.dir)!;
  const selectedId = useStore((s) => s.selectedId);
  const codex = useStore((s) => s.codex);
  const words = useStore((s) => (selectedId ? s.counts[selectedId] : 0));
  const set = useStore((s) => s.set);
  const [m, setM] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!selectedId) return setM({});
    void invoke<Record<string, number>>("scene_mentions", { dir, id: selectedId }).then(setM).catch(() => setM({}));
  }, [dir, selectedId, words, codex]);

  const rows = Object.entries(m)
    .map(([id, n]) => ({ e: codex.find((c) => c.id === id), n }))
    .filter((r): r is { e: CodexEntry; n: number } => !!r.e)
    .sort((a, b) => b.n - a.n);
  return (
    <div className="field">
      <div className="field-label-row">
        <span className="field-label grow">In this scene</span>
        {rows.length > 0 && (
          <span className="muted">
            {rows.length} entr{rows.length === 1 ? "y" : "ies"}
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="muted">{codex.length ? "No codex entries are mentioned yet." : "Codex entries you create are listed here when this scene names them."}</div>
      ) : (
        <div className="mention-chips">
          {rows.map(({ e, n }) => (
            <button key={e.id} className="mention-chip" data-tip={`${e.type}: show in reference pane`} onClick={() => set({ refId: e.id, rightTab: "reference" })}>
              <span className="dot" style={{ background: TYPE_COLORS[e.type] ?? "#8a8a84" }} />
              {e.name}
              <span className="n">{n}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function HoverCard() {
  const hover = useStore((s) => s.hover);
  const codex = useStore((s) => s.codex);
  if (!hover) return null;
  const entries = hover.ids.map((id) => codex.find((e) => e.id === id)).filter((e): e is CodexEntry => !!e);
  if (entries.length === 0) return null;
  return (
    <div className="hovercard" style={{ left: Math.min(hover.rect.left, window.innerWidth - 300), top: hover.rect.bottom + 6 }}>
      {entries.length > 1 && <div className="muted">Ambiguous: matches {entries.length} entries</div>}
      {entries.map((e) => (
        <div key={e.id} className="hc-entry">
          <strong>{e.name}</strong> <span className="muted">{e.type}</span>
          {e.summary && <div>{e.summary}</div>}
        </div>
      ))}
      <div className="muted">{MOD}-click to open in the reference pane</div>
    </div>
  );
}
