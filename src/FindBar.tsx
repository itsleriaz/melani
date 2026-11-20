// SPDX-License-Identifier: GPL-3.0-only
// Ctrl+F: find and replace in the text on screen (one scene, or every scene of a chapter shown as text).
// Replacing goes through the editors, so Cmd+Z undoes it. The project-wide search lives in the left panel.
import { useEffect, useRef, useState } from "react";
import { closeHistory } from "@tiptap/pm/history";
import { allHandles, getActiveEditor, onActiveChange, type EditorHandle } from "./editorRegistry";
import { Icon } from "./icons";
import { MOD } from "./platform";
import { docMatches, findAll, FIND_META, replaceMatches } from "./search";
import { useStore } from "./store";

/** The editors on screen, top to bottom. */
function sortedHandles(): EditorHandle[] {
  return allHandles()
    .filter((h) => !h.editor.isDestroyed)
    .sort((a, b) => (a.editor.view.dom.compareDocumentPosition(b.editor.view.dom) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function FindBar() {
  const focusSeq = useStore((s) => s.findFocus);
  const set = useStore((s) => s.set);
  const input = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  /** What the last replace did, shown where the match count is. */
  const [note, setNote] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWhole] = useState(false);
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(0);
  const [editors, setEditors] = useState(0);
  const [tick, setTick] = useState(0);
  const scroll = useRef(false);
  // Pinned to the bottom right corner of the editor pane, wherever the sidebars are.
  const [corner, setCorner] = useState<{ right: number; bottom: number }>({ right: 28, bottom: 20 });
  useEffect(() => {
    const pane = document.querySelector(".editor-scroll");
    if (!pane) return;
    const place = () => {
      const r = pane.getBoundingClientRect();
      setCorner({ right: window.innerWidth - r.right + 28, bottom: window.innerHeight - r.bottom + 16 });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(pane);
    window.addEventListener("resize", place);
    return () => (ro.disconnect(), window.removeEventListener("resize", place));
  }, []);

  // Opening (or pressing Ctrl+F again) focuses the field, seeded with the selected text.
  useEffect(() => {
    // "Replace in this text" from the command palette opens the replace row and starts there.
    const wantsReplace = useStore.getState().findReplace;
    if (wantsReplace) {
      useStore.setState({ findReplace: false });
      setReplaceOpen(true);
    }
    if (document.activeElement !== input.current) {
      const ed = getActiveEditor();
      const sel = ed && !ed.state.selection.empty ? ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to, " ") : "";
      if (sel && sel.length < 120) {
        setQ(sel);
        setPos(0);
        scroll.current = true;
      }
    }
    // The replace field is not there until the next render.
    window.setTimeout(() => {
      const el = wantsReplace ? replaceInput.current : input.current;
      el?.focus();
      el?.select();
    }, 0);
  }, [focusSeq]);

  // Re-run when editors mount or unmount (switching scene) and when the text changes.
  useEffect(() => {
    const off = onActiveChange(() => setTick((t) => t + 1));
    const hs = allHandles();
    const bump = () => setTick((t) => t + 1);
    hs.forEach((h) => h.editor.on("update", bump));
    return () => {
      off();
      hs.forEach((h) => !h.editor.isDestroyed && h.editor.off("update", bump));
    };
  }, [tick]);

  useEffect(() => {
    const hs = sortedHandles();
    const opts = { caseSensitive, wholeWord };
    const per = hs.map((h) => (q ? docMatches(h.editor.state.doc, q, opts).length : 0));
    const n = per.reduce((a, b) => a + b, 0);
    const idx = n ? Math.min(pos, n - 1) : -1;
    let acc = 0;
    hs.forEach((h, i) => {
      const local = idx >= acc && idx < acc + per[i] ? idx - acc : -1;
      const state = q ? { query: q, opts, current: local } : null;
      h.editor.view.dispatch(h.editor.state.tr.setMeta(FIND_META, state).setMeta("addToHistory", false));
      acc += per[i];
    });
    setTotal(n);
    setEditors(hs.length);
    if (scroll.current && idx >= 0) {
      scroll.current = false;
      requestAnimationFrame(() => document.querySelector(".editor-scroll .search-hit.current")?.scrollIntoView({ block: "center" }));
    }
  }, [q, caseSensitive, wholeWord, pos, tick]);

  // Closing clears the highlights.
  useEffect(
    () => () => {
      for (const h of allHandles()) if (!h.editor.isDestroyed) h.editor.view.dispatch(h.editor.state.tr.setMeta(FIND_META, null).setMeta("addToHistory", false));
    },
    [],
  );

  const step = (d: number) => {
    if (!total) return;
    scroll.current = true;
    setPos((((Math.min(pos, total - 1) + d) % total) + total) % total);
  };
  const close = () => {
    set({ findOpen: false });
    getActiveEditor()?.commands.focus();
  };
  const retype = (v: string) => {
    setQ(v);
    setPos(0);
    setNote(null);
    scroll.current = true;
  };
  const idx = total ? Math.min(pos, total - 1) : -1;
  const opts = { caseSensitive, wholeWord };

  /** Replace the highlighted match. The next one slides into its place, so it becomes the current one. */
  const replaceCurrent = () => {
    if (!q || idx < 0) return;
    let before = 0;
    for (const h of sortedHandles()) {
      const n = docMatches(h.editor.state.doc, q, opts).length;
      if (idx >= before + n) {
        before += n;
        continue;
      }
      if (!h.editor.isEditable) return setNote("Wait for the AI to finish writing here.");
      const r = replaceMatches(h.editor.state, q, opts, replacement, idx - before);
      if (!r) return;
      if (!r.count) return (setNote("That match is inside an AI suggestion. Accept or reject it first."), step(1));
      h.editor.view.dispatch(closeHistory(r.tr));
      // A replacement that contains the query would be found again: move past it.
      setPos(idx + findAll(replacement, q, opts).length);
      scroll.current = true;
      return setNote(null);
    }
  };

  /** Replace every match on screen: one undo step in each scene. */
  const replaceAll = () => {
    if (!q || !total) return;
    let count = 0;
    let skipped = 0;
    let locked = 0;
    for (const h of sortedHandles()) {
      if (!h.editor.isEditable) {
        if (docMatches(h.editor.state.doc, q, opts).length) locked++;
        continue;
      }
      const r = replaceMatches(h.editor.state, q, opts, replacement);
      if (!r) continue;
      count += r.count;
      skipped += r.skipped;
      if (r.count) h.editor.view.dispatch(closeHistory(r.tr));
    }
    const extra = [skipped ? `${plural(skipped, "match")} inside AI suggestions left alone` : "", locked ? `${plural(locked, "scene")} locked while the AI writes` : ""].filter(Boolean);
    setNote(`Replaced ${count}${extra.length ? `. ${extra.join("; ")}` : ""}`);
    setPos(0);
  };
  return (
    <div className="find-bar" role="search" aria-label={replaceOpen ? "Find and replace in this text" : "Find in this text"} style={corner}>
      <div className="find-row">
        <button className="icon-btn small find-expand" aria-label={replaceOpen ? "Hide replace" : "Show replace"} aria-expanded={replaceOpen} data-tip={replaceOpen ? "Hide replace" : "Replace"} onClick={() => setReplaceOpen(!replaceOpen)}>
          <Icon name={replaceOpen ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <div className="search-field">
          <Icon name="search" size={15} />
          <input
            ref={input}
            value={q}
            placeholder="Find in this text"
            aria-label="Find in this text"
            onChange={(e) => retype(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), step(e.shiftKey ? -1 : 1));
              else if (e.key === "Escape") (e.preventDefault(), close());
            }}
          />
          <span className="find-count muted" aria-live="polite">
            {!q ? "" : editors === 0 ? "No text here" : total ? `${idx + 1} of ${total}` : "No results"}
          </span>
        </div>
        <button className={`toggle-btn ${caseSensitive ? "on" : ""}`} aria-pressed={caseSensitive} data-tip="Match case" onClick={() => (setCase(!caseSensitive), setPos(0))}>
          Aa
        </button>
        <button className={`toggle-btn word ${wholeWord ? "on" : ""}`} aria-pressed={wholeWord} data-tip="Whole words only" onClick={() => (setWhole(!wholeWord), setPos(0))}>
          ab
        </button>
        <button className="icon-btn small" aria-label="Previous match" data-tip="Previous (Shift+Enter)" disabled={!total} onClick={() => step(-1)}>
          <Icon name="chevronUp" size={14} />
        </button>
        <button className="icon-btn small" aria-label="Next match" data-tip="Next (Enter)" disabled={!total} onClick={() => step(1)}>
          <Icon name="chevronDown" size={14} />
        </button>
        <button className="icon-btn small" aria-label="Close find" data-tip="Close (Esc)" onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {replaceOpen && (
        <div className="find-row">
          <span className="find-expand" aria-hidden="true" />
          <div className="search-field">
            <Icon name="pen" size={15} />
            <input
              ref={replaceInput}
              value={replacement}
              placeholder="Replace with"
              aria-label="Replace with"
              onChange={(e) => (setReplacement(e.target.value), setNote(null))}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.preventDefault(), e.metaKey || e.ctrlKey || e.altKey ? replaceAll() : replaceCurrent());
                else if (e.key === "Escape") (e.preventDefault(), close());
              }}
            />
          </div>
          <button className="find-act" data-tip="Replace this match (Enter)" disabled={!total} onClick={replaceCurrent}>
            Replace
          </button>
          <button className="find-act" data-tip="Replace every match on screen" data-tip-kbd={`${MOD}↵`} disabled={!total} onClick={replaceAll}>
            All
          </button>
        </div>
      )}
      {note && (
        <div className="find-note muted" role="status">
          {note}
        </div>
      )}
    </div>
  );
}
