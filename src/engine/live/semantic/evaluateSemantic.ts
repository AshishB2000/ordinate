// One Live question answered by a semantic layer (semantic layer part 7, b1; docs/semantic-layer/07-portability.md
// D15, D16) — PURE apart from the injected `run`, as ../evaluate's `evaluateLive` is. The twin of that function:
// the same `LiveOutcome`, shaped by the same ../shape, so labels still come from analysis/categoryKey.
//
//   1. An answer's data-relative period: the latest day, asked as a lookup (./semanticPlan planLatest), then
//      resolved exactly as the SQL path resolves it (../evaluate resolvePeriods).
//   2. The plan's questions, each through `run` (the executor's runner: the one door, counted).
//   3. The answers read back into the rows ../shape already labels (`o_g`, `o_s`, `o_m{i}v`, `o_cr`, `o_sr`,
//      `o_nc`) and handed to `shapeChart` / `shapeMetric` with a statement that has no SQL.
//
// NO ARITHMETIC ON THE LAYER'S FIGURES. "Other" is the layer's answer to its own question, never a sum of the
// rows it returned. Ranks are the answers' own order — largest first by the first metric, then the key (code
// points, a NULL last), exactly the SQL path's rule — re-derived here, never the order rows arrived in (a layer's
// reply promises no order across pages or wrappers; ../shape says the same of SQL).
//
// One named difference from the SQL path: in a SPLIT chart "Other" ranks after the kept categories, where the SQL
// path ranks it by its total — that total is one more question, and a split already asks four (pinned by
// test-semanticParity).

import type { CivilDate, DateGrain } from '../../../analysis/categoryKey';
import { CATEGORY_CAP, OTHER_LABEL, civilFromDays, daysFromCivil } from '../../../analysis/categoryKey';
import type { Cell } from '../../../data/transforms';
import type { LiveIR, LiveRefusal } from '../liveSpec';
import { isRefusal, refuse } from '../liveSpec';
import type { CompiledQuery, LiveKey } from '../compile';
import type { LiveOutcome, LiveStep, PeriodRange } from '../evaluate';
import { resolvePeriods } from '../evaluate';
import type { LiveChart } from '../shape';
import { shapeChart, shapeMetric, toNumber } from '../shape';
import type { ChartPlan } from './semanticPlan';
import { planChart, planLatest, planMetric } from './semanticPlan';
import type { SemanticAnswer, SemanticEnv, SemanticQuery } from './semanticQuery';
import { alignRows, answerColumns } from './semanticQuery';

export type SemanticStep = LiveStep | 'other' | 'seriesRanks';

/** Asks the layer one question. A refusal (the reply's shape, from the one door) comes back as a value; a layer error throws. */
export type SemanticRunner = (q: SemanticQuery, step: SemanticStep) => Promise<SemanticAnswer | LiveRefusal>;

type Rows = unknown[][];

/** One question → its rows, positional to the query's dimensions then metrics. */
async function ask(run: SemanticRunner, q: SemanticQuery, step: SemanticStep): Promise<Rows | LiveRefusal> {
  const a = await run(q, step);
  if (isRefusal(a)) return a;
  return (a && alignRows(a.columns, a.rows, answerColumns(q))) ?? refuse('rowShape');
}

const synthetic = (columns: string[]): CompiledQuery => ({ sql: '', params: [], columns });

// ── Reading a layer's values ─────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/;

/**
 * A date dimension's value (an ISO date, or a midnight UTC timestamp, at the grain's first day) → the epoch day
 * `shapeChart` labels; null for no date; undefined when it is no such thing (refused, never relabelled).
 */
export function dayOf(raw: unknown, grain: DateGrain): number | null | undefined {
  if (raw == null) return null;
  const m = typeof raw === 'string' ? ISO_DAY.exec(raw) : null;
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = daysFromCivil(y, mo, d);
  const back = civilFromDays(day);
  if (back.y !== y || back.m !== mo || back.d !== d) return undefined;
  // The gregorian start of its bucket (categoryKey.dateBucket with no week calendar; ISO weeks start on Monday).
  const start = grain === 'year' ? daysFromCivil(y, 1, 1)
    : grain === 'quarter' ? daysFromCivil(y, 1 + 3 * Math.floor((mo - 1) / 3), 1)
      : grain === 'month' ? daysFromCivil(y, mo, 1)
        : grain === 'week' ? day - (((day + 3) % 7) + 7) % 7 : day;
  return start === day ? day : undefined;
}

