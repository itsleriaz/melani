// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { MentionChips } from "./Codex";
import { NodeMetadata } from "./Metadata";
import { useAi } from "./aiStore";
import { openTool } from "./aiTools";
import { Icon } from "./icons";
import { nodeWords, useStore } from "./store";
import { findNode, findParent } from "./tree";

export const STATUSES = ["draft", "revised", "final"];
export const LABELS: Record<string, string> = {
  red: "#d0574f",
  orange: "#e08a2e",
  yellow: "#c9a227",
  green: "#3e9a5c",
  blue: "#3b6fd8",
  purple: "#8a5cc9",
};

/** An on/off switch drawn over a real checkbox. */
export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="switch-row">
      <span className="grow">
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Inspector() {
  const selectedId = useStore((s) => s.selectedId);
  const nodes = useStore((s) => s.nodes);
  const counts = useStore((s) => s.counts);
  const patch = useStore((s) => s.patch);
  const rename = useStore((s) => s.rename);
  const hasKey = useAi((s) => s.hasKey) === true;
  const node = selectedId ? findNode(nodes, selectedId) : null;
  const [synopsis, setSynopsis] = useState("");
  const [title, setTitle] = useState("");
  useEffect(() => setSynopsis(node?.synopsis ?? ""), [node?.id, node?.synopsis]);
  useEffect(() => setTitle(node?.title ?? ""), [node?.id, node?.title]);

  if (!node || node.type === "trash") return <div className="empty-state small">Select a scene or chapter to see its details.</div>;
  const isScene = node.type === "scene" || node.type === "note";
  const parent = findParent(nodes, node.id);
  const book = nodes.filter((n) => n.type !== "trash").reduce((a, n) => a + nodeWords(counts, n.id, nodes), 0);
  const own = nodeWords(counts, node.id, nodes);
  const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());

  return (
    <div className="inspector-body">
      <div className="field">
        <label htmlFor="insp-title" className="field-label">
          Title
        </label>
        <input
          id="insp-title"
          className="input strong"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== node.title && rename(node.id, title)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </div>

      <div className="field">
        <div className="field-label-row">
          <label htmlFor="insp-syn" className="field-label grow">
            Synopsis
          </label>
          {hasKey && node.type === "scene" && (
            <button className="link-btn" onClick={() => openTool("summary")} data-tip="Draft a synopsis with AI; nothing is saved until you accept it">
              <Icon name="sparkle" size={12} />
              Summarize
            </button>
          )}
        </div>
        <textarea
          id="insp-syn"
          className="input serif"
          rows={4}
          placeholder="What happens here, in a sentence or two."
          value={synopsis}
          onChange={(e) => setSynopsis(e.target.value)}
          onBlur={() => synopsis !== node.synopsis && patch(node.id, { synopsis })}
        />
      </div>

      <div className="field">
        <span className="field-label" id="insp-status">
          Status
        </span>
        <div className="segmented full" role="radiogroup" aria-labelledby="insp-status">
          {[...new Set([...STATUSES, node.status])].map((s) => (
            <button key={s} role="radio" aria-checked={node.status === s} className={node.status === s ? "on" : ""} onClick={() => patch(node.id, { status: s })}>
              <span className={`status-dot ${s}`} aria-hidden="true" />
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
          <span className="field-label" id="insp-label">
            Label
          </span>
          <div className="swatches" role="radiogroup" aria-labelledby="insp-label">
            <button role="radio" aria-checked={!node.label} aria-label="No label" className={`swatch none ${!node.label ? "on" : ""}`} onClick={() => patch(node.id, { label: null })} />
            {Object.entries(LABELS).map(([name, color]) => (
              <button key={name} role="radio" aria-checked={node.label === name} aria-label={name} data-tip={name} className={`swatch ${node.label === name ? "on" : ""}`} style={{ background: color, color }} onClick={() => patch(node.id, { label: name })} />
            ))}
          </div>
      </div>

      <Switch label="Include in export" checked={node.includeInExport} onChange={(v) => patch(node.id, { includeInExport: v })} />

      <NodeMetadata node={node} />

      {isScene && (
        <>
          <hr />
          <MentionChips />
        </>
      )}

      <div className="field">
        <span className="field-label">Words</span>
        <div className="stat-tiles">
          <div className="stat-tile">
            <strong>{fmt(own)}</strong>
            <span>{node.type === "scene" ? "Scene" : node.type === "note" ? "Note" : node.type === "chapter" ? "Chapter" : "Part"}</span>
          </div>
          {parent && parent.type !== "trash" && (
            <div className="stat-tile">
              <strong>{fmt(nodeWords(counts, parent.id, nodes))}</strong>
              <span>{parent.type === "chapter" ? "Chapter" : "Part"}</span>
            </div>
          )}
          <div className="stat-tile">
            <strong>{fmt(book)}</strong>
            <span>Book</span>
          </div>
        </div>
      </div>
    </div>
  );
}
