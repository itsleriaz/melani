// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatCost, formatPrice, KeyInfo, ModelInfo, plainError, Template, TOOLS, ToolId, Usage } from "./ai";
import { useAi } from "./aiStore";
import { Icon } from "./icons";
import { Switch } from "./Inspector";
import { ProjectDetails } from "./Metadata";
import { MOD, SHIFT } from "./platform";
import { AppIcon, EditorFont, LineSpacing, ParagraphStyle, Theme, useStore } from "./store";

const VARIABLES = ["selection", "before", "after", "scene", "chapter_synopsis", "codex", "instruction", "pov", "style_notes"];

type SectionId = "details" | "general" | "editor" | "shortcuts" | "connection" | "models" | "templates" | "usage" | "project-goals" | "style" | "privacy";

let requested: SectionId | null = null;
/** Open Settings, optionally at a section. */
export function openSettings(section?: SectionId) {
  requested = section ?? null;
  useAi.getState().set({ settingsOpen: true });
}

export function ModelPicker({ value, onChange, allowClear = false, label }: { value: string; onChange: (id: string) => void; allowClear?: boolean; label?: string }) {
  const { models, modelsLoading, modelsError, prefs, loadModels, setPrefs } = useAi();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) void loadModels();
  }, [open, loadModels]);
  // Click elsewhere closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const current = models.find((m) => m.id === value);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = models.filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle));
    const fav = (m: ModelInfo) => (prefs.favourites.includes(m.id) ? 0 : 1);
    return [...list].sort((a, b) => fav(a) - fav(b)).slice(0, 80);
  }, [models, q, prefs.favourites]);
  const toggleFav = (id: string) => setPrefs({ favourites: prefs.favourites.includes(id) ? prefs.favourites.filter((f) => f !== id) : [...prefs.favourites, id] });

  return (
    <div
      className="model-picker"
      ref={root}
      onKeyDown={(e) => {
        // Escape closes the list first; the dialog around it stays open.
        if (e.key === "Escape" && open) (e.preventDefault(), e.stopPropagation(), setOpen(false));
      }}
    >
      <div className="mp-current">
        <button className="input select-like" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="grow">{value ? (current ? current.name : value) : allowClear ? "Use the default model" : "Choose a model…"}</span>
          <Icon name="chevronDown" size={14} />
        </button>
        {allowClear && value && (
          <button className="icon-btn" data-tip="Use the default model" aria-label="Use the default model" onClick={() => onChange("")}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {open && (
        <div className="mp-list">
          <input className="input" autoFocus placeholder="Search models" aria-label="Search models" value={q} onChange={(e) => setQ(e.target.value)} />
          {modelsLoading && <div className="muted pad">Loading models from OpenRouter…</div>}
          {modelsError && (
            <div className="banner warn">
              <span className="grow">{modelsError}</span>
              <button className="btn small" onClick={() => void loadModels(true)}>
                Retry
              </button>
            </div>
          )}
          <ul>
            {shown.map((m) => (
              <li key={m.id} className={m.id === value ? "sel" : ""}>
                <button className={`fav ${prefs.favourites.includes(m.id) ? "on" : ""}`} aria-label={prefs.favourites.includes(m.id) ? "Remove from favourites" : "Add to favourites"} onClick={() => toggleFav(m.id)}>
                  {prefs.favourites.includes(m.id) ? "★" : "☆"}
                </button>
                <button
                  className="mp-name"
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <strong>{m.name}</strong>
                  <span className="muted">
                    {m.contextLength ? `${Math.round(m.contextLength / 1000)}k context` : "context unknown"} · in {formatPrice(m.promptPrice)} / out {formatPrice(m.completionPrice)} per M tokens
                  </span>
                </button>
              </li>
            ))}
            {!modelsLoading && shown.length === 0 && !modelsError && <li className="muted pad">No models match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented full" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children, htmlFor, hint }: { label: string; children: React.ReactNode; htmlFor?: string; hint?: string }) {
  return (
    <div className="setting-row" style={hint ? { flexWrap: "wrap" } : undefined}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="setting-name">
          {label}
        </label>
      ) : (
        <span className="setting-name">{label}</span>
      )}
      <div className="setting-control">{children}</div>
      {hint && <p className="muted" style={{ flexBasis: "100%", margin: 0, fontSize: 12 }}>{hint}</p>}
    </div>
  );
}

function GeneralSection() {
  const { theme, appIcon, mentionsOn, set } = useStore();
  const icons: [AppIcon, string][] = [
    ["dark", "Dark"],
    ["light", "Light"],
    ["match", "Match theme"],
  ];
  const themes: [Theme, string][] = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "Match system"],
  ];
  return (
    <>
      <section>
        <h4>Theme</h4>
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {themes.map(([v, label]) => (
            <button key={v} role="radio" aria-checked={theme === v} className={`theme-card ${theme === v ? "on" : ""}`} onClick={() => set({ theme: v })}>
              <span className={`theme-preview ${v}`} aria-hidden="true">
                <span />
                <span />
              </span>
              {label}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h4 id="h-appicon">App icon</h4>
        <div className="theme-cards" role="radiogroup" aria-labelledby="h-appicon">
          {icons.map(([v, label]) => (
            <button key={v} role="radio" aria-checked={appIcon === v} className={`theme-card ${appIcon === v ? "on" : ""}`} onClick={() => set({ appIcon: v })}>
              <span className="theme-preview" aria-hidden="true" style={{ display: "grid", placeItems: "center" }}>
                <img src={v === "light" ? "/app-light.png" : "/app-dark.png"} width={36} height={36} alt="" />
              </span>
              {label}
            </button>
          ))}
        </div>
        <p className="muted">Changes the window and taskbar icon. The installed app icon is fixed, and on macOS it follows the system appearance.</p>
      </section>
      <section>
        <h4>Codex</h4>
        <Switch label="Highlight codex names in the text" hint={`Underlines names and aliases from your codex. ${MOD}-click one to open its entry.`} checked={mentionsOn} onChange={(v) => set({ mentionsOn: v })} />
      </section>
    </>
  );
}

const FONT_CARDS: [EditorFont, string, string][] = [
  ["literata", "Literata", '"Literata Variable", Georgia, serif'],
  ["spectral", "Spectral", "Spectral, Georgia, serif"],
  ["fraunces", "Fraunces", '"Fraunces Variable", Georgia, serif'],
  ["georgia", "Georgia", "Georgia, serif"],
  ["sans", "Sans", '"Inter Variable", system-ui, sans-serif'],
  ["mono", "Typewriter", 'ui-monospace, "SF Mono", Menlo, monospace'],
];

function EditorSection() {
  const s = useStore();
  return (
    <div className="settings-split">
      <div className="settings-controls">
        <section>
          <h4 id="h-typeface">Typeface</h4>
          <div className="font-cards" role="radiogroup" aria-labelledby="h-typeface">
            {FONT_CARDS.map(([v, label, family]) => (
              <button key={v} role="radio" aria-checked={s.editorFont === v} className={`font-card ${s.editorFont === v ? "on" : ""}`} onClick={() => s.set({ editorFont: v })}>
                <span className="font-sample" style={{ fontFamily: family }}>
                  Aa
                </span>
                {label}
              </button>
            ))}
          </div>
        </section>
        <section className="rows">
          <Row label="Text size" htmlFor="set-fs">
            <input id="set-fs" type="range" min={12} max={32} value={s.fontSize} onChange={(e) => s.set({ fontSize: parseInt(e.target.value, 10) })} />
            <span className="value">{s.fontSize} px</span>
          </Row>
          <Row label="Column width" htmlFor="set-cw">
            <input id="set-cw" type="range" min={480} max={960} step={20} value={s.columnWidth} onChange={(e) => s.set({ columnWidth: parseInt(e.target.value, 10) })} />
            <span className="value">{s.columnWidth} px</span>
          </Row>
          <Row label="Line spacing">
            <Segmented<LineSpacing>
              label="Line spacing"
              value={s.lineSpacing}
              onChange={(v) => s.set({ lineSpacing: v })}
              options={[
                ["compact", "Compact"],
                ["comfortable", "Comfortable"],
                ["airy", "Airy"],
              ]}
            />
          </Row>
          <Row label="Paragraphs">
            <Segmented<ParagraphStyle>
              label="Paragraphs"
              value={s.paragraphStyle}
              onChange={(v) => s.set({ paragraphStyle: v })}
              options={[
                ["indent", "Indent first line"],
                ["spaced", "Space between"],
              ]}
            />
          </Row>
        </section>
        <section>
          <h4>While writing</h4>
          <Switch label="Smart quotes and dashes" hint={'Turns "straight" quotes into curly ones and -- into an em dash as you type.'} checked={s.smartTypography} onChange={(v) => s.set({ smartTypography: v })} />
          <Switch label="Typewriter scrolling" hint="Keeps the line you are typing in the middle of the window." checked={s.typewriter} onChange={(v) => s.set({ typewriter: v })} />
          <Switch label="Smooth caret" hint="The cursor glides to where you click or move it, instead of jumping." checked={s.smoothCaret} onChange={(v) => s.set({ smoothCaret: v })} />
          <Switch label="Check spelling" hint="Uses your system's dictionary and language settings." checked={s.spellcheck} onChange={(v) => s.set({ spellcheck: v })} />
        </section>
      </div>
      <aside className="settings-preview" aria-label="Preview">
        <div className="section-label">Preview</div>
        <div className="preview-page prose">
          <p>
            The ferry left <span className="mention">Harrow Point</span> at six, the way it always had, with the horn sounding twice.
          </p>
          <p>“One way,” she said, before he could ask — and he did not meet her eyes.</p>
          <p className="dimmed">Out past the breakwater the water turned the colour of slate.</p>
        </div>
        <p className="muted">The faded line shows what focus mode dims.</p>
      </aside>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Commands", `${MOD}K`],
  ["Search the project", `${MOD}${SHIFT}F`],
  ["Focus mode", `${MOD}${SHIFT}.`],
  ["Leave focus mode", "esc"],
  ["Show or hide the sidebar", `${MOD}\\`],
  ["Show or hide the details panel", `${MOD}${SHIFT}\\`],
  ["Codex entry from selection", `${MOD}${SHIFT}E`],
  ["Open a highlighted name", `${MOD}-click`],
  ["Larger or smaller text", `${MOD}+ / ${MOD}−`],
  ["Settings", `${MOD},`],
  ["Bold, italic", `${MOD}B, ${MOD}I`],
  ["Highlight", `${MOD}${SHIFT}H`],
  ["Comment on the selection", `${MOD}⌥M`],
  ["Insert a footnote", `${MOD}⌥F`],
  ["Undo, redo", `${MOD}Z, ${MOD}${SHIFT}Z`],
];

function ShortcutsSection() {
  return (
    <section>
      <table className="shortcut-table">
        <tbody>
          {SHORTCUTS.map(([what, keys]) => (
            <tr key={what}>
              <td>{what}</td>
              <td>
                <kbd>{keys}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function KeySection() {
  const hasKey = useAi((s) => s.hasKey);
  const { saveKey, removeKey } = useAi();
  const [key, setKey] = useState("");
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await saveKey(key);
      setKey("");
      setMsg({ ok: true, text: "Key saved to your system keychain. The AI tools are now in the Assist menu." });
    } catch (e) {
      setMsg({ ok: false, text: plainError(e) });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setInfo(null);
    try {
      setInfo(await invoke<KeyInfo>("ai_key_info"));
      setMsg({ ok: true, text: "The key works." });
    } catch (e) {
      setMsg({ ok: false, text: plainError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <p className="setting-intro">
        AI is optional and off until you add your own OpenRouter API key. Text leaves this computer only when you run an AI tool, and only goes to OpenRouter using your key. The key is kept in your system keychain, never in project files.
      </p>
      <div className={`key-card ${hasKey ? "on" : ""}`}>
        <span className={`status-dot ${hasKey ? "final" : ""}`} aria-hidden="true" />
        <span className="grow">{hasKey ? "Connected with your OpenRouter key" : "Not connected"}</span>
        {hasKey && (
          <>
            <button className="btn" disabled={busy} onClick={() => void test()}>
              Test key
            </button>
            <button className="btn" disabled={busy} onClick={() => void removeKey().then(() => setMsg(null))}>
              Remove key
            </button>
          </>
        )}
      </div>
      {!hasKey && (
        <div className="inline-form">
          <label htmlFor="api-key" className="sr-only">
            OpenRouter API key
          </label>
          <input id="api-key" className="input grow" type="password" autoComplete="off" placeholder="OpenRouter API key (sk-or-…)" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && key.trim() && void save()} />
          <button className="btn primary" disabled={busy || !key.trim()} onClick={() => void save()}>
            Save key
          </button>
        </div>
      )}
      {msg && <div className={`banner ${msg.ok ? "ok" : "warn"}`}>{msg.text}</div>}
      {info && (
        <p className="muted">
          {info.label ? `${info.label}: ` : ""}spent {formatCost(info.usage)}
          {info.limit !== null && `, limit ${formatCost(info.limit)}`}
          {info.limitRemaining !== null && `, ${formatCost(info.limitRemaining)} left`}
        </p>
      )}
    </section>
  );
}

function ModelsSection() {
  const { prefs, setPrefs } = useAi();
  return (
    <>
      <section className="rows">
        <Row label="Default model">
          <ModelPicker label="Default model" value={prefs.defaultModel} onChange={(id) => setPrefs({ defaultModel: id })} />
        </Row>
      </section>
      <section className="rows">
        <h4>Per tool</h4>
        <p className="setting-intro">A cheap model suits summaries; a stronger one suits rewrites. Leave a tool on the default to use the model above.</p>
        {TOOLS.map((t) => (
          <Row key={t.id} label={t.label}>
            <ModelPicker label={`Model for ${t.label}`} value={prefs.models[t.id] ?? ""} allowClear onChange={(id) => setPrefs({ models: { ...prefs.models, [t.id]: id || undefined } })} />
          </Row>
        ))}
      </section>
      <section className="rows">
        <h4>Generation</h4>
        <Row label="Temperature" htmlFor="set-temp">
          <input id="set-temp" type="range" min={0} max={1.5} step={0.1} value={prefs.temperature} onChange={(e) => setPrefs({ temperature: parseFloat(e.target.value) })} />
          <span className="value">{prefs.temperature.toFixed(1)}</span>
        </Row>
        <Row label="Longest reply (tokens)" htmlFor="set-max">
          <input id="set-max" className="input narrow" type="number" min={100} step={100} value={prefs.maxTokens} onChange={(e) => setPrefs({ maxTokens: Math.max(100, parseInt(e.target.value, 10) || 1500) })} />
        </Row>
        <Row label="Reasoning effort" htmlFor="set-reason">
          <select id="set-reason" className="input" value={prefs.reasoning} onChange={(e) => setPrefs({ reasoning: e.target.value as typeof prefs.reasoning })}>
            <option value="">Model default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </Row>
        <Switch label="Send without the context preview" hint="Skips the inspector that shows what will be sent. You can still open it after a run." checked={prefs.skipPreview} onChange={(v) => setPrefs({ skipPreview: v })} />
      </section>
    </>
  );
}

function StyleSection() {
  const dir = useStore((s) => s.dir);
  const [s, setS] = useState({ styleNotes: "", pov: "" });
  useEffect(() => {
    if (dir) void invoke<typeof s>("ai_project_settings", { dir }).then(setS);
  }, [dir]);
  if (!dir) return null;
  const save = () => void invoke("ai_save_project_settings", { dir, settings: s });
  return (
    <section className="stack">
      <p className="setting-intro">Sent with every AI request as the style notes: voice, tense, point of view and words to avoid.</p>
      <div className="field">
        <label htmlFor="set-pov" className="field-label">
          Point of view
        </label>
        <input id="set-pov" className="input" value={s.pov} placeholder="e.g. Diane, close third person" onChange={(e) => setS({ ...s, pov: e.target.value })} onBlur={save} />
      </div>
      <div className="field">
        <label htmlFor="set-style" className="field-label">
          Style notes
        </label>
        <textarea id="set-style" className="input" rows={6} value={s.styleNotes} placeholder="Past tense. Short sentences. Never use “suddenly”." onChange={(e) => setS({ ...s, styleNotes: e.target.value })} onBlur={save} />
      </div>
    </section>
  );
}

function TemplatesSection() {
  const dir = useStore((s) => s.dir);
  const [list, setList] = useState<Template[]>([]);
  const [tool, setTool] = useState<ToolId>("rewrite");
  const [draft, setDraft] = useState<Template | null>(null);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    if (dir) setList(await invoke<Template[]>("ai_templates", { dir }));
  };
  useEffect(() => void load(), [dir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(list.find((t) => t.id === tool) ?? null), [list, tool]);
  useEffect(() => {
    if (!draft) return;
    const t = window.setTimeout(() => void invoke<string[]>("ai_check_template", { system: draft.system, user: draft.user }).then(setUnknown), 250);
    return () => window.clearTimeout(t);
  }, [draft?.system, draft?.user]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!dir) return <p className="setting-intro">Open a project to edit its prompt templates.</p>;
  if (!draft) return null;
  const save = async () => {
    await invoke("ai_save_template", { dir, template: draft });
    await load();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };
  return (
    <section className="stack">
      <p className="setting-intro">What each tool sends. Changes apply to this project only.</p>
      <div className="template-tabs" role="tablist" aria-label="Tool">
        {list.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tool} className={`chip ${t.id === tool ? "on" : ""}`} onClick={() => setTool(t.id as ToolId)}>
            {t.name}
            {t.overridden ? " •" : ""}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="tpl-sys" className="field-label">
          System prompt
        </label>
        <textarea id="tpl-sys" className="input mono" rows={8} value={draft.system} onChange={(e) => setDraft({ ...draft, system: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="tpl-user" className="field-label">
          User prompt
        </label>
        <textarea id="tpl-user" className="input mono" rows={6} value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
      </div>
      <div className="var-list">
        {VARIABLES.map((v) => (
          <code key={v}>{`{{${v}}}`}</code>
        ))}
      </div>
      {unknown.length > 0 && <div className="banner warn">Unknown variables will be left blank: {unknown.map((v) => `{{${v}}}`).join(", ")}</div>}
      <div className="inline-form">
        <button className="btn primary" onClick={() => void save()}>
          Save for this project
        </button>
        {draft.overridden && (
          <button className="btn" onClick={() => void invoke("ai_reset_template", { dir, id: tool }).then(load)}>
            Reset to default
          </button>
        )}
        {saved && <span className="muted">Saved</span>}
      </div>
    </section>
  );
}

function UsageSection() {
  const { session, project } = useAi();
  const dir = useStore((s) => s.dir);
  const card = (title: string, u: Usage) => (
    <div className="usage-card">
      <span className="field-label">{title}</span>
      <strong>{formatCost(u.cost)}</strong>
      <span className="muted">
        {u.calls} call{u.calls === 1 ? "" : "s"} · {(u.promptTokens + u.completionTokens).toLocaleString()} tokens
        {u.unpricedCalls ? ` · ${u.unpricedCalls} without a price` : ""}
      </span>
    </div>
  );
  return (
    <section className="stack">
      <div className="usage-cards">
        {card("This session", session)}
        {dir && card("This project", project)}
      </div>
      <p className="muted">Costs are estimates from what OpenRouter reports with each reply. The project total is stored in the project folder (usage.json).</p>
    </section>
  );
}

function GoalsSection() {
  const goals = useStore((s) => s.stats.goals);
  const setGoals = useStore((s) => s.setGoals);
  const set = useStore((s) => s.set);
  const num = (v: string) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return (
    <section className="rows">
      <Row label="Book target (words)" htmlFor="g-book">
        <input id="g-book" className="input narrow" type="number" min={0} value={goals.projectWords ?? ""} onChange={(e) => setGoals({ ...goals, projectWords: num(e.target.value) })} />
      </Row>
      <Row label="Deadline" htmlFor="g-dl">
        <input id="g-dl" className="input narrow" type="date" value={goals.deadline ?? ""} onChange={(e) => setGoals({ ...goals, deadline: e.target.value || undefined })} />
      </Row>
      <Row label="Start date" htmlFor="g-start" hint="Where the stats heatmap begins. Defaults to your first recorded day; days before that have no data.">
        <input id="g-start" className="input narrow" type="date" value={goals.startDate ?? ""} onChange={(e) => setGoals({ ...goals, startDate: e.target.value || undefined })} />
      </Row>
      <Row label="Daily target (words)" htmlFor="g-day">
        <input id="g-day" className="input narrow" type="number" min={0} value={goals.dailyWords ?? ""} onChange={(e) => setGoals({ ...goals, dailyWords: num(e.target.value) })} />
      </Row>
      <button
        className="link-btn"
        onClick={() => {
          useAi.getState().set({ settingsOpen: false });
          set({ statsView: true });
        }}
      >
        See your writing history
      </button>
    </section>
  );
}

function PrivacySection() {
  return (
    <section className="prose-section">
      <p>This app has no accounts, no analytics and no crash reporting. Your projects stay in the folders you choose.</p>
      <p>Text leaves your computer only when you run an AI tool. It then goes to OpenRouter, using your own key, and nowhere else. The context preview shows exactly what will be sent before you send it.</p>
      <p>Your API key is stored in your system keychain. It is never written to project files, logs or exports.</p>
    </section>
  );
}

interface NavItem {
  id: SectionId;
  label: string;
  group: string;
  badge?: string;
  needsKey?: boolean;
  needsProject?: boolean;
}

const NAV: NavItem[] = [
  { id: "general", label: "General", group: "App" },
  { id: "editor", label: "Editor", group: "App" },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "App" },
  { id: "connection", label: "Connection", group: "AI assistance" },
  { id: "models", label: "Models", group: "AI assistance", needsKey: true },
  { id: "templates", label: "Prompt templates", group: "AI assistance", needsKey: true, needsProject: true },
  { id: "usage", label: "Usage and cost", group: "AI assistance", needsKey: true },
  { id: "details", label: "Details and fields", group: "This project", needsProject: true },
  { id: "project-goals", label: "Goals", group: "This project", needsProject: true },
  { id: "style", label: "Style guide", group: "This project", needsKey: true, needsProject: true },
  { id: "privacy", label: "Privacy", group: "" },
];

/** Words each section can be found by in the settings search. */
const KEYWORDS: Record<SectionId, string> = {
  general: "theme dark light system codex highlight names app icon",
  editor: "font typeface size column width line spacing paragraph indent smart quotes dashes typewriter smooth caret cursor animation spelling spellcheck",
  shortcuts: "keyboard keys hotkeys",
  connection: "openrouter api key keychain",
  models: "model temperature tokens reasoning preview",
  templates: "prompt template system user variables",
  usage: "cost tokens spend",
  details: "title author genre language subtitle description keywords metadata fields custom scene pov location when",
  "project-goals": "goal target deadline daily words",
  style: "style guide pov point of view voice tense",
  privacy: "privacy telemetry data",
};

export function SettingsDialog() {
  const hasKey = useAi((s) => s.hasKey) === true;
  const set = useAi((s) => s.set);
  const dir = useStore((s) => s.dir);
  const [section, setSection] = useState<SectionId>(() => requested ?? "editor");
  const [q, setQ] = useState("");
  const close = () => set({ settingsOpen: false });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const nav = NAV.filter((n) => (!n.needsKey || hasKey) && (!n.needsProject || dir) && (!needle || `${n.label} ${KEYWORDS[n.id]}`.toLowerCase().includes(needle)));
  const current = NAV.find((n) => n.id === section) ?? NAV[0];
  const body: Record<SectionId, React.ReactNode> = {
    general: <GeneralSection />,
    editor: <EditorSection />,
    shortcuts: <ShortcutsSection />,
    connection: <KeySection />,
    models: <ModelsSection />,
    templates: <TemplatesSection />,
    usage: <UsageSection />,
    details: <ProjectDetails />,
    "project-goals": <GoalsSection />,
    style: <StyleSection />,
    privacy: <PrivacySection />,
  };

  return (
    <div className="overlay center" onMouseDown={close}>
      <div className="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="settings-nav" aria-label="Settings sections">
          <h2 id="settings-title">Settings</h2>
          <div className="panel-filter boxed">
            <Icon name="search" size={14} />
            <input aria-label="Search settings" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {nav.map((n, i) => (
            <div key={n.id}>
              {n.group !== nav[i - 1]?.group && <div className="section-label">{n.group || " "}</div>}
              <button className={`nav-item ${n.id === current.id ? "on" : ""}`} aria-current={n.id === current.id ? "page" : undefined} onClick={() => setSection(n.id)}>
                <span className="grow">{n.label}</span>
                {n.id === "connection" && <span className="nav-badge">{hasKey ? "On" : "Off"}</span>}
              </button>
            </div>
          ))}
          {nav.length === 0 && <div className="muted pad">No settings match.</div>}
        </nav>
        <div className="settings-page">
          <div className="settings-head">
            <h3 className="grow">{current.label}</h3>
            {current.group === "This project" && <span className="scope-pill">Saved in this project</span>}
            <span className="muted">Changes apply right away</span>
            <button className="icon-btn" aria-label="Close settings" onClick={close}>
              <Icon name="close" />
            </button>
          </div>
          <div className="settings-body">{body[current.id]}</div>
        </div>
      </div>
    </div>
  );
}
