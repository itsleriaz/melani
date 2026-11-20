// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { useStore } from "./store";

export interface Command {
  id: string;
  label: string;
  run: () => void;
  /** Shortcut shown on the right, e.g. "⌘K". */
  hint?: string;
  /** A short description shown under the label. */
  detail?: string;
  group?: string;
}

/** Every query character appears in order in the label (case-insensitive). Lower is better. */
function score(label: string, q: string): number {
  if (!q) return 0;
  const l = label.toLowerCase();
  const idx = l.indexOf(q);
  if (idx === 0) return 0;
  if (idx > 0) return 1 + (l[idx - 1] === " " ? 0 : 1);
  let at = 0;
  for (const ch of q) {
    at = l.indexOf(ch, at);
    if (at < 0) return -1;
    at++;
  }
  return 5;
}

export function Palette({ commands }: { commands: Command[] }) {
  const set = useStore((s) => s.set);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const scored = commands.map((c) => ({ c, s: score(c.label, needle) })).filter((x) => x.s >= 0);
    // While searching, best matches first; otherwise keep the grouped order.
    if (needle) scored.sort((a, b) => a.s - b.s);
    return scored.map((x) => x.c);
  }, [commands, needle]);
  const close = () => set({ paletteOpen: false });
  const run = (c?: Command) => {
    if (!c) return;
    close();
    c.run();
  };
  useEffect(() => {
    list.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [i]);

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog palette" role="dialog" aria-label="Commands" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            placeholder="Type a command"
            aria-label="Type a command"
            value={q}
            onChange={(e) => (setQ(e.target.value), setI(0))}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "ArrowDown") (e.preventDefault(), setI(Math.min(i + 1, shown.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setI(Math.max(i - 1, 0)));
              if (e.key === "Enter") run(shown[i]);
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {shown.map((c, n) => {
            const head = !needle && c.group && c.group !== shown[n - 1]?.group;
            return (
              <div key={c.id}>
                {head && <div className="section-label">{c.group}</div>}
                <button role="option" aria-selected={n === i} className={`palette-item ${n === i ? "sel" : ""}`} onMouseMove={() => n !== i && setI(n)} onClick={() => run(c)}>
                  <span className="grow">
                    <span className="palette-label">{c.label}</span>
                    {c.detail && <span className="palette-detail">{c.detail}</span>}
                  </span>
                  {needle && c.group && <span className="palette-group">{c.group}</span>}
                  {c.hint && <kbd>{c.hint}</kbd>}
                </button>
              </div>
            );
          })}
          {shown.length === 0 && <div className="empty-state small">No command matches “{q}”.</div>}
        </div>
      </div>
    </div>
  );
}
