// SPDX-License-Identifier: GPL-3.0-only
// Everything you did that can be taken back, in one list. Typing is not here: Cmd+Z in the text undoes that.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type ActivityAction, type ActivityItem, buildActivity, timeAgo, type SnapshotInfo } from "./activity";
import { MOD } from "./platform";
import { useStore } from "./store";

const REFRESH_MS = 5000;

export function ActivityPanel() {
  const dir = useStore((s) => s.dir)!;
  const binderUndo = useStore((s) => s.binderUndo);
  const binderRedo = useStore((s) => s.binderRedo);
  const codexTrash = useStore((s) => s.codexTrash);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  // So "5 min ago" moves on while the panel is open.
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let live = true;
    const load = () => {
      setNow(Date.now());
      void invoke<SnapshotInfo[]>("list_snapshots", { dir })
        .then((l) => live && setSnapshots(l))
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [dir]);

  const items = useMemo(() => buildActivity({ binderUndo, binderRedo, codexTrash, snapshots }), [binderUndo, binderRedo, codexTrash, snapshots]);

  const run = (a: ActivityAction) => {
    const s = useStore.getState();
    if (a.kind === "binder-undo") s.undoBinderSteps(a.steps);
    else if (a.kind === "binder-redo") s.redoBinderSteps(a.steps);
    else if (a.kind === "codex-restore") void s.restoreDeletedEntry(a.id);
    else s.set({ diff: { snapshotId: a.snapshotId, sceneId: a.sceneId } });
  };

  return (
    <div className="activity">
      <p className="activity-hint muted">Changes you can take back. Typing is undone in the text itself with {MOD}Z.</p>
      {items.length === 0 ? (
        <div className="empty-state small">Nothing yet. Moves, renames, deletions and the app&apos;s automatic backups will show up here.</div>
      ) : (
        <ul className="activity-list">
          {items.map((i) => (
            <Row key={i.key} item={i} now={now} onRun={run} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ item, now, onRun }: { item: ActivityItem; now: number; onRun: (a: ActivityAction) => void }) {
  return (
    <li className={`activity-item ${item.state}`}>
      <div className="activity-main">
        <span className="activity-title">{item.title}</span>
        <span className="activity-meta muted">
          {timeAgo(item.at, now)}
          {item.detail ? ` · ${item.detail}` : ""}
        </span>
      </div>
      <button className="activity-act" onClick={() => onRun(item.action)}>
        {item.actionLabel}
      </button>
    </li>
  );
}
