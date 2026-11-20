// SPDX-License-Identifier: GPL-3.0-only
// Comments on the selected scene (or every scene in the selected chapter): your own, and the AI's line feedback.
import { useEffect, useRef, useState } from "react";
import type { SceneComment } from "./ai";
import { useAi } from "./aiStore";
import { addCommentFromSelection, isAuthor, removeComment, updateComment } from "./authorComments";
import { jumpToPassage } from "./Comments";
import { getHandle } from "./editorRegistry";
import { Icon } from "./icons";
import { MOD } from "./platform";
import { useStore } from "./store";
import { findNode, leaves } from "./tree";

/** A box that grows with what is typed in it. */
function Note({ value, autoFocus, onSave }: { value: string; autoFocus: boolean; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return <textarea ref={ref} className="input note-box" rows={2} placeholder="Write a note to yourself" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} />;
}

export function CommentsPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const nodes = useStore((s) => s.nodes);
  const comments = useAi((s) => s.comments);
  const focus = useAi((s) => s.focusComment);
  const [showDone, setShowDone] = useState(false);
  const node = selectedId ? findNode(nodes, selectedId) : null;
  const scenes = node && node.type !== "trash" ? leaves(node) : [];
  const items = scenes.flatMap((s) => (comments[s.id] ?? []).map((c) => ({ sid: s.id, scene: s.title, c })));
  const open = items.filter((i) => !i.c.resolved);
  const done = items.filter((i) => i.c.resolved);

  const jump = (sid: string, c: SceneComment) => {
    const h = getHandle(sid);
    if (h && !jumpToPassage(h.editor, c.passage, c.at)) useStore.getState().set({ error: "That passage was edited, so it can't be found any more." });
  };
  const card = ({ sid, scene, c }: (typeof items)[number]) => (
    <li
      key={c.id}
      className={`${focus === c.id ? "focus" : ""} ${c.resolved ? "resolved" : ""}`}
      ref={(el) => {
        if (focus === c.id) el?.scrollIntoView({ block: "nearest" });
      }}
    >
      {scenes.length > 1 && <span className="comment-scene">{scene}</span>}
      <blockquote onClick={() => jump(sid, c)}>{c.passage || "(no quote)"}</blockquote>
      {isAuthor(c) ? <Note value={c.comment} autoFocus={focus === c.id && !c.comment} onSave={(v) => updateComment(sid, c.id, { comment: v })} /> : <div>{c.comment}</div>}
      <div className="comment-actions">
        {!isAuthor(c) && <span className="badge auto">AI</span>}
        <span className="grow" />
        <button className="icon-btn small" aria-label={c.resolved ? "Reopen" : "Resolve"} data-tip={c.resolved ? "Reopen" : "Resolve: stop marking it in the text"} onClick={() => updateComment(sid, c.id, { resolved: !c.resolved })}>
          <Icon name={c.resolved ? "restore" : "check"} size={14} />
        </button>
        <button className="icon-btn small" aria-label="Delete comment" data-tip="Delete" onClick={() => removeComment(sid, c.id)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </li>
  );

  if (!node || scenes.length === 0) return <div className="empty-state small">Select a scene to see its comments.</div>;
  return (
    <div className="comments">
      <div className="ref-bar">
        <button className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={() => addCommentFromSelection()} data-tip="Select some text first" data-tip-kbd={`${MOD}⌥M`}>
          <Icon name="commentAdd" size={14} />
          Comment on selection
        </button>
      </div>
      {items.length === 0 && <div className="empty-state small">No comments yet. Select words in the text and choose Comment to leave a note for yourself. Comments never change your text.</div>}
      <ul>{open.map(card)}</ul>
      {done.length > 0 && (
        <>
          <button className="linklike done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            <Icon name="chevronRight" size={12} className={`twisty ${showDone ? "open" : ""}`} />
            Resolved ({done.length})
          </button>
          {showDone && <ul>{done.map(card)}</ul>}
        </>
      )}
    </div>
  );
}
