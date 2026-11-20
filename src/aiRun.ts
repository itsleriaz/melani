// SPDX-License-Identifier: GPL-3.0-only
// Runs an AI call and streams the reply into a scene as a pending suggestion.
import { invoke } from "@tauri-apps/api/core";
import { Message, plainError, streamChat, ToolId, wordCount } from "./ai";
import { useAi } from "./aiStore";
import type { EditorHandle } from "./editorRegistry";
import { useStore } from "./store";
import { findNode } from "./tree";
import { AI_META } from "./Suggestion";
import { acceptTr, markOriginal, rejectTr, replaceStream, sidRanges, suggestionText, SUGGESTION } from "./suggestions";

const FLUSH_MS = 60;
/** A suggestion longer than this gets an automatic snapshot before it is accepted. */
export const LARGE_ACCEPT_WORDS = 200;

export interface SuggestionRun {
  handle: EditorHandle;
  tool: ToolId;
  model: string;
  messages: Message[];
  /** replace: strike through [from,to] and put the new text after it. insert: add at `from`. */
  mode: "replace" | "insert";
  from: number;
  to: number;
  /** Set when regenerating an existing suggestion. */
  sid?: string;
}

/** Stream a reply into the scene. Resolves when it finishes, fails or is cancelled. */
export function startSuggestion(o: SuggestionRun): Promise<void> {
  const { handle } = o;
  const ed = handle.editor;
  const ai = useAi.getState();
  const prefs = ai.prefs;
  const sid = o.sid ?? crypto.randomUUID();
  const attrs = { sid, tool: o.tool, model: o.model };

  let start: number;
  let end: number;
  if (o.sid) {
    const { added, original } = sidRanges(ed.state.doc, sid);
    start = added ? added.from : (original?.to ?? o.to);
    end = added ? added.to : start;
  } else if (o.mode === "replace") {
    const tr = ed.state.tr;
    markOriginal(tr, o.from, o.to, sid);
    ed.view.dispatch(tr.setMeta(AI_META, true).setMeta("addToHistory", false));
    start = end = o.to;
  } else {
    start = end = o.from;
  }

  handle.messages.set(sid, o.messages);
  handle.streaming.add(sid);
  ed.setEditable(false);
  ed.view.dispatch(ed.state.tr.setMeta(AI_META, true).setMeta("addToHistory", false));

  return new Promise<void>((resolve) => {
    let text = "";
    let usage: { promptTokens: number; completionTokens: number; cost: number | null } | null = null;
    let timer: number | undefined;
    let done = false;

    const flush = () => {
      timer = undefined;
      if (ed.isDestroyed) return;
      const tr = ed.state.tr;
      end = replaceStream(tr, start, end, text, attrs);
      ed.view.dispatch(tr.setMeta("addToHistory", false));
    };

    const finish = (error: string | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      useAi.setState({ running: null, runError: error });
      handle.streaming.delete(sid);
      if (!ed.isDestroyed) {
        flush();
        ed.setEditable(true);
        if (!text.trim()) {
          // Nothing arrived: undo the strike-through and forget the run.
          const tr = rejectTr(ed.state, sid);
          if (tr) ed.view.dispatch(tr.setMeta(AI_META, true).setMeta("addToHistory", false));
          handle.messages.delete(sid);
        }
        ed.view.dispatch(ed.state.tr.setMeta(AI_META, true).setMeta("addToHistory", false));
        handle.changed();
      }
      const dir = useStore.getState().dir;
      if (usage && dir) void useAi.getState().recordUsage(dir, o.tool, usage.promptTokens, usage.completionTokens, usage.cost);
      resolve();
    };

    const stream = streamChat(
      {
        model: o.model,
        messages: o.messages,
        temperature: prefs.temperature,
        maxTokens: prefs.maxTokens,
        reasoningEffort: prefs.reasoning || undefined,
      },
      (e) => {
        if (ed.isDestroyed) return void stream.cancel().then(() => finish(null));
        if (e.type === "delta") {
          text += e.text;
          if (timer === undefined) timer = window.setTimeout(flush, FLUSH_MS);
        } else if (e.type === "usage") {
          usage = { promptTokens: e.promptTokens, completionTokens: e.completionTokens, cost: e.cost };
        } else if (e.type === "done") finish(null);
        else if (e.type === "error") finish(plainError({ kind: e.kind, message: e.message }));
      },
    );
    useAi.setState({ running: { tool: o.tool, sid, stop: () => void stream.cancel().then(() => finish(null)) }, runError: null });
  });
}

/** The tool and model recorded on a suggestion's mark. */
function suggestionMeta(h: EditorHandle, sid: string): { tool: ToolId; model: string } | null {
  const { added } = sidRanges(h.editor.state.doc, sid);
  const mark = added && h.editor.state.doc.nodeAt(added.from)?.marks.find((m) => m.type.name === SUGGESTION);
  return mark ? { tool: mark.attrs.tool as ToolId, model: mark.attrs.model as string } : null;
}

export function canRegenerate(h: EditorHandle, sid: string): boolean {
  return h.messages.has(sid) && !!suggestionMeta(h, sid);
}

/** Replace the suggested text with a fresh generation from the same prompt. */
export function regenerateSuggestion(h: EditorHandle, sid: string): void {
  const meta = suggestionMeta(h, sid);
  const messages = h.messages.get(sid);
  if (!meta || !messages) return;
  const { original } = sidRanges(h.editor.state.doc, sid);
  const model = useAi.getState().modelFor(meta.tool) || meta.model;
  void startSuggestion({ handle: h, tool: meta.tool, model, messages, mode: original ? "replace" : "insert", from: original?.from ?? 0, to: original?.to ?? 0, sid });
}

/** Accept: the new text becomes normal prose. A large one is snapshotted first. */
export async function acceptSuggestion(h: EditorHandle, sid: string): Promise<void> {
  const { added } = sidRanges(h.editor.state.doc, sid);
  if (added && wordCount(suggestionText(h.editor.state.doc, added)) > LARGE_ACCEPT_WORDS) {
    try {
      await h.saveNow(); // the file on disk holds the text without pending suggestions
      const title = findNode(useStore.getState().nodes, h.id)?.title ?? "Scene";
      await invoke("create_snapshot", { dir: h.dir, sceneIds: [h.id], note: "Automatic: before accepting a large AI suggestion", label: title, scope: "auto" });
    } catch (e) {
      useStore.getState().set({ error: `Could not take the automatic snapshot, so the suggestion was not accepted: ${e}` });
      return;
    }
  }
  const tr = acceptTr(h.editor.state, sid);
  if (!tr) return;
  h.editor.view.dispatch(tr.setMeta(AI_META, true));
  h.messages.delete(sid);
  h.changed();
}

export function rejectSuggestion(h: EditorHandle, sid: string): void {
  const tr = rejectTr(h.editor.state, sid);
  if (!tr) return;
  h.editor.view.dispatch(tr.setMeta(AI_META, true));
  h.messages.delete(sid);
  h.changed();
}

/** Add text that already exists (e.g. a chat reply) at the cursor as a pending suggestion. */
export function insertAsSuggestion(h: EditorHandle, text: string, tool: string, model: string, messages?: Message[]): void {
  const sid = crypto.randomUUID();
  const tr = h.editor.state.tr;
  const at = h.editor.state.selection.to;
  replaceStream(tr, at, at, text, { sid, tool, model });
  h.editor.view.dispatch(tr.setMeta(AI_META, true));
  if (messages) h.messages.set(sid, messages);
  h.changed();
}
