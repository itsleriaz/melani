// SPDX-License-Identifier: GPL-3.0-only
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { diffLines, stats as diffStats } from "./diff";
import { renderOps } from "./Snapshots";
import { useStore } from "./store";
import { countWords, findNode } from "./tree";

const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Shown on open when the recovery journal holds text that never reached the scene files.
 * Modal on purpose: the manuscript stays hidden until every scene is restored or discarded,
 * so typing cannot overwrite a journal before the author has decided.
 */
export function RecoveryDialog() {
  const dir = useStore((s) => s.dir)!;
  const nodes = useStore((s) => s.nodes);
  const recovery = useStore((s) => s.recovery);
  const unclean = useStore((s) => s.uncleanExit);
  const set = useStore((s) => s.set);
  const [currentId, setCurrentId] = useState(recovery[0].id);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const cur = recovery.find((r) => r.id === currentId) ?? recovery[0];
  const node = findNode(nodes, cur.id);
  const ops = useMemo(() => diffLines(cur.disk, cur.text), [cur]);
  const st = diffStats(ops);
  const delta = countWords(cur.text) - countWords(cur.disk);

  const resolve = async (ids: string[], restore: boolean) => {
    setBusy(true);
    setMsg(null);
    const done: string[] = [];
    try {
      for (const id of ids) {
        if (restore && findNode(nodes, id)) {
          await invoke("restore_recovery", { dir, id, label: findNode(nodes, id)?.title ?? "Scene" });
        } else {
          await invoke("clear_recovery", { dir, id });
        }
        done.push(id);
      }
    } catch (e) {
      setMsg(String(e));
    }
    const left = useStore.getState().recovery.filter((r) => !done.includes(r.id));
    set({ recovery: left });
    if (left.length) setCurrentId(left[0].id);
    if (restore && done.length) void useStore.getState().refreshCounts();
    setBusy(false);
  };

  return (
    <div className="overlay">
      <div className="dialog diff recovery" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <div className="diff-head">
          <strong id="recovery-title">Recover unsaved text</strong>
          <span className="grow" />
          <span className="muted">
            <span className="w-del">saved version</span> · <span className="w-add">unsaved text</span>
          </span>
        </div>
        <p className="recovery-intro">
          {unclean ? "The app did not close cleanly last time. " : ""}
          {recovery.length === 1 ? "One scene has" : `${recovery.length} scenes have`} text that was typed but never saved. Restore it, or keep the saved version. Restoring takes a snapshot of the saved version first, so you can undo it from the Snapshots tab.
        </p>
        {recovery.length > 1 && (
          <div className="recovery-list" role="tablist">
            {recovery.map((r) => (
              <button key={r.id} role="tab" aria-selected={r.id === cur.id} className={r.id === cur.id ? "sel" : ""} onClick={() => setCurrentId(r.id)}>
                {findNode(nodes, r.id)?.title ?? "Deleted scene"}
              </button>
            ))}
          </div>
        )}
        <div className="diff-head">
          <span>
            <strong>{node?.title ?? "Deleted scene"}</strong> <span className="muted">typed {fmt(cur.at)}</span>
          </span>
          <span className="grow" />
          <span className="muted">
            {delta >= 0 ? "+" : ""}
            {delta.toLocaleString()} words · {st.removed} removed, {st.added} added lines
          </span>
        </div>
        {msg && <div className="banner warn">{msg}</div>}
        {!node && <div className="banner warn">This scene is no longer in the binder, so its text can only be discarded.</div>}
        <div className="diff-body">{renderOps(ops)}</div>
        <div className="diff-foot">
          <button disabled={busy || !node} onClick={() => void resolve([cur.id], true)}>
            Restore unsaved text
          </button>
          <button disabled={busy} onClick={() => void resolve([cur.id], false)}>
            Keep saved version
          </button>
          <span className="grow" />
          {recovery.length > 1 && (
            <>
              <button disabled={busy} onClick={() => void resolve(recovery.map((r) => r.id), true)}>
                Restore all {recovery.length}
              </button>
              <button disabled={busy} onClick={() => window.confirm(`Discard unsaved text in all ${recovery.length} scenes? This cannot be undone.`) && void resolve(recovery.map((r) => r.id), false)}>
                Discard all
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
