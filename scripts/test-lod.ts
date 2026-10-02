// Self-check for level-of-detail expressions: the grammar (formulaParse), the
// JS reference (formula/lod.ts), the query-time pass (analysis/lodQuery.ts),
// the metric-formula form, and the catalog entries.
//
// Hand-computed fixtures on purpose: what an LOD must get right — which rows
// share a group, that `null` and `''` are two groups, that an ordinary filter
// leaves a FIXED total alone while a context filter narrows it — is a property
// no second implementation can vouch for. The SQL twin is held to this file's
// reference by scripts/test-lod-resident.ts.
//
//   npm run build:ts && node scripts/test-lod.js

import { ok, finish } from './selfcheck';
import { compile } from '../src/formula/formula';
import * as lod from '../src/formula/lod';
import * as lq from '../src/analysis/lodQuery';
import { LOD_DOCS } from '../src/formula/formulaDocs';
import { applyPipeline } from '../src/data/transforms';
import type { Cell, FilterStep, TransformStep } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';
import { compileMetricFormula, evaluateMetricFormula } from '../src/analysis/metricFormula';
import { mergeDashboardFilters } from '../src/analysis/dashboardFilters';
import { sanitizeFilters } from '../src/analysis/visuals';

const same = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const show = (v: unknown): string => JSON.stringify(v);

// region · customer · order · sales · day
//   East  a     o1  10  2024-03-01
//   East  a     o2  20  2024-01-15
//   East  b     o3  30  2024-02-02
//   West  c     o4  40  2024-05-05
//   West  c     o5  —   2024-04-04
//   West  ''    o6  50  2024-06-06
//   —     d     o7  60  2024-07-07
//   East  —     o8   5  2024-08-08
const COLS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'customer', type: 'text' },
  { name: 'order', type: 'text' },
  { name: 'sales', type: 'number' },
  { name: 'day', type: 'date' },
];
const ROWS: Cell[][] = [
  ['East', 'a', 'o1', 10, '2024-03-01'],
  ['East', 'a', 'o2', 20, '2024-01-15'],
  ['East', 'b', 'o3', 30, '2024-02-02'],
  ['West', 'c', 'o4', 40, '2024-05-05'],
  ['West', 'c', 'o5', null, '2024-04-04'],
  ['West', '', 'o6', 50, '2024-06-06'],
  [null, 'd', 'o7', 60, '2024-07-07'],
  ['East', null, 'o8', 5, '2024-08-08'],
];

function values(expr: string, vizDims?: string[], rows: Cell[][] = ROWS): unknown[] {
  const c = compile(expr);
  if (!c.ok) throw new Error(`${expr}: ${c.error}`);
  return lod.evaluateTable(c.fn, COLS, rows, { vizDims });
}

// ── 1. Grammar ───────────────────────────────────────────────────────────────
{
  const c = compile('[sales] / {fixed [region], customer : sum([sales])}');
  const l = c.ok ? c.fn.lods[0] : null;
  ok('parse: keywords are case-insensitive, bare and bracketed dimensions both read', !!l && l.kind === 'fixed' &&
    show(l.dims.map((d) => d.name)) === '["region","customer"]' && l.agg === 'sum' && l.argCol === 'sales', show(c));
  ok('parse: dimensions are refs too, so an unknown one reaches the editor', c.ok && show(c.fn.refs.slice().sort()) === '["customer","region","sales"]');
  ok('parse: the LOD span covers the braces', !!l && l.start === 10 && l.end === 51, show(l && [l.start, l.end]));
  const none = compile('{FIXED : COUNT([order])}');
  ok('parse: FIXED with no dimensions', none.ok && none.fn.lods[0].dims.length === 0);
  const computed = compile('{INCLUDE [customer] : AVG([sales] * 2)}');
  ok('parse: a computed argument has no argCol (the resident path declines it)', computed.ok && computed.fn.lods[0].argCol === null);
  const nested = compile('{FIXED [region] : MAX({FIXED [customer] : SUM([sales])})}');
  ok('parse: a nested LOD is recorded first and the outer one says so', nested.ok && nested.fn.lods.length === 2 &&
    !nested.fn.lods[0].nested && nested.fn.lods[1].nested);

  const err = (src: string): { error: string; at?: { start: number; end: number } } => {
    const r = compile(src);
    return r.ok ? { error: 'compiled' } : r;
  };
  const e1 = err('{BOGUS [region] : SUM([sales])}');
  ok('parse error: an unknown keyword, underlined', /FIXED, INCLUDE or EXCLUDE/.test(e1.error) && show(e1.at) === '{"start":1,"end":6}', show(e1));
  const e2 = err('{FIXED [region] SUM([sales])}');
  ok('parse error: a missing colon, underlined at what came instead', /Expected ":"/.test(e2.error) && show(e2.at) === '{"start":16,"end":19}', show(e2));
  const e3 = err('{FIXED [region] : MEDIAN([sales])}');
  ok('parse error: an aggregate the LOD does not support', /SUM, AVG, MIN, MAX, COUNT or COUNTD/.test(e3.error) && show(e3.at) === '{"start":18,"end":24}', show(e3));
  const e4 = err('{FIXED [region] : SUM([sales])');
  ok('parse error: an unclosed brace', /Expected "}"/.test(e4.error) && !!e4.at, show(e4));
  const e5 = err('[a] : [b]');
  ok('parse error: a colon outside an LOD', /Unexpected token: :/.test(e5.error), show(e5));
}

