// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Icon } from "./icons";
import { Switch } from "./Inspector";
import { flushAll } from "./SceneEditor";
import { useStore } from "./store";
import { findNode } from "./tree";
import { useEscape } from "./useEscape";

interface Summary {
  parts: number;
  chapters: number;
  scenes: number;
  words: number;
  excluded: number;
  pending: string[];
}

type Format = "markdown" | "docx" | "epub";
const FORMATS: [Format, string, string][] = [
  ["markdown", "Markdown", ".md"],
  ["docx", "Word", ".docx"],
  ["epub", "EPUB", ".epub"],
];
const BREAKS = ["* * *", "#", "⁂", ""];

const loadFormat = (): Format => {
  try {
    const v = localStorage.getItem("exportFormat");
    return v === "docx" || v === "epub" ? v : "markdown";
  } catch {
    return "markdown";
  }
};

/** Export the book as Markdown, a Word file or an EPUB. Refused while AI suggestions are pending in any included scene. */
export function ExportDialog() {
  const dir = useStore((s) => s.dir)!;
  const title = useStore((s) => s.title);
  const nodes = useStore((s) => s.nodes);
  const root = useStore((s) => s.exportRoot);
  const set = useStore((s) => s.set);
  const [format, setFormat] = useState<Format>(loadFormat);
  const [layout, setLayout] = useState<"single" | "perChapter">("single");
  const [style, setStyle] = useState<"manuscript" | "book">("manuscript");
  const [sceneBreak, setSceneBreak] = useState("* * *");
  const [sceneTitles, setSceneTitles] = useState(false);
  const [frontMatter, setFrontMatter] = useState(false);
  const [titlePage, setTitlePage] = useState(true);
  const [comments, setComments] = useState(false);
  const [cover, setCover] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = { layout, sceneBreak, sceneTitles, frontMatter, root: root ?? null, style, titlePage, comments, cover };
  const close = () => set({ exportOpen: false, exportRoot: null });
  useEscape(close);
  const scope = root ? findNode(nodes, root)?.title : null;
  const ext = FORMATS.find((f) => f[0] === format)![2];

  const pickFormat = (f: Format) => {
    setFormat(f);
    setMsg(null);
    try {
      localStorage.setItem("exportFormat", f);
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    void flushAll().then(() => invoke<Summary>("export_summary", { dir, options }).then(setSummary).catch((e) => setMsg(String(e))));
  }, [dir, root]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickCover = async () => {
    const f = await open({ multiple: false, filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "gif"] }] });
    if (typeof f === "string") setCover(f);
  };

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await flushAll();
      const name = (scope ?? title) || "Manuscript";
      const folder = format === "markdown" && layout === "perChapter";
      const target = folder
        ? await open({ directory: true, multiple: false, title: "Choose where to create the export folder" })
        : await save({ defaultPath: `${name}${ext}`, filters: [{ name: FORMATS.find((f) => f[0] === format)![1], extensions: [ext.slice(1)] }] });
      if (typeof target !== "string") return;
      const command = format === "markdown" ? "export_markdown" : format === "docx" ? "export_docx" : "export_epub";
      const r = await invoke<{ files: string[]; summary: Summary }>(command, { dir, options: { ...options, layout: format === "markdown" ? layout : "single" }, target });
      setSummary(r.summary);
      if (r.files.length) setMsg(`Exported ${r.files.length === 1 ? r.files[0] : `${r.files.length} files to ${r.files[0].replace(/[\\/][^\\/]*$/, "")}`}`);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pending = summary?.pending ?? [];
  const label = FORMATS.find((f) => f[0] === format)![1];
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog export" role="dialog" aria-modal="true" aria-labelledby="export-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <strong id="export-title">Export {scope ? `“${scope}”` : "the book"}</strong>
        </div>
        <div className="run-body">
          <div className="field">
            <span className="field-label">Format</span>
            <div className="segmented full" role="radiogroup" aria-label="Format">
              {FORMATS.map(([f, name, e]) => (
                <button key={f} role="radio" aria-checked={format === f} className={format === f ? "on" : ""} onClick={() => pickFormat(f)}>
                  {name} <span className="fmt-ext">{e}</span>
                </button>
              ))}
            </div>
          </div>
          {summary && (
            <p className="muted">
              {[summary.parts && `${summary.parts} parts`, `${summary.chapters} chapter${summary.chapters === 1 ? "" : "s"}`, `${summary.scenes} scene${summary.scenes === 1 ? "" : "s"}`, `${summary.words.toLocaleString()} words`].filter(Boolean).join(" · ")}
              {summary.excluded > 0 && ` · ${summary.excluded} left out (include in export is off)`}. Notes and the trash are never exported.
            </p>
          )}
          {pending.length > 0 && (
            <div className="banner warn">
              <span className="grow">
                {pending.length} scene{pending.length === 1 ? " has" : "s have"} pending AI suggestions. Accept or reject them first:{" "}
                {pending.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <a href="#" onClick={(e) => (e.preventDefault(), close(), set({ selectedId: id, codexId: null }))}>
                      {findNode(nodes, id)?.title ?? "a scene"}
                    </a>
                  </span>
                ))}
              </span>
            </div>
          )}
          {format === "markdown" && (
            <div className="field">
              <span className="field-label">Files</span>
              <div className="segmented full" role="radiogroup" aria-label="Files">
                <button role="radio" aria-checked={layout === "single"} className={layout === "single" ? "on" : ""} onClick={() => setLayout("single")}>
                  One file
                </button>
                <button role="radio" aria-checked={layout === "perChapter"} className={layout === "perChapter" ? "on" : ""} onClick={() => setLayout("perChapter")}>
                  One file per chapter
                </button>
              </div>
            </div>
          )}
          {format === "docx" && (
            <div className="field">
              <span className="field-label">Pages</span>
              <div className="exp-styles" role="radiogroup" aria-label="Pages">
                <button role="radio" aria-checked={style === "manuscript"} className={`imp-mode ${style === "manuscript" ? "on" : ""}`} onClick={() => setStyle("manuscript")}>
                  <strong>Manuscript</strong>
                  <span>Letter size, 12 pt Times, double spaced, a title page and a running header</span>
                </button>
                <button role="radio" aria-checked={style === "book"} className={`imp-mode ${style === "book" ? "on" : ""}`} onClick={() => setStyle("book")}>
                  <strong>Book page</strong>
                  <span>6 × 9 in, Georgia, tighter spacing, page numbers at the foot</span>
                </button>
              </div>
            </div>
          )}
          <div className="field">
            <span className="field-label">Scene break</span>
            <div className="segmented full" role="radiogroup" aria-label="Scene break">
              {BREAKS.map((b) => (
                <button key={b || "blank"} role="radio" aria-checked={sceneBreak === b} className={sceneBreak === b ? "on" : ""} onClick={() => setSceneBreak(b)}>
                  {b || "Blank line"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Switch label="Scene titles as headings" checked={sceneTitles} onChange={setSceneTitles} />
            {format === "markdown" ? (
              <Switch label="Title and author at the top" hint="As YAML front matter, which Pandoc reads when converting to other formats." checked={frontMatter} onChange={setFrontMatter} />
            ) : (
              <Switch label="Title page" hint="The title and author, from your project details." checked={titlePage} onChange={setTitlePage} />
            )}
            {format === "docx" && <Switch label="My comments as Word comments" hint="Your own unresolved comments, attached to their passages. Highlights and footnotes always come across." checked={comments} onChange={setComments} />}
          </div>
          {format === "epub" && (
            <div className="field">
              <span className="field-label">Cover image</span>
              <div className="exp-cover">
                <span className="grow muted">{cover ? cover.split(/[\\/]/).pop() : "None. Pick a JPEG or PNG."}</span>
                {cover && (
                  <button className="icon-btn small" aria-label="Remove the cover" data-tip="Remove" onClick={() => setCover(null)}>
                    <Icon name="close" size={14} />
                  </button>
                )}
                <button className="btn small" onClick={() => void pickCover()}>
                  {cover ? "Change…" : "Choose…"}
                </button>
              </div>
              <span className="muted exp-note">Title, author, language, description and keywords come from Settings › Details and fields. Highlights are left out of an EPUB.</span>
            </div>
          )}
          {msg && <div className="banner ok">{msg}</div>}
        </div>
        <div className="diff-foot">
          <span className="grow" />
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" disabled={busy || !summary || pending.length > 0} onClick={() => void run()}>
            {format === "markdown" && layout === "perChapter" ? "Choose folder…" : `Export ${label}…`}
          </button>
        </div>
      </div>
    </div>
  );
}
