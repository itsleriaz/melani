// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { openMenu } from "./ContextMenu";
import { LABELS } from "./Inspector";
import { nodeMenu } from "./menus";
import { useStore } from "./store";
import { BinderNode, canContain, DropPos, leaves } from "./tree";

/** The children of a chapter or part as index cards. Drag to reorder. */
export function Corkboard({ node }: { node: BinderNode }) {
  const counts = useStore((s) => s.counts);
  const move = useStore((s) => s.move);
  const select = useStore((s) => s.select);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);

  if (node.children.length === 0) return <div className="empty-state">Nothing to show yet. Add scenes in the binder.</div>;
  return (
    <div className="cork" onDragEnd={() => (setDrag(null), setDrop(null))}>
      {node.children.map((c) => (
        <Card
          key={c.id}
          node={c}
          words={leaves(c).reduce((a, l) => a + (counts[l.id] ?? 0), 0)}
          dragging={drag === c.id}
          dropPos={drop?.id === c.id ? drop.pos : null}
          onOpen={() => select(c.id)}
          onDragStart={() => setDrag(c.id)}
          onDragOver={(e) => {
            if (!drag || drag === c.id) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setDrop({ id: c.id, pos: e.clientX - r.left < r.width / 2 ? "before" : "after" });
          }}
          onDrop={() => {
            // Siblings share a parent, so a card never needs a new container.
            const dragged = node.children.find((n) => n.id === drag);
            if (drag && drop && dragged && canContain(node.type, dragged.type)) move(drag, drop.id, drop.pos);
            setDrag(null);
            setDrop(null);
          }}
        />
      ))}
    </div>
  );
}

function Card(p: {
  node: BinderNode;
  words: number;
  dragging: boolean;
  dropPos: DropPos | null;
  onOpen: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}) {
  const patch = useStore((s) => s.patch);
  const { node } = p;
  const [synopsis, setSynopsis] = useState(node.synopsis);
  useEffect(() => setSynopsis(node.synopsis), [node.synopsis]);
  return (
    <div
      className={`card ${p.dragging ? "dragging" : ""} ${p.dropPos ? "drop-" + p.dropPos : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", node.id);
        e.dataTransfer.effectAllowed = "move";
        p.onDragStart();
      }}
      onDragOver={p.onDragOver}
      onDrop={(e) => (e.preventDefault(), p.onDrop())}
      onContextMenu={(e) => openMenu(e, nodeMenu(node))}
      style={node.label && LABELS[node.label] ? { borderTopColor: LABELS[node.label] } : undefined}
    >
      <div className="card-head">
        <strong className="title" onClick={p.onOpen} data-tip="Open">
          {node.title}
        </strong>
        <span className="status">{node.status}</span>
      </div>
      <textarea
        placeholder="Synopsis…"
        value={synopsis}
        onChange={(e) => setSynopsis(e.target.value)}
        onBlur={() => synopsis !== node.synopsis && patch(node.id, { synopsis })}
      />
      <div className="muted">{p.words.toLocaleString()} words</div>
    </div>
  );
}
