// SPDX-License-Identifier: GPL-3.0-only
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Binder } from "./Binder";
import { Inspector } from "./Inspector";
import { Palette, Command } from "./Overlays";
import { SceneEditor, flushAll, getActiveEditor, saveHistoryAll } from "./SceneEditor";
import { Corkboard } from "./Corkboard";
import { Outliner } from "./Outliner";
import { FindBar } from "./FindBar";
import { SMOOTH_CARET_EVENT } from "./SmoothCaret";
import { CollectionsPanel, CollectionView } from "./Collections";
import { DiffView, SnapshotsTab } from "./Snapshots";
import { StatsView } from "./StatsView";
import { CodexEditor, CodexPanel, HoverCard, ReferencePane } from "./Codex";
import { SearchPanel } from "./SearchPanel";
import { invoke } from "@tauri-apps/api/core";
import { nodeWords, PANEL_LIMITS, useStore } from "./store";
import { findNode, findParent, leaves } from "./tree";
import { TOOLS, ToolId } from "./ai";
import { useAi } from "./aiStore";
import { openTool } from "./aiTools";
import { ChatPanel, FindingsPanel, RunStatus, SummaryDialog } from "./AiPanels";
import { CommentsPanel } from "./CommentsPanel";
import { FootnotePopover } from "./FootnotePopover";
import { RunDialog } from "./RunDialog";
import { RecoveryDialog } from "./Recovery";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
import { ExtractDialog } from "./ExtractDialog";
import { SettingsDialog, openSettings } from "./Settings";
import { ContextMenu, useSuppressBrowserMenu } from "./ContextMenu";
import { Icon, IconName, Ring } from "./icons";
import { FormatBar, HistoryButtons, SelectionMenu } from "./EditorChrome";
import { TooltipLayer } from "./Tooltip";
import { createEntryFromSelection } from "./selection";
import { IS_MAC, MOD, SHIFT } from "./platform";
import { dayKey, wordsOn } from "./stats";
import "./App.css";

type RightTab = ReturnType<typeof useStore.getState>["rightTab"];
type LeftTab = ReturnType<typeof useStore.getState>["leftTab"];

async function pickFolder(): Promise<string | null> {
  const sel = await open({ directory: true, multiple: false });
  return typeof sel === "string" ? sel : null;
}

const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Writing late." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