// ── 2. FIXED / INCLUDE / EXCLUDE against hand-computed values ─────────────────
{
  // East 10+20+30+5 = 65, West 40+50 = 90, the null region 60.
  ok('FIXED [region] SUM', same(values('{FIXED [region] : SUM([sales])}'), [65, 65, 65, 90, 90, 90, 60, 65]),
    show(values('{FIXED [region] : SUM([sales])}')));
  ok('share of region', same(values('[sales] / {FIXED [region] : SUM([sales])}'),
    [10 / 65, 20 / 65, 30 / 65, 40 / 90, null, 50 / 90, 1, 5 / 65]));
  ok('FIXED with no dimensions is the whole table', same(values('{FIXED : SUM([sales])}'), new Array(8).fill(215)));
  // a 30 · b 30 · c 40 (o5 has no sales) · '' 50 · d 60 · null 5 — '' and null are TWO groups.
  ok('FIXED [customer]: null and empty are distinct groups', same(values('{FIXED [customer] : SUM([sales])}'),
    [30, 30, 30, 40, 40, 50, 60, 5]));
  ok('AVG skips the missing figure', same(values('{FIXED [region] : AVG([sales])}'), [65 / 4, 65 / 4, 65 / 4, 45, 45, 45, 60, 65 / 4]));
  ok('MIN / MAX numeric', same(values('{FIXED [region] : MIN([sales])}'), [5, 5, 5, 40, 40, 40, 60, 5]) &&
    same(values('{FIXED [region] : MAX([sales])}'), [30, 30, 30, 50, 50, 50, 60, 30]));
  ok('COUNT counts non-empty values', same(values('{FIXED [region] : COUNT([sales])}'), [4, 4, 4, 2, 2, 2, 1, 4]));
  ok('COUNTD counts distinct non-empty values', same(values('{FIXED [region] : COUNTD([customer])}'), [2, 2, 2, 1, 1, 1, 1, 2]));
  ok('first order date per customer (MIN of dates, as written)', same(values('{FIXED [customer] : MIN([day])}'),
    ['2024-01-15', '2024-01-15', '2024-02-02', '2024-04-04', '2024-04-04', '2024-06-06', '2024-07-07', '2024-08-08']));
  ok('customers with more than 1 order', same(values('{FIXED [customer] : COUNTD([order])} > 1'),
    [true, true, false, true, true, false, false, false]));
  ok('a nested LOD: each region\'s biggest customer total',
    same(values('{FIXED [region] : MAX({FIXED [customer] : SUM([sales])})}'), [30, 30, 30, 50, 50, 50, 60, 30]));

  // INCLUDE adds to the visual's dimensions; EXCLUDE removes from them.
  ok('INCLUDE [customer] in a region visual groups by region × customer',
    same(values('{INCLUDE [customer] : SUM([sales])}', ['region']), [30, 30, 30, 40, 40, 50, 60, 5]));
  ok('INCLUDE outside a visual is FIXED on its own dimensions',
    same(values('{INCLUDE [region] : SUM([sales])}'), values('{FIXED [region] : SUM([sales])}')));
  ok('EXCLUDE [customer] in a region × customer visual is the region total',
    same(values('{EXCLUDE [customer] : SUM([sales])}', ['region', 'customer']), [65, 65, 65, 90, 90, 90, 60, 65]));
  ok('EXCLUDE outside a visual is the whole table', same(values('{EXCLUDE [region] : SUM([sales])}'), new Array(8).fill(215)));
  ok('lodGroupDims', show(lod.lodGroupDims({ kind: 'include', dims: [{ name: 'b', start: 0, end: 0 }] }, ['a', 'b'])) === '["a","b"]' &&
    show(lod.lodGroupDims({ kind: 'exclude', dims: [{ name: 'b', start: 0, end: 0 }] }, ['a', 'b'])) === '["a"]');
}

