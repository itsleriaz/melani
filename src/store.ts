// SPDX-License-Identifier: GPL-3.0-only
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { CodexEntry, emptyEntry } from "./codexTypes";
import { emptyStats, Goals, parseStats, recordTotal, Stats } from "./stats";
import { Collection, defaultRule } from "./collectionRules";
import type { SearchScope } from "./searchScope";
import { BinderEntry, parseBinderHistory, pickSelection, pushEntry, serializeBinderHistory } from "./binderHistory";
import { addChild, BinderNode, canContain, findNode, findParent, leaves, mapNodes, moveNode, moveNodes, orderedIds, topLevelIds, newNode, NodeType, removeNode, updateNode, DropPos } from "./tree";

/** What project.json holds. */
export type ViewMode = "text" | "corkboard" | "outliner";

export interface ProjectMeta {
  formatVersion: number;
  title: string;
  author: string;
  keywords?: string[];
  /** Book-level fields by name (subtitle, genre, language, description, and custom ones). */
  fields?: Record<string, string>;
  /** Names of the custom fields every scene can carry. */
  sceneFields?: string[];
}

interface Opened {
  meta: ProjectMeta;
  binder: { nodes: BinderNode[] };
  uncleanExit: boolean;
}

/** Unsaved text found in the crash recovery journal (see src-tauri/src/recovery.rs). */
export interface Recovered {
  id: string;
  text: string;
  disk: string;
  at: number;
}

export type Theme = "system" | "light" | "dark";
export type AppIcon = "dark" | "light" | "match";
export type EditorFont = "literata" | "spectral" | "fraunces" | "georgia" | "sans" | "mono";
export type LineSpacing = "compact" | "comfortable" | "airy";
export type ParagraphStyle = "indent" | "spaced";

/** What the search panel is looking for. Kept in the store so it survives switching tabs. */
export interface SearchQuery {
  q: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  manuscript: boolean;
  codex: boolean;
  notes: boolean;
  /** The whole project, or the chapter or scene that is selected. */
  scope: SearchScope;
}

/** Ask the editor for a scene to select the n-th match of a search once it has loaded. */
export interface Jump {
  id: string;
  query: SearchQuery;
  index: number;
  /** Bumped so jumping to the same match twice still scrolls. */
  seq: number;
}

