// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef } from "react";

/** Call `fn` when Escape is pressed, unless something closer (a dropdown, say) already handled it. */
export function useEscape(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
