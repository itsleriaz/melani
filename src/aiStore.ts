// SPDX-License-Identifier: GPL-3.0-only
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emptyUsage, Finding, ModelInfo, plainError, SceneComment, ToolId, Usage } from "./ai";
import type { EditorHandle } from "./editorRegistry";

export interface Prefs {
  /** Model per tool; falls back to defaultModel. */
  models: Partial<Record<ToolId, string>>;
  defaultModel: string;
  favourites: string[];
  temperature: number;
  maxTokens: number;
  /** "" = leave to the model; otherwise low / medium / high where the model supports it. */
  reasoning: "" | "low" | "medium" | "high";
  /** Send without showing the context inspector first. */
  skipPreview: boolean;
}

const DEFAULTS: Prefs = { models: {}, defaultModel: "", favourites: [], temperature: 0.8, maxTokens: 1500, reasoning: "", skipPreview: false };

function loadPrefs(): Prefs {
  try {
    const v = localStorage.getItem("aiPrefs");
    return v ? { ...DEFAULTS, ...JSON.parse(v) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** What a tool run is about, captured when the user triggers it. */
export interface RunSpec {
  tool: ToolId;
  handle: EditorHandle | null;
  sceneId: string | null;
  selection: string;
  /** Editor range of the selection (rewrite) or the insertion point (continue). */
  from: number;
  to: number;
  before: string;
  after: string;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** What was sent for this turn, for the inspector-style disclosure. */
  context?: { title: string; reason: string; level: string; tokens: number }[];
  error?: string;
}

interface AiState {
  /** null until the keychain has been checked. */
  hasKey: boolean | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  prefs: Prefs;
  settingsOpen: boolean;
  session: Usage;
  project: Usage;
  lastCall: { tool: string; promptTokens: number; completionTokens: number; cost: number | null } | null;
  run: RunSpec | null;
  chat: ChatMsg[];
  chatBusy: boolean;
  findings: { sceneId: string; items: Finding[]; busy: boolean; error?: string } | null;
  /** The scene-summary result awaiting the user's decision. */
  summaryResult: { spec: RunSpec; text: string; busy: boolean; error?: string } | null;
  /** The suggestion currently streaming in, if any. */
  running: { tool: ToolId; sid: string; stop: () => void } | null;
  runError: string | null;
  /** Re-sends the last tool run (offered next to an error). */
  retry: (() => void) | null;
  /** Line-feedback comments per scene (persisted in the scene sidecar). */
  comments: Record<string, SceneComment[]>;
  /** Pending suggestion counts per scene. */
  pending: Record<string, number>;
  /** Comment to highlight in the panel after clicking it in the text. */
  focusComment: string | null;
  setSceneComments: (sceneId: string, list: SceneComment[]) => void;
  setPending: (sceneId: string, n: number) => void;

  refreshKey: () => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  removeKey: () => Promise<void>;
  loadModels: (force?: boolean) => Promise<void>;
  setPrefs: (p: Partial<Prefs>) => void;
  modelFor: (tool: ToolId) => string;
  loadProjectUsage: (dir: string) => Promise<void>;
  recordUsage: (dir: string, tool: string, promptTokens: number, completionTokens: number, cost: number | null) => Promise<void>;
  set: (p: Partial<AiState>) => void;
}

export const useAi = create<AiState>((set, get) => ({
  hasKey: null,
  models: [],
  modelsLoading: false,
  modelsError: null,
  prefs: loadPrefs(),
  settingsOpen: false,
  session: emptyUsage(),
  project: emptyUsage(),
  lastCall: null,
  run: null,
  chat: [],
  chatBusy: false,
  findings: null,
  summaryResult: null,
  running: null,
  runError: null,
  retry: null,
  comments: {},
  pending: {},
  focusComment: null,
  setSceneComments: (sceneId, list) => set({ comments: { ...get().comments, [sceneId]: list } }),
  setPending: (sceneId, n) => get().pending[sceneId] !== n && set({ pending: { ...get().pending, [sceneId]: n } }),

  // Only reads the OS keychain. No network.
  refreshKey: async () => {
    try {
      set({ hasKey: await invoke<boolean>("ai_has_key") });
    } catch {
      set({ hasKey: false });
    }
  },
  saveKey: async (key) => {
    await invoke("ai_set_key", { key });
    set({ hasKey: true });
  },
  removeKey: async () => {
    await invoke("ai_clear_key");
    set({ hasKey: false, models: [], modelsError: null });
  },
  loadModels: async (force = false) => {
    if (get().modelsLoading || (!force && get().models.length)) return;
    set({ modelsLoading: true, modelsError: null });
    try {
      set({ models: await invoke<ModelInfo[]>("ai_models") });
    } catch (e) {
      set({ modelsError: plainError(e) });
    } finally {
      set({ modelsLoading: false });
    }
  },
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    set({ prefs });
    try {
      localStorage.setItem("aiPrefs", JSON.stringify(prefs));
    } catch {
      /* storage unavailable */
    }
  },
  modelFor: (tool) => get().prefs.models[tool] || get().prefs.defaultModel,
  loadProjectUsage: async (dir) => {
    set({ project: await invoke<Usage>("ai_usage", { dir }).catch(() => emptyUsage()) });
  },
  recordUsage: async (dir, tool, promptTokens, completionTokens, cost) => {
    const s = get().session;
    set({
      lastCall: { tool, promptTokens, completionTokens, cost },
      session: {
        calls: s.calls + 1,
        promptTokens: s.promptTokens + promptTokens,
        completionTokens: s.completionTokens + completionTokens,
        cost: s.cost + (cost ?? 0),
        unpricedCalls: s.unpricedCalls + (cost === null ? 1 : 0),
      },
    });
    try {
      set({ project: await invoke<Usage>("ai_usage_add", { dir, promptTokens, completionTokens, cost }) });
    } catch {
      /* non-fatal */
    }
  },
  set: (p) => set(p),
}));
