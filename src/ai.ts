// SPDX-License-Identifier: GPL-3.0-only
import { Channel, invoke } from "@tauri-apps/api/core";

export type ToolId = "rewrite" | "continue" | "brainstorm" | "consistency" | "feedback" | "summary" | "extract";
export const TOOLS: { id: ToolId; label: string }[] = [
  { id: "rewrite", label: "Rewrite / expand" },
  { id: "continue", label: "Continue" },
  { id: "brainstorm", label: "Brainstorm chat" },
  { id: "consistency", label: "Consistency check" },
  { id: "feedback", label: "Line feedback" },
  { id: "summary", label: "Scene summary" },
  { id: "extract", label: "Codex from the book" },
];

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  /** USD per million tokens. */
  promptPrice: number | null;
  completionPrice: number | null;
}

export interface KeyInfo {
  label: string;
  usage: number | null;
  limit: number | null;
  limitRemaining: number | null;
}

export interface Template {
  id: string;
  name: string;
  system: string;
  user: string;
  output: "suggestion" | "chat" | "findings" | "comments" | "synopsis" | "entries";
  overridden: boolean;
}

export interface ContextItem {
  kind: string;
  id: string;
  title: string;
  reason: string;
  level: "full" | "summary";
  tokens: number;
  included: boolean;
  text: string;
  priority: number;
}

export interface Prepared {
  tool: ToolId;
  output: Template["output"];
  system: string;
  user: string;
  context: { items: ContextItem[]; usedTokens: number; budget: number };
  promptTokens: number;
}

export interface PrepareParams {
  tool: ToolId;
  sceneId: string | null;
  selection: string;
  before: string;
  after: string;
  instruction: string;
  modelContext: number;
  maxOutput: number;
  pinned: string[];
  excluded: string[];
  attachEntries: string[];
  attachScenes: string[];
}

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  unpricedCalls: number;
}
export const emptyUsage = (): Usage => ({ calls: 0, promptTokens: 0, completionTokens: 0, cost: 0, unpricedCalls: 0 });

export type AiEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; cost: number | null }
  | { type: "truncated" }
  | { type: "done" }
  | { type: "error"; kind: string; message: string };

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
}

/** Plain-language text for an error from the Rust core ({kind, message}) or anything else. */
export function plainError(e: unknown): string {
  const kind = errorKind(e);
  const raw = typeof e === "string" ? e : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
  switch (kind) {
    case "auth":
      return "OpenRouter rejected your API key. Check it in Settings.";
    case "credit":
      return "Your OpenRouter account is out of credit. Add credit at openrouter.ai, then retry.";
    case "rate_limit":
      return "The provider is rate limiting requests. Wait a moment, then retry.";
    case "model":
      return `That model is unavailable right now. Pick another in Settings. (${raw})`;
    case "provider":
      return `The model provider had a problem: ${raw}`;
    default:
      return raw;
  }
}

export function errorKind(e: unknown): string {
  return e && typeof e === "object" && "kind" in e ? String((e as { kind: unknown }).kind) : "other";
}

export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "cost unknown";
  if (cost === 0) return "$0";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function formatPrice(perMillion: number | null): string {
  return perMillion === null ? "?" : perMillion === 0 ? "free" : `$${perMillion < 1 ? perMillion.toFixed(2) : perMillion.toFixed(1)}`;
}

export interface Stream {
  cancel: () => Promise<void>;
}

/**
 * Start a streamed completion in the Rust core. `onEvent` receives deltas, usage, and exactly
 * one terminal `done` or `error`. Cancelling stops the request and emits nothing further.
 */
export function streamChat(request: ChatRequest, onEvent: (e: AiEvent) => void): Stream {
  const id = crypto.randomUUID();
  const channel = new Channel<AiEvent>();
  let finished = false;
  channel.onmessage = (e) => {
    if (finished) return;
    if (e.type === "done" || e.type === "error") finished = true;
    onEvent(e);
  };
  invoke("ai_start", { requestId: id, request, onEvent: channel }).catch((e) => {
    if (finished) return;
    finished = true;
    onEvent({ type: "error", kind: errorKind(e), message: plainError(e) });
  });
  return {
    cancel: async () => {
      finished = true;
      await invoke("ai_cancel", { requestId: id }).catch(() => {});
    },
  };
}

/** Pulls a JSON array out of a model reply, tolerating code fences and surrounding prose. */
export function parseJsonArray(text: string): unknown[] | null {
  const t = text.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The complete objects in a JSON array that was cut off before it closed (a reply that ran into the
 * output limit). Null when there are none.
 */
export function salvageObjects(text: string): unknown[] | null {
  const t = text.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("[");
  if (start < 0) return null;
  const out: unknown[] = [];
  let depth = 0;
  let from = -1;
  let inString = false;
  for (let i = start + 1; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") {
      if (depth++ === 0) from = i;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      try {
        out.push(JSON.parse(t.slice(from, i + 1)));
      } catch {
        /* a broken object is skipped */
      }
    }
  }
  return out.length ? out : null;
}

export interface Finding {
  passage: string;
  entry: string | null;
  problem: string;
  fix: string;
}

export function parseFindings(text: string): Finding[] | null {
  const arr = parseJsonArray(text) ?? salvageObjects(text);
  if (!arr) return null;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ passage: s(x.passage), entry: typeof x.entry === "string" && x.entry ? x.entry : null, problem: s(x.problem), fix: s(x.fix) }))
    .filter((f) => f.problem);
}

export interface LineComment {
  passage: string;
  comment: string;
}

export function parseComments(text: string): LineComment[] | null {
  const arr = parseJsonArray(text) ?? salvageObjects(text);
  if (!arr) return null;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ passage: s(x.passage), comment: s(x.comment) }))
    .filter((c) => c.comment);
}

/** A line-feedback comment anchored to a quoted passage of a scene. Never changes the text. */
export interface SceneComment {
  id: string;
  passage: string;
  comment: string;
  /** The AI tool that wrote it, or "author" for the writer's own comment. */
  tool: string;
  model: string;
  /** Where the passage was when the comment was made: finds the right one if it appears twice. */
  at?: number;
  created?: number;
  /** Set aside: no longer marked in the text. */
  resolved?: boolean;
}

export const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
