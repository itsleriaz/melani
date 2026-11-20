// SPDX-License-Identifier: GPL-3.0-only
// The formatting toolbar above the manuscript, and the floating menu over a selection.
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { ENTRY_TYPES } from "./codexTypes";
import { getActiveEditor, onActiveChange } from "./editorRegistry";
import { openTool } from "./aiTools";
import { useAi } from "./aiStore";
import { useStore } from "./store";
import { createEntryFromSelection, selectedText } from "./selection";
import { addCommentFromSelection } from "./authorComments";
import { HIGHLIGHTS } from "./Highlight";
import { Icon, IconName } from "./icons";
import { MOD, SHIFT } from "./platform";

const ALT = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌥" : "Alt+";

interface Fmt {
  key: string;
  icon: IconName;
  label: string;
  keys?: string;
  run: (ed: Editor) => void;
  active?: (ed: Editor) => boolean;
}

const GROUPS: Fmt[][] = [
  [
    { key: "bold", icon: "bold", label: "Bold", keys: `${MOD}B`, run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive("bold") },
    { key: "italic", icon: "italic", label: "Italic", keys: `${MOD}I`, run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive("italic") },
    { key: "strike", icon: "strike", label: "Strikethrough", keys: `${MOD}${SHIFT}S`, run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive("strike") },
  ],
  [
    { key: "h1", icon: "h1", label: "Heading 1", keys: `${MOD}${ALT}1`, run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), active: (e) => e.isActive("heading", { level: 1 }) },
    { key: "h2", icon: "h2", label: "Heading 2", keys: `${MOD}${ALT}2`, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive("heading", { level: 2 }) },
    { key: "quote", icon: "quote", label: "Block quote", keys: `${MOD}${SHIFT}B`, run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive("blockquote") },
    { key: "ul", icon: "listBullet", label: "Bulleted list", keys: `${MOD}${SHIFT}8`, run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive("bulletList") },
    { key: "ol", icon: "listOrdered", label: "Numbered list", keys: `${MOD}${SHIFT}7`, run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive("orderedList") },
    { key: "hr", icon: "rule", label: "Scene break", run: (e) => e.chain().focus().setHorizontalRule().run() },
  ],
];

