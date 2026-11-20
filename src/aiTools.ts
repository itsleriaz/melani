// SPDX-License-Identifier: GPL-3.0-only
// Opening and sending the AI tools.
import { invoke } from "@tauri-apps/api/core";
import { AiEvent, Message, parseComments, parseFindings, plainError, Prepared, PrepareParams, SceneComment, streamChat, ToolId } from "./ai";
import { RunSpec, useAi } from "./aiStore";
import { startSuggestion } from "./aiRun";
import { getActive } from "./editorRegistry";
import { useStore } from "./store";

/** Text sent before/after the target is capped so a long scene does not eat the whole budget. */
const BEFORE_CHARS = 6000;
const AFTER_CHARS = 2000;

const NEEDS_INSTRUCTION: ToolId[] = ["rewrite"];

/** Capture what the tool is about from the focused scene editor, then open the dialog (or send). */
export function openTool(tool: ToolId): void {
  const store = useStore.getState();
  const ai = useAi.getState();
  if (tool === "brainstorm") return store.set({ rightTab: "chat" });
  if (tool === "extract") return store.set({ extractOpen: true });
  const h = getActive();
  if (!h) return store.set({ error: "Click into a scene first." });
  const doc = h.editor.state.doc;
  const { from, to } = h.editor.state.selection;
  const text = (a: number, b: number) => doc.textBetween(a, b, "\n", "\n");
  let spec: RunSpec;
  if (tool === "rewrite") {
    if (from === to) return store.set({ error: "Select the text you want to rewrite first." });
    spec = { tool, handle: h, sceneId: h.id, selection: text(from, to), from, to, before: text(0, from), after: text(to, doc.content.size) };
  } else if (tool === "continue") {
    spec = { tool, handle: h, sceneId: h.id, selection: "", from: to, to, before: text(0, to), after: "" };
  } else {
    // Consistency, feedback and summary work on the selection, or the whole scene.
    const whole = from === to;
    const [a, b] = whole ? [0, doc.content.size] : [from, to];
    spec = { tool, handle: h, sceneId: h.id, selection: text(a, b), from: a, to: b, before: "", after: "" };
    if (!spec.selection.trim()) return store.set({ error: "This scene is empty." });
  }
  spec.before = spec.before.slice(-BEFORE_CHARS);
  spec.after = spec.after.slice(0, AFTER_CHARS);
  store.set({ error: null });
  if (ai.prefs.skipPreview && !NEEDS_INSTRUCTION.includes(tool) && ai.modelFor(tool)) {
    void prepare(spec, "", ai.modelFor(tool), [], []).then((p) => sendTool(spec, p, ai.modelFor(tool))).catch((e) => useStore.getState().set({ error: plainError(e) }));
    return;
  }
  ai.set({ run: spec });
}

export async function prepare(spec: RunSpec, instruction: string, model: string, pinned: string[], excluded: string[], extra: Partial<PrepareParams> = {}): Promise<Prepared> {
  const dir = useStore.getState().dir;
  const ai = useAi.getState();
  const info = ai.models.find((m) => m.id === model);
  const params: PrepareParams = {
    tool: spec.tool,
    sceneId: spec.sceneId,
    selection: spec.selection,
    before: spec.before,
    after: spec.after,
    instruction,
    modelContext: info?.contextLength ?? 0,
    maxOutput: ai.prefs.maxTokens,
    pinned,
    excluded,
    attachEntries: [],
    attachScenes: [],
    ...extra,
  };
  return invoke<Prepared>("ai_prepare", { dir, params });
}

/** Run a stream to completion, collecting the text. Registers a cancel button while it runs. */
/** The tools that reply with a long JSON list need more room than a chat reply does. */
const LIST_TOOL_MIN_TOKENS = 4000;

