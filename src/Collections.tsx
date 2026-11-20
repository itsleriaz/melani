// SPDX-License-Identifier: GPL-3.0-only
// Collections: the sidebar list, and the page for one collection with its rules.
import { useEffect, useMemo } from "react";
import { openMenu } from "./ContextMenu";
import { Collection, defaultRule, Facts, members, needsValue, opsFor, Rule, RuleField, usesMentions } from "./collectionRules";
import { Icon } from "./icons";
import { LABELS, STATUSES } from "./Inspector";
import { TextField, useKnownKeywords } from "./Metadata";
import { Outliner } from "./Outliner";
import { useStore } from "./store";

/** The facts rules look at. Mentions cost a call per scene, so they load only when a collection needs them. */
export function useFacts(needMentions: boolean): Facts {
  const counts = useStore((s) => s.counts);
  const mentions = useStore((s) => s.mentions);
  const loadMentions = useStore((s) => s.loadMentions);
  const codexVersion = useStore((s) => s.codexVersion);
  useEffect(() => {
    if (needMentions) void loadMentions();
  }, [needMentions, loadMentions, codexVersion, counts]);
  return useMemo(() => ({ words: counts, mentions }), [counts, mentions]);
}

function NewMenu() {
  const newCollection = useStore((s) => s.newCollection);
  const set = useStore((s) => s.set);
  const make = (kind: Collection["kind"]) => set({ collectionId: newCollection(kind), bookOutline: false, codexId: null });
  return (
    <button
      className="icon-btn small"
      aria-label="New collection"
      data-tip="New collection"
      onClick={(e) =>
        openMenu(e, [
          { label: "Smart collection", icon: "filter", hint: "Updates itself from rules", onSelect: () => make("smart") },
          { label: "Manual collection", icon: "outline", hint: "Scenes you choose", onSelect: () => make("manual") },
        ])
      }
    >
      <Icon name="plus" size={15} />
    </button>
  );
}

