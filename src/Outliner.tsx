// SPDX-License-Identifier: GPL-3.0-only
// The outline table: every part, chapter and scene as a row, with columns you choose.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openMenu } from "./ContextMenu";
import { Icon } from "./icons";
import { LABELS, STATUSES } from "./Inspector";
import { SCENE_FIELDS, TagInput, TextField, useKnownKeywords } from "./Metadata";
import { nodeMenu } from "./menus";
import { nodeWords, useStore } from "./store";
import { BinderNode, leaves } from "./tree";

type Kind = "text" | "long" | "status" | "label" | "words" | "keywords" | "characters";
interface Col {
  id: string;
  label: string;
  kind: Kind;
  width: number;
  /** The key in node.fields for text columns that are metadata. */
  field?: string;
  /** Metadata fields only apply to scenes and notes. */
  sceneOnly?: boolean;
}

interface Row {
  node: BinderNode;
  depth: number;
  group: boolean;
}

const rank = (s: string) => {
  const i = STATUSES.indexOf(s);
  return i < 0 ? STATUSES.length : i;
};

/** Parts and chapters, then scenes, flattened in book order. */
function flatten(nodes: BinderNode[], depth = 0): Row[] {
  return nodes
    .filter((n) => n.type !== "trash")
    .flatMap((n) => {
      const group = n.type === "part" || n.type === "chapter";
      return [{ node: n, depth, group }, ...(group ? flatten(n.children, depth + 1) : [])];
    });
}

