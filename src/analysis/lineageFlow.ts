// How Prepare moves columns (semantic layer D18) — MAIN, PURE. A fold over a dataset's steps that says, for
// every column the dataset ever had, which columns it was computed from, what it was called before, and
// whether a step masked or dropped it. Names only: no expression, value or table leaves this file.
//
// One rule per STEP_TYPES member (FLOW_RULES). `test-lineageColumns` holds the key sets equal, so a step type
// added without a line here fails a test; a step type this file has never heard of (a newer pod's) reads
// `approximate`: every column it makes comes from every column it saw.

import { STEP_TYPES } from '../data/transforms';
import type { TransformStep } from '../data/transforms';
import { compile } from '../formula/formula';

export type FlowRule = 'calc' | 'conditional' | 'rename' | 'drop' | 'in_place' | 'masked' | 'aggregate' | 'lookup' | 'rows' | 'approximate';

/** One entry per STEP_TYPES member. */
export const FLOW_RULES: Readonly<Record<string, FlowRule>> = {
  calculated_field: 'calc', conditional_column: 'conditional',
  rename_column: 'rename', drop_column: 'drop',
  fill_empty: 'in_place', trim: 'in_place', replace_values: 'in_place', parse_date: 'in_place',
  mask_hash: 'masked', mask_redact: 'masked', mask_generalize: 'masked',
  group_aggregate: 'aggregate', lookup_join: 'lookup',
  filter: 'rows', dedupe: 'rows', dedupe_key: 'rows',
  split_column: 'approximate', unpivot: 'approximate', pivot: 'approximate', union: 'approximate', window: 'approximate',
  spatial_join: 'approximate', segment: 'approximate', text_terms: 'approximate', text_sentiment: 'approximate', keyword_rules: 'approximate',
};

export interface FlowColumn {
  /** Identity: the column's final name, or its last name when a step drops it. */
  key: string;
  /** Earlier names, oldest first. */
  was: string[];
  /** Keys of the columns it was computed from ([] for a source column). */
  from: string[];
  how: 'source' | 'calc' | 'in_place' | 'masked' | 'aggregate' | 'lookup' | 'approximate';
  dropped?: true;
  lookup?: { datasetId: string; column: string };
}

interface Id { names: string[]; from: Id[]; how: FlowColumn['how']; dropped?: true; lookup?: FlowColumn['lookup'] }

type Step = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Columns a calculated field reads: the parser's refs, LOD dimensions included. A formula that does not compile reads none. */
export function formulaColumns(expression: string): string[] {
  const c = compile(expression);
  return c.ok ? c.fn.refs : [];
}

/** The columns a conditional's rules test. */
const conditionColumns = (s: Step): string[] => list(s.rules).map((r) => str((r as { when?: { column?: unknown } } | null)?.when?.column)).filter(Boolean);

/** Names a step adds, for the approximate steps before it to leave alone. */
function namesMade(s: Step): string[] {
  switch (FLOW_RULES[str(s.type)]) {
    case 'calc': case 'conditional': return [str(s.name)];
    case 'rename': return [str(s.to)];
    case 'aggregate': return list(s.aggregations).map((a) => str((a as { as?: unknown } | null)?.as));
    case 'lookup': return list(s.columns).map((c) => str(s.prefix) + str(c));
    case 'in_place': return [str(s.as)];
    default: return [];
  }
}

/**
 * `source`: the dataset's columns before any step. `final`: its columns after the last one, which is the only way to
 * name what a pivot or a split made (their names come from the data); without it an approximate step makes none.
 * First-seen order.
 */
