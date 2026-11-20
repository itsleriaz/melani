// SPDX-License-Identifier: GPL-3.0-only
import { createContext, useContext, useEffect, useState } from "react";
import { openMenu } from "./ContextMenu";
import { Icon, IconName } from "./icons";
import { MOD, SHIFT } from "./platform";
import { multiMenu, nodeMenu } from "./menus";
import { LABELS } from "./Inspector";
import { useStore } from "./store";
import { BinderNode, canContain, DropPos, findNode, findParent, isDescendant, leaves, NodeType, topLevelIds } from "./tree";

const ICON: Record<string, IconName> = { part: "part", chapter: "folder", scene: "sceneSolid", note: "note", trash: "trash" };

/** Collapsed containers, remembered per browser profile. */
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("binderCollapsed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
interface BinderCtx {
  collapsed: Set<string>;
  toggle: (id: string) => void;
  /** Items picked together; empty when there is just the one selection. */
  multi: Set<string>;
  /** Click with Cmd/Ctrl (add or remove one) or Shift (a range). */
  pick: (id: string, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  /** The ids being dragged: the picked items when the drag starts on one of them. */
  dragIds: string[];
  setDragIds: (ids: string[]) => void;
}
const Collapse = createContext<BinderCtx>({ collapsed: new Set(), toggle: () => {}, multi: new Set(), pick: () => {}, dragIds: [], setDragIds: () => {} });

interface Drop {
  id: string;
  pos: DropPos;
}

export function Binder() {
  const nodes = useStore((s) => s.nodes);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const move = useStore((s) => s.move);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const save = (next: Set<string>) => {
    setCollapsed(next);
    try {
      localStorage.setItem("binderCollapsed", JSON.stringify([...next]));
    } catch {
      /* storage unavailable */
    }
  };
  // Every item that holds others: all folded away means the toggle offers to open them.
  const containers: string[] = [];
  const gather = (list: BinderNode[]) => list.forEach((n) => (n.children.length > 0 && containers.push(n.id), gather(n.children)));
  gather(nodes);
  const allCollapsed = containers.length > 0 && containers.every((id) => collapsed.has(id));
  const toggleAll = () => save(allCollapsed ? new Set() : new Set(containers));
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    save(next);
  };

  const multi = useStore((s) => s.multi);
  const moveMany = useStore((s) => s.moveMany);
  const [dragIds, setDragIds] = useState<string[]>([]);
  // The rows you can see, in order, so Shift-click can pick a range.
  const visible: string[] = [];
  const walk = (list: BinderNode[]) =>
    list.forEach((n) => {
      visible.push(n.id);
      if (!collapsed.has(n.id)) walk(n.children);
    });
  walk(nodes);
  const pick: BinderCtx["pick"] = (id, e) => {
    const st = useStore.getState();
    const node = findNode(st.nodes, id);
    if (!node || node.type === "trash") return;
    if (e.shiftKey && st.selectedId) {
      const a = visible.indexOf(st.selectedId);
      const b = visible.indexOf(id);
      if (a >= 0 && b >= 0) {
        const range = visible.slice(Math.min(a, b), Math.max(a, b) + 1).filter((x) => findNode(st.nodes, x)?.type !== "trash");
        st.set({ multi: range.length > 1 ? range : [] });
        return;
      }
    }
    const current = st.multi.length ? st.multi : st.selectedId ? [st.selectedId] : [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    if (next.length > 1) st.set({ multi: next, selectedId: next.includes(id) ? id : next[next.length - 1] });
    else st.set({ multi: [], selectedId: next[0] ?? st.selectedId });
  };

  // Escape lets go of a multiple selection; Delete moves it to the trash (not while typing).
  useEffect(() => {
    if (multi.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest("input, textarea, select, [contenteditable]") !== null);
      if (e.key === "Escape" && !e.defaultPrevented) useStore.getState().set({ multi: [] });
      else if ((e.key === "Delete" || e.key === "Backspace") && !typing) (e.preventDefault(), useStore.getState().trashMany(multi));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [multi]);

  const onDrop = () => {
    if (drag && drop) {
      if (dragIds.length > 1) moveMany(dragIds, drop.id, drop.pos);
      else move(drag, drop.id, drop.pos);
    }
    setDrag(null);
    setDrop(null);
    setDragIds([]);
  };

  return (
    <Collapse.Provider value={{ collapsed, toggle, multi: new Set(multi), pick, dragIds, setDragIds }}>
      <div className="panel-head">
        <span className="section-label grow">Binder</span>
        <button className="icon-btn small" aria-label={allCollapsed ? "Expand all" : "Collapse all"} data-tip={allCollapsed ? "Expand all" : "Collapse all"} disabled={containers.length === 0} onClick={toggleAll}>
          <Icon name={allCollapsed ? "expandAll" : "collapseAll"} size={15} />
        </button>
        <AddButtons parentId={null} parentType={null} always />
        <button className="icon-btn small" aria-label="Import writing" data-tip="Import writing" data-tip-kbd={`${MOD}${SHIFT}I`} onClick={() => useStore.getState().set({ importOpen: true })}>
          <Icon name="import" size={15} />
        </button>
      </div>
      <nav className="binder" role="tree" aria-label="Binder" onDragEnd={() => (setDrag(null), setDrop(null), setDragIds([]))} onDrop={onDrop}>
        <Level nodes={nodes} depth={0} drag={drag} drop={drop} setDrag={setDrag} setDrop={setDrop} inTrash={false} />
      </nav>
    </Collapse.Provider>
  );
}

/** Offers only what the parent can hold: book > part > chapter > scene. */
function AddButtons({ parentId, parentType, always = false }: { parentId: string | null; parentType: NodeType | null; always?: boolean }) {
  const add = useStore((s) => s.addNode);
  const btn = (type: NodeType, title: string) =>
    canContain(parentType, type) && (
      <button className="icon-btn small add" data-tip={title} aria-label={title} onClick={(e) => (e.stopPropagation(), void add(type, parentId))}>
        <Icon name={ICON[type]} size={14} />
        <Icon name="plus" size={10} className="plus-badge" />
      </button>
    );
  return (
    <span className={`actions ${always ? "always" : ""}`}>
      {btn("part", "New part")}
      {btn("chapter", "New chapter")}
      {btn("scene", "New scene")}
    </span>
  );
}

interface LevelProps {
  nodes: BinderNode[];
  depth: number;
  drag: string | null;
  drop: Drop | null;
  setDrag: (id: string | null) => void;
  setDrop: (d: Drop | null) => void;
  inTrash: boolean;
}

function Level(props: LevelProps) {
  return (
    <ul role="group">
      {props.nodes.map((n) => (
        <Row key={n.id} node={n} {...props} />
      ))}
    </ul>
  );
}

/** Asks before permanently deleting trashed items, saying how much is going. */
function confirmDelete(nodes: BinderNode[], remove: (ids: string[]) => Promise<void>) {
  const { counts } = useStore.getState();
  const items = nodes.flatMap((n) => (n.type === "scene" || n.type === "note" ? [n] : leaves(n)));
  const words = items.reduce((a, n) => a + (counts[n.id] ?? 0), 0);
  const what = nodes.length === 1 && items.length <= 1 ? `“${nodes[0].title}”` : `${items.length} scene${items.length === 1 ? "" : "s"} and notes`;
  if (window.confirm(`Permanently delete ${what}${words ? ` (${words.toLocaleString()} words)` : ""}? This cannot be undone. Snapshots keep their own copies.`)) void remove(nodes.map((n) => n.id));
}

function Row({ node, depth, drag, drop, setDrag, setDrop, inTrash }: LevelProps & { node: BinderNode }) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const rename = useStore((s) => s.rename);
  const trash = useStore((s) => s.trash);
  const restore = useStore((s) => s.restore);
  const deleteForever = useStore((s) => s.deleteForever);
  const counts = useStore((s) => s.counts);
  const all = useStore((s) => s.nodes);
  const [editingLocal, setEditingLocal] = useState(false);
  const renaming = useStore((s) => s.renamingId === node.id);
  const editing = editingLocal || renaming;
  const setEditing = (v: boolean) => {
    setEditingLocal(v);
    if (!v && useStore.getState().renamingId) useStore.getState().set({ renamingId: null });
  };
  const { collapsed, toggle, multi, pick, dragIds, setDragIds } = useContext(Collapse);
  const isCollapsed = collapsed.has(node.id);
  const container = node.type === "chapter" || node.type === "part" || node.type === "trash";
  const words = node.type === "scene" || node.type === "note" ? counts[node.id] : undefined;
  const isDropTarget = drop?.id === node.id;

  const onDragOver = (e: React.DragEvent) => {
    if (!drag) return;
    const draggedIds = dragIds.length > 1 ? topLevelIds(all, dragIds) : [drag];
    const dragged = draggedIds.map((id) => findNode(all, id)).filter((n): n is BinderNode => !!n);
    if (dragged.length === 0 || draggedIds.includes(node.id) || dragged.some((d) => isDescendant(d, node.id))) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    let pos: DropPos = y < 0.25 ? "before" : y > 0.75 ? "after" : container ? "inside" : y < 0.5 ? "before" : "after";
    if (node.type === "trash") pos = "inside";
    const newParent = pos === "inside" ? node.type : (findParent(all, node.id)?.type ?? null);
    if (!dragged.every((d) => canContain(newParent, d.type)) || (node.type === "trash" && pos !== "inside")) {
      setDrop(null);
      return;
    }
    setDrop({ id: node.id, pos });
  };

  return (
    <li role="treeitem" aria-selected={multi.size > 0 ? multi.has(node.id) : selectedId === node.id} aria-expanded={container && node.children.length > 0 ? !isCollapsed : undefined}>
      <div
        className={`row ${node.type} ${(multi.size > 0 ? multi.has(node.id) : selectedId === node.id) ? "sel" : ""} ${multi.size > 0 && multi.has(node.id) ? "multi" : ""} ${isDropTarget ? "drop-" + drop!.pos : ""} ${drag === node.id || dragIds.includes(node.id) ? "dragging" : ""}`}
        style={{ paddingLeft: 6 + depth * 16 }}
        draggable={node.type !== "trash" && !editing}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", node.id);
          e.dataTransfer.effectAllowed = "move";
          setDrag(node.id);
          // Dragging one of several picked items takes them all; dragging any other takes just that one.
          setDragIds(multi.size > 1 && multi.has(node.id) ? [...multi] : []);
          if (!multi.has(node.id) && multi.size > 0) useStore.getState().set({ multi: [] });
        }}
        onDragOver={onDragOver}
        onClick={(e) => {
          if (node.type === "trash") return;
          if (e.metaKey || e.ctrlKey || e.shiftKey) pick(node.id, e);
          else select(node.id);
        }}
        onDoubleClick={() => node.type !== "trash" && setEditing(true)}
        onContextMenu={(e) => openMenu(e, multi.size > 1 && multi.has(node.id) ? multiMenu([...multi]) : nodeMenu(node))}
      >
        {container && node.children.length > 0 ? (
          <button className="twisty" aria-label={isCollapsed ? "Expand" : "Collapse"} onClick={(e) => (e.stopPropagation(), toggle(node.id))}>
            <Icon name="chevronRight" size={13} className={isCollapsed ? "" : "open"} />
          </button>
        ) : (
          <span className="twisty" />
        )}
        <span className="icon" style={node.label && LABELS[node.label] ? { color: LABELS[node.label] } : undefined} data-tip={node.label ? `Label: ${node.label}` : undefined}>
          <Icon name={ICON[node.type]} size={15} />
        </span>
        {editing ? (
          <input
            autoFocus
            defaultValue={node.title}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => (rename(node.id, e.target.value), setEditing(false))}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="title">{node.title}</span>
        )}
        {!node.includeInExport && (
          <span className="excluded" data-tip="Excluded from export">
            excl.
          </span>
        )}
        {!editing && node.type === "trash" && node.children.length > 0 && (
          <span className="actions">
            <button className="icon-btn small" data-tip="Empty trash" aria-label="Empty trash" onClick={(e) => (e.stopPropagation(), confirmDelete(node.children, deleteForever))}>
              <Icon name="trash" size={14} />
            </button>
          </span>
        )}
        {!editing && node.type !== "trash" && (
          <span className="actions">
            {!inTrash && <AddButtons parentId={node.id} parentType={node.type} />}
            {inTrash ? (
              <>
                <button className="icon-btn small" data-tip="Restore" aria-label="Restore" onClick={(e) => (e.stopPropagation(), restore(node.id))}>
                  <Icon name="restore" size={14} />
                </button>
                <button className="icon-btn small" data-tip="Delete permanently" aria-label="Delete permanently" onClick={(e) => (e.stopPropagation(), confirmDelete([node], deleteForever))}>
                  <Icon name="close" size={14} />
                </button>
              </>
            ) : (
              <button className="icon-btn small" data-tip="Move to trash" aria-label="Move to trash" onClick={(e) => (e.stopPropagation(), trash(node.id))}>
                <Icon name="trash" size={14} />
              </button>
            )}
          </span>
        )}
        {node.type === "scene" && <span className={`status-dot ${node.status}`} data-tip={`Status: ${node.status}`} />}
        {words !== undefined && <span className="count">{words.toLocaleString()}</span>}
      </div>
      {node.children.length > 0 && !(container && isCollapsed) && (
        <Level nodes={node.children} depth={depth + 1} drag={drag} drop={drop} setDrag={setDrag} setDrop={setDrop} inTrash={inTrash || node.type === "trash"} />
      )}
    </li>
  );
}
