// SPDX-License-Identifier: GPL-3.0-only
export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
/** Modifier labels for shortcut hints: "⌘" and "⇧" on macOS, "Ctrl+" and "Shift+" elsewhere. */
export const MOD = IS_MAC ? "⌘" : "Ctrl+";
export const SHIFT = IS_MAC ? "⇧" : "Shift+";