// ── 3. Errors ────────────────────────────────────────────────────────────────
{
  const c = compile('[sales] / {FIXED [Regon] : SUM([sales])}');
  const p = c.ok ? lod.lodDimProblem(c.fn, COLS.map((x) => x.name)) : null;
  ok('an unknown dimension is named, with the close match', !!p &&
    p.error === 'LOD dimension [Regon] is not a column in this dataset. Did you mean [region]?' && show(p.at) === '{"start":17,"end":24}', show(p));
  const far = compile('{FIXED [zzzzzz] : SUM([sales])}');
  const p2 = far.ok ? lod.lodDimProblem(far.fn, COLS.map((x) => x.name)) : null;
  ok('no suggestion when nothing is close', !!p2 && p2.error === 'LOD dimension [zzzzzz] is not a column in this dataset.', show(p2));
  const out = applyPipeline({ columns: COLS, rows: ROWS }, [{ type: 'calculated_field', name: 'x', expression: '{FIXED [Regon] : SUM([sales])}' }]);
  ok('a calculated field with an unknown dimension is skipped with that message, not computed as one group',
    out.columns.length === COLS.length && out.warnings.some((w) => /\[Regon\].*Did you mean \[region\]/.test(w)), show(out.warnings));
  const m = compileMetricFormula('sum([sales]) / sum({FIXED [Regon] : SUM([sales])})', COLS.map((x) => x.name));
  ok('a metric formula reports it too, positioned in the metric\'s own text', !m.ok && /Did you mean \[region\]/.test(m.error) &&
    !!m.at && 'sum([sales]) / sum({FIXED [Regon] : SUM([sales])})'.slice(m.at.start, m.at.end) === '[Regon]', show(m));
}

// ── 4. The pipeline stores it; a calc field gets every row's value ───────────
const STEPS: TransformStep[] = [{ type: 'calculated_field', name: 'share', expression: '[sales] / {FIXED [region] : SUM([sales])}' }];
const PREPARED = applyPipeline({ columns: COLS, rows: ROWS }, STEPS);
{
  const si = PREPARED.columns.findIndex((c) => c.name === 'share');
  ok('the stored field is the share of the WHOLE region, typed number', si === 5 && PREPARED.columns[si].type === 'number' &&
    same(PREPARED.rows.map((r) => r[si]), [10 / 65, 20 / 65, 30 / 65, 40 / 90, null, 50 / 90, 1, 5 / 65]), show(PREPARED.rows.map((r) => r[si])));
}

// ── 5. Filter order: context → LOD → ordinary → the visual ──────────────────
{
  const enc = { category: 'region', values: [{ column: 'share', aggregation: 'sum' as const }] };
  const big: FilterStep = { type: 'filter', column: 'sales', op: '>=', value: 20 };
  const run = (filters: FilterStep[]) => lq.lodVizData(PREPARED.columns, PREPARED.rows, STEPS, enc, filters).data;
  const plain = run([]);
  ok('no filter: every region\'s shares sum to its whole', show(plain.labels) === '["East","West",""]' &&
    same(plain.series[0].values, [10 / 65 + 20 / 65 + 30 / 65 + 5 / 65, 40 / 90 + 50 / 90, 1]), show(plain));
  const after = run([big]);
  ok('an ORDINARY filter runs after the LOD: East keeps 20 and 30 of its 65', show(after.labels) === '["East","West",""]' &&
    same(after.series[0].values, [20 / 65 + 30 / 65, 40 / 90 + 50 / 90, 1]), show(after));
  const before = run([{ ...big, context: true }]);
  ok('a CONTEXT filter runs before it: East\'s total becomes 50, its shares sum to 1', show(before.labels) === '["East","West",""]' &&
    same(before.series[0].values, [20 / 50 + 30 / 50, 40 / 90 + 50 / 90, 1]), show(before));

  ok('needsLodPass: FIXED under ordinary filters keeps the stored column (and the fast paths)', !lq.needsLodPass(STEPS, [big], ['region']));
  ok('needsLodPass: a context filter needs the pass', lq.needsLodPass(STEPS, [{ ...big, context: true }], ['region']));
  const inc: TransformStep[] = [{ type: 'calculated_field', name: 'c', expression: '{INCLUDE [customer] : SUM([sales])}' }];
  ok('needsLodPass: INCLUDE needs it inside a visual, not outside one', lq.needsLodPass(inc, [], ['region']) && !lq.needsLodPass(inc, [], []));
  ok('needsLodPass: a dataset with no LOD field never needs it', !lq.needsLodPass([], [{ ...big, context: true }], ['region']));

  // A downstream field follows its recomputed input.
  const chain: TransformStep[] = [
    { type: 'calculated_field', name: 'rt', expression: '{FIXED [region] : SUM([sales])}' },
    { type: 'calculated_field', name: 'sh', expression: '[sales] / [rt]' },
  ];
  const prep = applyPipeline({ columns: COLS, rows: ROWS }, chain);
  const ctx = lq.lodVizData(prep.columns, prep.rows, chain, { category: 'region', values: [{ column: 'sh', aggregation: 'sum' }] },
    [{ ...big, context: true }]).data;
  ok('a field computed FROM an LOD field is recomputed after it', same(ctx.series[0].values, [20 / 50 + 30 / 50, 40 / 90 + 50 / 90, 1]), show(ctx));

  // INCLUDE in a visual: avg over (region × customer) totals, per region.
  const incPrep = applyPipeline({ columns: COLS, rows: ROWS }, inc);
  const incViz = lq.lodVizData(incPrep.columns, incPrep.rows, inc, { category: 'region', values: [{ column: 'c', aggregation: 'max' }] }, []).data;
  ok('INCLUDE inside a visual groups by the visual\'s dimension too', same(incViz.series[0].values, [30, 50, 60]), show(incViz));

  // The flag survives every sanitiser and the dashboard merge keeps both kinds.
  const clean = sanitizeFilters([{ ...big, context: true }, { ...big, context: 'yes' }]);
  ok('sanitize keeps context:true and drops anything else', clean[0].context === true && clean[1].context === undefined, show(clean));
  ok('the dashboard merge keeps a context and an ordinary copy of one predicate', mergeDashboardFilters([big], [{ ...big, context: true }]).length === 2);
}

