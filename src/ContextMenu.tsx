// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Icon, IconName } from "./icons";

export type MenuEntry =
  | { label: string; onSelect: () => void; icon?: IconName; hint?: string; danger?: boolean; disabled?: boolean; checked?: boolean }
  | { separator: true }
  | { heading: string }
  | { colors: Record<string, string>; value: string | null; onPick: (name: string | null) => void };

interface MenuState {
  menu: { x: number; y: number; items: MenuEntry[] } | null;
  open: (e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuEntry[]) => void;
  close: () => void;
}

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (e, items) => {
    e.preventDefault();
    set({ menu: { x: e.clientX, y: e.clientY, items } });
  },
  close: () => set({ menu: null }),
}));

/** Open a context menu from a React event: `onContextMenu={(e) => openMenu(e, [...])}`. */
export const openMenu = (e: React.MouseEvent, items: MenuEntry[]) => {
  e.stopPropagation();
  useMenu.getState().open(e, items);
};

/**
 * The browser's own menu stays inside text (spelling suggestions, Look Up, paste);
 * everywhere else it is replaced by these menus, or by nothing.
 */
export function useSuppressBrowserMenu() {
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true'], .ProseMirror")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);
}

const actionable = (m: MenuEntry): m is Extract<MenuEntry, { label: string }> => "label" in m && !m.disabled;

export function ContextMenu() {
  const { menu, close } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [active, setActive] = useState(-1);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, window.innerWidth - r.width - 8), top: Math.min(menu.y, window.innerHeight - r.height - 8) });
    setActive(-1);
    ref.current.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const blur = () => close();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    document.addEventListener("scroll", blur, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
      document.removeEventListener("scroll", blur, true);
    };
  }, [menu, close]);

  if (!menu) return null;
  const items = menu.items;
  const run = (m: MenuEntry) => {
    if (!actionable(m)) return;
    close();
    m.onSelect();
  };
  const stepTo = (dir: 1 | -1) => {
    for (let k = 1; k <= items.length; k++) {
      const i = (active + dir * k + items.length * 2) % items.length;
      if (actionable(items[i])) return setActive(i);
    }
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left || menu.x, top: pos.top || menu.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.preventDefault(), close());
        else if (e.key === "ArrowDown") (e.preventDefault(), stepTo(1));
        else if (e.key === "ArrowUp") (e.preventDefault(), stepTo(-1));
        else if (e.key === "Enter" && active >= 0) (e.preventDefault(), run(items[active]));
      }}
    >
      {items.map((m, i) => {
        if ("separator" in m) return <div key={i} className="cm-sep" role="separator" />;
        if ("heading" in m)
          return (
            <div key={i} className="cm-heading">
              {m.heading}
            </div>
          );
        if ("colors" in m)
          return (
            <div key={i} className="cm-colors" role="group" aria-label="Label">
              <button className={`swatch none ${!m.value ? "on" : ""}`} aria-label="No label" data-tip="No label" onClick={() => (close(), m.onPick(null))} />
              {Object.entries(m.colors).map(([name, color]) => (
                <button key={name} className={`swatch ${m.value === name ? "on" : ""}`} aria-label={name} data-tip={name} style={{ background: color, color }} onClick={() => (close(), m.onPick(name))} />
              ))}
            </div>
          );
        return (
          <button
            key={i}
            role="menuitem"
            disabled={m.disabled}
            className={`cm-item ${m.danger ? "danger-item" : ""} ${i === active ? "active" : ""}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(m)}
          >
            <span className="cm-icon">{m.checked ? <Icon name="check" size={14} /> : m.icon ? <Icon name={m.icon} size={14} /> : null}</span>
            <span className="grow">{m.label}</span>
            {m.hint && <span className="cm-hint">{m.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