/** The editor that has focus (or the only one open), kept current as focus moves between scenes. */
function useActiveEditor(): Editor | null {
  const [ed, setEd] = useState<Editor | null>(() => getActiveEditor());
  useEffect(() => {
    const sync = () => setEd(getActiveEditor());
    sync();
    return onActiveChange(sync);
  }, []);
  return ed && !ed.isDestroyed ? ed : null;
}

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/** The highlight button: opens a row of colours, and takes the highlight off again. */
function HighlightButton({ ed, on, color, size = 16 }: { ed: Editor | null; on: boolean; color?: string; size?: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return (
    <span className="hl-wrap" ref={root}>
      <button className={`fmt-btn ${on ? "on" : ""}`} aria-label="Highlight" aria-expanded={open} data-tip="Highlight" data-tip-kbd={`${MOD}${SHIFT}H`} disabled={!ed} onMouseDown={keepFocus} onClick={() => setOpen(!open)}>
        <Icon name="highlight" size={size} />
      </button>
      {open && ed && (
        <div className="hl-pop" role="menu" aria-label="Highlight colour" onMouseDown={keepFocus}>
          {HIGHLIGHTS.map((c) => (
            <button key={c} role="menuitem" className={`hl-swatch hl-${c} ${on && color === c ? "on" : ""}`} aria-label={c} data-tip={c[0].toUpperCase() + c.slice(1)} onClick={() => (ed.chain().focus().setHighlight(c).run(), setOpen(false))} />
          ))}
          <button role="menuitem" className="hl-swatch none" aria-label="Remove highlight" data-tip="Remove highlight" disabled={!on} onClick={() => (ed.chain().focus().unsetHighlight().run(), setOpen(false))}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
    </span>
  );
}

/** Undo and redo for the area you last used: the binder's edits, or the active scene's text. */
export function HistoryButtons() {
  const ed = useActiveEditor();
  const state = useEditorState({ editor: ed, selector: ({ editor }) => ({ undo: !!editor?.can().undo(), redo: !!editor?.can().redo() }) });
  const binder = useStore((s) => s.historyScope === "binder");
  const nextUndo = useStore((s) => s.binderUndo[s.binderUndo.length - 1]);
  const nextRedo = useStore((s) => s.binderRedo[s.binderRedo.length - 1]);
  const canUndo = binder ? !!nextUndo : !!ed && !!state?.undo;
  const canRedo = binder ? !!nextRedo : !!ed && !!state?.redo;
  const tip = (verb: string, e?: { label: string }) => (binder ? (e ? `${verb} ${e.label.toLowerCase()} (binder)` : `${verb} (binder)`) : `${verb} (text)`);
  return (
    <div className="icon-group" role="group" aria-label="Undo and redo">
      <button className="icon-btn" aria-label="Undo" data-tip={tip("Undo", nextUndo)} data-tip-kbd={`${MOD}Z`} disabled={!canUndo} onMouseDown={keepFocus} onClick={() => (binder ? useStore.getState().undoBinder() : ed?.chain().focus().undo().run())}>
        <Icon name="undo" size={18} />
      </button>
      <button className="icon-btn" aria-label="Redo" data-tip={tip("Redo", nextRedo)} data-tip-kbd={`${MOD}${SHIFT}Z`} disabled={!canRedo} onMouseDown={keepFocus} onClick={() => (binder ? useStore.getState().redoBinder() : ed?.chain().focus().redo().run())}>
        <Icon name="redo" size={18} />
      </button>
    </div>
  );
}

export function FormatBar() {
  const ed = useActiveEditor();
  const state = useEditorState({
    editor: ed,
    selector: ({ editor }) => {
      const on: Record<string, boolean> = {};
      if (editor) for (const g of GROUPS) for (const f of g) on[f.key] = f.active?.(editor) ?? false;
      return { on, hl: !!editor?.isActive("highlight"), hlColor: editor?.getAttributes("highlight").color as string | undefined, undo: !!editor?.can().undo(), redo: !!editor?.can().redo() };
    },
  });
  const has = !!ed;
  return (
    <div className="formatbar-wrap">
      <div className="formatbar" role="toolbar" aria-label="Formatting">
        {GROUPS.map((g, gi) => (
          <div key={gi} className="fmt-group">
            {g.map((f) => (
              <button
                key={f.key}
                className={`fmt-btn ${state?.on[f.key] ? "on" : ""}`}
                aria-label={f.label}
                aria-pressed={f.active ? !!state?.on[f.key] : undefined}
                data-tip={f.label}
                data-tip-kbd={f.keys}
                disabled={!has}
                onMouseDown={keepFocus}
                onClick={() => ed && f.run(ed)}
              >
                <Icon name={f.icon} size={16} />
              </button>
            ))}
            {gi === 0 && <HighlightButton ed={ed} on={!!state?.hl} color={state?.hlColor} />}
          </div>
        ))}
        <div className="fmt-group">
          <button className="fmt-btn" aria-label="Footnote" data-tip="Footnote" data-tip-kbd={`${MOD}${ALT}F`} disabled={!has} onMouseDown={keepFocus} onClick={() => ed?.commands.insertFootnote()}>
            <Icon name="footnote" size={16} />
          </button>
          <button className="fmt-btn" aria-label="Comment on selection" data-tip="Comment on the selection" data-tip-kbd={`${MOD}${ALT}M`} disabled={!has} onMouseDown={keepFocus} onClick={() => addCommentFromSelection()}>
            <Icon name="commentAdd" size={16} />
          </button>
        </div>
        <div className="fmt-group">
          <button className="fmt-btn" aria-label="Undo" data-tip="Undo" data-tip-kbd={`${MOD}Z`} disabled={!has || !state?.undo} onMouseDown={keepFocus} onClick={() => ed?.chain().focus().undo().run()}>
            <Icon name="undo" size={16} />
          </button>
          <button className="fmt-btn" aria-label="Redo" data-tip="Redo" data-tip-kbd={`${MOD}${SHIFT}Z`} disabled={!has || !state?.redo} onMouseDown={keepFocus} onClick={() => ed?.chain().focus().redo().run()}>
            <Icon name="redo" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

interface Anchor {
  x: number;
  top: number;
  bottom: number;
  bold: boolean;
  italic: boolean;
  highlight: boolean;
  hlColor?: string;
}

/** A small bar that floats over the selected text: formatting, codex, find, and AI tools. */
export function SelectionMenu() {
  const hasKey = useAi((s) => s.hasKey) === true;
  const running = useAi((s) => !!s.running || !!s.run);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [step, setStep] = useState<"main" | "codex">("main");
  const dragging = useRef(false);
  const frame = useRef(0);
  const lastText = useRef("");
  /** Escape hides the menu for this selection; a different selection brings it back. */
  const dismissed = useRef<string | null>(null);
  /** The menu is on screen right now (Escape elsewhere, such as in a dialog, must not dismiss it). */
  const showing = useRef(false);

  const update = useCallback(() => {
    window.cancelAnimationFrame(frame.current);
    frame.current = window.requestAnimationFrame(() => {
      const ed = getActiveEditor();
      const sel = window.getSelection();
      if (!ed || ed.isDestroyed || !ed.isFocused || ed.state.selection.empty || dragging.current || !sel || sel.rangeCount === 0 || !ed.view.dom.contains(sel.anchorNode)) {
        setAnchor(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return setAnchor(null);
      const text = selectedText();
      if (text !== dismissed.current) dismissed.current = null;
      else return setAnchor(null);
      if (text !== lastText.current) setStep("main");
      lastText.current = text;
      setAnchor({ x: Math.max(215, Math.min(window.innerWidth - 215, r.left + r.width / 2)), top: r.top, bottom: r.bottom, bold: ed.isActive("bold"), italic: ed.isActive("italic"), highlight: ed.isActive("highlight"), hlColor: ed.getAttributes("highlight").color });
    });
  }, []);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(".sel-menu")) return;
      dragging.current = !!(e.target instanceof Element && e.target.closest(".prose"));
      if (dragging.current) setAnchor(null);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      window.setTimeout(update, 0);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !showing.current) return;
      dismissed.current = selectedText() || null;
      setAnchor(null);
    };
    document.addEventListener("keydown", esc);
    document.addEventListener("selectionchange", update);
    document.addEventListener("mousedown", down, true);
    document.addEventListener("mouseup", up, true);
    document.addEventListener("keyup", update, true);
    document.addEventListener("focusin", update, true);
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    window.addEventListener("blur", update);
    return () => {
      window.cancelAnimationFrame(frame.current);
      document.removeEventListener("keydown", esc);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("mouseup", up, true);
      document.removeEventListener("keyup", update, true);
      document.removeEventListener("focusin", update, true);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      window.removeEventListener("blur", update);
    };
  }, [update]);

  showing.current = !!anchor && !running;
  if (!anchor || running) return null;
  const below = anchor.top < 90;
  const ed = getActiveEditor();
  const text = lastText.current;
  const done = () => setAnchor(null);
  return (
    <div
      className={`sel-menu ${below ? "below" : ""}`}
      role="toolbar"
      aria-label="Selection"
      style={{ left: anchor.x, top: below ? anchor.bottom + 10 : anchor.top - 10 }}
      onMouseDown={keepFocus}
    >
      {step === "main" ? (
        <>
          <button className={`fmt-btn ${anchor.bold ? "on" : ""}`} aria-label="Bold" data-tip="Bold" data-tip-kbd={`${MOD}B`} onClick={() => ed?.chain().focus().toggleBold().run()}>
            <Icon name="bold" size={15} />
          </button>
          <button className={`fmt-btn ${anchor.italic ? "on" : ""}`} aria-label="Italic" data-tip="Italic" data-tip-kbd={`${MOD}I`} onClick={() => ed?.chain().focus().toggleItalic().run()}>
            <Icon name="italic" size={15} />
          </button>
          <HighlightButton ed={ed} on={anchor.highlight} color={anchor.hlColor} size={15} />
          <button className="fmt-btn" aria-label="Comment on selection" data-tip="Leave yourself a comment" data-tip-kbd={`${MOD}${ALT}M`} onClick={() => (done(), addCommentFromSelection())}>
            <Icon name="commentAdd" size={15} />
          </button>
          <span className="sel-sep" aria-hidden="true" />
          <button className="sel-btn" data-tip="Make a codex entry from this text" data-tip-kbd={`${MOD}${SHIFT}E`} onClick={() => setStep("codex")}>
            <Icon name="codexAdd" size={15} />
            Codex
          </button>
          <button className="fmt-btn" aria-label="Find in project" data-tip="Find this text in the project" onClick={() => (done(), useStore.getState().openSearch(text))}>
            <Icon name="search" size={15} />
          </button>
          {hasKey && (
            <>
              <span className="sel-sep" aria-hidden="true" />
              <button className="sel-btn ai" data-tip="Rewrite the selection with AI" onClick={() => (done(), openTool("rewrite"))}>
                <Icon name="sparkle" size={15} />
                Rewrite
              </button>
              <button className="fmt-btn ai" aria-label="Line feedback" data-tip="Line feedback on the selection" onClick={() => (done(), openTool("feedback"))}>
                <Icon name="comment" size={15} />
              </button>
              <button className="fmt-btn ai" aria-label="Consistency check" data-tip="Check the selection against the codex" onClick={() => (done(), openTool("consistency"))}>
                <Icon name="findings" size={15} />
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <button className="fmt-btn" aria-label="Back" data-tip="Back" onClick={() => setStep("main")}>
            <Icon name="chevronRight" size={15} className="flip" />
          </button>
          <span className="sel-label">New entry as</span>
          {ENTRY_TYPES.map((t) => (
            <button key={t} className="sel-chip" onClick={() => (done(), void createEntryFromSelection(t))}>
              {t}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
