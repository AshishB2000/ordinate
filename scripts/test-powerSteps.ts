// Self-check for the ten power prepare steps' JS side: the sanitizer and the
// regex subset, every step's edge cases (empty input, missing columns, date
// failures, non-unique lookup keys, union mapping), the per-step row counts,
// and — through the REAL dataset store on a temp userData — references between
// datasets: union/lookup loading, self-reference and cycles, a deleted
// reference, the counts persisted with the record, the editor previews,
// lineage and the dependents list. The SQL twins are held to these by
// scripts/test-powerStepsDuck.ts.
//
// It also pins that a pipeline of the ORIGINAL eight step types produces
// byte-identical output to before this feature: the hash below was taken from
// the unchanged build.

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Cell, TableData, TransformStep } from '../src/data/transforms';

const crypto: typeof import('crypto') = require('crypto');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // ponytail: the electron stub pattern of test-datasets.ts

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-power-steps-'));
process.on('exit', () => { try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp */ } });
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_name: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { applyPipeline, sanitizeSteps } = transforms;
const { checkRegex }: typeof import('../src/data/regexSubset') = require('../src/data/regexSubset');
const { checkPowerStep }: typeof import('../src/data/stepsSanitize') = require('../src/data/stepsSanitize');
const clean: typeof import('../src/data/stepsClean') = require('../src/data/stepsClean');
const combine: typeof import('../src/data/stepsCombine') = require('../src/data/stepsCombine');
const { keyOf }: typeof import('../src/analysis/joinJs') = require('../src/analysis/joinJs');
const { compile }: typeof import('../src/formula/formula') = require('../src/formula/formula');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const { loadStepRefs }: typeof import('../src/data/stepRefs') = require('../src/data/stepRefs');
const { summarize }: typeof import('../src/data/datasetSummary') = require('../src/data/datasetSummary');
const { buildGraph, focus }: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
const preview: typeof import('../src/ipc/preparePower') = require('../src/ipc/preparePower');

const ID_A = '33333333-3333-4333-8333-333333333333';

const T: TableData = {
  columns: [
    { name: 'region', type: 'text' }, { name: 'sku', type: 'text' },
    { name: 'units', type: 'number' }, { name: 'day', type: 'text' }, { name: 'tags', type: 'text' },
  ],
  rows: [
    ['East', '007', 3, '2024-02-09', 'a,b'],
    ['West', '012', 5, '2024-02-30', 'x'],
    ['East', '007', 1, 'abc', null],
    ['North', '900', null, '', 'p,q,r'],
  ],
};
const EMPTY: TableData = { columns: T.columns, rows: [] };
const run = (steps: unknown[], src: TableData = T, ctx?: any) => applyPipeline(src, steps as TransformStep[], ctx);
const col = (t: { columns: any[]; rows: Cell[][] }, name: string): Cell[] => {
  const i = t.columns.findIndex((c) => c.name === name);
  return t.rows.map((r) => r[i]);
};

