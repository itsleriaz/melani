// SPDX-License-Identifier: GPL-3.0-only
import { ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { diffLines, diffWords, stats as diffStats, Op } from "./diff";
import { flushAll } from "./SceneEditor";
import { Switch } from "./Inspector";
import { useStore } from "./store";
import { findNode, leaves } from "./tree";
import { useEscape } from "./useEscape";

export interface Snap {
  id: string;
  createdAt: number;
  note: string;
  label: string;
  scope: string;
  sceneIds: string[];
}

const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function SnapshotsTab() {
  const dir = useStore((s) => s.dir)!;
  const selectedId = useStore((s) => s.selectedId);
  const nodes = useStore((s) => s.nodes);
  const set = useStore((s) => s.set);
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [note, setNote] = useState("");
  const [project, setProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const node = selectedId ? findNode(nodes, selectedId) : null;
  const leafIds = node ? leaves(node).map((l) => l.id) : [];

  const reload = () => invoke<Snap[]>("list_snapshots", { dir }).then(setSnaps).catch(() => setSnaps([]));
  useEffect(() => void reload(), [dir, selectedId]);

  const create = async () => {
    setBusy(true);
    try {
      await flushAll();
      const ids = project ? nodes.filter((n) => n.type !== "trash").flatMap(leaves).map((l) => l.id) : leafIds;
      const scope = project ? "project" : node?.type === "scene" || node?.type === "note" ? "scene" : "chapter";
      await invoke("create_snapshot", { dir, sceneIds: ids, note: note.trim(), label: project ? "Whole project" : (node?.title ?? "Snapshot"), scope });
      setNote("");
      await reload();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const shown = project ? snaps : snaps.filter((s) => s.sceneIds.some((id) => leafIds.includes(id)));
  const canCreate = project || leafIds.length > 0;
  return (
    <div className="snapshots">
      <div className="fields">
        <Switch label="Whole project" hint="Every scene, not just the one you have selected." checked={project} onChange={setProject} />
        <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && canCreate && void create()} />
        <button className="btn primary snap-create" disabled={!canCreate || busy} onClick={() => void create()}>
          {project ? "Snapshot whole project" : node ? `Snapshot “${node.title}”` : "Select a scene"}
        </button>
      </div>
      {shown.length === 0 && <div className="empty-state small">No snapshots yet{project ? "" : " for this selection"}.</div>}
      <ul className="snap-list">
        {shown.map((s) => (
          <li key={s.id}>
            <div>
              <strong>{s.label}</strong> <span className={`badge ${s.scope}`}>{s.scope}</span>
            </div>
            <div className="muted">{fmt(s.createdAt)}</div>
            {s.note && <div className="note">{s.note}</div>}
            <div className="snap-actions">
              <button
                onClick={() => {
                  const sceneId = s.sceneIds.find((id) => leafIds.includes(id)) ?? s.sceneIds[0];
                  if (sceneId) set({ diff: { snapshotId: s.id, sceneId } });
                }}
              >
                Compare
              </button>
              <button
                onClick={async () => {
                  if (window.confirm("Delete this snapshot? This cannot be undone.")) {
                    await invoke("delete_snapshot", { dir, snapshot: s.id });
                    void reload();
                  }
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function renderOps(ops: Op[]): ReactNode[] {
  const rows: ReactNode[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === "same") {
      rows.push(
        <div key={i} className="ln same">
          {ops[i].value || " "}
        </div>,
      );
      i++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    const at = i;
    while (i < ops.length && ops[i].type !== "same") (ops[i].type === "del" ? dels : adds).push(ops[i++].value);
    if (dels.length === adds.length && dels.length <= 20) {
      // Paired edits: show one line per paragraph with the changed words marked.
      dels.forEach((d, k) =>
        rows.push(
          <div key={`${at}-${k}`} className="ln changed">
            {diffWords(d, adds[k]).map((w, n) => (
              <span key={n} className={w.type === "same" ? "" : w.type === "add" ? "w-add" : "w-del"}>
                {w.value}
              </span>
            ))}
          </div>,
        ),
      );
    } else {
      dels.forEach((d, k) => rows.push(<div key={`${at}d${k}`} className="ln del">{d || " "}</div>));
      adds.forEach((a, k) => rows.push(<div key={`${at}a${k}`} className="ln add">{a || " "}</div>));
    }
  }
  return rows;
}

/** Compares a snapshot of a scene with its current text and offers restore. */
export function DiffView() {
  const diff = useStore((s) => s.diff)!;
  const dir = useStore((s) => s.dir)!;
  const nodes = useStore((s) => s.nodes);
  const set = useStore((s) => s.set);
  const [meta, setMeta] = useState<Snap | null>(null);
  const [sceneId, setSceneId] = useState(diff.sceneId);
  const [ops, setOps] = useState<Op[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const close = () => set({ diff: null });
  useEscape(close);

  useEffect(() => {
    void invoke<Snap[]>("list_snapshots", { dir }).then((l) => setMeta(l.find((s) => s.id === diff.snapshotId) ?? null));
  }, [dir, diff.snapshotId]);

  useEffect(() => {
    let live = true;
    setOps(null);
    void (async () => {
      await flushAll();
      const [old, cur] = await Promise.all([
        invoke<string>("read_snapshot_scene", { dir, snapshot: diff.snapshotId, scene: sceneId }),
        invoke<string>("read_scene", { dir, id: sceneId }),
      ]);
      if (live) setOps(diffLines(old, cur));
    })().catch((e) => live && setMsg(String(e)));
    return () => {
      live = false;
    };
  }, [dir, diff.snapshotId, sceneId]);

  const restore = async (ids: string[]) => {
    const what = ids.length === 1 ? "this scene" : `${ids.length} scenes`;
    if (!window.confirm(`Restore ${what} from this snapshot? The current text is snapshotted first, so you can undo it.`)) return;
    try {
      await flushAll();
      await invoke("restore_snapshot", { dir, snapshot: diff.snapshotId, sceneIds: ids });
      void useStore.getState().refreshCounts();
      close();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const st = ops ? diffStats(ops) : null;
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog diff" onMouseDown={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <strong>{meta ? `${meta.label}, ${fmt(meta.createdAt)}` : "Snapshot"}</strong>
          {meta && meta.sceneIds.length > 1 && (
            <select value={sceneId} onChange={(e) => setSceneId(e.target.value)}>
              {meta.sceneIds.map((id) => (
                <option key={id} value={id}>
                  {findNode(nodes, id)?.title ?? id}
                </option>
              ))}
            </select>
          )}
          <span className="grow" />
          <span className="muted">
            <span className="w-del">in snapshot only</span> · <span className="w-add">in current text only</span>
            {st && ` · ${st.removed} removed, ${st.added} added lines`}
          </span>
        </div>
        {msg && <div className="banner warn">{msg}</div>}
        <div className="diff-body">{ops ? ops.length === 0 ? <div className="empty-state small">Both versions are empty.</div> : st && st.added + st.removed === 0 ? <div className="empty-state small">No differences. The scene matches this snapshot.</div> : renderOps(ops) : <div className="empty-state small">Loading…</div>}</div>
        <div className="diff-foot">
          <button onClick={() => void restore([sceneId])}>Restore this scene</button>
          {meta && meta.sceneIds.length > 1 && <button onClick={() => void restore(meta.sceneIds)}>Restore all {meta.sceneIds.length} scenes</button>}
          <span className="grow" />
          <button onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