export const PANEL_LIMITS = { left: [200, 560], right: [260, 640] } as const;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function persist(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

interface State {
  dir: string | null;
  title: string;
  meta: ProjectMeta;
  /** Change book-level details (author, keywords, fields) and save project.json. */
  patchMeta: (p: Partial<ProjectMeta>) => void;
  nodes: BinderNode[];
  selectedId: string | null;
  uncleanExit: boolean;
  /** Scenes with unsaved text from a crash. The manuscript stays hidden until each is resolved. */
  recovery: Recovered[];
  counts: Record<string, number>;
  error: string | null;
  recent: string[];
  theme: Theme;
  appIcon: AppIcon;
  focusMode: boolean;
  typewriter: boolean;
  smoothCaret: boolean;
  formatBar: boolean;
  fontSize: number;
  editorFont: EditorFont;
  lineSpacing: LineSpacing;
  columnWidth: number;
  paragraphStyle: ParagraphStyle;
  smartTypography: boolean;
  spellcheck: boolean;
  paletteOpen: boolean;
  /** Sidebars: shown or hidden, and their widths in px. */
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  search: SearchQuery;
  /** Bumped to move keyboard focus into the search field. */
  searchFocus: number;
  jump: Jump | null;
  openSearch: (q?: string) => void;
  /** The find bar (Ctrl+F) for the text on screen. The counter re-focuses it when pressed again. */
  findOpen: boolean;
  /** Open the find bar with its replace row showing. */
  findReplace: boolean;
  findFocus: number;

  codex: CodexEntry[];
  /** Bumped whenever the codex changes so editors rescan for mentions. */
  codexVersion: number;
  leftTab: "binder" | "codex" | "search" | "collections";
  rightTab: "inspector" | "reference" | "snapshots" | "comments" | "chat" | "findings";
  stats: Stats;
  /** True once word counts have been read, so the first (empty) total is never recorded. */
  countsLoaded: boolean;
  statsLoaded: boolean;
  /** Show the stats page in the main area. */
  statsView: boolean;
  /** Snapshot comparison overlay. */
  diff: { snapshotId: string; sceneId: string } | null;
  /** Show a chapter/part as cards instead of one continuous document. */
  /** How a chapter or part is shown: its scenes as text, as cards, or as a table. */
  view: ViewMode;
  /** Show the whole book as an outline table instead of the selected item. */
  bookOutline: boolean;
  /** Saved lists of scenes (collections.json). */
  collections: Collection[];
  /** The collection shown in the main area, if any. */
  collectionId: string | null;
  /** Codex entries mentioned in each scene; filled in on demand for smart collections. */
  mentions: Record<string, string[]>;
  loadMentions: () => Promise<void>;
  newCollection: (kind: Collection["kind"], init?: Partial<Collection>) => string;
  patchCollection: (id: string, p: Partial<Collection>) => void;
  deleteCollection: (id: string) => void;
  addToCollection: (id: string, sceneIds: string[]) => void;
  /** Outliner columns that are switched on, besides the title. */
  outlineCols: string[];
  trackTotal: (total: number) => void;
  setGoals: (goals: Goals) => void;
  /** Entry open in the main area (codex editor), or null for the manuscript. */
  codexId: string | null;
  /** Entry shown in the reference pane. */
  refId: string | null;
  mentionsOn: boolean;
  hover: { ids: string[]; rect: DOMRect } | null;

  loadCodex: () => Promise<void>;
  saveEntry: (entry: CodexEntry, body: string) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  createEntry: (type: string, name: string) => Promise<string>;
  openProject: (dir: string) => Promise<void>;
  createProject: (dir: string, title: string) => Promise<void>;
  closeProject: () => Promise<void>;
  /** Undo and redo for binder edits (moves, renames, trashing). Scene text has its own history in each editor. */
  binderUndo: BinderEntry[];
  binderRedo: BinderEntry[];
  /** Which history Cmd+Z and the title bar buttons act on: the one for the area you last used. */
  historyScope: "text" | "binder";
  /** A short message shown at the bottom of the window for a moment, for things that happen without other feedback. */
  toast: { id: number; text: string; action?: { label: string; run: () => void } } | null;
  /** With an action (such as Undo) the message stays up a little longer and can be clicked. */
  showToast: (text: string, action?: { label: string; run: () => void }) => void;
  undoBinder: () => void;
  redoBinder: () => void;
  select: (id: string) => void;
  addNode: (type: NodeType, parentId: string | null) => Promise<void>;
  rename: (id: string, title: string) => void;
  /** Rename a custom scene field, moving every scene's value with it. */
  renameSceneField: (from: string, to: string) => void;
  /** Remove a custom scene field and every scene's value for it. */
  removeSceneField: (name: string) => void;
  patch: (id: string, patch: Partial<BinderNode>) => void;
  move: (id: string, target: string, pos: DropPos) => void;
  trash: (id: string) => void;
  /** Items picked together in the binder (with Cmd/Ctrl or Shift); empty when just one is selected. */
  multi: string[];
  patchMany: (ids: string[], patch: Partial<BinderNode>) => void;
  moveMany: (ids: string[], target: string, pos: DropPos) => void;
  trashMany: (ids: string[]) => void;
  /** Copy a node (and, for a chapter or part, everything in it) right after the original. */
  duplicate: (id: string) => Promise<void>;
  /** Binder row being renamed in place, started from a context menu. */
  renamingId: string | null;
  exportOpen: boolean;
  importOpen: boolean;
  /** The dialog that finds codex entries in the book. */
  extractOpen: boolean;
  /** Export just this part or chapter; the whole book when null. */
  exportRoot: string | null;
  restore: (id: string) => void;
  /** Permanently deletes these trashed items (and everything inside them), including the scene files. */
  deleteForever: (ids: string[]) => Promise<void>;
  refreshCounts: () => Promise<void>;
  set: (p: Partial<State>) => void;
}

/** Set by the editor module so a duplicate copies text that is saved, not stale. */
let flushPending: () => Promise<void> = async () => {};
/** Write the binder's undo history now, if a write is waiting. Set up by the store. */
export let flushBinderHistory: () => Promise<void> = async () => {};
export const setFlushPending = (f: () => Promise<void>) => {
  flushPending = f;
};

export const useStore = create<State>((set, get) => {
  let statsTimer: number | undefined;
  /** Debounced: word counts change on every save, but the file only needs the latest. */
  const saveStats = () => {
    window.clearTimeout(statsTimer);
    statsTimer = window.setTimeout(() => {
      const { dir, stats } = get();
      if (dir) void invoke("write_stats", { dir, content: JSON.stringify(stats, null, 2) }).catch((e) => set({ error: String(e) }));
    }, 1000);
  };
  // The binder's undo history goes to disk shortly after it changes, and when the project closes.
  let binderHistoryTimer: number | undefined;
  const writeBinderHistory = async () => {
    window.clearTimeout(binderHistoryTimer);
    binderHistoryTimer = undefined;
    const { dir, binderUndo, binderRedo, nodes } = get();
    if (!dir) return;
    const op = binderUndo.length || binderRedo.length ? invoke("write_history", { dir, name: "binder", content: serializeBinderHistory(binderUndo, binderRedo, nodes) }) : invoke("clear_history", { dir, name: "binder" });
    await op.catch(() => {
      /* history is a convenience; never let it get in the way */
    });
  };
  flushBinderHistory = async () => {
    if (binderHistoryTimer !== undefined) await writeBinderHistory();
  };
  /** Write the binder. `label` names the edit for undo; pass null for a change that must not be undoable. */
  const saveBinder = async (nodes: BinderNode[], label: string | null = "Edit") => {
    const dir = get().dir;
    if (label) set({ binderUndo: pushEntry(get().binderUndo, { label, nodes: get().nodes, selectedId: get().selectedId, at: Date.now() }), binderRedo: [] });
    set({ nodes });
    if (!dir) return;
    window.clearTimeout(binderHistoryTimer);
    binderHistoryTimer = window.setTimeout(() => void writeBinderHistory(), 500);
    try {
      await invoke("save_binder", { dir, binder: { nodes } });
    } catch (e) {
      set({ error: String(e) });
    }
  };
  const saveCollections = (collections: Collection[]) => {
    const dir = get().dir;
    set({ collections });
    if (dir) void invoke("write_collections", { dir, content: JSON.stringify(collections, null, 2) }).catch((e) => set({ error: String(e) }));
  };
  const enter = (dir: string, o: Opened, recovery: Recovered[] = []) => {
    const recent = [dir, ...get().recent.filter((r) => r !== dir)].slice(0, 8);
    persist("recent", recent);
    const first = o.binder.nodes.flatMap(leaves)[0];
    set({ dir, title: o.meta.title, meta: o.meta, nodes: o.binder.nodes, binderUndo: [], binderRedo: [], historyScope: "text", uncleanExit: o.uncleanExit, recovery, selectedId: first?.id ?? null, recent, error: null, codex: [], codexId: null, refId: null, stats: emptyStats(), countsLoaded: false, statsLoaded: false, diff: null, view: "text", bookOutline: false, collections: [], collectionId: null, mentions: {} });
    void invoke<string>("read_history", { dir, name: "binder" })
      .then((raw) => {
        const h = raw ? parseBinderHistory(raw, get().nodes) : null;
        if (h && get().dir === dir && !get().binderUndo.length && !get().binderRedo.length) set({ binderUndo: h.undo, binderRedo: h.redo });
      })
      .catch(() => {});
    void invoke<string>("read_stats", { dir })
      .then((raw) => get().dir === dir && set({ stats: parseStats(raw), statsLoaded: true }))
      .catch(() => get().dir === dir && set({ statsLoaded: true }));
    void get().refreshCounts();
    void get().loadCodex();
    void invoke<string>("read_collections", { dir })
      .then((raw) => get().dir === dir && set({ collections: (JSON.parse(raw) as Collection[]) ?? [] }))
      .catch(() => {});
  };
  return {
    dir: null,
    title: "",
    meta: { formatVersion: 1, title: "", author: "" },
    patchMeta: (p) => {
      const { dir, meta } = get();
      if (!dir) return;
      const next = { ...meta, ...p };
      set({ meta: next, title: next.title });
      void invoke("save_project_meta", { dir, meta: next }).catch((e) => set({ error: String(e) }));
    },
    nodes: [],
    binderUndo: [],
    binderRedo: [],
    historyScope: "text",
    toast: null,
    showToast: (text, action) => {
      const id = Date.now() + Math.random();
      set({ toast: { id, text, action } });
      window.setTimeout(() => get().toast?.id === id && set({ toast: null }), action ? 7000 : 2800);
    },
    selectedId: null,
    uncleanExit: false,
    recovery: [],
    counts: {},
    error: null,
    recent: load<string[]>("recent", []),
    theme: load<Theme>("theme", "system"),
    appIcon: load<AppIcon>("appIcon", "dark"),
    focusMode: load("focusMode", false),
    typewriter: load("typewriter", false),
    smoothCaret: load("smoothCaret", false),
    formatBar: load("formatBar", true),
    fontSize: load("fontSize", 18),
    editorFont: load<EditorFont>("editorFont", "literata"),
    lineSpacing: load<LineSpacing>("lineSpacing", "comfortable"),
    columnWidth: load("columnWidth", 660),
    paragraphStyle: load<ParagraphStyle>("paragraphStyle", "indent"),
    smartTypography: load("smartTypography", true),
    spellcheck: load("spellcheck", true),
    paletteOpen: false,
    leftOpen: load("leftOpen", true),
    rightOpen: load("rightOpen", true),
    leftWidth: load("leftWidth", 272),
    rightWidth: load("rightWidth", 312),
    search: { q: "", caseSensitive: false, wholeWord: false, manuscript: true, codex: true, notes: true, scope: "project" },
    searchFocus: 0,
    findOpen: false,
    findReplace: false,
    findFocus: 0,
    jump: null,
    openSearch: (q) => {
      const search = q === undefined ? get().search : { ...get().search, q };
      get().set({ leftTab: "search", search, searchFocus: get().searchFocus + 1 });
    },

    codex: [],
    codexVersion: 0,
    leftTab: "binder",
    rightTab: "inspector",
    stats: emptyStats(),
    countsLoaded: false,
    statsLoaded: false,
    statsView: false,
    diff: null,
    view: "text",
    bookOutline: false,
    collections: [],
    collectionId: null,
    mentions: {},
    loadMentions: async () => {
      const { dir, nodes } = get();
      if (!dir) return;
      const ids = nodes.filter((n) => n.type !== "trash").flatMap(leaves).map((n) => n.id);
      const res = await Promise.all(ids.map((id) => invoke<Record<string, number>>("scene_mentions", { dir, id }).catch(() => ({}) as Record<string, number>)));
      if (get().dir !== dir) return;
      set({ mentions: Object.fromEntries(ids.map((id, i) => [id, Object.keys(res[i])])) });
    },
    newCollection: (kind, init = {}) => {
      const id = crypto.randomUUID().slice(0, 8);
      const n = get().collections.length + 1;
      const c: Collection = { id, name: kind === "smart" ? `Smart collection ${n}` : `Collection ${n}`, kind, ids: [], rules: kind === "smart" ? [defaultRule("status")] : [], match: "all", ...init };
      saveCollections([...get().collections, c]);
      return id;
    },
    patchCollection: (id, p) => saveCollections(get().collections.map((c) => (c.id === id ? { ...c, ...p } : c))),
    deleteCollection: (id) => {
      saveCollections(get().collections.filter((c) => c.id !== id));
      if (get().collectionId === id) set({ collectionId: null });
    },
    addToCollection: (id, sceneIds) => saveCollections(get().collections.map((c) => (c.id === id ? { ...c, ids: [...c.ids, ...sceneIds.filter((s) => !c.ids.includes(s))] } : c))),
    outlineCols: load("outlineCols", ["synopsis", "status", "pov", "words"]),
    trackTotal: (total) => {
      const next = recordTotal(get().stats, total);
      if (next !== get().stats) {
        set({ stats: next });
        saveStats();
      }
    },
    setGoals: (goals) => {
      set({ stats: { ...get().stats, goals } });
      saveStats();
    },
    codexId: null,
    refId: null,
    mentionsOn: load("mentionsOn", true),
    hover: null,

    loadCodex: async () => {
      const dir = get().dir;
      if (!dir) return;
      try {
        set({ codex: await invoke<CodexEntry[]>("list_codex", { dir }), codexVersion: get().codexVersion + 1 });
      } catch (e) {
        set({ error: String(e) });
      }
    },
    saveEntry: async (entry, body) => {
      const dir = get().dir;
      if (!dir) return;
      try {
        await invoke("save_codex_entry", { dir, entry, body });
        await get().loadCodex();
      } catch (e) {
        set({ error: String(e) });
      }
    },
    deleteEntry: async (id) => {
      const dir = get().dir;
      if (!dir) return;
      // Keep what is needed to put it back: the entry's fields and its text.
      const entry = get().codex.find((e) => e.id === id);
      const body = entry ? await invoke<string>("read_codex_body", { dir, id }).catch(() => null) : null;
      await invoke("delete_codex_entry", { dir, id });
      if (entry && body !== null) {
        get().showToast(`Deleted “${entry.name}”`, {
          label: "Undo",
          run: () => {
            set({ toast: null });
            if (get().dir === dir) void get().saveEntry(entry, body);
          },
        });
      }
      set({ codexId: get().codexId === id ? null : get().codexId, refId: get().refId === id ? null : get().refId });
      await get().loadCodex();
    },
    createEntry: async (type, name) => {
      const id = await invoke<string>("new_id");
      await get().saveEntry(emptyEntry(id, type, name), "");
      return id;
    },

    openProject: async (dir) => {
      try {
        const o = await invoke<Opened>("open_project", { dir });
        // Read before any editor mounts: typing would overwrite a scene's journal.
        const recovery = await invoke<Recovered[]>("list_recovery", { dir }).catch(() => []);
        enter(dir, o, recovery);
      } catch (e) {
        set({ error: String(e) });
      }
    },
    createProject: async (dir, title) => {
      try {
        enter(dir, await invoke<Opened>("create_project", { dir, title }));
      } catch (e) {
        set({ error: String(e) });
      }
    },
    closeProject: async () => {
      const dir = get().dir;
      await flushBinderHistory();
      if (dir) await invoke("close_project", { dir }).catch(() => {});
      set({ dir: null, nodes: [], binderUndo: [], binderRedo: [], selectedId: null, counts: {}, recovery: [] });
    },
    undoBinder: () => {
      const { binderUndo, binderRedo, nodes, selectedId } = get();
      const e = binderUndo[binderUndo.length - 1];
      if (!e) return;
      set({ binderUndo: binderUndo.slice(0, -1), binderRedo: [...binderRedo, { ...e, nodes, selectedId }], selectedId: pickSelection(e.nodes, selectedId, e.selectedId), multi: [] });
      void saveBinder(e.nodes, null);
      get().showToast(`Undid ${e.label.toLowerCase()}`);
    },
    redoBinder: () => {
      const { binderUndo, binderRedo, nodes, selectedId } = get();
      const e = binderRedo[binderRedo.length - 1];
      if (!e) return;
      set({ binderRedo: binderRedo.slice(0, -1), binderUndo: [...binderUndo, { ...e, nodes, selectedId }], selectedId: pickSelection(e.nodes, selectedId, e.selectedId), multi: [] });
      void saveBinder(e.nodes, null);
      get().showToast(`Redid ${e.label.toLowerCase()}`);
    },
    select: (id) => set({ selectedId: id, codexId: null, bookOutline: false, statsView: false, collectionId: null, multi: [] }),
    addNode: async (type, parentId) => {
      if (type === "scene" && parentId === null) {
        // Scenes live in chapters: use the selection's chapter, else the first one.
        const { nodes, selectedId } = get();
        const sel = selectedId ? findNode(nodes, selectedId) : null;
        const chapter = sel?.type === "chapter" ? sel : sel ? findParent(nodes, sel.id) : null;
        parentId = chapter?.type === "chapter" ? chapter.id : (nodes.find((n) => n.type === "chapter")?.id ?? null);
        if (!parentId) return;
      }
      const parent = parentId ? findNode(get().nodes, parentId) : null;
      if (!canContain(parent?.type ?? null, type)) return;
      const id = await invoke<string>("new_id");
      const title = type === "chapter" ? "New chapter" : type === "part" ? "New part" : type === "note" ? "New note" : "New scene";
      await saveBinder(addChild(get().nodes, parentId, newNode(id, type, title)), `New ${type}`);
      if (type === "scene" || type === "note") set({ selectedId: id });
    },
    renameSceneField: (from, to) => {
      const fields = (get().meta.sceneFields ?? []).map((f) => (f === from ? to : f));
      get().patchMeta({ sceneFields: fields });
      void saveBinder(
        mapNodes(get().nodes, (n) => {
          if (!n.fields || !(from in n.fields)) return n;
          const { [from]: v, ...rest } = n.fields;
          return { ...n, fields: { ...rest, [to]: v } };
        }),
        "Rename field",
      );
    },
    removeSceneField: (name) => {
      get().patchMeta({ sceneFields: (get().meta.sceneFields ?? []).filter((f) => f !== name) });
      void saveBinder(
        mapNodes(get().nodes, (n) => {
          if (!n.fields || !(name in n.fields)) return n;
          const { [name]: _gone, ...rest } = n.fields;
          return { ...n, fields: rest };
        }),
        "Remove field",
      );
    },
    rename: (id, title) => void saveBinder(updateNode(get().nodes, id, { title: title.trim() || "Untitled" }), "Rename"),
    patch: (id, p) => void saveBinder(updateNode(get().nodes, id, p), "Edit details"),
    move: (id, target, pos) => {
      const next = moveNode(get().nodes, id, target, pos);
      if (next !== get().nodes) void saveBinder(next, findNode(get().nodes, target)?.type === "trash" && pos === "inside" ? "Move to trash" : "Move");
    },
    renamingId: null,
    exportOpen: false,
    importOpen: false,
    extractOpen: false,
    exportRoot: null,
    duplicate: async (id) => {
      const dir = get().dir;
      const orig = findNode(get().nodes, id);
      if (!dir || !orig || orig.type === "trash") return;
      const copy = async (n: BinderNode, top: boolean): Promise<BinderNode> => {
        const nid = await invoke<string>("new_id");
        if (n.type === "scene" || n.type === "note") {
          const text = await invoke<string>("read_scene", { dir, id: n.id });
          await invoke("write_scene", { dir, id: nid, content: text });
        }
        const children = await Promise.all(n.children.map((c) => copy(c, false)));
        return { ...n, id: nid, title: top ? `${n.title} (copy)` : n.title, children };
      };
      try {
        await flushPending();
        const dup = await copy(orig, true);
        const parent = findParent(get().nodes, id);
        const added = addChild(get().nodes, parent?.id ?? null, dup);
        await saveBinder(moveNode(added, dup.id, id, "after"), "Duplicate");
        set({ selectedId: dup.id, codexId: null });
      } catch (e) {
        set({ error: String(e) });
      }
    },
    multi: [],
    patchMany: (ids, p) => void saveBinder(ids.reduce((acc, id) => updateNode(acc, id, p), get().nodes), "Edit details"),
    moveMany: (ids, target, pos) => {
      const next = moveNodes(get().nodes, ids, target, pos);
      if (next !== get().nodes) void saveBinder(next, findNode(get().nodes, target)?.type === "trash" && pos === "inside" ? "Move to trash" : "Move");
    },
    trashMany: (ids) => {
      const trash = get().nodes.find((n) => n.type === "trash");
      if (!trash) return;
      get().moveMany(topLevelIds(get().nodes, ids), trash.id, "inside");
      set({ multi: [] });
    },
    trash: (id) => {
      const trash = get().nodes.find((n) => n.type === "trash");
      if (trash) get().move(id, trash.id, "inside");
    },
    restore: (id) => {
      const nodes = get().nodes;
      const [without, node] = removeNode(nodes, id);
      if (!node) return;
      void saveBinder(addChild(without, null, node), "Restore");
    },
    deleteForever: async (ids) => {
      const dir = get().dir;
      const trash = get().nodes.find((n) => n.type === "trash");
      if (!dir || !trash) return;
      // Only things that are really in the trash, and the whole subtree of each.
      const doomed = topLevelIds(get().nodes, ids)
        .map((id) => findNode(trash.children, id))
        .filter((n): n is BinderNode => !!n);
      if (!doomed.length) return;
      const gone = new Set(orderedIds(doomed));
      const files = orderedIds(doomed).filter((id) => {
        const n = findNode(get().nodes, id);
        return n?.type === "scene" || n?.type === "note";
      });
      try {
        await flushPending();
        const sel = get().selectedId;
        if (sel && gone.has(sel)) set({ selectedId: null });
        set({ multi: get().multi.filter((id) => !gone.has(id)) });
        // The binder first: a crash in between leaves stray files, never a scene with no text.
        let nodes = get().nodes;
        for (const n of doomed) nodes = removeNode(nodes, n.id)[0];
        // The files are about to go, so earlier binder states that still list these scenes can no longer be restored.
        set({ binderUndo: [], binderRedo: [] });
        await saveBinder(nodes, null);
        const cols = get().collections;
        if (cols.some((c) => c.ids.some((id) => gone.has(id)))) saveCollections(cols.map((c) => ({ ...c, ids: c.ids.filter((id) => !gone.has(id)) })));
        await invoke("delete_scenes", { dir, ids: files });
        void get().refreshCounts();
      } catch (e) {
        set({ error: String(e) });
      }
    },
    refreshCounts: async () => {
      const dir = get().dir;
      if (!dir) return;
      try {
        set({ counts: await invoke<Record<string, number>>("word_counts", { dir }), countsLoaded: true });
      } catch {
        /* non-fatal */
      }
    },
    set: (p) => {
      // Choosing a sidebar tab shows that sidebar.
      if ("leftTab" in p && !("leftOpen" in p)) p = { ...p, leftOpen: true };
      if ("rightTab" in p && !("rightOpen" in p)) p = { ...p, rightOpen: true };
      // Going somewhere in the main area leaves whatever page was open (the outline, a collection, stats).
      if ("selectedId" in p && !("multi" in p)) p = { ...p, multi: [] };
      const goes = ("selectedId" in p && p.selectedId) || p.codexId || p.collectionId || p.bookOutline || p.statsView;
      if (goes) {
        if (!("bookOutline" in p)) p = { ...p, bookOutline: false };
        if (!("collectionId" in p)) p = { ...p, collectionId: null };
        if (!("statsView" in p)) p = { ...p, statsView: false };
      }
      set(p);
      for (const k of PERSISTED) if (k in p) persist(k, get()[k]);
    },
  };
});

const PERSISTED = [
  "recent",
  "theme",
  "appIcon",
  "focusMode",
  "typewriter",
  "smoothCaret",
  "formatBar",
  "outlineCols",
  "fontSize",
  "mentionsOn",
  "editorFont",
  "lineSpacing",
  "columnWidth",
  "paragraphStyle",
  "smartTypography",
  "spellcheck",
  "leftOpen",
  "rightOpen",
  "leftWidth",
  "rightWidth",
] as const;

export function nodeWords(counts: Record<string, number>, id: string, nodes: BinderNode[]): number {
  const n = findNode(nodes, id);
  return n ? leaves(n).reduce((a, l) => a + (counts[l.id] ?? 0), 0) : 0;
}
