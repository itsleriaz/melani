// SPDX-License-Identifier: GPL-3.0-only
// Bring existing writing into the book: Markdown, plain text or Word files, or a folder of them.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "./icons";
import { Switch } from "./Inspector";
import { flushAll } from "./SceneEditor";
import { useStore } from "./store";
import type { BinderNode } from "./tree";
import { useEscape } from "./useEscape";

type Mode = "chapters" | "chaptersScenes" | "partsChaptersScenes";

interface PreviewNode {
  type: "part" | "chapter" | "scene";
  title: string;
  words: number;
  children: PreviewNode[];
}
interface Preview {
  files: string[];
  headings: Mode;
  nodes: PreviewNode[];
  parts: number;
  chapters: number;
  scenes: number;
  words: number;
  footnotes: number;
  comments: number;
  lostComments: number;
}
interface Imported {
  binder: { nodes: BinderNode[] };
  scenes: number;
  chapters: number;
  words: number;
  firstScene: string | null;
}

const MODES: [Mode, string, string][] = [
  ["chapters", "# Chapter", "Each # heading starts a chapter"],
  ["chaptersScenes", "# Chapter, ## Scene", "Two levels: chapters, then scenes"],
  ["partsChaptersScenes", "# Part, ## Chapter, ### Scene", "Three levels: parts, chapters, scenes"],
];

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Tree({ nodes, depth = 0 }: { nodes: PreviewNode[]; depth?: number }) {
  return (
    <ul className="imp-tree">
      {nodes.map((n, i) => (
        <li key={i}>
          <div className={`imp-row ${n.type}`} style={{ paddingLeft: 8 + depth * 16 }}>
            <Icon name={n.type === "scene" ? "scene" : n.type === "part" ? "part" : "folder"} size={13} />
            <span className="imp-title">{n.title}</span>
            <span className="imp-words">{n.words.toLocaleString()}</span>
          </div>
          {n.children.length > 0 && <Tree nodes={n.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function ImportDialog() {
  const dir = useStore((s) => s.dir)!;
  const set = useStore((s) => s.set);
  const [paths, setPaths] = useState<string[]>([]);
  const [headings, setHeadings] = useState<Mode | null>(null);
  const [sceneBreaks, setSceneBreaks] = useState(true);
  const [fileAsChapter, setFileAsChapter] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => set({ importOpen: false });
  useEscape(close);

  const options = { headings, sceneBreaks, fileAsChapter };
  useEffect(() => {
    if (paths.length === 0) return;
    let live = true;
    setError(null);
    invoke<Preview>("import_preview", { paths, options })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        // The first look works out what the headings mean; after that it is the writer's choice.
        setHeadings((h) => h ?? p.headings);
        // Several files with no headings of their own are most likely one chapter each.
        if (p.files.length > 1 && p.chapters <= 1 && headings === null) setFileAsChapter(true);
      })
      .catch((e) => live && (setPreview(null), setError(String(e))));
    return () => {
      live = false;
    };
  }, [paths, headings, sceneBreaks, fileAsChapter]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (folder: boolean) => {
    const sel = await open(folder ? { directory: true, multiple: false, title: "Choose a folder of manuscript files" } : { multiple: true, filters: [{ name: "Manuscripts", extensions: ["md", "markdown", "txt", "docx"] }] });
    const list = sel === null ? [] : Array.isArray(sel) ? sel : [sel];
    if (list.length) {
      setPreview(null);
      setHeadings(null);
      setPaths(list);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await flushAll();
      const r = await invoke<Imported>("import_commit", { dir, paths, options });
      set({ nodes: r.binder.nodes, selectedId: r.firstScene, importOpen: false, codexId: null, error: null });
      void useStore.getState().refreshCounts();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const empty = preview && preview.scenes === 0;
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog import" role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="run-head">
          <span className="run-icon">
            <Icon name="import" size={17} />
          </span>
          <div className="grow">
            <strong id="import-title">Import writing</strong>
            <div className="muted">Added to the end of your book. Nothing you have is changed.</div>
          </div>
          <button className="icon-btn" aria-label="Close" data-tip="Close" data-tip-kbd="esc" onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="run-body run2">
          {paths.length === 0 ? (
            <div className="imp-pick">
              <button className="big-btn" onClick={() => void pick(false)}>
                <Icon name="scene" size={18} />
                <span className="grow">
                  Choose files…
                  <small>Word (.docx), Markdown (.md) or plain text (.txt)</small>
                </span>
              </button>
              <button className="big-btn" onClick={() => void pick(true)}>
                <Icon name="folder" size={18} />
                <span className="grow">
                  Choose a folder…
                  <small>Every manuscript file in it, in name order</small>
                </span>
              </button>
              <p className="muted">Headings, bold and italic, highlights, footnotes and comments come across from Word files. Scene breaks such as * * * or --- start a new scene.</p>
            </div>
          ) : (
            <>
              <div className="imp-source">
                <Icon name="scene" size={14} />
                <span className="grow">{preview ? plural(preview.files.length, "file") : "Reading…"}{preview && preview.files.length > 0 ? `: ${preview.files.slice(0, 3).join(", ")}${preview.files.length > 3 ? ` and ${preview.files.length - 3} more` : ""}` : ""}</span>
                <button className="link-btn" onClick={() => (setPaths([]), setPreview(null))}>
                  Choose others
                </button>
              </div>
              {error && <div className="banner warn">{error}</div>}
              <div className="run-field">
                <span className="field-label">Headings mean</span>
                <div className="imp-modes" role="radiogroup" aria-label="What headings mean">
                  {MODES.map(([m, label, hint]) => (
                    <button key={m} role="radio" aria-checked={headings === m} className={`imp-mode ${headings === m ? "on" : ""}`} disabled={fileAsChapter} onClick={() => setHeadings(m)}>
                      <strong>{label}</strong>
                      <span>{hint}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Switch label="Split scenes at breaks" hint="A line of * * *, ***, --- or # on its own starts a new scene." checked={sceneBreaks} onChange={setSceneBreaks} />
                <Switch label="Each file is one chapter" hint="Named by its first heading, or its file name. Headings inside then stay in the text." checked={fileAsChapter} onChange={setFileAsChapter} />
              </div>
              {preview && (
                <section className="imp-preview" aria-label="What will be added">
                  <header>
                    <strong>What will be added</strong>
                    <span className="muted">
                      {[preview.parts > 0 && plural(preview.parts, "part"), plural(preview.chapters, "chapter"), plural(preview.scenes, "scene"), plural(preview.words, "word")].filter(Boolean).join(" · ")}
                    </span>
                  </header>
                  {(preview.footnotes > 0 || preview.comments > 0 || preview.lostComments > 0) && (
                    <div className="muted imp-extras">
                      {[preview.footnotes > 0 && plural(preview.footnotes, "footnote"), preview.comments > 0 && plural(preview.comments, "comment")].filter(Boolean).join(" and ")} come across.
                      {preview.lostComments > 0 && ` ${plural(preview.lostComments, "comment")} could not be placed and will be left out.`}
                    </div>
                  )}
                  {empty ? <div className="muted">Nothing to import from these files.</div> : <Tree nodes={preview.nodes} />}
                </section>
              )}
            </>
          )}
          {paths.length === 0 && error && <div className="banner warn">{error}</div>}
        </div>
        <div className="diff-foot">
          <span className="grow" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !preview || !!empty} onClick={() => void run()}>
            {busy ? "Importing…" : preview && !empty ? `Import ${plural(preview.scenes, "scene")}` : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