async function main(): Promise<void> {
  // ── 0. old pipelines are byte-identical ───────────────────────────────────
  {
    const SRC: TableData = {
      columns: [
        { name: 'city', type: 'text' }, { name: 'sku', type: 'text' },
        { name: 'units', type: 'number' }, { name: 'price', type: 'number' },
        { name: 'day', type: 'date' }, { name: 'note', type: 'text' },
      ],
      rows: [
        ['Paris', '007', 3, 2.5, '2024-01-05', ' a '],
        ['Berlin', '012', 5, 1.25, '2024-02-10', ''],
        ['Paris', '007', 3, 2.5, '2024-01-05', ' a '],
        ['Tokyo', '900', null, 10, '2023-12-31', null],
        ['Berlin', '049', 1, 0.1, '2024-03-01', '  '],
        ['', '100', 7, 3, null, 'z'],
      ],
    };
    const CASES: unknown[][] = [
      [],
      [{ type: 'filter', column: 'units', op: '>', value: 2 }],
      [{ type: 'filter', column: 'city', op: 'in', values: ['Paris', 'Tokyo'] }],
      [{ type: 'filter', column: 'city', op: 'not in', values: ['Paris'] }],
      [{ type: 'filter', column: 'note', op: 'is_empty' }],
      [{ type: 'filter', column: 'sku', op: 'contains', value: '0' }],
      [{ type: 'calculated_field', name: 'rev', expression: '[units] * [price]' }],
      [{ type: 'calculated_field', name: 'code', expression: 'concat("0", [sku])' }],
      [{ type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'units', fn: 'sum', as: 's' }, { column: 'price', fn: 'avg', as: 'a' }, { column: 'note', fn: 'count', as: 'n' }] }],
      [{ type: 'dedupe' }],
      [{ type: 'dedupe', columns: ['city', 'nope'] }],
      [{ type: 'fill_empty', column: 'units', value: 0 }],
      [{ type: 'fill_empty', column: 'note', value: 'none' }],
      [{ type: 'trim' }, { type: 'trim', column: 'note' }],
      [{ type: 'drop_column', column: 'price' }, { type: 'rename_column', from: 'units', to: 'qty' }],
      [{ type: 'filter', column: 'nope', op: '=', value: 1 }, { type: 'frobnicate' }],
      [{ type: 'calculated_field', name: 'x', expression: '1 +' }, { type: 'rename_column', from: 'city', to: ' ' }],
    ];
    const out = CASES.map((steps) => {
      const r = run(steps, SRC);
      return JSON.stringify({ columns: r.columns, rows: r.rows, rowCount: r.rowCount, warnings: r.warnings });
    });
    ok('the original eight step types give byte-identical output',
      crypto.createHash('sha256').update(out.join('\n')).digest('hex') === '970730d60d839c8946d331170153d16ac072534a975478dc23dd67e0216b2cd0');
    const r = run(CASES[1], SRC);
    ok('…and now also report their row counts', JSON.stringify(r.stepCounts) === JSON.stringify([{ before: 6, after: 4 }]));
  }

  // ── 1. the regex subset ───────────────────────────────────────────────────
  for (const [p, why] of [
    ['(?=a)', 'lookahead'], ['(?<=a)b', 'lookbehind'], ['(a)\\1', 'backreference'], ['(?<n>a)', 'named group'],
    ['\\bword', 'word boundary'], ['\\u0041', '\\u escape'], ['a*', 'matches empty'], ['x|', 'matches empty'],
    ['[]a]', 'empty class'], ['[[:alpha:]]', 'POSIX class'], ['a{2000}', 'repeat over 1000'], ['a{', 'stray {'],
    ['(a', 'unclosed ('], ['a)', 'unmatched )'], ['(?i)a', 'inline flag'], ['', 'empty'],
  ] as const) {
    ok(`regex subset refuses ${why}: ${p}`, !checkRegex(p).ok);
  }
  for (const p of ['[,;]\\s*', '(a|b)+', '\\d{2,3}', 'x.y', '^0+', '[a-z]+\\.']) ok(`regex subset accepts ${p}`, checkRegex(p).ok);
  {
    const r = checkRegex('(a|b).\\s');
    ok('groups become non-capturing and . / \\s are spelled out for RE2', r.ok && r.re2.startsWith('(?:a|b)[^') && r.re2.includes('\\x{00a0}'),
      JSON.stringify(r));
  }

  // ── 2. the sanitizer ──────────────────────────────────────────────────────
  const valid: unknown[] = [
    { type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'rows' },
    { type: 'unpivot', columns: ['units'] },
    { type: 'pivot', key: 'region', value: 'units', fn: 'sum', groupBy: [] },
    { type: 'parse_date', column: 'day', format: 'DD-MMM-YYYY HH:mm' },
    { type: 'dedupe_key', columns: ['sku'], keep: 'max', by: 'units' },
    { type: 'replace_values', column: 'sku', mode: 'regex', rules: [{ from: '^0+', to: '' }] },
    { type: 'conditional_column', name: 'c', rules: [{ when: { column: 'units', op: '>', value: 2 }, then: 5 }] },
    { type: 'union', datasetId: ID_A },
    { type: 'lookup_join', datasetId: ID_A, leftKey: 'sku', rightKey: 'sku', columns: ['x'] },
    { type: 'window', fn: 'lag', as: 'p', column: 'units', offset: 5000 },
  ];
  const kept = sanitizeSteps(valid);
  ok('every power step type survives sanitizeSteps', kept.length === valid.length, JSON.stringify(kept.map((s) => s.type)));
  ok('a conditional "then" number is kept as text', (kept[6] as any).rules[0].then === '5');
  ok('a lag offset is clamped to 1000', (kept[9] as any).offset === 1000);
  ok('split into columns defaults to two parts', (sanitizeSteps([{ type: 'split_column', column: 'a', mode: 'delimiter', delimiter: ',' }])[0] as any).count === 2);
  const refused: Array<[unknown, RegExp]> = [
    [{ type: 'split_column', column: 'a', mode: 'regex', pattern: '(?=x)', into: 'rows' }, /lookaround/],
    [{ type: 'split_column', column: 'a', mode: 'delimiter', delimiter: '', into: 'rows' }, /delimiter/],
    [{ type: 'split_column', column: 'a', mode: 'position', positions: [3, 2], into: 'rows' }, /increasing/],
    [{ type: 'parse_date', column: 'd', format: 'YYYY-DD-MM' }, /unsupported format/],
    [{ type: 'dedupe_key', columns: ['a'], keep: 'max' }, /rank by/],
    [{ type: 'replace_values', column: 'a', mode: 'contains', rules: [{ from: '', to: 'x' }] }, /text to find/],
    [{ type: 'union', datasetId: '../../etc' }, /no dataset/],
    [{ type: 'lookup_join', datasetId: ID_A, leftKey: 'a', rightKey: 'b', columns: [] }, /no columns/],
    [{ type: 'window', fn: 'ntile', as: 'x' }, /unknown function/],
    [{ type: 'pivot', key: 'a', value: 'b', fn: 'median', groupBy: [] }, /aggregation/],
  ];
  for (const [raw, why] of refused) {
    const r = checkPowerStep(raw as Record<string, unknown>);
    ok(`refused with a reason: ${String(why)}`, typeof r === 'string' && why.test(r), String(r));
    ok(`…and dropped by sanitizeSteps (${String(why)})`, sanitizeSteps([raw]).length === 0);
  }

  // ── 3. empty input and missing columns ────────────────────────────────────
  for (const s of valid) {
    const r = run([s], EMPTY, { tables: { [ID_A]: T } });
    ok(`${(s as any).type} over an empty table: no throw, 0 → ${r.rowCount} rows`,
      Array.isArray(r.rows) && JSON.stringify(r.stepCounts) === JSON.stringify([{ before: 0, after: r.rowCount }]));
  }
  const missing: Array<[unknown, string]> = [
    [{ type: 'split_column', column: 'nope', mode: 'delimiter', delimiter: ',', into: 'rows' }, 'Split skipped: unknown column "nope"'],
    [{ type: 'pivot', key: 'nope', value: 'units', fn: 'sum', groupBy: [] }, 'Pivot skipped: unknown column "nope"'],
    [{ type: 'parse_date', column: 'nope', format: 'YYYY-MM-DD' }, 'Parse dates skipped: unknown column "nope"'],
    [{ type: 'replace_values', column: 'nope', mode: 'exact', rules: [{ from: 'a', to: 'b' }] }, 'Replace skipped: unknown column "nope"'],
    [{ type: 'window', fn: 'running_sum', as: 'r', column: 'nope' }, 'Window skipped: unknown column "nope"'],
    [{ type: 'conditional_column', name: 'c', rules: [{ when: { column: 'nope', op: '=', value: 1 }, then: 'x' }] }, 'Conditional column skipped: unknown column "nope"'],
  ];
  for (const [s, w] of missing) {
    const r = run([s]);
    ok(`missing column skips with a warning: ${w}`, r.warnings.includes(w) && JSON.stringify(r.rows) === JSON.stringify(T.rows), JSON.stringify(r.warnings));
  }

  // ── 4. dates ──────────────────────────────────────────────────────────────
  {
    const r = run([{ type: 'parse_date', column: 'day', format: 'YYYY-MM-DD' }]);
    ok('Feb 30 and text fail to null; an empty cell stays null', JSON.stringify(col(r, 'day')) === '["2024-02-09",null,null,null]');
    ok('the parsed column is declared date', r.columns[3].type === 'date');
    const p = clean.parseDatePreview(T, { type: 'parse_date', column: 'day', format: 'YYYY-MM-DD' });
    ok('the preview counts failures and lists them', p.parsed === 1 && p.failed === 2 && p.empty === 1 &&
      JSON.stringify(p.samples) === '["2024-02-30","abc"]', JSON.stringify(p));
    const plan = clean.planDateFormat('DD-MMM-YYYY HH:mm');
    ok('month names, any case; 24:00 fails', clean.parseDateCell('09-feb-2024 13:05', plan) === '2024-02-09 13:05:00' &&
      clean.parseDateCell('09-FEB-2024 24:00', plan) === null && clean.parseDateCell('09-Sept-2024 10:00', plan) === null);
    const ymd = clean.planDateFormat('YYYY-MM-DD');
    ok('leap years are the proleptic Gregorian rule', clean.parseDateCell('2000-02-29', ymd) === '2000-02-29' &&
      clean.parseDateCell('1900-02-29', ymd) === null && clean.parseDateCell('2024-2-9', ymd) === null &&
      clean.parseDateCell(' 2024-02-09\t', ymd) === '2024-02-09');
  }

  // ── 5. the other steps' semantics ─────────────────────────────────────────
  {
    const s = run([{ type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'columns', count: 2 }]);
    ok('split into columns replaces the column in place, missing parts null',
      s.columns.map((c) => c.name).join() === 'region,sku,units,day,tags_1,tags_2' && JSON.stringify(col(s, 'tags_2')) === '["b",null,null,"q"]');
    const rows = run([{ type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'rows' }]);
    ok('split into rows keeps a null cell as one row', rows.rowCount === 7 && JSON.stringify(rows.stepCounts) === '[{"before":4,"after":7}]');
    const u = run([{ type: 'unpivot', columns: ['units', 'tags'] }]);
    ok('unpivot is row-major and keeps nulls', u.rowCount === 8 && JSON.stringify(col(u, 'attribute').slice(0, 2)) === '["units","tags"]');
    const pv = run([{ type: 'pivot', key: 'region', value: 'units', fn: 'count', groupBy: ['sku'] }]);
    ok('pivot: first-seen keys, one row per group, missing combinations null',
      pv.columns.map((c) => c.name).join() === 'sku,East,West,North' && JSON.stringify(pv.rows[0]) === '["007",2,null,null]', JSON.stringify(pv));
    const d = run([{ type: 'dedupe_key', columns: ['sku'], keep: 'last' }]);
    ok('dedupe keep last keeps the survivor in its own place', JSON.stringify(col(d, 'units')) === '[5,1,null]');
    const rp = run([{ type: 'replace_values', column: 'sku', mode: 'exact', rules: [{ from: '007', to: '7' }, { from: '012', to: '12' }] }]);
    ok('a replaced column is typed from its values', rp.columns[1].type === 'number' && col(rp, 'sku')[0] === 7);
    const kept007 = run([{ type: 'replace_values', column: 'sku', mode: 'exact', rules: [{ from: '900', to: '9' }] }]);
    ok('…and "007" still keeps it text', kept007.columns[1].type === 'text' && col(kept007, 'sku')[0] === '007');
    const w = run([{ type: 'window', fn: 'running_sum', as: 'rs', column: 'units', partitionBy: ['region'] }]);
    ok('running sum restarts per partition and skips nulls', JSON.stringify(col(w, 'rs')) === '[3,5,4,null]');
  }
  {
    const calc = clean.conditionalAsCalc(T.columns, { type: 'conditional_column', name: 'band',
      rules: [{ when: { column: 'tags', op: 'is_empty' }, then: 'none' }, { when: { column: 'units', op: '>=', value: '3' }, then: 'big "one"' }], else: null });
    ok('conditional rules compile to ONE formula the engine accepts', typeof calc !== 'string' && compile(calc.expression).ok,
      typeof calc === 'string' ? calc : calc.expression);
    const r = run([{ type: 'conditional_column', name: 'band', rules: [{ when: { column: 'units', op: '>=', value: 3 }, then: 'big' }], else: 'small' }]);
    ok('…and run through the calculated-field machinery', JSON.stringify(col(r, 'band')) === '["big","big","small","small"]');
    ok('a column a formula cannot name is refused', clean.conditionalAsCalc([{ name: 'a]b', type: 'text' }],
      { type: 'conditional_column', name: 'x', rules: [{ when: { column: 'a]b', op: '=', value: 'q' }, then: 'y' }] }) ===
      'Conditional column skipped: column "a]b" cannot be used in a rule');
  }

  // ── 6. lookup and union in the pure fold ──────────────────────────────────
  {
    const other: TableData = {
      columns: [{ name: 'sku', type: 'text' }, { name: 'label', type: 'text' }, { name: 'units', type: 'text' }],
      rows: [['007', 'Seven', 'x'], ['007', 'Seven again', 'y'], ['012', 'Twelve', null], ['', 'Blank', 'z']],
    };
    const ctx = { tables: { [ID_A]: other } };
    const l = run([{ type: 'lookup_join', datasetId: ID_A, leftKey: 'sku', rightKey: 'sku', columns: ['label'] }], T, ctx);
    ok('lookup: a repeated right key takes the first match and warns',
      JSON.stringify(col(l, 'label')) === '["Seven","Twelve","Seven",null]' &&
      l.warnings.join() === 'Lookup: 1 key value(s) repeat in "sku" of the other dataset; the first match in stored order was used');
    ok('lookup never multiplies rows', l.rowCount === T.rows.length);
    const stats = combine.lookupStats(T, { type: 'lookup_join', datasetId: ID_A, leftKey: 'sku', rightKey: 'sku', columns: [] }, ctx);
    ok('the matched rate is counted by the app', JSON.stringify(stats) === '{"matched":3,"total":4,"dupes":1}', JSON.stringify(stats));
    const cells: Cell[] = [7, '7', '007', '', '  ', null, 7.5, NaN as unknown as Cell];
    ok('lookupKey is joinJs.keyOf', cells.every((c) => ['text', 'number'].every((ty) =>
      combine.lookupKey(c, ty as 'text') === keyOf(c, ty as 'text'))));
    const u = run([{ type: 'union', datasetId: ID_A, mapping: [{ from: 'label', to: 'region' }] }], T, ctx);
    ok('union: rows appended in order, mapping consumes its column, unmatched dropped',
      u.rowCount === 8 && JSON.stringify(col(u, 'region').slice(4)) === '["Seven","Seven again","Twelve","Blank"]' &&
      u.columns.length === T.columns.length);
    ok('union: a column whose two types disagree is re-typed from the values', u.columns[2].type === 'text' && col(u, 'units')[0] === '3');
    const cyc = run([{ type: 'union', datasetId: ID_A }], T, { tables: {}, errors: { [ID_A]: 'it would make a cycle' } });
    ok('a withheld reference skips with its reason', cyc.warnings.join() === 'Union skipped: it would make a cycle' && cyc.rowCount === 4);
    ok('no context at all: the step says the table is not loaded',
      run([{ type: 'union', datasetId: ID_A }]).warnings.join() === 'Union skipped: the other dataset is not loaded');
  }

  // ── 7. references through the real dataset store ──────────────────────────
  await projects.init();
  const proj = await projects.createProject('Power steps');
  const pid = proj.id;
  const a = await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: T.columns, rows: T.rows });
  const b = await datasets.saveDataset(pid, { name: 'Products', sourceKind: 'csv',
    columns: [{ name: 'sku', type: 'text' }, { name: 'label', type: 'text' }],
    rows: [['007', 'Seven'], ['012', 'Twelve'], ['900', 'Nine hundred']] });
  if (!a || !b) { ok('saved two datasets', false); return; }
  const lookup = { type: 'lookup_join', datasetId: b.id, leftKey: 'sku', rightKey: 'sku', columns: ['label'] };
  const up = await datasets.updateSteps(pid, a.id, [lookup]);
  ok('a lookup to another dataset resolves through the store',
    up !== null && JSON.stringify(col(up.output, 'label')) === '["Seven","Twelve","Seven","Nine hundred"]', JSON.stringify(up && up.output.warnings));
  const meta = await datasets.getDatasetMeta(pid, a.id);
  ok('the step counts are stored with the record', JSON.stringify(meta && meta.stepCounts) === '[{"before":4,"after":4}]');
  const counts: any = await preview.stepCounts(pid, a.id);
  ok('prepare:stepCounts returns them', counts.ok && JSON.stringify(counts.stepCounts) === '[{"before":4,"after":4}]');
  const pv: any = await preview.stepPreview(pid, a.id, -1, { ...lookup, columns: [] });
  ok('prepare:stepPreview counts the matched rate before any column is chosen',
    pv.ok && pv.lookup && pv.lookup.matched === 4 && pv.lookup.total === 4 && pv.lookup.ratePct === 100, JSON.stringify(pv));
  const pd: any = await preview.stepPreview(pid, a.id, 0, { type: 'parse_date', column: 'day', format: 'YYYY-MM-DD' });
  ok('…and a date format\'s failures over the step\'s input', pd.ok && pd.parseDate.failed === 2 && pd.before === 4);

  const self = await loadStepRefs(pid, a.id, [{ type: 'union', datasetId: a.id }]);
  ok('a dataset cannot read itself', !!self.errors && /its own rows/.test(self.errors[a.id]) && !self.tables[a.id]);
  const cycle = await datasets.updateSteps(pid, b.id, [{ type: 'union', datasetId: a.id }]);
  ok('B reading A, which already reads B, is refused as a cycle',
    cycle !== null && cycle.output.rowCount === 3 && /cycle/.test(cycle.output.warnings.join()), JSON.stringify(cycle && cycle.output.warnings));

  await datasets.updateSteps(pid, b.id, []); // the user removes the refused step
  const list = await datasets.listDatasets(pid);
  const sa = list.find((d) => d.id === a.id);
  ok('the saved-list summary names what the steps read', JSON.stringify(sa && sa.stepDeps) === JSON.stringify([b.id]));
  const full = await datasets.getDataset(pid, a.id);
  ok('summarize carries it', full !== null && JSON.stringify(summarize(full).stepDeps) === JSON.stringify([b.id]));
  const metas = await Promise.all(list.map((d) => datasets.getDatasetMeta(pid, d.id)));
  const g = focus(buildGraph({ datasets: metas.filter(Boolean) as any[], visuals: [], dashboards: [], metrics: [], reports: [], alerts: [] }), 'dataset:' + b.id);
  ok('lineage: the read dataset counts the reader in "Used in"', g.usedIn.dataset === 1, JSON.stringify(g.usedIn));

  await datasets.deleteDataset(pid, b.id);
  const again = await datasets.updateSteps(pid, a.id, [lookup]);
  ok('a deleted reference skips the step with a warning, never throws',
    again !== null && /not found/.test(again.output.warnings.join()) && again.output.columns.length === T.columns.length);
}

main()
  .then(() => finish())
  .catch((e) => { console.error(e); process.exit(1); });
