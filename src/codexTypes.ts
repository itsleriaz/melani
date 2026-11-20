// SPDX-License-Identifier: GPL-3.0-only
export interface CodexLink {
  id: string;
  relation: string | null;
}

export interface CodexEntry {
  id: string;
  name: string;
  aliases: string[];
  type: string;
  tags: string[];
  links: CodexLink[];
  alwaysInclude: boolean;
  priority: number;
  summary: string;
  matchOptions: { caseSensitive: boolean; wholeWord: boolean; ignore: string[] };
}

export interface Mention {
  start: number;
  end: number;
  entries: string[];
  ambiguous: boolean;
  text: string;
}

export const ENTRY_TYPES = ["character", "place", "item", "faction", "event", "lore", "other"];

/** Templates only pre-fill the body of a new entry. */
export const TEMPLATES: Record<string, string> = {
  character: "**Age:**\n\n**Appearance:**\n\n**Voice:**\n\n**Goals:**\n\n**Notes:**\n",
  place: "**Description:**\n\n**Atmosphere:**\n\n**History:**\n",
  item: "**Description:**\n\n**Origin:**\n\n**Significance:**\n",
  faction: "**Purpose:**\n\n**Members:**\n\n**Rivals:**\n",
  event: "**When:**\n\n**Who:**\n\n**What happened:**\n\n**Consequences:**\n",
  lore: "",
  other: "",
};

export function emptyEntry(id: string, type: string, name: string): CodexEntry {
  return {
    id,
    name,
    aliases: [],
    type,
    tags: [],
    links: [],
    alwaysInclude: false,
    priority: 0,
    summary: "",
    matchOptions: { caseSensitive: false, wholeWord: true, ignore: [] },
  };
}

/** "a, b ,, c" -> ["a","b","c"] */
export function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