/** The outline table. Given `root` it shows that part or chapter; given `scenes` it shows exactly those, flat (a collection). */
export function Outliner({ root, scenes, onRemove, emptyText }: { root?: BinderNode; scenes?: BinderNode[]; onRemove?: (id: string) => void; emptyText?: string }) {
  const dir = useStore((s) => s.dir)!;
  const nodes = useStore((s) => s.nodes);
  const counts = useStore((s) => s.counts);
  const codex = useStore((s) => s.codex);
  const codexVersion = useStore((s) => s.codexVersion);
  const meta = useStore((s) => s.meta);
  const cols = useStore((s) => s.outlineCols);
  const set = useStore((s) => s.set);
  const patch = useStore((s) => s.patch);
  const select = useStore((s) => s.select);
  const keywords = useKnownKeywords();
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState("");
  const [mentions, setMentions] = useState<Record<string, string[]>>({});

  const all: Col[] = useMemo(
    () => [
      { id: "title", label: "Title", kind: "text", width: 240 },
      { id: "synopsis", label: "Synopsis", kind: "long", width: 340 },
      { id: "status", label: "Status", kind: "status", width: 120 },
      { id: "label", label: "Label", kind: "label", width: 110 },
      ...SCENE_FIELDS.map((f): Col => ({ id: f.key, label: f.label, kind: "text", width: 150, field: f.key, sceneOnly: true })),
      ...(meta.sceneFields ?? []).map((f): Col => ({ id: `f:${f}`, label: f, kind: "text", width: 150, field: f, sceneOnly: true })),
      { id: "keywords", label: "Keywords", kind: "keywords", width: 220 },
      { id: "characters", label: "Characters", kind: "characters", width: 200, sceneOnly: true },
      { id: "words", label: "Words", kind: "words", width: 84 },
    ],
    [meta.sceneFields],
  );
  const shown = all.filter((c) => c.id === "title" || cols.includes(c.id));
  const hasCharacters = shown.some((c) => c.kind === "characters");

  const rows = useMemo(() => (scenes ? scenes.map((node): Row => ({ node, depth: 0, group: false })) : flatten(root ? root.children : nodes)), [root, scenes, nodes]);
  const sceneIds = useMemo(() => (scenes ?? (root ? leaves(root) : nodes.filter((n) => n.type !== "trash").flatMap(leaves))).map((n) => n.id), [root, scenes, nodes]);
  const flat = !!scenes || !!sort;

  // Who appears in each scene, from the mention index. Only fetched when the column is on.
  useEffect(() => {
    if (!hasCharacters) return;
    let live = true;
    void Promise.all(sceneIds.map((id) => invoke<Record<string, number>>("scene_mentions", { dir, id }).catch(() => ({}) as Record<string, number>))).then((res) => {
      if (!live) return;
      const out: Record<string, string[]> = {};
      sceneIds.forEach((id, i) => {
        out[id] = Object.entries(res[i])
          .sort((a, b) => b[1] - a[1])
          .map(([eid]) => codex.find((c) => c.id === eid)?.name)
          .filter((n): n is string => !!n);
      });
      setMentions(out);
    });
    return () => {
      live = false;
    };
  }, [dir, hasCharacters, sceneIds, codex, codexVersion, counts]);

  const value = (n: BinderNode, c: Col): string | number => {
    switch (c.kind) {
      case "words":
        return nodeWords(counts, n.id, nodes);
      case "status":
        return rank(n.status);
      case "label":
        return n.label ?? "";
      case "keywords":
        return (n.keywords ?? []).join(", ");
      case "characters":
        return (mentions[n.id] ?? []).join(", ");
      default:
        return c.field ? (n.fields?.[c.field] ?? "") : c.id === "synopsis" ? n.synopsis : n.title;
    }
  };

  const needle = filter.trim().toLowerCase();
  const matches = (n: BinderNode) => !needle || all.some((c) => String(c.kind === "status" ? n.status : value(n, c)).toLowerCase().includes(needle));
  let view: Row[] = rows;
  if (sort) {
    const col = all.find((c) => c.id === sort.col)!;
    // Sorting flattens the book: groups would make no sense in a reordered list.
    view = rows
      .filter((r) => !r.group)
      .sort((a, b) => {
        const x = value(a.node, col);
        const y = value(b.node, col);
        const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
        return cmp * sort.dir;
      });
  }
  if (needle) view = view.filter((r) => matches(r.node));

  const cycle = (id: string) => setSort(!sort || sort.col !== id ? { col: id, dir: 1 } : sort.dir === 1 ? { col: id, dir: -1 } : null);
  const parentTitle = (id: string) => (scenes ? nodes : rows.map((r) => r.node)).flatMap(function walk(n: BinderNode): BinderNode[] { return [n, ...n.children.flatMap(walk)]; }).find((n) => (n.type === "chapter" || n.type === "part") && n.children.some((c) => c.id === id))?.title;
  const columnsMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      { heading: "Columns" },
      ...all
        .filter((c) => c.id !== "title")
        .map((c) => ({ label: c.label, checked: cols.includes(c.id), onSelect: () => set({ outlineCols: cols.includes(c.id) ? cols.filter((x) => x !== c.id) : [...cols, c.id] }) })),
    ]);

  if (rows.length === 0) return <div className="empty-state">{emptyText ?? "Nothing to show yet. Add chapters and scenes in the binder."}</div>;
  const total = sceneIds.reduce((a, id) => a + (counts[id] ?? 0), 0);
  return (
    <div className="outliner">
      <div className="outline-bar">
        <div className="search-field">
          <Icon name="search" size={14} />
          <input aria-label="Filter the outline" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {sort && (
          <button className="btn small" onClick={() => setSort(null)}>
            {scenes ? "Back to collection order" : "Back to book order"}
          </button>
        )}
        <span className="grow" />
        <span className="muted">
          {sceneIds.length} scene{sceneIds.length === 1 ? "" : "s"} · {total.toLocaleString()} words
        </span>
        <button className="btn small" onClick={columnsMenu}>
          <Icon name="columns" size={14} />
          Columns
        </button>
      </div>
      <div className="outline-wrap">
        <table className="outline" style={{ minWidth: shown.reduce((a, c) => a + c.width, 40) }}>
          <thead>
            <tr>
              <th className="o-open" />
              {shown.map((c) => (
                <th key={c.id} style={{ width: c.width }} aria-sort={sort?.col === c.id ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={c.kind === "words" ? "num" : ""}>
                  <button onClick={() => cycle(c.id)}>
                    {c.label}
                    {sort?.col === c.id && <Icon name={sort.dir === 1 ? "sortUp" : "sortDown"} size={13} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map(({ node, depth, group }) => (
              <tr key={node.id} className={group ? "o-group" : ""} onContextMenu={(e) => openMenu(e, onRemove ? [...nodeMenu(node), { separator: true }, { label: "Remove from this collection", icon: "close", onSelect: () => onRemove(node.id) }] : nodeMenu(node))}>
                <td className="o-open">
                  <button className="icon-btn small" aria-label={`Open ${node.title}`} data-tip="Open" onClick={() => select(node.id)}>
                    <Icon name="external" size={14} />
                  </button>
                </td>
                {shown.map((c, i) => (
                  <td key={c.id} className={c.kind === "words" ? "num" : ""}>
                    {c.id === "title" ? (
                      <div className="o-title" style={{ paddingLeft: flat ? 0 : depth * 16 }}>
                        <Icon name={node.type === "scene" ? "sceneSolid" : node.type === "note" ? "note" : node.type === "part" ? "part" : "folder"} size={14} />
                        <TextField id={`o-t-${node.id}`} value={node.title} onSave={(v) => patch(node.id, { title: v || "Untitled" })} />
                        {flat && !group && parentTitle(node.id) && <span className="o-crumb">{parentTitle(node.id)}</span>}
                      </div>
                    ) : (
                      <Cell node={node} col={c} words={nodeWords(counts, node.id, nodes)} names={mentions[node.id]} keywords={keywords} first={i === 0} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {view.length === 0 && (
              <tr>
                <td colSpan={shown.length + 1} className="o-empty">
                  Nothing matches “{filter}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ node, col, words, names, keywords }: { node: BinderNode; col: Col; words: number; names?: string[]; keywords: string[]; first: boolean }) {
  const patch = useStore((s) => s.patch);
  const text = node.type === "scene" || node.type === "note";
  if (col.sceneOnly && !text) return <span className="o-na" />;
  switch (col.kind) {
    case "words":
      return <span className="o-words">{words.toLocaleString()}</span>;
    case "status":
      return (
        <select className="cell-select" aria-label={`Status of ${node.title}`} value={node.status} onChange={(e) => patch(node.id, { status: e.target.value })}>
          {[...new Set([...STATUSES, node.status])].map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      );
    case "label":
      return (
        <label className="o-label">
          <span className="o-dot" style={{ background: node.label ? LABELS[node.label] : "transparent" }} />
          <select className="cell-select" aria-label={`Label of ${node.title}`} value={node.label ?? ""} onChange={(e) => patch(node.id, { label: e.target.value || null })}>
            <option value="">None</option>
            {Object.keys(LABELS).map((l) => (
              <option key={l} value={l}>
                {l[0].toUpperCase() + l.slice(1)}
              </option>
            ))}
          </select>
        </label>
      );
    case "keywords":
      return <TagInput label={`Keywords of ${node.title}`} value={node.keywords ?? []} suggestions={keywords} placeholder="" onChange={(v) => patch(node.id, { keywords: v })} />;
    case "characters":
      return (
        <div className="o-chars">
          {(names ?? []).slice(0, 3).map((n) => (
            <span key={n} className="tag plain">
              {n}
            </span>
          ))}
          {(names?.length ?? 0) > 3 && <span className="muted">+{names!.length - 3}</span>}
        </div>
      );
    case "long":
      return <TextField id={`o-s-${node.id}`} long value={node.synopsis} hint="" onSave={(v) => patch(node.id, { synopsis: v })} />;
    default: {
      const f = col.field!;
      return (
        <TextField
          id={`o-${f}-${node.id}`}
          value={node.fields?.[f] ?? ""}
          onSave={(v) => {
            const next = { ...node.fields };
            if (v) next[f] = v;
            else delete next[f];
            patch(node.id, { fields: next });
          }}
        />
      );
    }
  }
}