export function columnFlow(source: string[], steps: readonly TransformStep[], final?: string[]): FlowColumn[] {
  const all: Id[] = [];
  const live = new Map<string, Id>();
  const make = (name: string, from: Id[], how: Id['how'], extra: Partial<Id> = {}): Id => {
    const old = live.get(name);
    if (old) old.dropped = true; // overwritten: the earlier column ends here, and still fed whatever read it
    const id: Id = { names: [name], from: [...new Set(from)], how, ...extra };
    all.push(id);
    live.set(name, id);
    return id;
  };
  const read = (names: string[]): Id[] => names.map((n) => live.get(n)).filter((x): x is Id => !!x);
  for (const n of source) make(n, [], 'source');

  (steps as readonly unknown[]).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const s = raw as Step;
    const rule = FLOW_RULES[str(s.type)] ?? 'approximate';
    switch (rule) {
      case 'rows': return;
      case 'calc': if (str(s.name)) make(str(s.name), read(formulaColumns(str(s.expression))), 'calc'); return;
      case 'conditional': if (str(s.name)) make(str(s.name), read(conditionColumns(s)), 'calc'); return;
      case 'rename': {
        const id = live.get(str(s.from));
        if (!id || !str(s.to) || str(s.to) === str(s.from)) return;
        const clash = live.get(str(s.to));
        if (clash) clash.dropped = true;
        live.delete(str(s.from));
        id.names.push(str(s.to));
        live.set(str(s.to), id);
        return;
      }
      case 'drop': { const id = live.get(str(s.column)); if (id) { id.dropped = true; live.delete(str(s.column)); } return; }
      case 'in_place': case 'masked': {
        const col = str(s.column);
        const id = live.get(col);
        if (rule === 'in_place' && s.type === 'parse_date' && str(s.as) && str(s.as) !== col) { make(str(s.as), read([col]), 'calc'); return; }
        if (!id) return;
        if (rule === 'masked') id.how = 'masked';
        else if (id.how === 'source') id.how = 'in_place';
        return;
      }
      case 'aggregate': {
        const by = list(s.groupBy).map(str);
        const aggs = list(s.aggregations) as Array<{ column?: unknown; as?: unknown }>;
        const made = aggs.filter((a) => str(a?.as)).map((a) => ({ as: str(a.as), from: read([str(a.column)]) }));
        for (const [name, id] of [...live]) if (!by.includes(name)) { id.dropped = true; live.delete(name); }
        for (const m of made) make(m.as, m.from, 'aggregate');
        return;
      }
      case 'lookup': {
        const left = live.get(str(s.leftKey));
        const names = list(s.columns).map((c) => ({ col: str(c), name: str(s.prefix) + str(c) })).filter((x) => x.col);
        // The fold skips a lookup whose key is missing or whose names clash: so does this.
        if (!left || !str(s.datasetId) || names.some((x) => live.has(x.name))) return;
        for (const x of names) make(x.name, [left], 'lookup', { lookup: { datasetId: str(s.datasetId), column: x.col } });
        return;
      }
      default: { // approximate: every column it makes from every column it saw
        const seen = [...live.values()];
        const later = new Set(steps.slice(i + 1).flatMap((t) => namesMade(t as unknown as Step)));
        for (const name of final ?? []) if (!live.has(name) && !later.has(name)) make(name, seen, 'approximate');
      }
    }
  });

  // Keys: a live column keeps its name; an earlier one it shadows is "<name> (earlier)", so two never share a key.
  const keyOf = new Map<Id, string>();
  const taken = new Set<string>();
  for (const id of all) if (live.get(id.names[id.names.length - 1]) === id) { keyOf.set(id, id.names[id.names.length - 1]); taken.add(id.names[id.names.length - 1]); }
  for (const id of all) {
    if (keyOf.has(id)) continue;
    let k = id.names[id.names.length - 1];
    while (taken.has(k)) k += ' (earlier)';
    keyOf.set(id, k);
    taken.add(k);
  }
  return all.map((id) => {
    const out: FlowColumn = { key: keyOf.get(id)!, was: id.names.slice(0, -1), from: id.from.map((f) => keyOf.get(f)!), how: id.how };
    if (id.dropped || (final && live.get(id.names[id.names.length - 1]) === id && !final.includes(id.names[id.names.length - 1]))) out.dropped = true;
    if (id.lookup) out.lookup = id.lookup;
    return out;
  });
}

// STEP_TYPES is imported so the module fails to load if the set moves; the test holds the key sets equal.
export const KNOWN_STEP_TYPES: ReadonlySet<string> = STEP_TYPES;
