// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Message, plainError } from "./ai";
import { ChatMsg, RunSpec, useAi } from "./aiStore";
import { insertAsSuggestion } from "./aiRun";
import { collect, prepare, sendTool } from "./aiTools";
import { jumpToPassage } from "./Comments";
import { getActive, getHandle } from "./editorRegistry";
import { useStore } from "./store";
import { findNode, leaves } from "./tree";
import { useEscape } from "./useEscape";

/** Show a scene (unless its editor is already on screen, say inside a chapter) and run `fn` once its text has loaded. */
function withScene(sceneId: string, fn: (h: NonNullable<ReturnType<typeof getHandle>>) => boolean | void) {
  const s = useStore.getState();
  if (!getHandle(sceneId) && s.selectedId !== sceneId) s.set({ selectedId: sceneId, codexId: null, leftTab: "binder" });
  let tries = 0;
  const t = window.setInterval(() => {
    const h = getHandle(sceneId);
    if ((h && h.ready()) || ++tries > 40) {
      window.clearInterval(t);
      if (h && h.ready()) {
        if (fn(h) === false) useStore.getState().set({ error: "That passage was edited, so it can't be found any more." });
      }
    }
  }, 100);
}

export function FindingsPanel() {
  const findings = useAi((s) => s.findings);
  const codex = useStore((s) => s.codex);
  const set = useAi((s) => s.set);
  if (!findings) return <div className="empty-state small">Run “Consistency check” to compare a scene with your codex and earlier scenes.</div>;
  if (findings.busy) return <div className="empty-state small">Checking for contradictions…</div>;
  return (
    <div className="comments">
      <div className="ref-bar">
        <button onClick={() => set({ findings: null })}>Clear</button>
      </div>
      {findings.error && <div className="banner warn">{findings.error}</div>}
      {!findings.error && findings.items.length === 0 && <div className="empty-state small">No contradictions found.</div>}
      <ul>
        {findings.items.map((f, i) => {
          const entry = f.entry ? codex.find((c) => c.name.toLowerCase() === f.entry!.toLowerCase()) : null;
          return (
            <li
              key={i}
              className={f.passage ? "jumpable" : undefined}
              tabIndex={f.passage ? 0 : undefined}
              data-tip={f.passage ? "Show this passage in the text" : undefined}
              onClick={(e) => {
                if (f.passage && !(e.target as HTMLElement).closest("button")) withScene(findings.sceneId, (h) => jumpToPassage(h.editor, f.passage));
              }}
              onKeyDown={(e) => {
                if (f.passage && e.key === "Enter" && e.target === e.currentTarget) withScene(findings.sceneId, (h) => jumpToPassage(h.editor, f.passage));
              }}
            >
              {f.passage && <blockquote>{f.passage}</blockquote>}
              <div>{f.problem}</div>
              {f.fix && <div className="muted">Suggested fix: {f.fix}</div>}
              <div className="snap-actions">
                {f.entry && (entry ? <button onClick={() => useStore.getState().set({ refId: entry.id, rightTab: "reference" })}>Open “{entry.name}”</button> : <span className="muted">Conflicts with: {f.entry}</span>)}
                <button onClick={() => set({ findings: { ...findings, items: findings.items.filter((_, n) => n !== i) } })}>Dismiss</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const plural = (n: number) => `${n} scene${n === 1 ? "" : "s"}`;

export function ChatPanel() {
  const { chat, chatBusy, set } = useAi();
  const nodes = useStore((s) => s.nodes);
  const codex = useStore((s) => s.codex);
  const selectedId = useStore((s) => s.selectedId);
  const [input, setInput] = useState("");
  /** Scenes, chapters and parts attached; a chapter stands for all the scenes in it. */
  const [attached, setAttached] = useState<string[]>([]);
  const [entries, setEntries] = useState<string[]>([]);
  const scenes = [...new Set(attached.flatMap((id) => { const n = findNode(nodes, id); return n ? leaves(n).map((l) => l.id) : []; }))];
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [chat]);
  const sceneNodes = nodes.filter((n) => n.type !== "trash").flatMap(leaves);
  const groups = nodes.filter((n) => n.type === "chapter" || n.type === "part").filter((n) => leaves(n).length > 0);

  const send = async () => {
    const text = input.trim();
    const ai = useAi.getState();
    const model = ai.modelFor("brainstorm");
    if (!text || ai.chatBusy) return;
    if (!model) return useStore.getState().set({ error: "Choose a model for Brainstorm chat in Settings." });
    setInput("");
    const history: Message[] = chat.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
    const update = (patch: Partial<ChatMsg>) => {
      const c = [...useAi.getState().chat];
      c[c.length - 1] = { ...c[c.length - 1], ...patch };
      set({ chat: c });
    };
    set({ chat: [...chat, { role: "user", content: text }, { role: "assistant", content: "" }], chatBusy: true });
    try {
      const scene = selectedId && findNode(nodes, selectedId)?.type === "scene" ? selectedId : null;
      const spec: RunSpec = { tool: "brainstorm", handle: null, sceneId: scene, selection: "", from: 0, to: 0, before: "", after: "" };
      const p = await prepare(spec, text, model, [], [], { attachEntries: entries, attachScenes: scenes });
      const used = p.context.items.filter((i) => i.included).map((i) => ({ title: i.title, reason: i.reason, level: i.level, tokens: i.tokens }));
      const messages: Message[] = [{ role: "system", content: p.system }, ...history, { role: "user", content: p.user }];
      const r = await collect("brainstorm", model, messages, (t) => update({ content: t }));
      update({ content: r.text, context: used, error: r.error ?? undefined });
    } catch (e) {
      update({ error: plainError(e) });
    } finally {
      set({ chatBusy: false });
    }
  };

  const saveAsNote = async (content: string) => {
    const s = useStore.getState();
    await s.addNode("note", null);
    const id = useStore.getState().selectedId;
    if (!id || !s.dir) return;
    await invoke("write_scene", { dir: s.dir, id, content });
    s.rename(id, content.split("\n")[0].replace(/[#*_>]/g, "").trim().slice(0, 50) || "Brainstorm note");
    void s.refreshCounts();
  };

  const model = useAi.getState().modelFor("brainstorm");
  return (
    <div className="chat">
      <div className="chat-log">
        {chat.length === 0 && <div className="empty-state small">Talk through plot, characters or a stuck scene. Attach scenes and codex entries below to give the assistant the details. Names you mention pull their codex entries in automatically.</div>}
        {chat.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="who">{m.role === "user" ? "You" : "Assistant"}</div>
            <div className="text">{m.content || (chatBusy && i === chat.length - 1 ? "…" : "")}</div>
            {m.error && <div className="banner warn">{m.error}</div>}
            {m.context && m.context.length > 0 && (
              <details>
                <summary className="muted">Used {m.context.length} context item{m.context.length === 1 ? "" : "s"}</summary>
                <ul className="muted">
                  {m.context.map((c, n) => (
                    <li key={n}>
                      {c.title}: {c.reason}
                      {c.level === "summary" ? " (summary)" : ""}, {c.tokens} tokens
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {m.role === "assistant" && m.content && !chatBusy && (
              <div className="snap-actions">
                <button
                  onClick={() => {
                    const h = getActive();
                    if (!h) return useStore.getState().set({ error: "Click into a scene first, where the text should go." });
                    insertAsSuggestion(h, m.content, "brainstorm", model);
                  }}
                >
                  Insert as suggestion
                </button>
                <button onClick={() => void saveAsNote(m.content)}>Save as note</button>
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <div className="attach">
          <select value="" aria-label="Attach a scene or chapter" onChange={(e) => e.target.value && setAttached([...attached, e.target.value])}>
            <option value="">Attach a scene or chapter…</option>
            {groups.filter((n) => !attached.includes(n.id)).length > 0 && (
              <optgroup label="Whole chapters">
                {groups.filter((n) => !attached.includes(n.id)).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title} ({plural(leaves(n).length)})
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Scenes">
              {sceneNodes.filter((n) => !attached.includes(n.id)).map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </optgroup>
          </select>
          <select value="" onChange={(e) => e.target.value && setEntries([...entries, e.target.value])}>
            <option value="">Attach a codex entry…</option>
            {codex.filter((c) => !entries.includes(c.id)).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="chips">
          {attached.map((id) => {
            const n = findNode(nodes, id);
            const many = n && (n.type === "chapter" || n.type === "part");
            return (
              <button key={id} data-tip="Remove" onClick={() => setAttached(attached.filter((s) => s !== id))}>
                {many ? "§" : "¶"} {n?.title ?? "scene"}
                {many ? ` (${plural(leaves(n).length)})` : ""} ✕
              </button>
            );
          })}
          {entries.map((id) => (
            <button key={id} data-tip="Remove" onClick={() => setEntries(entries.filter((s) => s !== id))}>
              {codex.find((c) => c.id === id)?.name ?? "entry"} ✕
            </button>
          ))}
        </div>
        <textarea
          rows={3}
          placeholder={model ? "Ask anything about your story…" : "Choose a model for Brainstorm chat in Settings first"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), void send());
          }}
        />
        <div className="snap-actions">
          {chatBusy ? <button onClick={() => useAi.getState().running?.stop()}>Stop</button> : <button disabled={!input.trim()} onClick={() => void send()}>Send</button>}
          <button disabled={chatBusy || chat.length === 0} onClick={() => set({ chat: [] })}>
            New conversation
          </button>
        </div>
      </div>
    </div>
  );
}

/** The scene-summary result: review, edit, then write it into the synopsis. */
export function SummaryDialog() {
  const result = useAi((s) => s.summaryResult)!;
  const set = useAi((s) => s.set);
  const patch = useStore((s) => s.patch);
  const [text, setText] = useState(result.text);
  useEffect(() => {
    if (result.busy) setText(result.text);
    else setText(result.text);
  }, [result.busy, result.text]);
  const close = () => {
    useAi.getState().running?.stop();
    set({ summaryResult: null });
  };
  useEscape(close);
  const regenerate = async () => {
    const ai = useAi.getState();
    const model = ai.modelFor("summary");
    try {
      const p = await prepare(result.spec, "", model, [], []);
      void sendTool(result.spec, p, model);
    } catch (e) {
      set({ summaryResult: { ...result, busy: false, error: plainError(e) } });
    }
  };
  const sceneId = result.spec.sceneId;
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <strong>Scene summary</strong>
          <span className="grow" />
          <button onClick={close}>{result.busy ? "Stop" : "Discard"}</button>
        </div>
        <div className="run-body">
          {result.error && <div className="banner warn">{result.error}</div>}
          <textarea rows={6} value={result.busy ? result.text : text} readOnly={result.busy} placeholder={result.busy ? "Writing…" : ""} onChange={(e) => setText(e.target.value)} />
          <div className="muted">Nothing is saved until you choose “Use as synopsis”. You can edit the text first.</div>
        </div>
        <div className="diff-foot">
          <button disabled={result.busy} onClick={() => void regenerate()}>
            Regenerate
          </button>
          <span className="grow" />
          <button
            className="primary"
            disabled={result.busy || !text.trim() || !sceneId}
            onClick={() => {
              if (sceneId) patch(sceneId, { synopsis: text.trim() });
              set({ summaryResult: null });
            }}
          >
            Use as synopsis
          </button>
        </div>
      </div>
    </div>
  );
}

/** Floating status: stop a running request, or show why it failed with a retry. */
export function RunStatus() {
  const running = useAi((s) => s.running);
  const error = useAi((s) => s.runError);
  const retry = useAi((s) => s.retry);
  const set = useAi((s) => s.set);
  if (!running && !error) return null;
  return (
    <div className={`run-status ${error ? "error" : ""}`} role="status">
      {running ? (
        <>
          <span className="spinner" /> AI is writing…
          <button onClick={() => running.stop()}>Stop</button>
        </>
      ) : (
        <>
          <span>{error}</span>
          {retry && <button onClick={() => retry()}>Retry</button>}
          <button onClick={() => set({ runError: null })}>Dismiss</button>
        </>
      )}
    </div>
  );
}
