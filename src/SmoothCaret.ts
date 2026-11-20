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
          let shown = false;
          let prevDoc = view.state.doc;

          const hide = () => {
            if (shown) el.classList.remove("on");
            shown = false;
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
            const x = c.left - box.left + scroller.scrollLeft;
            const y = c.top - box.top + scroller.scrollTop;
            // Appearing, or a big layout jump: place it without gliding.
            el.style.transitionDuration = !shown || reduced() ? "0ms" : typing ? "45ms" : "120ms";
            el.style.height = `${c.bottom - c.top}px`;
            el.style.transform = `translate(${x}px, ${y}px)`;
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
              el.remove();
            },
          };
        },
      }),
    ];
  },
});
