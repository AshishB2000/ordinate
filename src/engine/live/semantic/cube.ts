// Cube: b1's neutral question → ONE REST query object (semantic layer part 7, e1; docs/live-data/cube.md,
// docs/semantic-layer/07-portability.md D15) — PURE.
//
//   { measures: ["orders.revenue"], dimensions: ["orders.region"],
//     timeDimensions: [{ dimension: "orders.d", granularity: "month" }],
//     filters: [{ member: "orders.region", operator: "notEquals", values: ["North"] }],
//     order: [["orders.revenue", "desc"], ["orders.region", "asc"]], limit: 51, timezone: "UTC" }
//
// VALUES ARE JSON: every filter value is a string in a `values` array (Cube's rule), never part of a member name.
// MEMBER NAMES are `<model>.<name>`, each part a plain identifier (CUBE_NAME_RE): only the dataset's declared
// dimensions and the layer's synced metrics, so nothing a person typed becomes a name; anything else throws.
//
// Each filter means what it means on an extract (../compileFilter is the reference: a NULL compares as '', a date
// as its ISO day), written with Cube's operators as its BaseFilter turns them into SQL (the table in
// docs/live-data/cube.md). What Cube cannot express exactly is refused `layerFilter`, never approximated: text
// order (`<` on text), `contains` (Cube's is case-insensitive), a text `empty` (Cube has no whitespace test — save a
// value list's own "not empty", which the connector applies to the list it gets back), a date list.
//
// Always an explicit limit: the plan's, else CUBE_ROW_LIMIT (a full reply is refused there, ../../../connectors).

import { civilFromDays, daysFromCivil } from '../../../analysis/categoryKey';
import type { CubeBody, CubeFilter, CubeOperator, CubeQuery } from '../../../connectors/cubeWire';
import { CUBE_NAME_RE, CUBE_ROW_LIMIT } from '../../../connectors/cubeWire';
import type { SemanticRequest } from '../../../connectors/semanticRun';
import { coerceValue } from '../../../data/parse';
import type { Cell } from '../../../data/transforms';
import type { LiveColumn, LiveRefusal } from '../liveSpec';
import { columnOf, refuse } from '../liveSpec';
import type { SemanticAdapter } from './adapters';
import { refuseLayer } from './semanticRefusals';
import type { SemanticFilter, SemanticQuery } from './semanticQuery';
import { answerColumns } from './semanticQuery';

/** Thrown inside `encode` to come back as its refusal. */
class Refused {
  constructor(readonly refusal: LiveRefusal) {}
}

/** A member as Cube names it. */
export function cubeMember(model: string, name: string): string {
  if (!CUBE_NAME_RE.test(String(model)) || !CUBE_NAME_RE.test(String(name))) throw new Error('[semantic] a Cube model and member must be plain identifiers');
  return `${model}.${name}`;
}

const leaf = (member: string, operator: CubeOperator, values?: string[]): CubeFilter => (values ? { member, operator, values } : { member, operator });
const text = (v: Cell): string => (v == null ? '' : String(v));

/** An ISO day as written, or null when it is not a real one. */
export function isoDay(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const back = civilFromDays(daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])));
  return back.y === Number(m[1]) && back.m === Number(m[2]) && back.d === Number(m[3]) ? v : null;
}