// ── 6. Metrics: a KPI, and an LOD inside a ratio metric ─────────────────────
{
  const ctxWest: FilterStep = { type: 'filter', column: 'region', op: '=', value: 'West', context: true };
  const west: FilterStep = { type: 'filter', column: 'region', op: '=', value: 'West' };
  ok('a KPI over the stored share under a context filter is recomputed', Object.is(
    lq.lodMetricValue(PREPARED.columns, PREPARED.rows, STEPS, { column: 'share', aggregation: 'sum' }, [ctxWest]), 40 / 90 + 50 / 90));

  // "West's share of the total": sum(sales) / max({FIXED : SUM([sales])}).
  const expr = 'sum(sales) / max({FIXED : SUM([sales])})';
  const prog = compileMetricFormula(expr, COLS.map((c) => c.name));
  ok('the ratio metric compiles to two aggregates, one over an LOD', prog.ok &&
    show(prog.program.aggregates.map((a) => [a.aggregation, a.column])) === '[["sum","sales"],["max","{FIXED : SUM([sales])}"]]', show(prog));
  const ratio = (filters: FilterStep[]): number | null => {
    if (!prog.ok) return null;
    const vals = new Map<string, number | null>();
    for (const a of prog.program.aggregates) {
      vals.set(a.ref, lq.lodMetricValue(COLS, ROWS, [], { column: a.column, aggregation: a.aggregation }, filters));
    }
    return evaluateMetricFormula(prog.program, vals);
  };
  ok('the LOD ignores an ordinary filter: West is 90 of 215', Object.is(ratio([west]), 90 / 215), String(ratio([west])));
  ok('a context filter narrows it: West is all of West', Object.is(ratio([ctxWest]), 1), String(ratio([ctxWest])));
  ok('a malformed LOD in a metric is a positioned parse error', (() => {
    const bad = compileMetricFormula('sum({FIXED [region] SUM([sales])})', COLS.map((c) => c.name));
    return !bad.ok && /Expected ":"/.test(bad.error) && !!bad.at;
  })());
}

// ── 7. Helpers and the catalog ───────────────────────────────────────────────
{
  ok('lodColumnRefs: the column refs inside braces, functions and keywords skipped',
    show(lod.lodColumnRefs('[x] + {FIXED [Region], Seg : SUM(round([Sales]) * qty)}')) === '["Region","Seg","Sales","qty"]');
  ok('isLodExpression: one LOD and nothing else', lod.isLodExpression(' {FIXED [r] : SUM([s])} ') &&
    !lod.isLodExpression('{FIXED [r] : SUM([s])} + 1') && !lod.isLodExpression('[s]'));
  ok('the catalog has the three keywords and the three named recipes',
    show(LOD_DOCS.map((d) => d.name)) === '["fixed","include","exclude","share of region","first order date per customer","customers with more than 3 orders"]');
  const bad = LOD_DOCS.filter((d) => { const r = compile(d.example); return !r.ok || r.fn.lods.length === 0 || r.fn.lods[0].kind !== (d.kind === 'keyword' ? d.name : r.fn.lods[0].kind); });
  ok('every catalog example compiles to an LOD of its own kind', bad.length === 0, bad.map((d) => d.name).join(', '));
  ok('every recipe inserts its example', LOD_DOCS.filter((d) => d.kind === 'recipe').every((d) => d.insert === d.example));
}

finish();
