// A shaped bundle's filter literals — PURE. A filter step on a column marked personal or financial stores the
// value it compares with (`email = 'ana@…'`), and a value cut out of it is no fix: on import a value-less `=`
// passes sanitizeFilterStep and matches blank rows, a wrong figure. So a bundle the Share policy shapes (mask or
// drop, ./sharePolicy.ts applyToBundle) is REFUSED while any record or saved version holds such a step.

import type { ZipEntry } from './bundle';
import * as msg from './bundleMessages';

export interface FilterValueHit {
  entry: string;
  /** The record's name, or the entry's when it has none. */
  name: string;
  column: string;
  /** A saved version (history/…), not the record itself. */
  version: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The withheld column a filter step compares with a literal it stores (a value, a list, custom dates, a centre), or null. */
function valueColumn(o: Record<string, unknown>, withheld: ReadonlySet<string>): string | null {
  if (o.type !== 'filter' || typeof o.column !== 'string') return null;
  const period = isObject(o.period) ? o.period : null;
  const radius = isObject(o.radius) ? o.radius : null;
  const literal = o.value != null || (Array.isArray(o.values) && o.values.length > 0) || !!radius
    || (!!period && (period.from !== undefined || period.to !== undefined));
  if (!literal) return null;
  if (withheld.has(o.column)) return o.column;
  return radius && typeof radius.lngColumn === 'string' && withheld.has(radius.lngColumn) ? radius.lngColumn : null;
}

/**
 * Every record of `entries` holding a filter step that compares one of `withheld` with a stored literal, wherever
 * in the record it sits (a visual's filters, a dashboard card's frozen copy, a metric's tree, a story block, an
 * alert rule…), one hit per name, column and version. A dataset record and its versions are left out: their own steps
 * are judged on their own marks where the bundle shapes them. An entry that does not parse is skipped, as a
 * corrupt record is everywhere.
 */
export function filterValueHits(entries: readonly ZipEntry[], withheld: ReadonlySet<string>): FilterValueHit[] {
  const hits = new Map<string, FilterValueHit>();
  if (!withheld.size) return [];
  for (const e of entries) {
    if (!e.name.endsWith('.json') || e.name.startsWith('datasets/') || e.name.startsWith('history/dataset/') || !e.data.includes('"filter"')) continue;
    let doc: unknown;
    try { doc = JSON.parse(e.data.toString('utf8')); } catch (_) { continue; }
    const version = e.name.startsWith('history/');
    // `name` is the shallowest one on the way down: a dashboard's, not its card's; an alert rule's in alerts.json.
    const walk = (node: unknown, name: string | undefined): void => {
      if (Array.isArray(node)) { node.forEach((x) => walk(x, name)); return; }
      if (!isObject(node)) return;
      const label = name ?? (typeof node.name === 'string' && node.name.trim() ? node.name.trim() : undefined);
      const column = valueColumn(node, withheld);
      if (column === null) { Object.values(node).forEach((x) => walk(x, label)); return; }
      const hit = { entry: e.name, name: label ?? e.name, column, version };
      hits.set(JSON.stringify([hit.name, column, version]), hit); // a visual's fifty versions are one line
    };
    walk(doc, undefined);
  }
  return [...hits.values()];
}

const SHOWN = 5;

/** The export's refusal: the records named (the first five), never a value. */
export class FilterValueRefusal extends Error {
  readonly code = 'share_filter_value';
  constructor(readonly hits: FilterValueHit[]) {
    const list = hits.slice(0, SHOWN).map((h) => (h.version ? msg.versionFiltersByValue(h.name, h.column) : msg.filtersByValue(h.name, h.column))).join('; ');
    super(msg.bundleFilterValues(hits.length > SHOWN ? msg.andMore(list, hits.length - SHOWN) : list));
    this.name = 'FilterValueRefusal';
  }
}
