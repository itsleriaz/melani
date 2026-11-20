// SPDX-License-Identifier: GPL-3.0-only
// One tooltip for the whole app. Anything with a `data-tip` attribute gets it:
//
//   <button data-tip="Bold" data-tip-kbd="⌘B">…</button>
//   <Tooltip label="Bold" shortcut="⌘B"><button>…</button></Tooltip>
//
// <TooltipLayer /> is mounted once and listens for hover and keyboard focus.
import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react";

const SHOW_DELAY_MS = 500;
/** Moving from one tipped control to the next within this window shows the tip at once. */
const WARM_MS = 700;
const GAP = 8;

/** Gives its single child a tooltip. The child must be a DOM element such as a button. */
export function Tooltip({ label, shortcut, children }: { label: string; shortcut?: string; children: React.ReactElement<Record<string, unknown>> }) {
  if (!isValidElement(children)) return children;
  return cloneElement(children, { "data-tip": label, ...(shortcut ? { "data-tip-kbd": shortcut } : {}) });
}

interface Shown {
  text: string;
  kbd?: string;
  rect: DOMRect;
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? (node.closest("[data-tip]") as HTMLElement | null) : null;
}

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const lastHidden = useRef(0);
  const current = useRef<HTMLElement | null>(null);
  /** A tip is on screen right now. */
  const visible = useRef(false);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      current.current = null;
      if (visible.current) lastHidden.current = Date.now();
      visible.current = false;
      setShown(null);
    };
    const show = (t: HTMLElement, instant: boolean) => {
      const text = t.getAttribute("data-tip");
      if (!text) return;
      current.current = t;
      window.clearTimeout(timer.current);
      const go = () => {
        visible.current = true;
        setShown({ text, kbd: t.getAttribute("data-tip-kbd") ?? undefined, rect: t.getBoundingClientRect() });
      };
      // Already showing a tip, or just closed one: skip the delay, like a native toolbar.
      if (instant || visible.current || Date.now() - lastHidden.current < WARM_MS) go();
      else timer.current = window.setTimeout(go, SHOW_DELAY_MS);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const t = tipTarget(e.target);
      if (t === current.current) return;
      if (!t) return hide();
      show(t, false);
    };
    const focus = (e: FocusEvent) => {
      const t = tipTarget(e.target);
      // Only keyboard focus: a click focuses the button too, and the tip would flash up.
      if (t && (e.target as HTMLElement).matches(":focus-visible")) show(t, true);
    };
    const leave = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    window.addEventListener("pointerover", over);
    window.addEventListener("pointerout", leave);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("focusin", focus);
    window.addEventListener("focusout", hide);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener("pointerover", over);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("focusin", focus);
      window.removeEventListener("focusout", hide);
    };
  }, []);

  // Position once the tip has a size: below the control, or above when there is no room.
  useLayoutEffect(() => {
    if (!shown || !el.current) return setPos(null);
    const { width, height } = el.current.getBoundingClientRect();
    const r = shown.rect;
    const below = r.bottom + GAP + height < window.innerHeight - 4;
    const left = Math.max(6, Math.min(window.innerWidth - width - 6, r.left + r.width / 2 - width / 2));
    setPos({ left, top: below ? r.bottom + GAP : r.top - GAP - height, below });
  }, [shown]);

  // A tipped control that disappears (or is removed from under the pointer) takes its tip with it.
  useEffect(() => {
    if (shown && current.current && !current.current.isConnected) setShown(null);
  });

  if (!shown) return null;
  return (
    <div ref={el} role="tooltip" className={`tooltip ${pos ? "ready" : ""} ${pos?.below === false ? "above" : ""}`} style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}>
      <span>{shown.text}</span>
      {shown.kbd && <kbd>{shown.kbd}</kbd>}
    </div>
  );
}