function Welcome() {
  const { recent, openProject, createProject, error, set } = useStore();
  const create = async () => {
    const dir = await pickFolder();
    if (dir) await createProject(dir, folderName(dir) || "Untitled");
  };
  const openExisting = async () => {
    const dir = await pickFolder();
    if (dir) await openProject(dir);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(IS_MAC ? e.metaKey : e.ctrlKey)) return;
      if (e.key.toLowerCase() === "n") (e.preventDefault(), void create());
      if (e.key.toLowerCase() === "o") (e.preventDefault(), void openExisting());
      if (e.key === ",") (e.preventDefault(), openSettings());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="welcome">
      <div className="titlebar-space" data-tauri-drag-region />
      <div className="welcome-body">
        <section className="welcome-start">
          <div className="app-brand">
            <div className="app-mark" aria-hidden="true">
              <Icon name="book" size={26} />
            </div>
            <span className="app-name">Melani</span>
          </div>
          <h1>{greeting()}</h1>
          <p className="lede">Your projects are plain folders of Markdown files. Keep them anywhere and sync them with anything.</p>
          <div className="welcome-actions">
            <button className="big-btn primary" onClick={() => void create()}>
              <Icon name="plus" size={18} />
              <span className="grow">New project…</span>
              <kbd>{MOD}N</kbd>
            </button>
            <button className="big-btn" onClick={() => void openExisting()}>
              <Icon name="folder" size={18} />
              <span className="grow">Open a project folder…</span>
              <kbd>{MOD}O</kbd>
            </button>
          </div>
          {error && <div className="banner warn">{error}</div>}
          <div className="grow" />
          <div className="welcome-foot">
            <button className="text-btn" onClick={() => openSettings("general")}>
              Settings
            </button>
            <span>No account, no telemetry. AI stays off until you add a key.</span>
          </div>
        </section>
        <section className="welcome-recent" aria-labelledby="recent-h">
          <div className="section-head">
            <h2 id="recent-h" className="section-label">
              Recent
            </h2>
            {recent.length > 0 && (
              <button className="text-btn" onClick={() => set({ recent: [] })}>
                Clear list
              </button>
            )}
          </div>
          {recent.length === 0 ? (
            <div className="empty-card">Projects you open will be listed here.</div>
          ) : (
            <ul className="recent-list">
              {recent.map((r, i) => (
                <li key={r} style={{ "--i": i } as React.CSSProperties}>
                  <div className="recent-card">
                    <button className="recent-open" onClick={() => void openProject(r)}>
                      <span className="spine" aria-hidden="true" />
                      <span className="grow recent-text">
                        <span className="recent-title">{folderName(r)}</span>
                        <span className="recent-path">{r}</span>
                      </span>
                      <Icon name="chevronRight" className="recent-chevron" />
                    </button>
                    <button className="icon-btn small recent-remove" aria-label={`Remove ${folderName(r)} from recent projects`} data-tip="Remove from list" onClick={() => set({ recent: recent.filter((x) => x !== r) })}>
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** A drag handle between two panes. Drag, use the arrow keys, or double-click to reset. */
function ResizeHandle({ side }: { side: "left" | "right" }) {
  const width = useStore((s) => (side === "left" ? s.leftWidth : s.rightWidth));
  const set = useStore((s) => s.set);
  const [dragging, setDragging] = useState(false);
  const [min, max] = PANEL_LIMITS[side];
  const key = side === "left" ? "leftWidth" : "rightWidth";
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(max, w)));
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    setDragging(true);
    const move = (ev: PointerEvent) => set({ [key]: clamp(w0 + (side === "left" ? ev.clientX - x0 : x0 - ev.clientX)) });
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`resize-handle ${dragging ? "active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize sidebar" : "Resize details panel"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={() => set({ [key]: side === "left" ? 272 : 312 })}
      onKeyDown={(e) => {
        const d = (e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0) * (side === "left" ? 1 : -1);
        if (d) (e.preventDefault(), set({ [key]: clamp(width + d) }));
      }}
    />
  );
}

function RailButton({ icon, label, active, onClick, children }: { icon?: IconName; label: string; active?: boolean; onClick: () => void; children?: React.ReactNode }) {
  return (
    <button className={`rail-btn ${active ? "on" : ""}`} aria-label={label} data-tip={label} aria-pressed={active} onClick={onClick}>
      {children ?? (icon && <Icon name={icon} size={19} />)}
    </button>
  );
}

function ActivityRail() {
  const leftTab = useStore((s) => s.leftTab);
  const leftOpen = useStore((s) => s.leftOpen);
  const stats = useStore((s) => s.stats);
  const set = useStore((s) => s.set);
  const openSearch = useStore((s) => s.openSearch);
  const bookOutline = useStore((s) => s.bookOutline);
  const statsView = useStore((s) => s.statsView);
  const today = wordsOn(stats, dayKey());
  const goal = stats.goals.dailyWords;
  const pick = (t: LeftTab) => set(leftOpen && leftTab === t ? { leftOpen: false } : { leftTab: t, ...(t === "binder" ? { codexId: null } : {}) });
  return (
    <nav className="rail" aria-label="Sidebar">
      <RailButton icon="binder" label="Binder" active={leftOpen && leftTab === "binder"} onClick={() => pick("binder")} />
      <RailButton icon="codex" label="Codex" active={leftOpen && leftTab === "codex"} onClick={() => pick("codex")} />
      <RailButton icon="collection" label="Collections" active={leftOpen && leftTab === "collections"} onClick={() => pick("collections")} />
      <RailButton icon="search" label={`Search (${MOD}${SHIFT}F)`} active={leftOpen && leftTab === "search"} onClick={() => (leftOpen && leftTab === "search" ? set({ leftOpen: false }) : openSearch())} />
      <div className="grow" />
      <RailButton icon="outline" label="Book outline" active={bookOutline} onClick={() => set({ bookOutline: !bookOutline, statsView: false, codexId: null })} />
      <RailButton active={statsView} label={goal ? `Goals and stats: ${today.toLocaleString()} of ${goal.toLocaleString()} words today` : "Goals and stats"} onClick={() => set({ statsView: !statsView, codexId: null })}>
        {goal ? <Ring value={today / goal} /> : <Icon name="target" size={19} />}
      </RailButton>
      <RailButton icon="settings" label={`Settings (${MOD},)`} onClick={() => openSettings()} />
    </nav>
  );
}

function LeftPanel() {
  const tab = useStore((s) => s.leftTab);
  const width = useStore((s) => s.leftWidth);
  return (
    <aside className="sidebar left" style={{ width }} aria-label={tab === "binder" ? "Binder" : tab === "codex" ? "Codex" : tab === "collections" ? "Collections" : "Search"}>
      {tab === "binder" ? <Binder /> : tab === "codex" ? <CodexPanel /> : tab === "collections" ? <CollectionsPanel /> : <SearchPanel />}
    </aside>
  );
}

function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  const width = useStore((s) => s.rightWidth);
  const selectedId = useStore((s) => s.selectedId);
  const set = useStore((s) => s.set);
  const hasKey = useAi((s) => s.hasKey) === true;
  const commentCount = useAi((s) => (selectedId ? (s.comments[selectedId]?.filter((c) => !c.resolved).length ?? 0) : 0));
  const base: [RightTab, string, IconName][] = [
    ["inspector", "Details", "info"],
    ["reference", "Reference", "codex"],
    ["comments", "Comments", "comment"],
    ["snapshots", "Snapshots", "history"],
  ];
  const ai: [RightTab, string, IconName][] = hasKey
    ? [
        ["chat", "Chat", "sparkle"],
        ["findings", "Findings", "findings"],
      ]
    : [];
  const shown = [...base, ...ai].some(([k]) => k === tab) ? tab : "inspector";
  const tabBtn = ([k, label, icon]: [RightTab, string, IconName]) => (
    <button key={k} role="tab" aria-selected={shown === k} aria-label={label} data-tip={label} className={`panel-tab ${shown === k ? "on" : ""}`} onClick={() => set({ rightTab: k })}>
      <Icon name={icon} />
      {shown === k && <span>{label}</span>}
      {k === "comments" && commentCount > 0 && <span className="tab-badge">{commentCount}</span>}
    </button>
  );
  return (
    <aside className="sidebar right" style={{ width }} aria-label="Details">
      <div className="panel-tabs" role="tablist">
        {base.map(tabBtn)}
        {ai.length > 0 && <span className="tab-sep" aria-hidden="true" />}
        {ai.map(tabBtn)}
      </div>
      <div className="panel-body">
        {shown === "inspector" && <Inspector />}
        {shown === "reference" && <ReferencePane />}
        {shown === "snapshots" && <SnapshotsTab />}
        {shown === "comments" && <CommentsPanel />}
        {shown === "chat" && <ChatPanel />}
        {shown === "findings" && <FindingsPanel />}
      </div>
    </aside>
  );
}

function SceneHeading({ id }: { id: string }) {
  const node = useStore((s) => findNode(s.nodes, id));
  const words = useStore((s) => s.counts[id]);
  const select = useStore((s) => s.select);
  if (!node) return null;
  return (
    <div className="scene-heading">
      <button className="scene-name" onClick={() => select(node.id)}>
        {node.title}
      </button>
      {node.type === "scene" && <span className={`status-pill ${node.status}`}>{node.status}</span>}
      {words !== undefined && <span>{words.toLocaleString()} words</span>}
      <span className="rule" />
    </div>
  );
}

function Manuscript() {
  const selectedId = useStore((s) => s.selectedId);
  const nodes = useStore((s) => s.nodes);
  const codexId = useStore((s) => s.codexId);
  const view = useStore((s) => s.view);
  const bookOutline = useStore((s) => s.bookOutline);
  const collectionId = useStore((s) => s.collectionId);
  const statsView = useStore((s) => s.statsView);
  const node = selectedId ? findNode(nodes, selectedId) : null;
  if (statsView) return <StatsView />;
  if (collectionId && !codexId) return <CollectionView key={collectionId} id={collectionId} />;
  if (bookOutline && !codexId)
    return (
      <div className="doc wide outline-doc">
        <p className="eyebrow">Book</p>
        <h1 className="chapter-title">Outline</h1>
        <Outliner />
      </div>
    );
  if (codexId)
    return (
      <div className="doc codex-doc">
        <CodexEditor key={codexId} id={codexId} />
      </div>
    );
  if (!node) return <div className="empty-state">Select or create a scene in the binder.</div>;
  if (node.type === "scene" || node.type === "note") {
    const chapter = findParent(nodes, node.id);
    return (
      <div className="doc">
        {chapter && chapter.type !== "trash" && <p className="eyebrow">{chapter.title}</p>}
        <SceneHeading id={node.id} />
        <SceneEditor key={node.id} id={node.id} />
      </div>
    );
  }
  // Scrivenings: a chapter or part reads as one document; each scene stays its own file.
  const parts = leaves(node);
  if (view === "outliner") {
    return (
      <div className="doc wide outline-doc">
        <p className="eyebrow">{node.type}</p>
        <h1 className="chapter-title">{node.title}</h1>
        <Outliner root={node} />
      </div>
    );
  }
  if (view === "corkboard") {
    return (
      <div className="doc wide">
        <p className="eyebrow">{node.type}</p>
        <h1 className="chapter-title">{node.title}</h1>
        <Corkboard node={node} />
      </div>
    );
  }
  return (
    <div className="doc">
      <p className="eyebrow">{node.type}</p>
      <h1 className="chapter-title">{node.title}</h1>
      {parts.length === 0 && <div className="empty-state">This {node.type} has no scenes yet.</div>}
      {parts.map((p) => (
        <section key={p.id} className="scrivening">
          <SceneHeading id={p.id} />
          <SceneEditor id={p.id} />
        </section>
      ))}
    </div>
  );
}

// These take no props and read the store through selectors, so memoising them stops the
// workspace's frequent re-renders (every word-count update) from re-rendering the editors.
const MemoLeft = memo(LeftPanel);
const MemoRight = memo(RightPanel);
const MemoManuscript = memo(Manuscript);
const MemoRail = memo(ActivityRail);

const TOOL_HINTS: Record<ToolId, string> = {
  rewrite: "Rework the selected text",
  continue: "Write on from the cursor",
  brainstorm: "Talk the story through",
  consistency: "Check against the codex",
  feedback: "Comments on the prose",
  summary: "Draft a synopsis",
  extract: "Find characters, places and more in the book",
};

function AssistMenu() {
  const running = useAi((s) => !!s.running);
  const [openMenu, setOpenMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpenMenu(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpenMenu(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [openMenu]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="btn assist"
        aria-haspopup="menu"
        aria-expanded={openMenu}
        disabled={running}
        onMouseDown={(e) => e.preventDefault() /* keep the editor's selection */}
        onClick={() => setOpenMenu(!openMenu)}
      >
        <Icon name="sparkle" className="accent-icon" />
        Assist
        <Icon name="chevronDown" size={14} />
      </button>
      {openMenu && (
        <div className="menu" role="menu">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              className="menu-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpenMenu(false);
                openTool(t.id);
              }}
            >
              <span className="menu-label">{t.label}</span>
              <span className="menu-hint">{TOOL_HINTS[t.id]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Save everything, release the project, and show the start screen. */
const closeToStart = () => flushAll().then(saveHistoryAll).then(() => useStore.getState().closeProject());

function TitleBar() {
  const s = useStore();
  const hasKey = useAi((a) => a.hasKey) === true;
  const node = s.selectedId ? findNode(s.nodes, s.selectedId) : null;
  const chapter = node && (node.type === "scene" || node.type === "note") ? findParent(s.nodes, node.id) : null;
  const canCork = !s.codexId && !s.bookOutline && !s.collectionId && !s.statsView && (node?.type === "chapter" || node?.type === "part");
  const entry = s.codexId ? s.codex.find((e) => e.id === s.codexId) : null;
  return (
    <header className={`titlebar ${IS_MAC ? "mac" : ""}`} data-tauri-drag-region>
      <button className="icon-btn" aria-label="Close project and return to the start screen" data-tip="Back to all projects" onClick={() => void closeToStart()}>
        <Icon name="home" size={18} />
      </button>
      <button className={`icon-btn ${s.leftOpen ? "" : "off"}`} aria-label={s.leftOpen ? "Hide sidebar" : "Show sidebar"} data-tip={`${s.leftOpen ? "Hide" : "Show"} sidebar (${MOD}\\)`} onClick={() => s.set({ leftOpen: !s.leftOpen })}>
        <Icon name="sidebarLeft" size={18} />
      </button>
      <HistoryButtons />
      <nav className="crumbs" aria-label="Location">
        <button className="crumb root" onClick={() => s.set({ leftTab: "binder", codexId: null })}>
          {s.title}
        </button>
        {entry ? (
          <>
            <Icon name="chevronRight" size={13} />
            <span className="crumb">Codex</span>
            <Icon name="chevronRight" size={13} />
            <span className="crumb current">{entry.name}</span>
          </>
        ) : (
          <>
            {chapter && chapter.type !== "trash" && (
              <>
                <Icon name="chevronRight" size={13} />
                <button className="crumb" onClick={() => s.select(chapter.id)}>
                  {chapter.title}
                </button>
              </>
            )}
            {node && (
              <>
                <Icon name="chevronRight" size={13} />
                <span className="crumb current">{node.title}</span>
              </>
            )}
          </>
        )}
      </nav>
      <div className="grow" data-tauri-drag-region />
      {(canCork || (s.bookOutline && !s.codexId)) && (
        <div className="segmented" role="group" aria-label="View">
          {canCork && (
            <>
              <button className={s.view === "text" ? "on" : ""} aria-pressed={s.view === "text"} onClick={() => s.set({ view: "text" })}>
                <Icon name="pen" size={15} />
                Text
              </button>
              <button className={s.view === "corkboard" ? "on" : ""} aria-pressed={s.view === "corkboard"} onClick={() => s.set({ view: "corkboard" })}>
                <Icon name="grid" size={15} />
                Corkboard
              </button>
              <button className={s.view === "outliner" ? "on" : ""} aria-pressed={s.view === "outliner"} onClick={() => s.set({ view: "outliner" })}>
                <Icon name="outline" size={15} />
                Outline
              </button>
            </>
          )}
          {!canCork && (
            <button className="on" aria-pressed="true">
              <Icon name="outline" size={15} />
              Book outline
            </button>
          )}
        </div>
      )}
      <div className="grow" data-tauri-drag-region />
      <button className="btn ghost" data-tip={`Focus mode (${MOD}${SHIFT}.)`} onClick={() => s.set({ focusMode: true })}>
        <Icon name="focus" />
        <span className="label">Focus</span>
      </button>
      <button className={`btn ghost ${s.typewriter ? "on" : ""}`} aria-pressed={s.typewriter} data-tip="Typewriter scrolling: keep the line you are typing in the middle" onClick={() => s.set({ typewriter: !s.typewriter })}>
        <Icon name="typewriter" />
        <span className="label">Typewriter</span>
      </button>
      {hasKey && <AssistMenu />}
      <button className="icon-btn" aria-label="Export" data-tip="Export" data-tip-kbd={`${MOD}E`} onClick={() => s.set({ exportOpen: true, exportRoot: null })}>
        <Icon name="export" size={18} />
      </button>
      <button className="command-box" onClick={() => s.set({ paletteOpen: true })}>
        <Icon name="search" size={14} />
        <span className="grow">Commands</span>
        <kbd>{MOD}K</kbd>
      </button>
      <button className={`icon-btn ${s.rightOpen ? "" : "off"}`} aria-label={s.rightOpen ? "Hide details panel" : "Show details panel"} data-tip={`${s.rightOpen ? "Hide" : "Show"} details (${MOD}${SHIFT}\\)`} onClick={() => s.set({ rightOpen: !s.rightOpen })}>
        <Icon name="sidebarRight" size={18} />
      </button>
    </header>
  );
}

/** A brief message at the bottom of the window. */
function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div key={toast.id} className="toast" role="status" aria-live="polite">
      {toast.text}
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className="progress" aria-hidden="true">
      <span className={v >= 1 ? "done" : ""} style={{ width: `${v * 100}%` }} />
    </span>
  );
}

function StatusBar({ manuscriptWords }: { manuscriptWords: number }) {
  const s = useStore();
  const ai = useAi();
  const hasKey = ai.hasKey === true;
  const node = s.selectedId ? findNode(s.nodes, s.selectedId) : null;
  const selWords = node ? nodeWords(s.counts, node.id, s.nodes) : 0;
  const pendingScenes = Object.entries(ai.pending).filter(([, n]) => n > 0);
  const pendingTotal = pendingScenes.reduce((a, [, n]) => a + n, 0);
  const { goals } = s.stats;
  const today = wordsOn(s.stats, dayKey());
  return (
    <footer className="statusbar">
      {node && !s.codexId && (
        <span>
          {selWords.toLocaleString()} words in this {node.type}
        </span>
      )}
      {pendingTotal > 0 && (
        <button className="pill amber" data-tip="Pending AI suggestions are not saved in your text until you accept them" onClick={() => s.set({ selectedId: pendingScenes[0][0], codexId: null, leftTab: "binder" })}>
          {pendingTotal} pending suggestion{pendingTotal === 1 ? "" : "s"}
        </button>
      )}
      <span className="grow" />
      {hasKey && ai.lastCall && (
        <span data-tip="From the last AI call; the project total is in Settings">
          Last AI call {(ai.lastCall.promptTokens + ai.lastCall.completionTokens).toLocaleString()} tokens, {ai.lastCall.cost === null ? "cost unknown" : `$${ai.lastCall.cost < 0.01 ? ai.lastCall.cost.toFixed(4) : ai.lastCall.cost.toFixed(2)}`}
        </span>
      )}
      <button className="status-btn" onClick={() => s.set({ statsView: !s.statsView, codexId: null })} data-tip="Goals and stats">
        Today {today < 0 ? "−" : ""}
        {Math.abs(today).toLocaleString()}
        {goals.dailyWords ? ` of ${goals.dailyWords.toLocaleString()}` : " words"}
        {goals.dailyWords ? <ProgressBar value={today / goals.dailyWords} /> : null}
      </button>
      <span>
        Book {manuscriptWords.toLocaleString()}
        {goals.projectWords ? ` of ${goals.projectWords.toLocaleString()}` : " words"}
      </span>
    </footer>
  );
}

/** Shown at the bottom in focus mode; fades in when the pointer moves over it. */
function FocusHud() {
  const s = useStore();
  const node = s.selectedId ? findNode(s.nodes, s.selectedId) : null;
  const words = node ? nodeWords(s.counts, node.id, s.nodes) : 0;
  const today = wordsOn(s.stats, dayKey());
  const goal = s.stats.goals.dailyWords;
  return (
    <div className="focus-hud">
      <span>
        <strong>{words.toLocaleString()}</strong> words
      </span>
      {goal ? (
        <>
          <span className="hud-sep" />
          <span className="hud-goal">
            <Ring value={today / goal} size={18} />
            {today.toLocaleString()} of {goal.toLocaleString()} today
          </span>
        </>
      ) : null}
      <button className="hud-exit" onClick={() => s.set({ focusMode: false })}>
        Exit focus <kbd>esc</kbd>
      </button>
    </div>
  );
}

function Workspace() {
  const s = useStore();
  const node = s.selectedId ? findNode(s.nodes, s.selectedId) : null;
  const manuscriptWords = s.nodes.filter((n) => n.type !== "trash").reduce((a, n) => a + nodeWords(s.counts, n.id, s.nodes), 0);

  // Record the manuscript total for daily stats, once counts and saved stats are both loaded.
  const { countsLoaded, statsLoaded, trackTotal } = s;
  useEffect(() => {
    if (countsLoaded && statsLoaded) trackTotal(manuscriptWords);
  }, [countsLoaded, statsLoaded, manuscriptWords, trackTotal]);

  // AI: nothing appears, and nothing touches the network, until an API key is set.
  const ai = useAi();
  const hasKey = ai.hasKey === true;
  const dir = s.dir;
  useEffect(() => {
    if (dir && hasKey) void ai.loadProjectUsage(dir);
  }, [dir, hasKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const commands = useMemo<Command[]>(
    () => [
      { id: "find", label: "Find in this text", hint: `${MOD}F`, group: "Go to", run: () => s.set({ findOpen: true, findFocus: s.findFocus + 1 }) },
      { id: "replace", label: "Replace in this text", group: "Go to", run: () => s.set({ findOpen: true, findReplace: true, findFocus: s.findFocus + 1 }) },
      { id: "search", label: "Search the project", hint: `${MOD}${SHIFT}F`, group: "Go to", run: () => s.openSearch() },
      { id: "binder", label: "Binder", group: "Go to", run: () => s.set({ leftTab: "binder" }) },
      { id: "collections", label: "Collections", group: "Go to", run: () => s.set({ leftTab: "collections" }) },
      { id: "new-collection", label: "New smart collection", group: "Create", run: () => s.set({ collectionId: s.newCollection("smart"), leftTab: "collections", bookOutline: false, codexId: null }) },
      { id: "codex", label: "Codex", group: "Go to", run: () => s.set({ leftTab: "codex" }) },
      { id: "snap", label: "Snapshots", group: "Go to", run: () => s.set({ rightTab: "snapshots" }) },
      { id: "stats", label: "Goals and stats", group: "Go to", run: () => s.set({ statsView: !s.statsView, codexId: null }) },
      { id: "settings", label: "Settings", hint: `${MOD},`, group: "Go to", run: () => openSettings() },
      ...(hasKey ? TOOLS.map((t) => ({ id: `ai-${t.id}`, label: t.label, detail: TOOL_HINTS[t.id], group: "Assist", run: () => openTool(t.id) })) : []),
      { id: "scene", label: "New scene", group: "Create", run: () => void s.addNode("scene", null) },
      { id: "chapter", label: "New chapter", group: "Create", run: () => void s.addNode("chapter", null) },
      {
        id: "entry",
        label: "New codex entry",
        group: "Create",
        run: async () => {
          const id = await s.createEntry("character", "New character");
          s.set({ leftTab: "codex", codexId: id });
        },
      },
      { id: "entry-scan", label: "Find codex entries in the book…", group: "Create", run: () => s.set({ extractOpen: true }) },
      { id: "entry-sel", label: "Codex entry from selection", hint: `${MOD}${SHIFT}E`, group: "Create", run: () => void createEntryFromSelection() },
      { id: "left", label: `${s.leftOpen ? "Hide" : "Show"} sidebar`, hint: `${MOD}\\`, group: "View", run: () => s.set({ leftOpen: !s.leftOpen }) },
      { id: "right", label: `${s.rightOpen ? "Hide" : "Show"} details panel`, hint: `${MOD}${SHIFT}\\`, group: "View", run: () => s.set({ rightOpen: !s.rightOpen }) },
      { id: "focus", label: `${s.focusMode ? "Leave" : "Enter"} focus mode`, hint: `${MOD}${SHIFT}.`, group: "View", run: () => s.set({ focusMode: !s.focusMode }) },
      { id: "fmtbar", label: `${s.formatBar ? "Hide" : "Show"} formatting toolbar`, group: "View", run: () => s.set({ formatBar: !s.formatBar }) },
      { id: "caret", label: `Turn ${s.smoothCaret ? "off" : "on"} smooth caret`, group: "View", run: () => s.set({ smoothCaret: !s.smoothCaret }) },
      { id: "tw", label: `Turn ${s.typewriter ? "off" : "on"} typewriter scrolling`, group: "View", run: () => s.set({ typewriter: !s.typewriter }) },
      { id: "cork", label: "Show chapter as corkboard", group: "View", run: () => s.set({ view: "corkboard", bookOutline: false }) },
      { id: "outline", label: "Show chapter as outline", group: "View", run: () => s.set({ view: "outliner", bookOutline: false }) },
      { id: "text-view", label: "Show chapter as text", group: "View", run: () => s.set({ view: "text", bookOutline: false }) },
      { id: "book-outline", label: "Book outline", group: "Go to", run: () => s.set({ bookOutline: true, codexId: null }) },
      { id: "mentions", label: `${s.mentionsOn ? "Hide" : "Show"} codex name highlighting`, group: "View", run: () => s.set({ mentionsOn: !s.mentionsOn }) },
      { id: "t-light", label: "Light theme", group: "View", run: () => s.set({ theme: "light" }) },
      { id: "t-dark", label: "Dark theme", group: "View", run: () => s.set({ theme: "dark" }) },
      { id: "t-sys", label: "Match system theme", group: "View", run: () => s.set({ theme: "system" }) },
      { id: "f+", label: "Larger text", hint: `${MOD}+`, group: "View", run: () => s.set({ fontSize: Math.min(32, s.fontSize + 1) }) },
      { id: "f-", label: "Smaller text", hint: `${MOD}−`, group: "View", run: () => s.set({ fontSize: Math.max(12, s.fontSize - 1) }) },
      { id: "import", label: "Import writing…", hint: `${MOD}${SHIFT}I`, group: "Project", run: () => s.set({ importOpen: true }) },
      { id: "export", label: "Export…", hint: `${MOD}E`, group: "Project", run: () => s.set({ exportOpen: true, exportRoot: null }) },
      { id: "close", label: "Close project (back to start)", group: "Project", run: () => void closeToStart() },
    ],
    [s, hasKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // On macOS only Cmd is the shortcut key; Ctrl+E/F/K/N/O are text-editing keys (end of line, etc.).
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      const st = useStore.getState();
      if (e.key === "Escape" && st.focusMode && !st.paletteOpen) return st.set({ focusMode: false });
      if (!mod) return;
      // Cmd+Z in the text is the editor's own; elsewhere it follows the area you last used.
      if (k === "z" || (k === "y" && !IS_MAC)) {
        const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
        if (st.historyScope === "binder" && !typing) {
          e.preventDefault();
          if (e.shiftKey || k === "y") st.redoBinder();
          else st.undoBinder();
        }
        return;
      }
      const go = (f: () => void) => (e.preventDefault(), f());
      if (e.shiftKey && k === "f") go(() => st.openSearch());
      else if (k === "f") go(() => st.set({ findOpen: true, findFocus: st.findFocus + 1 }));
      else if (k === "k" || (e.shiftKey && k === "p")) go(() => st.set({ paletteOpen: true }));
      else if (e.shiftKey && (k === "." || k === ">")) go(() => st.set({ focusMode: !st.focusMode }));
      else if (e.shiftKey && (k === "\\" || k === "|")) go(() => st.set({ rightOpen: !st.rightOpen }));
      else if (k === "\\") go(() => st.set({ leftOpen: !st.leftOpen }));
      else if (k === ",") go(() => openSettings());
      else if (e.shiftKey && k === "e") go(() => void createEntryFromSelection());
      else if (e.shiftKey && k === "i") go(() => st.set({ importOpen: true }));
      else if (k === "e") go(() => st.set({ exportOpen: true, exportRoot: null }));
      else if (k === "=" || k === "+") go(() => st.set({ fontSize: Math.min(32, st.fontSize + 1) }));
      else if (k === "-") go(() => st.set({ fontSize: Math.max(12, st.fontSize - 1) }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Remember whether you last used the binder or the text, so undo and redo act on the right one.
  useEffect(() => {
    const mark = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest) return;
      if (t.closest(".binder")) useStore.setState({ historyScope: "binder" });
      else if (t.closest(".editor-scroll, .formatbar")) useStore.setState({ historyScope: "text" });
    };
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("focusin", mark);
    return () => {
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("focusin", mark);
    };
  }, []);

  const focus = s.focusMode;
  // Entering focus mode puts the cursor back in the text, so the current paragraph lights up.
  useEffect(() => {
    if (focus) getActiveEditor()?.commands.focus();
  }, [focus]);

  return (
    <div className={`app ${focus ? "focus-mode" : ""}`}>
      {focus ? <div className="titlebar-space" data-tauri-drag-region /> : <TitleBar />}
      {s.error && (
        <div className="banner warn">
          <span className="grow">{s.error}</span>
          <button className="btn small" onClick={() => s.set({ error: null })}>
            Dismiss
          </button>
        </div>
      )}
      <div className="main">
        {!focus && <MemoRail />}
        {!focus && s.leftOpen && (
          <>
            <MemoLeft />
            <ResizeHandle side="left" />
          </>
        )}
        <main className="editor-scroll">
          {s.findOpen && !s.statsView && <FindBar />}
          {s.recovery.length === 0 && (
            <>
              {s.formatBar && !focus && !s.codexId && !s.bookOutline && !s.collectionId && !s.statsView && !(s.view !== "text" && (node?.type === "chapter" || node?.type === "part")) && <FormatBar />}
              <MemoManuscript />
            </>
          )}
        </main>
        {!focus && s.rightOpen && (
          <>
            <ResizeHandle side="right" />
            <MemoRight />
          </>
        )}
      </div>
      {focus ? <FocusHud /> : <StatusBar manuscriptWords={manuscriptWords} />}
      <HoverCard />
      <Toast />
      <SelectionMenu />
      <FootnotePopover />
      {ai.run && <RunDialog key={ai.run.tool + ai.run.from + ai.run.to} />}
      {ai.summaryResult && <SummaryDialog />}
      <RunStatus />
      {s.diff && <DiffView key={s.diff.snapshotId} />}
            {s.paletteOpen && <Palette commands={commands} />}
      {s.exportOpen && <ExportDialog />}
      {s.importOpen && <ImportDialog />}
      {s.extractOpen && <ExtractDialog />}
      {s.recovery.length > 0 && <RecoveryDialog />}
    </div>
  );
}

const FONTS: Record<string, string> = {
  literata: '"Literata Variable", Literata, Georgia, serif',
  spectral: 'Spectral, Georgia, serif',
  fraunces: '"Fraunces Variable", Georgia, serif',
  georgia: 'Georgia, "Times New Roman", serif',
  sans: '"Inter Variable", Inter, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const LINE_HEIGHTS: Record<string, number> = { compact: 1.5, comfortable: 1.75, airy: 2 };

export default function App() {
  const dir = useStore((s) => s.dir);
  const theme = useStore((s) => s.theme);
  const fs = useStore((s) => s.fontSize);
  const editorFont = useStore((s) => s.editorFont);
  const lineSpacing = useStore((s) => s.lineSpacing);
  const columnWidth = useStore((s) => s.columnWidth);
  const paragraphStyle = useStore((s) => s.paragraphStyle);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
  }, [theme]);

  const smoothCaret = useStore((s) => s.smoothCaret);
  useEffect(() => {
    document.documentElement.dataset.smoothCaret = smoothCaret ? "on" : "off";
    window.dispatchEvent(new Event(SMOOTH_CARET_EVENT));
  }, [smoothCaret]);

  // The window icon follows the setting; "match" follows the app theme (or the system when that is "system").
  const appIcon = useStore((s) => s.appIcon);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = appIcon === "match" ? (theme === "system" ? mq.matches : theme === "dark") : appIcon === "dark";
      invoke("set_app_icon", { variant: dark ? "dark" : "light" }).catch(() => {});
    };
    apply();
    if (appIcon !== "match" || theme !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [appIcon, theme]);

  useEffect(() => {
    const el = document.documentElement;
    el.style.setProperty("--font-size", `${fs}px`);
    el.style.setProperty("--editor-font", FONTS[editorFont] ?? FONTS.literata);
    el.style.setProperty("--line-height", String(LINE_HEIGHTS[lineSpacing] ?? 1.75));
    el.style.setProperty("--column", `${columnWidth}px`);
    el.dataset.paragraphs = paragraphStyle;
  }, [fs, editorFont, lineSpacing, columnWidth, paragraphStyle]);

  // Flush pending saves and release the session lock on a clean close.
  useEffect(() => {
    const p = getCurrentWindow().onCloseRequested(async () => {
      await flushAll();
      await saveHistoryAll();
      await useStore.getState().closeProject();
    });
    return () => void p.then((un) => un());
  }, []);

  // Only reads the OS keychain to learn whether a key exists; no network.
  const refreshKey = useAi((s) => s.refreshKey);
  useEffect(() => void refreshKey(), [refreshKey]);
  const settingsOpen = useAi((s) => s.settingsOpen);
  useSuppressBrowserMenu();

  return (
    <>
      {dir ? <Workspace /> : <Welcome />}
      {settingsOpen && <SettingsDialog />}
      <ContextMenu />
      <TooltipLayer />
    </>
  );
}
