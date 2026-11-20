// SPDX-License-Identifier: GPL-3.0-only
// Actions on the text selected in the focused scene editor.
import { getActiveEditor } from "./editorRegistry";
import { useStore } from "./store";

/** The selected text, trimmed, or "" when nothing is selected. */
export function selectedText(): string {
  const ed = getActiveEditor();
  if (!ed) return "";
  const { from, to } = ed.state.selection;
  return ed.state.doc.textBetween(from, to, " ").trim();
}

/** Make a codex entry named after the selection, and open it. */
export async function createEntryFromSelection(type = "character") {
  const s = useStore.getState();
  const name = selectedText();
  if (!name) return s.set({ error: "Select a name in a scene first, then create the entry." });
  const id = await s.createEntry(type, name);
  s.set({ leftTab: "codex", codexId: id, error: null });
}
