// SPDX-License-Identifier: GPL-3.0-only
// Collections: saved lists of scenes. A manual one holds the scenes you put in it; a smart one
// holds every scene that matches its rules, and updates as the book changes.
import { BinderNode, leaves } from "./tree";

export type RuleField = "status" | "label" | "keyword" | "mentions" | "words" | "pov" | "location" | "when" | `field:${string}`;
export type RuleOp = "is" | "isNot" | "contains" | "has" | "hasNot" | "isSet" | "isUnset" | "gt" | "lt";

export interface Rule {
  field: RuleField;
  op: RuleOp;
  value: string;
}

export interface Collection {
  id: string;
  name: string;
  kind: "manual" | "smart";
  /** Manual: the scenes in it, in the order they were added. */
  ids: string[];
  /** Smart: the rules, and whether a scene must meet all of them or any one. */
  rules: Rule[];
  match: "all" | "any";
}

/** What a rule can look at besides the scene itself. */
export interface Facts {
  words: Record<string, number>;
  /** Codex entry ids mentioned in each scene. */
  mentions: Record<string, string[]>;
}

const TEXT_FIELDS = ["pov", "location", "when"];

export function opsFor(field: RuleField): [RuleOp, string][] {
  if (field === "status" || field === "label") return [["is", "is"], ["isNot", "is not"]];
  if (field === "keyword" || field === "mentions") return [["has", "has"], ["hasNot", "does not have"]];
  if (field === "words") return [["gt", "more than"], ["lt", "fewer than"]];
  return [["is", "is"], ["contains", "contains"], ["isSet", "is filled in"], ["isUnset", "is empty"]];
}

export function defaultRule(field: RuleField): Rule {
  return { field, op: opsFor(field)[0][0], value: "" };
}

export const needsValue = (op: RuleOp) => op !== "isSet" && op !== "isUnset";

const low = (s: string) => s.trim().toLowerCase();

/** An empty value means the rule is not filled in yet, so it does not filter anything. */
function ready(r: Rule): boolean {
  return !needsValue(r.op) || r.value.trim() !== "";
}

function fieldValue(n: BinderNode, f: RuleField): string {
  const key = f.startsWith("field:") ? f.slice(6) : TEXT_FIELDS.includes(f) ? f : null;
  return key ? (n.fields?.[key] ?? "") : "";
}

export function ruleMatches(r: Rule, n: BinderNode, facts: Facts): boolean {
  const v = low(r.value);
  switch (r.field) {
    case "status":
      return r.op === "is" ? low(n.status) === v : low(n.status) !== v;
    case "label":
      return r.op === "is" ? low(n.label ?? "") === v : low(n.label ?? "") !== v;
    case "keyword": {
      const has = (n.keywords ?? []).some((k) => low(k) === v);
      return r.op === "has" ? has : !has;
    }
    case "mentions": {
      const has = (facts.mentions[n.id] ?? []).includes(r.value);
      return r.op === "has" ? has : !has;
    }
    case "words": {
      const w = facts.words[n.id] ?? 0;
      const limit = Number(r.value);
      return r.op === "gt" ? w > limit : w < limit;
    }
    default: {
      const x = low(fieldValue(n, r.field));
      if (r.op === "isSet") return x !== "";
      if (r.op === "isUnset") return x === "";
      return r.op === "is" ? x === v : x.includes(v);
    }
  }
}

/** The scenes and notes in the book (not the trash), in book order. */
export function allScenes(nodes: BinderNode[]): BinderNode[] {
  return nodes.filter((n) => n.type !== "trash").flatMap(leaves);
}

/** The scenes a collection holds right now, in book order for smart ones. */
export function members(c: Collection, nodes: BinderNode[], facts: Facts): BinderNode[] {
  const scenes = allScenes(nodes);
  if (c.kind === "manual") {
    const byId = new Map(scenes.map((s) => [s.id, s]));
    return c.ids.map((id) => byId.get(id)).filter((s): s is BinderNode => !!s);
  }
  const rules = c.rules.filter(ready);
  if (rules.length === 0) return [];
  return scenes.filter((s) => (c.match === "all" ? rules.every((r) => ruleMatches(r, s, facts)) : rules.some((r) => ruleMatches(r, s, facts))));
}

/** Whether any rule needs the mention index (so it is only loaded when it is wanted). */
export const usesMentions = (c: Collection) => c.kind === "smart" && c.rules.some((r) => r.field === "mentions");
