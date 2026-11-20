// SPDX-License-Identifier: GPL-3.0-only
// Everything you did that can be taken back, in one list. Typing is not here: Cmd+Z in the text undoes that.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type ActivityAction, type ActivityItem, type BackupInfo, buildActivity, formatSize, timeAgo, type SnapshotInfo } from "./activity";
import { flushAll, saveHistoryAll } from "./SceneEditor";
import { Icon } from "./icons";
import { MOD } from "./platform";
import { useStore } from "./store";

const REFRESH_MS = 5000;

export function ActivityPanel() {
  const dir = useStore((s) => s.dir)!;
  const binderUndo = useStore((s) => s.binderUndo);
  const binderRedo = useStore((s) => s.binderRedo);
  const codexTrash = useStore((s) => s.codexTrash);
  const collectionsUndo = useStore((s) => s.collectionsUndo);
  const collectionsRedo = useStore((s) => s.collectionsRedo);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  // So "5 min ago" moves on while the panel is open.
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let live = true;
    const load = () => {
      setNow(Date.now());
      void invoke<SnapshotInfo[]>("list_snapshots", { dir })
        .then((l) => live && setSnapshots(l))
        .catch(() => {});
      void invoke<BackupInfo[]>("list_backups", { dir })
        .then((l) => live && setBackups(l))
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [dir]);

  const items = useMemo(() => buildActivity({ binderUndo, binderRedo, codexTrash, snapshots, collectionsUndo, collectionsRedo }), [binderUndo, binderRedo, codexTrash, snapshots, collectionsUndo, collectionsRedo]);

  const backUpNow = async () => {
    setBusy(true);
    try {
      await flushAll();
      await invoke("create_backup", { dir });
      setBackups(await invoke<BackupInfo[]>("list_backups", { dir }));
      useStore.getState().showToast("Backed up the whole project");
    } catch (e) {
      useStore.getState().set({ error: `Could not back up: ${e}` });
    } finally {
      setBusy(false);
    }
  };

  /** Unpack a backup next to the project. It never touches the project itself; the toast offers to open the copy. */
  const restoreCopy = async (b: BackupInfo) => {
    setBusy(true);
    try {
      const path = await invoke<string>("restore_backup_copy", { dir, name: b.name });
      const name = path.split(/[\\/]/).pop() ?? path;
      useStore.getState().showToast(`Restored as “${name}”`, {
        label: "Open it",
        run: async () => {
          useStore.setState({ toast: null });
          await flushAll();
          await saveHistoryAll();
          await useStore.getState().closeProject();
          await useStore.getState().openProject(path);
        },
      });
    } catch (e) {
      useStore.getState().set({ error: `Could not restore the backup: ${e}` });
    } finally {
      setBusy(false);
    }
  };

  const deleteBackup = async (b: BackupInfo) => {
    if (!window.confirm(`Delete the backup from ${new Date(b.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}? This cannot be undone.`)) return;
    try {
      await invoke("delete_backup", { dir, name: b.name });
      setBackups((l) => l.filter((x) => x.name !== b.name));
    } catch (e) {
      useStore.getState().set({ error: `Could not delete the backup: ${e}` });
    }
  };

  const run = (a: ActivityAction) => {
    const s = useStore.getState();
    if (a.kind === "binder-undo") s.undoBinderSteps(a.steps);
    else if (a.kind === "binder-redo") s.redoBinderSteps(a.steps);
    else if (a.kind === "collections-undo") s.undoCollections(a.steps);
    else if (a.kind === "collections-redo") s.redoCollections(a.steps);
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
      <section className="backups" aria-label="Backups">
        <div className="backups-head">
          <strong>Backups</strong>
          <button className="activity-act" disabled={busy} onClick={() => void backUpNow()}>
            Back up now
          </button>
        </div>
        <p className="activity-hint muted">A copy of the whole project, taken automatically about once a day when you open it. The last 14 are kept. Restoring makes a new folder next to your project and never changes it.</p>
        {backups.length === 0 ? (
          <div className="empty-state small">No backups yet.</div>
        ) : (
          <ul className="activity-list">
            {backups.map((b) => (
              <li key={b.name} className="activity-item">
                <div className="activity-main">
                  <span className="activity-title">{new Date(b.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                  <span className="activity-meta muted">{formatSize(b.size)}</span>
                </div>
                <div className="activity-acts">
                  <button className="activity-act" disabled={busy} onClick={() => void restoreCopy(b)}>
                    Restore as copy
                  </button>
                  <button className="icon-btn small" aria-label="Delete this backup" data-tip="Delete this backup" disabled={busy} onClick={() => void deleteBackup(b)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
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
