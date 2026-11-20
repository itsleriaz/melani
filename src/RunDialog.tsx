// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { formatCost, plainError, Prepared, TOOLS } from "./ai";
import { useAi } from "./aiStore";
import { prepare, sendTool } from "./aiTools";
import { ModelPicker } from "./Settings";
import { Icon, IconName } from "./icons";
import { MOD } from "./platform";
import { useEscape } from "./useEscape";

const ICONS: Partial<Record<string, IconName>> = { rewrite: "pen", continue: "pen", consistency: "findings", feedback: "comment", summary: "sparkle" };
const CHIPS = ["Tighten", "More tension", "Expand with detail", "Simplify", "More vivid", "Show, don't tell", "Make it flow better"];

/** Instruction + model + a look at exactly what will be sent, before sending. */
export function RunDialog() {
  const spec = useAi((s) => s.run)!;
  const { prefs, models, loadModels, setPrefs, set } = useAi();
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState(useAi.getState().modelFor(spec.tool));
  const [pinned, setPinned] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [sys, setSys] = useState("");
  const [usr, setUsr] = useState("");
  const [edited, setEdited] = useState(false);
  const editedRef = useRef(false);
  const [showInspector, setShowInspector] = useState(!prefs.skipPreview);
  const [error, setError] = useState<string | null>(null);
  const tool = TOOLS.find((t) => t.id === spec.tool)!;
  const needsInstruction = spec.tool === "rewrite";

  useEffect(() => void loadModels(), [loadModels]);

  // Rebuild the context whenever something that affects it changes.
  useEffect(() => {
    const t = window.setTimeout(() => {
      prepare(spec, instruction, model, pinned, excluded)
        .then((p) => {
          setPrepared(p);
          setError(null);
          if (!editedRef.current) {
            setSys(p.system);
            setUsr(p.user);
          }
        })
        .catch((e) => setError(plainError(e)));
    }, 250);
    return () => window.clearTimeout(t);
  }, [spec, instruction, model, pinned, excluded, models.length]);

  const info = models.find((m) => m.id === model);
  const maxOut = prefs.maxTokens;
  const promptTokens = prepared ? Math.round((sys.length + usr.length) / 4) : 0;
  const tooBig = !!info && info.contextLength > 0 && prepared && Math.max(prepared.promptTokens, promptTokens) + maxOut > info.contextLength;
  const costCeiling = info && info.promptPrice !== null && info.completionPrice !== null && prepared ? (promptTokens * info.promptPrice + maxOut * info.completionPrice) / 1_000_000 : null;
  const canSend = !!model && !!prepared && (!needsInstruction || instruction.trim().length > 0);
  /** Cancel: back to the text you had selected, so the selection menu comes back too. */
  const close = () => {
    set({ run: null });
    window.setTimeout(() => spec.handle?.editor.isDestroyed === false && spec.handle.editor.commands.focus(), 0);
  };
  useEscape(close);

  const toggle = (list: string[], setList: (l: string[]) => void, id: string) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const send = () => {
    if (!canSend) return;
    set({ run: null });
    void sendTool(spec, { system: sys, user: usr }, model);
  };

  const itemCount = prepared?.context.items.length ?? 0;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), send());
    else if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.target.closest(".model-picker")) send();
  };
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog run" role="dialog" aria-modal="true" aria-labelledby="run-title" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="run-head">
          <span className="run-icon">
            <Icon name={ICONS[spec.tool] ?? "sparkle"} size={17} />
          </span>
          <div className="grow">
            <strong id="run-title">{tool.label}</strong>
            <div className="muted">Nothing changes in your text until you accept the result.</div>
          </div>
          <button className="icon-btn" aria-label="Cancel" data-tip="Cancel" data-tip-kbd="esc" onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="run-body run2">
          {spec.selection && spec.tool === "rewrite" && (
            <figure className="run-quote">
              <figcaption>Selected text</figcaption>
              <blockquote>{spec.selection.length > 400 ? spec.selection.slice(0, 400) + "…" : spec.selection}</blockquote>
            </figure>
          )}
          {needsInstruction && (
            <div className="run-field">
              <span className="field-label">What should change?</span>
              <div className="chips run-chips">
                {CHIPS.map((c) => (
                  <button key={c} className={instruction === c ? "on" : ""} onClick={() => setInstruction(c)}>
                    {c}
                  </button>
                ))}
              </div>
              <input className="input" autoFocus placeholder="Or say it in your own words" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            </div>
          )}
          {!needsInstruction && (spec.tool === "continue" || spec.tool === "consistency" || spec.tool === "feedback") && (
            <div className="run-field">
              <span className="field-label">{spec.tool === "continue" ? "Direction" : "Focus"} (optional)</span>
              <input
                className="input"
                autoFocus
                placeholder={spec.tool === "continue" ? "e.g. “Diane finds the letter”" : "e.g. “timeline”"}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </div>
          )}
          <div className="run-field">
            <span className="field-label">Model</span>
            <ModelPicker
              label="Model"
              value={model}
              onChange={(id) => {
                setModel(id);
                setPrefs({ models: { ...prefs.models, [spec.tool]: id } });
              }}
            />
          </div>
          {!model && <div className="banner warn">Choose a model to use for this tool.</div>}
          {error && <div className="banner warn">{error}</div>}
          {tooBig && <div className="banner warn">This prompt plus the reply is larger than the model's context window. Turn off some context below, or pick a model with more room.</div>}

          <section className="run-context">
            <button className="run-context-head" aria-expanded={showInspector} onClick={() => setShowInspector(!showInspector)}>
              <Icon name="chevronRight" size={14} className={`twisty ${showInspector ? "open" : ""}`} />
              <span className="grow">
                <strong>What will be sent</strong>
                <span className="muted">
                  {prepared ? ` · ${itemCount} context item${itemCount === 1 ? "" : "s"} · about ${promptTokens.toLocaleString()} tokens` : " · working it out…"}
                </span>
              </span>
              {costCeiling !== null && <span className="run-cost">≤ {formatCost(costCeiling)}</span>}
            </button>
            {showInspector && prepared && (
              <div className="run-context-body">
                <div className="run-meter" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, (prepared.context.usedTokens / Math.max(1, prepared.context.budget)) * 100)}%` }} />
                </div>
                <div className="muted run-meter-label">
                  Context {prepared.context.usedTokens.toLocaleString()} of {prepared.context.budget.toLocaleString()} tokens · reply up to {maxOut.toLocaleString()}
                </div>
                {itemCount === 0 ? (
                  <div className="muted">No codex entries or story context apply to this text.</div>
                ) : (
                  <ul className="ctx-list">
                    {prepared.context.items.map((i) => {
                      const on = !excluded.includes(i.id);
                      return (
                        <li key={i.id} className={`ctx-item ${on && i.included ? "" : "off"}`}>
                          <input type="checkbox" className="switch small" aria-label={`Include ${i.title}`} data-tip={on ? "Included. Turn off to leave it out." : "Left out"} checked={on} onChange={() => toggle(excluded, setExcluded, i.id)} />
                          <div className="grow ctx-text">
                            <div>
                              <strong>{i.title}</strong> <span className="badge">{i.kind.replace("_", " ")}</span>
                              {i.level === "summary" && <span className="badge auto">summary only</span>}
                            </div>
                            <div className="muted">{i.reason}</div>
                          </div>
                          <span className="ctx-tokens">{i.tokens.toLocaleString()}</span>
                          <button className={`icon-btn small pin ${pinned.includes(i.id) ? "on" : ""}`} aria-label="Always keep" aria-pressed={pinned.includes(i.id)} data-tip="Always keep, even if space is tight" onClick={() => toggle(pinned, setPinned, i.id)}>
                            <Icon name="pin" size={14} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <details className="run-prompt">
                  <summary>Prompt {edited && <span className="badge auto">edited</span>}</summary>
                  <label>
                    System
                    <textarea className="input mono" rows={7} value={sys} onChange={(e) => (setSys(e.target.value), setEdited(true), (editedRef.current = true))} />
                  </label>
                  <label>
                    User
                    <textarea className="input mono" rows={7} value={usr} onChange={(e) => (setUsr(e.target.value), setEdited(true), (editedRef.current = true))} />
                  </label>
                  {edited && (
                    <button
                      className="btn small"
                      onClick={() => {
                        editedRef.current = false;
                        setEdited(false);
                        if (prepared) (setSys(prepared.system), setUsr(prepared.user));
                      }}
                    >
                      Reset prompt
                    </button>
                  )}
                </details>
              </div>
            )}
          </section>
        </div>
        <div className="diff-foot">
          <label className="switch-row inline">
            <input type="checkbox" className="switch small" checked={prefs.skipPreview} onChange={(e) => setPrefs({ skipPreview: e.target.checked })} />
            <span className="switch-label muted">Skip this preview next time</span>
          </label>
          <span className="grow" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canSend} onClick={send}>
            Send <kbd>{MOD}↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
