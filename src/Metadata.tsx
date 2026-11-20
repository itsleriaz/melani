// SPDX-License-Identifier: GPL-3.0-only
// Keywords and fields on scenes and on the book: a few fixed ones, plus any the author adds.
import { useEffect, useId, useMemo, useState } from "react";
import { Icon } from "./icons";
import { useStore } from "./store";
import { BinderNode } from "./tree";

/** Fixed scene fields. `codex` offers entries of that type as suggestions. */
export const SCENE_FIELDS = [
  { key: "pov", label: "Point of view", hint: "Whose eyes we are behind", codex: "character" },
  { key: "location", label: "Location", hint: "Where it happens", codex: "place" },
  { key: "when", label: "When", hint: "e.g. Day 3, morning" },
] as const;

/** Fixed book fields. */
export const BOOK_FIELDS = [
  { key: "subtitle", label: "Subtitle", hint: "" },
  { key: "genre", label: "Genre", hint: "e.g. Mystery" },
  { key: "language", label: "Language", hint: "e.g. en-GB" },
  { key: "description", label: "Description", hint: "The blurb", long: true },
] as const;

const FIXED_SCENE_KEYS: string[] = SCENE_FIELDS.map((f) => f.key);

/** Every keyword already used in the book, for suggestions. */
export function useKnownKeywords(): string[] {
  const nodes = useStore((s) => s.nodes);
  const book = useStore((s) => s.meta.keywords);
  return useMemo(() => {
    const all = new Set<string>(book ?? []);
    const walk = (list: BinderNode[]) => list.forEach((n) => (n.keywords?.forEach((k) => all.add(k)), walk(n.children)));
    walk(nodes);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [nodes, book]);
}

/** A row of removable tags with a box to add more. Enter or comma adds one. */
export function TagInput({ value, onChange, suggestions = [], label, placeholder = "Add a keyword" }: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; label: string; placeholder?: string }) {
  const [text, setText] = useState("");
  const list = useId();
  const add = (raw: string) => {
    const t = raw.trim().replace(/,+$/, "").trim();
    setText("");
    if (!t || value.some((v) => v.toLowerCase() === t.toLowerCase())) return;
    onChange([...value, t]);
  };
  return (
    <div className="tag-input" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), e.currentTarget.querySelector("input")?.focus())}>
      {value.map((t) => (
        <span key={t} className="tag">
          {t}
          <button aria-label={`Remove ${t}`} data-tip="Remove" onClick={() => onChange(value.filter((v) => v !== t))}>
            <Icon name="close" size={11} />
          </button>
        </span>
      ))}
      <input
        list={list}
        aria-label={label}
        placeholder={value.length ? "" : placeholder}
        value={text}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setText(e.target.value))}
        onBlur={() => add(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.preventDefault(), add(text));
          else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
      />
      <datalist id={list}>
        {suggestions.filter((s) => !value.includes(s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

/** A single-line or multi-line field that saves when you leave it. */
export function TextField({ id, value, onSave, hint, list, long }: { id: string; value: string; onSave: (v: string) => void; hint?: string; list?: string; long?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => text.trim() !== value && onSave(text.trim());
  return long ? (
    <textarea id={id} className="input serif" rows={3} placeholder={hint} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
  ) : (
    <input id={id} className="input" list={list} placeholder={hint} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
  );
}

function useCodexNames(type?: string): string[] {
  const codex = useStore((s) => s.codex);
  return useMemo(() => (type ? codex.filter((e) => e.type === type).map((e) => e.name) : []), [codex, type]);
}

function setField(fields: Record<string, string> | undefined, key: string, v: string): Record<string, string> {
  const next = { ...fields };
  if (v) next[key] = v;
  else delete next[key];
  return next;
}

/** Name box for a new custom field, shown after "Add field". */
function AddField({ taken, onAdd }: { taken: string[]; onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const clash = taken.some((t) => t.toLowerCase() === name.trim().toLowerCase());
  const done = () => (setOpen(false), setName(""));
  if (!open)
    return (
      <button className="link-btn add-field" onClick={() => setOpen(true)}>
        <Icon name="plus" size={12} />
        Add a field
      </button>
    );
  return (
    <div className="add-field-row">
      <input
        className="input"
        autoFocus
        placeholder="Field name, e.g. Weather"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim() && !clash) (onAdd(name.trim()), done());
          else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), done());
        }}
      />
      <button className="btn small" disabled={!name.trim() || clash} onClick={() => (onAdd(name.trim()), done())}>
        Add
      </button>
      <button className="icon-btn small" aria-label="Cancel" onClick={done}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Keywords and fields for the selected binder item, shown in the details panel. */
export function NodeMetadata({ node }: { node: BinderNode }) {
  const patch = useStore((s) => s.patch);
  const meta = useStore((s) => s.meta);
  const patchMeta = useStore((s) => s.patchMeta);
  const keywords = useKnownKeywords();
  const povNames = useCodexNames("character");
  const placeNames = useCodexNames("place");
  const id = useId();
  const isText = node.type === "scene" || node.type === "note";
  const custom = meta.sceneFields ?? [];
  const lists = { pov: `${id}-pov`, location: `${id}-loc` } as Record<string, string>;
  return (
    <>
      <div className="field">
        <span className="field-label">Keywords</span>
        <TagInput label="Keywords" value={node.keywords ?? []} suggestions={keywords} onChange={(v) => patch(node.id, { keywords: v })} />
      </div>
      {isText && (
        <div className="field meta-fields">
          <span className="field-label">Details</span>
          {SCENE_FIELDS.map((f) => (
            <div key={f.key} className="meta-row">
              <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
              <TextField id={`${id}-${f.key}`} value={node.fields?.[f.key] ?? ""} hint={f.hint} list={f.key in lists ? lists[f.key] : undefined} onSave={(v) => patch(node.id, { fields: setField(node.fields, f.key, v) })} />
            </div>
          ))}
          <datalist id={lists.pov}>{povNames.map((n) => <option key={n} value={n} />)}</datalist>
          <datalist id={lists.location}>{placeNames.map((n) => <option key={n} value={n} />)}</datalist>
          {custom.map((name) => (
            <div key={name} className="meta-row">
              <label htmlFor={`${id}-c-${name}`}>{name}</label>
              <TextField id={`${id}-c-${name}`} value={node.fields?.[name] ?? ""} onSave={(v) => patch(node.id, { fields: setField(node.fields, name, v) })} />
            </div>
          ))}
          <AddField taken={[...FIXED_SCENE_KEYS, ...SCENE_FIELDS.map((f) => f.label), ...custom]} onAdd={(n) => patchMeta({ sceneFields: [...custom, n] })} />
        </div>
      )}
    </>
  );
}

/** Settings: details of the book itself, and the custom fields scenes carry. */
export function ProjectDetails() {
  const meta = useStore((s) => s.meta);
  const patchMeta = useStore((s) => s.patchMeta);
  const nodes = useStore((s) => s.nodes);
  const renameSceneField = useStore((s) => s.renameSceneField);
  const removeSceneField = useStore((s) => s.removeSceneField);
  const keywords = useKnownKeywords();
  const fields = meta.fields ?? {};
  const scene = meta.sceneFields ?? [];
  const bookKeys: string[] = BOOK_FIELDS.map((f) => f.key);
  const bookCustom = Object.keys(fields).filter((k) => !bookKeys.includes(k));
  const usage = (name: string) => {
    let n = 0;
    const walk = (list: BinderNode[]) => list.forEach((x) => (x.fields?.[name] && n++, walk(x.children)));
    walk(nodes);
    return n;
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  return (
    <>
      <section className="rows">
        <div className="setting-row">
          <label htmlFor="pd-title" className="setting-name">Title</label>
          <div className="setting-control"><TextField id="pd-title" value={meta.title} onSave={(v) => patchMeta({ title: v || meta.title })} /></div>
        </div>
        <div className="setting-row">
          <label htmlFor="pd-author" className="setting-name">Author</label>
          <div className="setting-control"><TextField id="pd-author" value={meta.author} onSave={(v) => patchMeta({ author: v })} /></div>
        </div>
        {BOOK_FIELDS.map((f) => (
          <div key={f.key} className="setting-row">
            <label htmlFor={`pd-${f.key}`} className="setting-name">{f.label}</label>
            <div className="setting-control">
              <TextField id={`pd-${f.key}`} long={"long" in f} value={fields[f.key] ?? ""} hint={f.hint} onSave={(v) => patchMeta({ fields: setField(fields, f.key, v) })} />
            </div>
          </div>
        ))}
        <div className="setting-row">
          <span className="setting-name">Keywords</span>
          <div className="setting-control"><TagInput label="Book keywords" value={meta.keywords ?? []} suggestions={keywords} onChange={(v) => patchMeta({ keywords: v })} /></div>
        </div>
      </section>
      <section className="rows">
        <h4>More book fields</h4>
        <p className="setting-intro">Anything else about the book: series, imprint, ISBN.</p>
        {bookCustom.map((k) => (
          <div key={k} className="setting-row">
            <label htmlFor={`pd-c-${k}`} className="setting-name">{k}</label>
            <div className="setting-control field-with-remove">
              <TextField id={`pd-c-${k}`} value={fields[k] ?? ""} onSave={(v) => patchMeta({ fields: { ...fields, [k]: v } })} />
              <button className="icon-btn" aria-label={`Remove ${k}`} data-tip="Remove field" onClick={() => patchMeta({ fields: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== k)) })}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
        <AddField taken={[...bookKeys, ...BOOK_FIELDS.map((f) => f.label), ...bookCustom]} onAdd={(n) => patchMeta({ fields: { ...fields, [n]: "" } })} />
      </section>
      <section className="rows">
        <h4>Scene fields</h4>
        <p className="setting-intro">Every scene has point of view, location and when. These are extra fields that every scene can fill in. They also appear as columns in the outliner.</p>
        {scene.length === 0 && <p className="muted">No extra fields yet. Add one from any scene's details.</p>}
        {scene.map((name) => (
          <div key={name} className="setting-row">
            {renaming === name ? (
              <input
                className="input"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onBlur={() => setRenaming(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim() && newName.trim() !== name && !scene.includes(newName.trim())) (renameSceneField(name, newName.trim()), setRenaming(null));
                  else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setRenaming(null));
                }}
              />
            ) : (
              <span className="setting-name">{name}</span>
            )}
            <div className="setting-control field-with-remove">
              <span className="muted">{usage(name)} scene{usage(name) === 1 ? "" : "s"} filled in</span>
              <button className="icon-btn" aria-label={`Rename ${name}`} data-tip="Rename" onClick={() => (setRenaming(name), setNewName(name))}>
                <Icon name="pen" size={14} />
              </button>
              <button
                className="icon-btn"
                aria-label={`Remove ${name}`}
                data-tip="Remove field"
                onClick={() => {
                  const n = usage(name);
                  if (n === 0 || window.confirm(`Remove “${name}”? ${n} scene${n === 1 ? " has" : "s have"} a value for it, and those values will be deleted.`)) removeSceneField(name);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
