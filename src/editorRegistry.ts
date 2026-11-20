// SPDX-License-Identifier: GPL-3.0-only
import type { Editor } from "@tiptap/core";
import type { Message } from "./ai";

/** What the AI tools need from a mounted scene editor. */
export interface EditorHandle {
  id: string;
  dir: string;
  editor: Editor;
  /** The prompt behind each pending suggestion, kept so "Regenerate" works (and survives a restart). */
  messages: Map<string, Message[]>;
  /** Suggestions still streaming in; their controls are hidden and the editor is locked. */
  streaming: Set<string>;
  /** True once the scene's text has been loaded into the editor. */
  ready: () => boolean;
  saveNow: () => Promise<void>;
  /** Call after changing suggestions: refreshes controls and the pending count, and saves. */
  changed: () => void;
}

const handles = new Map<string, EditorHandle>();
let active: EditorHandle | null = null;

export function registerHandle(h: EditorHandle) {
  handles.set(h.id, h);
  notify();
}
export function unregisterHandle(id: string) {
  const h = handles.get(id);
  handles.delete(id);
  if (active === h) active = null;
  notify();
}
/** Every mounted scene editor (a chapter shown as text has one per scene). */
export const allHandles = () => [...handles.values()];
const listeners = new Set<() => void>();
/** Called whenever the focused scene editor changes. */
export function onActiveChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const notify = () => listeners.forEach((f) => f());

export function setActive(h: EditorHandle) {
  if (active === h) return;
  active = h;
  notify();
}
export function getHandle(id: string): EditorHandle | null {
  return handles.get(id) ?? null;
}
/** The editor that last had focus, else the only one mounted. */
export function getActive(): EditorHandle | null {
  if (active && handles.get(active.id) === active) return active;
  return handles.size === 1 ? [...handles.values()][0] : null;
}
export const getActiveEditor = () => getActive()?.editor ?? null;
