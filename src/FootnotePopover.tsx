// SPDX-License-Identifier: GPL-3.0-only
// The box that opens beside a footnote mark so you can write or change its note.
import { useEffect, useRef, useState } from "react";
import { cleanNote, useFootnoteUi } from "./Footnote";
import { Icon } from "./icons";

export function FootnotePopover() {
  const open = useFootnoteUi((s) => s.open);
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  const nodeAt = () => (open ? open.editor.state.doc.nodeAt(open.pos) : null);
  const close = (keep = true) => {
    if (open && !keep) open.editor.chain().deleteRange({ from: open.pos, to: open.pos + 1 }).focus().run();
    else open?.editor.commands.focus();
    useFootnoteUi.setState({ open: null });
  };
  /** Closing an empty footnote throws it away, so none are left blank in the book. */
  const finish = () => close(cleanNote(note).trim() !== "");

  useEffect(() => {
    if (!open) return;
    const n = open.editor.state.doc.nodeAt(open.pos);
    setNote(n?.type.name === "footnote" ? (n.attrs.note as string) : "");
    requestAnimationFrame(() => area.current?.focus());
  }, [open]);

  // Sit just under the mark, kept on screen.
  useEffect(() => {
    if (!open || !box.current) return setAt(null);
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const below = open.rect.bottom + 8 + h < window.innerHeight - 8;
    setAt({ left: Math.max(8, Math.min(window.innerWidth - w - 8, open.rect.left + open.rect.width / 2 - w / 2)), top: below ? open.rect.bottom + 8 : open.rect.top - 8 - h });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && finish();
    window.addEventListener("mousedown", away, true);
    return () => window.removeEventListener("mousedown", away, true);
  });

  if (!open) return null;
  const save = (v: string) => {
    setNote(v);
    const n = nodeAt();
    if (n?.type.name !== "footnote") return;
    open.editor.view.dispatch(open.editor.state.tr.setNodeMarkup(open.pos, undefined, { note: cleanNote(v) }));
  };
  return (
    <div ref={box} className={`footnote-pop ${at ? "ready" : ""}`} role="dialog" aria-label="Footnote" style={{ left: at?.left ?? 0, top: at?.top ?? 0 }}>
      <label htmlFor="fn-note" className="field-label">Footnote</label>
      <textarea
        id="fn-note"
        ref={area}
        className="input serif"
        rows={3}
        placeholder="The note that goes at the foot of the page"
        value={note}
        onChange={(e) => save(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) (e.preventDefault(), e.stopPropagation(), finish());
        }}
      />
      <div className="footnote-actions">
        <span className="muted">Shown as a numbered mark in the text</span>
        <span className="grow" />
        <button className="icon-btn small" aria-label="Delete footnote" data-tip="Delete footnote" onClick={() => close(false)}>
          <Icon name="trash" size={14} />
        </button>
        <button className="btn small primary" onClick={finish}>
          Done
        </button>
      </div>
    </div>
  );
}