function finite(raw: unknown): number | null {
  const n = toNumber(raw);
  return n !== null && Number.isFinite(n) ? n : null;
}

function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!); // code points, on purpose: a warehouse's VARCHAR order
  return out;
}

/** Code-point order, a NULL last: the SQL path's `ORDER BY key` tie-break. */
function keyCompare(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = codePoints(String(a));
  const y = codePoints(String(b));
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** Largest first by the value at `v`, an empty value last, then the key at `k`: compile.byValue. */
function byValue(rows: Rows, v: number, k = 0): Rows {
  return rows.slice().sort((a, b) => {
    const x = finite(a[v]);
    const y = finite(b[v]);
    if (x === null || y === null) return x === y ? keyCompare(a[k], b[k]) : x === null ? 1 : -1;
    return y - x || keyCompare(a[k], b[k]);
  });
}

const json = (v: unknown): string => JSON.stringify(v ?? null);

// ── The chart ────────────────────────────────────────────────────────────────

/** The answers → the rows ../shape reads, in its column layout. */
async function chartRows(ir: LiveIR, plan: ChartPlan, run: SemanticRunner, grain: DateGrain | undefined): Promise<{ rows: Rows; columns: string[] } | LiveRefusal> {
  const text = grain === undefined;
  const key = (raw: unknown): unknown => (text ? raw : dayOf(raw, grain!));
  const ranked = await ask(run, plan.ranks, 'chart');
  if (isRefusal(ranked)) return ranked;
  const ms = ir.measures.map((_m, i) => `o_m${i}v`);

  if (!ir.series) {
    let rows = ranked.map((r) => [key(r[0]), ...r.slice(1)]);
    if (rows.some((r) => r[0] === undefined)) return refuse('rowShape');
    if (!text) rows.sort((a, b) => keyCompare(a[0], b[0]));
    const folded = text && rows.length > CATEGORY_CAP;
    if (text) rows = byValue(rows, 1).slice(0, CATEGORY_CAP);
    if (folded) {
      const other = await ask(run, plan.other!(rows.map((r) => r[0] as Cell)), 'other');
      if (isRefusal(other)) return other;
      if (other.length !== 1) return refuse('rowShape');
      rows = byValue([...rows, [OTHER_LABEL, ...other[0]]], 1); // ranked by its own value, as the SQL path ranks it
    }
    if (ir.top !== undefined) rows = rows.slice(0, ir.top); // unsplit, the SQL path cuts in the statement
    const nc = folded ? CATEGORY_CAP + 1 : rows.length;
    return { rows: rows.map((r, i) => [...r, i + 1, ...(text ? [nc] : [])]), columns: ['o_g', ...ms, 'o_cr', ...(text ? ['o_nc'] : [])] };
  }

  // A split: categories ranked by their totals, series by theirs (a text split) or by key (a number split).
  let cells: Rows;
  let other: Rows = [];
  const catRank = new Map<string, number>();
  let nc = 0;
  if (text) {
    const kept = byValue(ranked, 1).slice(0, CATEGORY_CAP).map((r) => r[0]);
    kept.forEach((k, i) => catRank.set(json(k), i + 1));
    nc = ranked.length > CATEGORY_CAP ? CATEGORY_CAP + 1 : ranked.length;
    const c = await ask(run, plan.cells!(kept as Cell[]), 'chart');
    if (isRefusal(c)) return c;
    cells = c;
    if (ranked.length > CATEGORY_CAP) {
      const o = await ask(run, plan.other!(kept as Cell[]), 'other');
      if (isRefusal(o)) return o;
      other = o.map((r) => [OTHER_LABEL, ...r]);
      catRank.set(json(OTHER_LABEL), CATEGORY_CAP + 1);
    }
  } else {
    cells = ranked.map((r) => [key(r[0]), ...r.slice(1)]);
    if (cells.some((r) => r[0] === undefined)) return refuse('rowShape');
    [...new Set(cells.map((r) => json(r[0])))].map((k) => JSON.parse(k) as unknown).sort(keyCompare).forEach((k, i) => catRank.set(json(k), i + 1));
  }
  const all = [...cells, ...other];
  const seriesRank = new Map<string, number>();
  if (plan.seriesRanks) {
    const s = await ask(run, plan.seriesRanks, 'seriesRanks');
    if (isRefusal(s)) return s;
    byValue(s, 1).forEach((r, i) => seriesRank.set(json(r[0]), i + 1));
  } else {
    // −0 and 0 are one series (compile.compileChart); JSON writes both as 0.
    [...new Set(all.map((r) => json(r[1])))].map((k) => JSON.parse(k) as unknown).sort(keyCompare).forEach((k, i) => seriesRank.set(json(k), i + 1));
  }
  const rows: Rows = [];
  for (const [g, s, v] of all) {
    const cr = catRank.get(json(g));
    const sr = seriesRank.get(json(s));
    if (cr === undefined || sr === undefined) return refuse('rowShape'); // a cell the layer was not asked for
    rows.push([g, s, v, cr, sr, ...(text ? [nc] : [])]);
  }
  return { rows, columns: ['o_g', 'o_s', 'o_m0v', 'o_cr', 'o_sr', ...(text ? ['o_nc'] : [])] };
}

/**
 * Answer one Live question from a semantic layer: refusals come back as values, a layer error is the
 * runner's to throw (the executor serves the last cached answer, labelled stale, or a typed error).
 */
export async function evaluateSemantic(ir: LiveIR, env: SemanticEnv, run: SemanticRunner): Promise<LiveOutcome> {
  let q = ir;
  let warnings: string[] = [];
  let periodLabels: string[] = [];
  let periodRanges: PeriodRange[] = [];
  // Refused before anything is asked: a refusal never costs a counted question (the periods resolve to ranges).
  const asIfResolved = { ...ir, filters: ir.filters.filter((f) => f.kind !== 'latest') };
  const pre = ir.kind === 'metric' ? planMetric(asIfResolved, env) : planChart(asIfResolved, env);
  if (isRefusal(pre)) return pre;
  const lp = planLatest(ir, env);
  if (isRefusal(lp)) return lp;
  if (lp.queries.length) {
    const latest: Record<string, CivilDate | null> = {};
    for (const { column, query } of lp.queries) {
      const rows = await ask(run, query, 'latest');
      if (isRefusal(rows)) return rows;
      const day = rows.length === 0 ? null : rows.length === 1 ? dayOf(rows[0][0], 'day') : undefined;
      if (day === undefined) return refuse('rowShape');
      latest[column] = day === null ? null : civilFromDays(day);
    }
    ({ ir: q, warnings, periodLabels, periodRanges } = resolvePeriods(ir, latest));
  }
  const dated = { warnings, periodLabels, ...(periodRanges.length ? { periodRanges } : {}) };

  if (q.kind === 'metric') {
    const p = planMetric(q, env);
    if (isRefusal(p)) return p;
    const rows = await ask(run, p.query, 'metric');
    if (isRefusal(rows)) return rows;
    const value = shapeMetric(rows, synthetic(['o_m0v']), q);
    if (isRefusal(value)) return value;
    return { ok: true, kind: 'metric', value, ...dated };
  }

  const p = planChart(q, env);
  if (isRefusal(p)) return p;
  const cat = q.category!;
  const grain = cat.kind === 'date' ? cat.grain : undefined;
  const got = await chartRows(q, p, run, grain);
  if (isRefusal(got)) return got;
  const key: LiveKey = grain ? { kind: 'date', grain } : { kind: 'text' };
  const chart: LiveChart | LiveRefusal = shapeChart(got.rows, synthetic(got.columns), q, key, env.columns);
  if (isRefusal(chart)) return chart;
  return { ok: true, kind: 'chart', chart, ...dated };
}