/** Left sidebar tab: every collection, with how many scenes it holds. */
export function CollectionsPanel() {
  const collections = useStore((s) => s.collections);
  const nodes = useStore((s) => s.nodes);
  const collectionId = useStore((s) => s.collectionId);
  const set = useStore((s) => s.set);
  const del = useStore((s) => s.deleteCollection);
  const newCollection = useStore((s) => s.newCollection);
  const facts = useFacts(collections.some(usesMentions));
  return (
    <>
      <div className="panel-head">
        <span className="section-label grow">Collections</span>
        <NewMenu />
      </div>
      <nav className="binder collection-list" aria-label="Collections">
        {collections.length === 0 && (
          <div className="empty-state small">
            Collections are saved lists of scenes. Make one by hand, or write rules such as “status is draft” or “mentions Diane” and let it fill itself.
          </div>
        )}
        <ul>
          {collections.map((c) => (
            <li key={c.id}>
              <div
                className={`row ${c.id === collectionId ? "sel" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => set({ collectionId: c.id, bookOutline: false, codexId: null })}
                onKeyDown={(e) => e.key === "Enter" && set({ collectionId: c.id, bookOutline: false, codexId: null })}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: "Open", icon: "outline", onSelect: () => set({ collectionId: c.id, bookOutline: false, codexId: null }) },
                    {
                      label: "Duplicate",
                      icon: "scene",
                      onSelect: () => set({ collectionId: newCollection(c.kind, { name: `${c.name} copy`, ids: [...c.ids], rules: c.rules.map((r) => ({ ...r })), match: c.match }), bookOutline: false, codexId: null }),
                    },
                    { separator: true },
                    {
                      label: "Delete collection",
                      icon: "trash",
                      danger: true,
                      onSelect: () => {
                        if (window.confirm(`Delete the collection “${c.name}”? The scenes themselves are not deleted.`)) del(c.id);
                      },
                    },
                  ])
                }
              >
                <span className="icon">
                  <Icon name={c.kind === "smart" ? "filter" : "outline"} size={15} />
                </span>
                <span className="title grow">{c.name}</span>
                <span className="count">{members(c, nodes, facts).length}</span>
              </div>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

const FIELD_LABELS: [RuleField, string][] = [
  ["status", "Status"],
  ["keyword", "Keyword"],
  ["mentions", "Mentions"],
  ["pov", "Point of view"],
  ["location", "Location"],
  ["when", "When"],
  ["label", "Label"],
  ["words", "Word count"],
];

function RuleRow({ rule, onChange, onRemove }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void }) {
  const codex = useStore((s) => s.codex);
  const meta = useStore((s) => s.meta);
  const keywords = useKnownKeywords();
  const fields: [RuleField, string][] = [...FIELD_LABELS, ...(meta.sceneFields ?? []).map((f): [RuleField, string] => [`field:${f}`, f])];
  const setField = (field: RuleField) => onChange(defaultRule(field));
  const value = (() => {
    if (!needsValue(rule.op)) return null;
    if (rule.field === "status")
      return (
        <select className="input" aria-label="Status" value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
          <option value="">Choose…</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      );
    if (rule.field === "label")
      return (
        <select className="input" aria-label="Label" value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
          <option value="">Choose…</option>
          {Object.keys(LABELS).map((l) => (
            <option key={l} value={l}>
              {l[0].toUpperCase() + l.slice(1)}
            </option>
          ))}
        </select>
      );
    if (rule.field === "mentions")
      return (
        <select className="input" aria-label="Codex entry" value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
          <option value="">Choose an entry…</option>
          {[...codex].sort((a, b) => a.name.localeCompare(b.name)).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.type})
            </option>
          ))}
        </select>
      );
    return (
      <>
        <input
          className="input"
          aria-label="Value"
          type={rule.field === "words" ? "number" : "text"}
          list={rule.field === "keyword" ? "rule-keywords" : undefined}
          value={rule.value}
          placeholder={rule.field === "words" ? "e.g. 1000" : "Value"}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
        />
        {rule.field === "keyword" && (
          <datalist id="rule-keywords">
            {keywords.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        )}
      </>
    );
  })();
  return (
    <div className="rule-row">
      <select className="input" aria-label="Field" value={rule.field} onChange={(e) => setField(e.target.value as RuleField)}>
        {fields.map(([f, l]) => (
          <option key={f} value={f}>
            {l}
          </option>
        ))}
      </select>
      <select className="input" aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as Rule["op"], value: needsValue(e.target.value as Rule["op"]) ? rule.value : "" })}>
        {opsFor(rule.field).map(([op, l]) => (
          <option key={op} value={op}>
            {l}
          </option>
        ))}
      </select>
      <div className="rule-value">{value}</div>
      <button className="icon-btn small" aria-label="Remove rule" data-tip="Remove rule" onClick={onRemove}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** The main area for one collection: its name, rules (smart) and the scenes it holds. */
export function CollectionView({ id }: { id: string }) {
  const c = useStore((s) => s.collections.find((x) => x.id === id));
  const nodes = useStore((s) => s.nodes);
  const patch = useStore((s) => s.patchCollection);
  const facts = useFacts(!!c && usesMentions(c));
  const scenes = useMemo(() => (c ? members(c, nodes, facts) : []), [c, nodes, facts]);
  if (!c) return <div className="empty-state">This collection no longer exists.</div>;
  const setRule = (i: number, r: Rule) => patch(c.id, { rules: c.rules.map((x, j) => (j === i ? r : x)) });
  return (
    <div className="doc wide outline-doc">
      <p className="eyebrow">{c.kind === "smart" ? "Smart collection" : "Collection"}</p>
      <div className="collection-title">
        <TextField id="coll-name" value={c.name} onSave={(v) => patch(c.id, { name: v || c.name })} />
      </div>
      {c.kind === "smart" ? (
        <section className="rules" aria-label="Rules">
          <div className="rules-head">
            Scenes that match
            <select className="input inline" aria-label="Match all or any" value={c.match} onChange={(e) => patch(c.id, { match: e.target.value as "all" | "any" })}>
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            of these rules
          </div>
          {c.rules.map((r, i) => (
            <RuleRow key={i} rule={r} onChange={(x) => setRule(i, x)} onRemove={() => patch(c.id, { rules: c.rules.filter((_, j) => j !== i) })} />
          ))}
          <button className="link-btn" onClick={() => patch(c.id, { rules: [...c.rules, defaultRule("status")] })}>
            <Icon name="plus" size={12} />
            Add a rule
          </button>
        </section>
      ) : (
        <p className="muted collection-hint">Right-click a scene in the binder or the outline and choose “Add to collection”. Right-click a row here to remove it.</p>
      )}
      <Outliner
        scenes={scenes}
        onRemove={c.kind === "manual" ? (sid) => patch(c.id, { ids: c.ids.filter((x) => x !== sid) }) : undefined}
        emptyText={c.kind === "smart" ? "No scenes match yet. Fill in a rule above." : "No scenes yet. Add some from the binder."}
      />
    </div>
  );
}
