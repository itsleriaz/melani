// SPDX-License-Identifier: GPL-3.0-only
// A caret that glides instead of jumping. The browser's caret is hidden (see .prose in App.css) and
// this draws its own, moved with a CSS transition. Whenever it cannot draw one (no focus, a selection,
// IME composition, or the setting off) the native caret comes back, so there is never no caret.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Dispatched on window when the setting changes, so every editor redraws at once. */
export const SMOOTH_CARET_EVENT = "smooth-caret-change";
const enabled = () => document.documentElement.dataset.smoothCaret === "on";
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export const SmoothCaret = Extension.create({
  name: "smoothCaret",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("smoothCaret"),
        view(view: EditorView) {
          const el = document.createElement("div");
          el.className = "smooth-caret";
          el.setAttribute("aria-hidden", "true");
          const trail = document.createElement("div");
          trail.className = "smooth-caret-trail";
          el.appendChild(trail);
          let shown = false;
          let prevDoc = view.state.doc;
          // Spring state: the caret chases (tx, ty) with a critically damped spring, so it eases in
          // and out and carries real velocity, which drives the motion-blur trail.
          let x = 0, y = 0, vx = 0, vy = 0, tx = 0, ty = 0, omega = 30, h = 0;
          let raf = 0, last = 0;

          const paint = () => {
            el.style.transform = `translate(${x}px, ${y}px)`;
            // Motion blur: a fading smear behind the caret, along the direction it is moving.
            const speed = Math.hypot(vx, vy);
            const len = Math.min(speed * 0.035, 36);
            if (len < 1.5) { trail.style.opacity = "0"; return; }
            const horizontal = Math.abs(vx) >= Math.abs(vy);
            trail.style.opacity = String(Math.min(1, len / 14) * 0.55);
            if (horizontal) {
              trail.style.cssText += `;width:${len}px;height:${h}px;top:0;${vx > 0 ? "right:100%" : "left:100%"};left:${vx > 0 ? "auto" : "100%"};background:linear-gradient(${vx > 0 ? "to right" : "to left"}, transparent, var(--accent))`;
            } else {
              trail.style.cssText += `;width:100%;height:${len}px;left:0;right:auto;${vy > 0 ? "bottom:100%;top:auto" : "top:100%;bottom:auto"};background:linear-gradient(${vy > 0 ? "to bottom" : "to top"}, transparent, var(--accent))`;
            }
          };

          const step = (now: number) => {
            const dt = Math.min((now - last) / 1000, 1 / 30);
            last = now;
            // Exact critically damped spring step: stable at any frame time, never overshoots from rest.
            const e = Math.exp(-omega * dt);
            const dx = x - tx, dy = y - ty;
            const kx = vx + omega * dx, ky = vy + omega * dy;
            x = tx + (dx + kx * dt) * e;
            y = ty + (dy + ky * dt) * e;
            vx = (vx - kx * omega * dt) * e;
            vy = (vy - ky * omega * dt) * e;
            const settled = Math.abs(tx - x) < 0.05 && Math.abs(ty - y) < 0.05 && Math.hypot(vx, vy) < 1;
            if (settled) { x = tx; y = ty; vx = vy = 0; raf = 0; } else raf = requestAnimationFrame(step);
            paint();
          };

          const hide = () => {
            if (shown) el.classList.remove("on");
            shown = false;
            cancelAnimationFrame(raf);
            raf = 0;
            view.dom.classList.add("native-caret");
          };

          const draw = (typing: boolean) => {
            const scroller = view.dom.closest(".editor-scroll") as HTMLElement | null;
            const { selection } = view.state;
            if (!enabled() || !scroller || !view.hasFocus() || !selection.empty || view.composing) return hide();
            let c: { top: number; bottom: number; left: number };
            try {
              c = view.coordsAtPos(selection.head);
            } catch {
              return hide();
            }
            if (el.parentElement !== scroller) scroller.appendChild(el);
            const box = scroller.getBoundingClientRect();
            const nx = c.left - box.left + scroller.scrollLeft;
            const ny = c.top - box.top + scroller.scrollTop;
            h = c.bottom - c.top;
            el.style.height = `${h}px`;
            // A new line (Enter, wrap, arrow up/down) is a fresh move: drop the speed left over from
            // typing, otherwise it carries the caret the wrong way and it bounces before settling.
            if (Math.abs(ny - ty) > h / 2) { vx = 0; vy = 0; }
            tx = nx;
            ty = ny;
            if (!shown || reduced()) {
              // Appearing: place it without gliding.
              x = nx; y = ny; vx = vy = 0;
              cancelAnimationFrame(raf);
              raf = 0;
              paint();
            } else if (!raf) {
              last = performance.now();
              raf = requestAnimationFrame(step);
            }
            // Stiffer while typing so the caret keeps up with the text; looser for clicks and arrows.
            omega = typing ? 48 : 30;
            // Restart the blink so the caret stays solid while it moves.
            el.style.animation = "none";
            void el.offsetWidth;
            el.style.animation = "";
            if (!shown) el.classList.add("on");
            shown = true;
            view.dom.classList.remove("native-caret");
          };

          const redraw = () => draw(false);
          const onFocus = () => requestAnimationFrame(redraw);
          view.dom.addEventListener("focus", onFocus);
          view.dom.addEventListener("blur", redraw);
          window.addEventListener(SMOOTH_CARET_EVENT, redraw);
          window.addEventListener("resize", redraw);
          view.dom.addEventListener("compositionend", onFocus);
          view.dom.classList.add("native-caret");

          return {
            update(v) {
              const typing = v.state.doc !== prevDoc;
              prevDoc = v.state.doc;
              draw(typing);
            },
            destroy() {
              view.dom.removeEventListener("focus", onFocus);
              view.dom.removeEventListener("blur", redraw);
              view.dom.removeEventListener("compositionend", onFocus);
              window.removeEventListener(SMOOTH_CARET_EVENT, redraw);
              window.removeEventListener("resize", redraw);
              cancelAnimationFrame(raf);
              el.remove();
            },
          };
        },
      }),
    ];
  },
});