export function collect(tool: ToolId, model: string, messages: Message[], onText?: (t: string) => void): Promise<{ text: string; error: string | null; cancelled: boolean; truncated: boolean; limit: number }> {
  const ai = useAi.getState();
  return new Promise((resolve) => {
    let text = "";
    let usage: Extract<AiEvent, { type: "usage" }> | null = null;
    let settled = false;
    let truncated = false;
    const limit = tool === "consistency" || tool === "feedback" || tool === "extract" ? Math.max(ai.prefs.maxTokens, LIST_TOOL_MIN_TOKENS) : ai.prefs.maxTokens;
    const finish = (error: string | null, cancelled = false) => {
      if (settled) return;
      settled = true;
      useAi.setState({ running: null });
      const dir = useStore.getState().dir;
      if (usage && dir) void useAi.getState().recordUsage(dir, tool, usage.promptTokens, usage.completionTokens, usage.cost);
      resolve({ text, error, cancelled, truncated, limit });
    };
    const stream = streamChat(
      { model, messages, temperature: ai.prefs.temperature, maxTokens: limit, reasoningEffort: ai.prefs.reasoning || undefined },
      (e) => {
        if (e.type === "delta") {
          text += e.text;
          onText?.(text);
        } else if (e.type === "usage") usage = e;
        else if (e.type === "truncated") truncated = true;
        else if (e.type === "done") finish(null);
        else if (e.type === "error") finish(plainError({ kind: e.kind, message: e.message }));
      },
    );
    useAi.setState({ running: { tool, sid: "", stop: () => void stream.cancel().then(() => finish(null, true)) }, runError: null });
  });
}

/** Send a prepared prompt and route the result to where this tool's output belongs. */
export async function sendTool(spec: RunSpec, prepared: Pick<Prepared, "system" | "user">, model: string): Promise<void> {
  const ai = useAi.getState();
  const messages: Message[] = [
    { role: "system", content: prepared.system },
    { role: "user", content: prepared.user },
  ];
  const sceneId = spec.sceneId ?? "";
  ai.set({ retry: () => void sendTool(spec, prepared, model), runError: null });

  if (spec.tool === "rewrite" || spec.tool === "continue") {
    if (!spec.handle) return;
    await startSuggestion({ handle: spec.handle, tool: spec.tool, model, messages, mode: spec.tool === "rewrite" ? "replace" : "insert", from: spec.from, to: spec.to });
    return;
  }

  if (spec.tool === "consistency") {
    ai.set({ findings: { sceneId, items: [], busy: true }, running: null });
    useStore.getState().set({ rightTab: "findings" });
    const r = await collect("consistency", model, messages);
    if (r.cancelled) return useAi.setState({ findings: { sceneId, items: [], busy: false, error: "Cancelled." } });
    const items = r.error ? null : parseFindings(r.text);
    // A reply that ran into the output limit is cut off mid-list: keep what was complete, and say why.
    const cutOff = r.truncated ? `The reply reached the ${r.limit.toLocaleString()}-token output limit and was cut off${items ? `, so only the first ${items.length} finding${items.length === 1 ? "" : "s"} are shown` : ""}. Raise “Max output” under Settings › Models, or check a shorter passage.` : undefined;
    useAi.setState({
      findings: {
        sceneId,
        items: items ?? [],
        busy: false,
        error: r.error ?? cutOff ?? (items ? undefined : "The model's reply was not in the expected format. Try again, or pick a different model."),
      },
    });
    return;
  }

  if (spec.tool === "feedback") {
    const r = await collect("feedback", model, messages);
    if (r.cancelled) return;
    const items = r.error ? null : parseComments(r.text);
    if (!items) return useStore.getState().set({ error: r.error ?? (r.truncated ? `The reply reached the ${r.limit.toLocaleString()}-token output limit before it finished. Raise “Max output” under Settings › Models, or review a shorter passage.` : "The model's reply was not in the expected format. Try again, or pick a different model.") });
    const fresh: SceneComment[] = items.map((c) => ({ id: crypto.randomUUID(), passage: c.passage, comment: c.comment, tool: "feedback", model }));
    ai.setSceneComments(sceneId, [...(useAi.getState().comments[sceneId] ?? []), ...fresh]);
    useStore.getState().set({ rightTab: "comments", error: items.length ? (r.truncated ? `The reply hit the ${r.limit.toLocaleString()}-token output limit, so only the first ${items.length} comments were kept.` : null) : "The model had no line feedback for this text." });
    return;
  }

  if (spec.tool === "summary") {
    ai.set({ summaryResult: { spec, text: "", busy: true } });
    const r = await collect("summary", model, messages, (text) => useAi.setState({ summaryResult: { spec, text, busy: true } }));
    useAi.setState({ summaryResult: { spec, text: r.text.trim(), busy: false, error: r.error ?? undefined } });
  }
}