/** The ISO day `n` days after `day`. */
export function dayAfter(day: string, n = 1): string {
  const c = civilFromDays(daysFromCivil(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))) + n);
  return `${String(c.y).padStart(4, '0')}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

type Names = { dataset: string; layer: string };

function textFilter(f: SemanticFilter, m: string, no: () => never): CubeFilter {
  if (f.kind === 'compare') {
    const v = text(f.value);
    if (f.op === '=') return v === '' ? { or: [leaf(m, 'equals', ['']), leaf(m, 'notSet')] } : leaf(m, 'equals', [v]);
    if (f.op === '!=') return v === '' ? { and: [leaf(m, 'notEquals', ['']), leaf(m, 'set')] } : leaf(m, 'notEquals', [v]);
    return no(); // Cube orders text in no filter
  }
  if (f.kind === 'in') {
    const values = f.values.map(text);
    if (values.length === 0) return no();
    const blank = values.includes(''); // a blank or a NULL in the list matches both, as on an extract
    if (f.negate) return blank ? { and: [leaf(m, 'notEquals', values), leaf(m, 'set')] } : leaf(m, 'notEquals', values);
    return blank ? { or: [leaf(m, 'equals', values), leaf(m, 'notSet')] } : leaf(m, 'equals', values);
  }
  if (f.kind === 'range') throw new Refused(refuse('periodNotDate', f.column));
  return no(); // contains (case-insensitive in Cube), empty (no whitespace test)
}

const NUMBER_OP: Record<string, CubeOperator> = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };
const NOTHING = (m: string): CubeFilter => ({ and: [leaf(m, 'set'), leaf(m, 'notSet')] });
const EVERYTHING = (m: string): CubeFilter => ({ or: [leaf(m, 'set'), leaf(m, 'notSet')] });

function numberFilter(f: SemanticFilter, m: string): CubeFilter {
  const finite = (v: Cell): string | null => {
    const n = coerceValue(v ?? null, 'number');
    return typeof n === 'number' && Number.isFinite(n) ? String(n) : null;
  };
  if (f.kind === 'compare') {
    const s = finite(f.value);
    if (s === null) return NOTHING(m); // not a number: the filter keeps nothing, `!=` included (compileFilter)
    if (f.op === '=') return leaf(m, 'equals', [s]);
    if (f.op === '!=') return { and: [leaf(m, 'notEquals', [s]), leaf(m, 'set')] }; // a NULL is no number
    return leaf(m, NUMBER_OP[f.op], [s]);
  }
  if (f.kind === 'in') {
    const values = f.values.map(finite).filter((s): s is string => s !== null);
    if (values.length === 0) return f.negate ? EVERYTHING(m) : NOTHING(m);
    return leaf(m, f.negate ? 'notEquals' : 'equals', values); // Cube's notEquals keeps a NULL, as `not in` does
  }
  if (f.kind === 'empty') return leaf(m, f.negate ? 'set' : 'notSet');
  if (f.kind === 'contains') throw new Refused(refuse('containsNumber', f.column));
  throw new Refused(refuse('periodNotDate', f.column));
}

function dateFilter(f: SemanticFilter, m: string, no: () => never): CubeFilter {
  const day = (v: Cell): string => isoDay(text(v)) ?? no();
  const from = (d: string): CubeFilter => leaf(m, 'afterOrOnDate', [d]); // x >= d 00:00
  const before = (d: string): CubeFilter => leaf(m, 'beforeDate', [d]); //  x <  d 00:00
  if (f.kind === 'compare') {
    const v = day(f.value);
    const kept = (x: CubeFilter): CubeFilter => ({ or: [x, leaf(m, 'notSet')] }); // a NULL compares as '': before every day
    switch (f.op) {
      case '=': return { and: [from(v), before(dayAfter(v))] };
      case '!=': return { or: [before(v), from(dayAfter(v)), leaf(m, 'notSet')] };
      case '>': return from(dayAfter(v));
      case '>=': return from(v);
      case '<': return kept(before(v));
      default: return kept(before(dayAfter(v)));
    }
  }
  if (f.kind === 'range') {
    const parts = [...(f.from ? [from(day(f.from))] : []), ...(f.to ? [before(dayAfter(day(f.to)))] : [])];
    return { and: parts.length ? parts : [leaf(m, 'set')] };
  }
  if (f.kind === 'empty') return leaf(m, f.negate ? 'set' : 'notSet');
  return no(); // a list of days, contains
}

function filterOf(f: SemanticFilter, columns: readonly LiveColumn[], model: string, names: Names): CubeFilter {
  const col = columnOf(columns.slice(), f.column);
  if (!col) throw new Refused(refuse('unknownColumn', f.column));
  if ('binary' in f && f.binary) throw new Refused(refuseLayer('layerRowPolicy', names)); // the plan refuses it first
  const no = (): never => {
    throw new Refused(refuseLayer('layerFilter', { ...names, column: col.name }));
  };
  const m = cubeMember(model, col.name);
  return col.type === 'text' ? textFilter(f, m, no) : col.type === 'number' ? numberFilter(f, m) : dateFilter(f, m, no);
}

function encode(q: SemanticQuery, model: string, columns: readonly LiveColumn[] = [], names: Names = { dataset: '', layer: 'Cube' }): SemanticRequest | LiveRefusal {
  const asked = answerColumns(q);
  if (asked.length === 0) throw new Error('[semantic] a question needs a dimension or a metric');
  if (new Set(asked).size !== asked.length) throw new Error('[semantic] a member asked twice: its rows could not be told apart');
  if (q.limit !== undefined && !(Number.isInteger(q.limit) && q.limit >= 0 && q.limit < CUBE_ROW_LIMIT)) throw new Error('[semantic] a limit must be a whole number under the row cap');
  const query: CubeQuery = { measures: [], dimensions: [], timeDimensions: [], filters: [], order: [], limit: CUBE_ROW_LIMIT, timezone: 'UTC' };
  for (const d of q.dimensions) {
    const col = columnOf(columns.slice(), d.name);
    if (!col) throw new Error(`[semantic] ${d.name} is not a dimension of this dataset`);
    if (col.type === 'date') {
      if (!d.grain) throw new Error(`[semantic] the date dimension ${d.name} needs a grain`);
      query.timeDimensions.push({ dimension: cubeMember(model, d.name), granularity: d.grain });
    } else {
      query.dimensions.push(cubeMember(model, d.name));
    }
  }
  query.measures = q.metrics.map((name) => cubeMember(model, name));
  const nonBlank: string[] = [];
  try {
    for (const f of q.where) {
      const col = columnOf(columns.slice(), f.column);
      // A value list's own "not empty" on a text dimension it lists: '' and NULL out here, whitespace out when read.
      if (q.metrics.length === 0 && f.kind === 'empty' && f.negate && col?.type === 'text' && q.dimensions.some((d) => d.name === col.name)) {
        const m = cubeMember(model, col.name);
        nonBlank.push(m);
        query.filters.push({ and: [leaf(m, 'notEquals', ['']), leaf(m, 'set')] });
        continue;
      }
      query.filters.push(filterOf(f, columns, model, names));
    }
    // "Other": every row but the kept categories', as a `not in` (the layer computes it).
    if (q.exclude) query.filters.push(filterOf({ kind: 'in', column: q.exclude.dimension, values: q.exclude.values, negate: true }, columns, model, names));
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    throw err;
  }
  query.order = q.order.map((o) => {
    if (!asked.includes(o.by)) throw new Error(`[semantic] cannot order by ${o.by}: it is not asked`);
    return [cubeMember(model, o.by), o.desc ? 'desc' : 'asc'];
  });
  const body: CubeBody = { query };
  if (q.limit !== undefined) {
    query.limit = q.limit;
    if (nonBlank.length) body.limit = q.limit; // cut again after the blanks are dropped (a short cut is asked again whole)
  }
  if (nonBlank.length) body.nonBlank = nonBlank;
  return { kind: 'semantic', body, columns: asked };
}

/** The Cube encoder: registered in ./adapters as the `cube` backend. */
export const cubeAdapter: SemanticAdapter = { encode };
