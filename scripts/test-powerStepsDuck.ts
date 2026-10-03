// Differential test for the ten power prepare steps: the JS fold (the
// reference) against DuckDB — both the in-memory path (runOnDuckDb, which also
// loads union/lookup references as relations) and the resident path
// (runResidentPipeline over a staged Parquet). Every cell is compared with
// Object.is, so a 7 vs '7', a null vs '' or a -0 is a failure; columns, types,
// warnings and the per-step row counts must match too.
//
// A power step the SQL path DECLINES here is a failure, not a skip: each case
// below is one the generator claims to express. The bail cases (a column typed
// from data by an earlier step) are asserted to decline on purpose.

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Cell, TableData, TransformStep } from '../src/data/transforms';
import type { PipelineContext } from '../src/data/stepTypes';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { applyPipeline }: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { runOnDuckDb, runResidentPipeline }: typeof import('../src/engine/pipelineDuck') = require('../src/engine/pipelineDuck');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');

const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_ID = '22222222-2222-4222-8222-222222222222';

// Nasty on purpose: leading zeros, '', whitespace, null, an emoji, duplicate
// keys, a numeric string in a text column, and dates in the wrong shapes.
const T: TableData = {
  columns: [
    { name: 'region', type: 'text' },
    { name: 'city', type: 'text' },
    { name: 'sku', type: 'text' },
    { name: 'units', type: 'number' },
    { name: 'price', type: 'number' },
    { name: 'day', type: 'text' },
    { name: 'tags', type: 'text' },
  ],
  rows: [
    ['East', 'Paris', '007', 3, 2.5, '2024-02-09', 'a,b;c'],
    ['West', 'Berlin', '012', 5, 1.25, '2024-02-30', 'x'],
    ['East', 'Paris', '007', 1, 10, ' 2024-01-05 ', null],
    ['North', 'Tokyo', '900', null, 0.5, '2024-2-9', ''],
    ['West', 'Berlin', '049', 7, 3, null, '007;8,9'],
    ['East', 'Lima', '100', 2, 2.5, '1900-02-29', 'a😀b,c'],
    ['', 'Oslo', '7', 4, 1, '2000-02-29', '  ,  '],
    ['West', '', '012', 5, 4, 'abc', 'A,B,C,D'],
  ],
};

const DATES: TableData = {
  columns: [{ name: 'd', type: 'text' }, { name: 'n', type: 'number' }],
  rows: [
    ['09/02/2024', 20240209], ['31/04/2024', 20240431], ['09-Feb-2024', 19991231], ['09-FEB-2024', null],
    ['09-Sept-2024', 20000229], ['2024-02-09 13:05', 1], ['2024-02-09 25:05', 20240230], ['0000-02-29', 99991231],
    ['29.02.2023 10:00:00', 0], ['28.02.2023 23:59:59', 100], ['2024-02-09T08:30', null], ['', 20240101],
  ],
};

const OTHER: TableData = {
  columns: [
    { name: 'sku', type: 'text' },
    { name: 'label', type: 'text' },
    { name: 'units', type: 'text' },
    { name: 'cost', type: 'number' },
    { name: 'extra', type: 'text' },
  ],
  rows: [
    ['007', 'Seven', 'n/a', 1.5, 'x'],
    ['012', 'Twelve', '4', 2, 'y'],
    ['007', 'Seven again', '9', 3, 'z'],
    ['7', 'Bare seven', null, 4, null],
    ['', 'Blank', '1', 5, 'w'],
  ],
};
const CTX: PipelineContext = { tables: { [OTHER_ID]: OTHER } };

function show(v: Cell): string {
  return v === null ? 'null' : `${typeof v}:${String(v)}`;
}

function sameRows(a: Cell[][], b: Cell[][]): string | null {
  if (a.length !== b.length) return `row count ${a.length} vs ${b.length}`;
  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) return `row ${r} width ${a[r].length} vs ${b[r].length}`;
    for (let c = 0; c < a[r].length; c++) {
      if (!Object.is(a[r][c], b[r][c])) return `row ${r} col ${c}: fold ${show(a[r][c])} vs sql ${show(b[r][c])}`;
    }
  }
  return null;
}

function compare(label: string, sql: ReturnType<typeof applyPipeline> | null, js: ReturnType<typeof applyPipeline>): void {
  ok(`${label}: the SQL path ran`, sql !== null);
  if (!sql) return;
  ok(`${label}: columns and types`, JSON.stringify(sql.columns) === JSON.stringify(js.columns),
    `${JSON.stringify(js.columns)} vs ${JSON.stringify(sql.columns)}`);
  const diff = sameRows(js.rows, sql.rows);
  ok(`${label}: every cell Object.is`, diff === null, diff);
  ok(`${label}: warnings`, JSON.stringify(sql.warnings) === JSON.stringify(js.warnings),
    `${JSON.stringify(js.warnings)} vs ${JSON.stringify(sql.warnings)}`);
  ok(`${label}: step row counts`, JSON.stringify(sql.stepCounts) === JSON.stringify(js.stepCounts),
    `${JSON.stringify(js.stepCounts)} vs ${JSON.stringify(sql.stepCounts)}`);
}

async function same(label: string, steps: TransformStep[], src: TableData = T, ctx: PipelineContext | undefined = CTX): Promise<void> {
  compare(label, await runOnDuckDb(src, steps, { force: true, ctx }), applyPipeline(src, steps, ctx));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-power-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp */ } });
let staged = 0;
async function resident(label: string, steps: TransformStep[], src: TableData = T): Promise<void> {
  const file = path.join(tmp, `t${staged++}.source.parquet`);
  pqSync.writeTable(file, src.columns, src.rows);
  compare(`resident ${label}`, await runResidentPipeline(file, src.columns, steps), applyPipeline(src, steps));
}

async function main(): Promise<void> {
  // ── split_column ────────────────────────────────────────────────────────────
  await same('split by delimiter into 3 columns', [{ type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'columns', count: 3 }]);
  await same('split by delimiter into rows', [{ type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'rows' }]);
  await same('split by positions (code points)', [{ type: 'split_column', column: 'tags', mode: 'position', positions: [1, 3], into: 'columns' }]);
  await same('split by positions into rows', [{ type: 'split_column', column: 'sku', mode: 'position', positions: [2], into: 'rows' }]);
  await same('split by regex into columns', [{ type: 'split_column', column: 'tags', mode: 'regex', pattern: '[,;]\\s*', into: 'columns', count: 4 }]);
  await same('split by regex, ignore case, into rows', [{ type: 'split_column', column: 'tags', mode: 'regex', pattern: 'b', ignoreCase: true, into: 'rows' }]);
  await same('split a number column', [{ type: 'split_column', column: 'price', mode: 'delimiter', delimiter: '.', into: 'columns', count: 2 }]);
  await same('split: unknown column warns', [{ type: 'split_column', column: 'nope', mode: 'delimiter', delimiter: ',', into: 'rows' }]);
  await same('split: a clashing part name skips', [{ type: 'rename_column', from: 'city', to: 'tags_2' }, { type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'columns', count: 2 }]);
  await same('split: a regex with . and a group', [{ type: 'split_column', column: 'tags', mode: 'regex', pattern: '(,|;).?', into: 'columns', count: 3 }]);

  // ── unpivot ─────────────────────────────────────────────────────────────────
  await same('unpivot two number columns', [{ type: 'unpivot', columns: ['units', 'price'] }]);
  await same('unpivot mixed types (re-detected)', [{ type: 'unpivot', columns: ['units', 'sku'], attribute: 'field', value: 'v' }]);
  await same('unpivot: unknown and clashing names', [{ type: 'unpivot', columns: ['nope', 'units'], attribute: 'city' }]);

  // ── pivot ───────────────────────────────────────────────────────────────────
  for (const fn of ['sum', 'avg', 'count', 'min', 'max'] as const) {
    await same(`pivot ${fn}(units) by region, grouped by city`, [{ type: 'pivot', key: 'region', value: 'units', fn, groupBy: ['city'] }]);
  }
  await same('pivot with no group columns', [{ type: 'pivot', key: 'city', value: 'price', fn: 'sum', groupBy: [] }]);
  await same('pivot over a text value (sum null, count real)', [{ type: 'pivot', key: 'region', value: 'sku', fn: 'sum', groupBy: ['city'] },
    { type: 'drop_column', column: 'city' }]);
  await same('pivot count over text', [{ type: 'pivot', key: 'region', value: 'tags', fn: 'count', groupBy: ['city'] }]);
  await same('pivot: a key equal to a group column skips', [{ type: 'pivot', key: 'city', value: 'units', fn: 'sum', groupBy: ['region'] },
    { type: 'rename_column', from: 'region', to: 'Paris' }]);
  {
    const wide: TableData = {
      columns: [{ name: 'k', type: 'text' }, { name: 'v', type: 'number' }, { name: 'g', type: 'text' }],
      rows: Array.from({ length: 150 }, (_, i) => [`k${(i * 7) % 130}`, i, i % 2 ? 'odd' : 'even']),
    };
    await same('pivot caps at 100 keys, first-seen, with the warning', [{ type: 'pivot', key: 'k', value: 'v', fn: 'max', groupBy: ['g'] }], wide);
  }

  // ── parse_date ──────────────────────────────────────────────────────────────
  await same('parse YYYY-MM-DD (Feb 30, 2024-2-9, 1900-02-29 fail)', [{ type: 'parse_date', column: 'day', format: 'YYYY-MM-DD' }]);
  await same('parse into a new column', [{ type: 'parse_date', column: 'day', format: 'YYYY-MM-DD', as: 'parsed' }]);
  for (const format of ['DD/MM/YYYY', 'DD-MMM-YYYY', 'YYYY-MM-DD HH:mm', 'DD.MM.YYYY HH:mm:ss', 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD']) {
    await same(`parse ${format}`, [{ type: 'parse_date', column: 'd', format }], DATES);
  }
  await same('parse YYYYMMDD off a number column', [{ type: 'parse_date', column: 'n', format: 'YYYYMMDD' }], DATES);

  // ── dedupe_key ──────────────────────────────────────────────────────────────
  for (const keep of ['first', 'last'] as const) await same(`dedupe by sku keep ${keep}`, [{ type: 'dedupe_key', columns: ['sku'], keep }]);
  await same('dedupe keep max units (nulls lose, ties keep first)', [{ type: 'dedupe_key', columns: ['region'], keep: 'max', by: 'units' }]);
  await same('dedupe keep min price', [{ type: 'dedupe_key', columns: ['region'], keep: 'min', by: 'price' }]);
  await same('dedupe keep max of a text column', [{ type: 'dedupe_key', columns: ['region'], keep: 'max', by: 'city' }]);
  await same('dedupe: unknown columns', [{ type: 'dedupe_key', columns: ['nope', 'city'], keep: 'last' }]);

  // ── replace_values ──────────────────────────────────────────────────────────
  await same('replace exact (first rule wins, blank rule)', [{ type: 'replace_values', column: 'city', mode: 'exact',
    rules: [{ from: 'Paris', to: 'FR' }, { from: 'Paris', to: 'no' }, { from: '', to: 'blank' }] }]);
  await same('replace exact on a number column', [{ type: 'replace_values', column: 'units', mode: 'exact', rules: [{ from: '5', to: '50' }] }]);
  await same('replace contains, rules in sequence', [{ type: 'replace_values', column: 'tags', mode: 'contains',
    rules: [{ from: ',', to: ';' }, { from: ';', to: ' | ' }] }]);
  await same('replace regex with literal $ and \\ in the replacement', [{ type: 'replace_values', column: 'sku', mode: 'regex',
    rules: [{ from: '^0+', to: '$1\\' }, { from: '[0-9]$', to: '#' }] }]);
  await same('replace regex ignore case to empty', [{ type: 'replace_values', column: 'tags', mode: 'regex', ignoreCase: true,
    rules: [{ from: 'a|b', to: '' }] }]);

  // ── conditional_column ──────────────────────────────────────────────────────
  await same('conditional over numbers and text', [{ type: 'conditional_column', name: 'band', rules: [
    { when: { column: 'units', op: '>=', value: 5 }, then: 'high' },
    { when: { column: 'units', op: '<', value: '2' }, then: 'low' },
    { when: { column: 'city', op: '=', value: 'Paris' }, then: '007' },
    { when: { column: 'tags', op: 'contains', value: 'b' }, then: 'has b' },
  ], else: 'mid' }]);
  await same('conditional: empty tests, != and a null else', [{ type: 'conditional_column', name: 'flag', rules: [
    { when: { column: 'tags', op: 'is_empty' }, then: '1' },
    { when: { column: 'units', op: '!=', value: 5 }, then: '2' },
    { when: { column: 'region', op: 'not_empty' }, then: '3' },
  ], else: null }]);
  await same('conditional: text ordering and a non-numeric value on a number column', [{ type: 'conditional_column', name: 'c', rules: [
    { when: { column: 'sku', op: '>', value: '05' }, then: 'after' },
    { when: { column: 'price', op: '=', value: 'abc' }, then: 'never' },
    { when: { column: 'price', op: '<=', value: 1.25 }, then: 'cheap' },
  ] }]);
  await same('conditional: unknown column skips', [{ type: 'conditional_column', name: 'x', rules: [{ when: { column: 'nope', op: '=', value: 1 }, then: 'a' }] }]);

  // ── window ──────────────────────────────────────────────────────────────────
  await same('row_number by region, units desc', [{ type: 'window', fn: 'row_number', as: 'rn', partitionBy: ['region'], orderBy: 'units', desc: true }]);
  await same('row_number in stored order', [{ type: 'window', fn: 'row_number', as: 'rn' }]);
  await same('lag 1 of a text column', [{ type: 'window', fn: 'lag', as: 'prev', column: 'city', partitionBy: ['region'], orderBy: 'price' }]);
  await same('lead 2 of a number column', [{ type: 'window', fn: 'lead', as: 'next', column: 'units', offset: 2, orderBy: 'city' }]);
  await same('running sum with nulls', [{ type: 'window', fn: 'running_sum', as: 'rs', column: 'units', partitionBy: ['region'], orderBy: 'price' }]);
  await same('running avg', [{ type: 'window', fn: 'running_avg', as: 'ra', column: 'price', orderBy: 'units' }]);
  await same('running sum over text is null', [{ type: 'window', fn: 'running_sum', as: 'rs', column: 'sku' }]);

  // ── union ───────────────────────────────────────────────────────────────────
  await same('union by name, dropping and re-typing', [{ type: 'union', datasetId: OTHER_ID }]);
  await same('union with a mapping', [{ type: 'union', datasetId: OTHER_ID, mapping: [{ from: 'label', to: 'city' }, { from: 'cost', to: 'price' }, { from: 'nope', to: 'city' }] }]);
  await same('union: a reference withheld for a cycle', [{ type: 'union', datasetId: OTHER_ID }], T,
    { tables: {}, errors: { [OTHER_ID]: 'it would create a cycle' } });
  await same('union: no context at all', [{ type: 'union', datasetId: MISSING_ID }], T, undefined);

  // ── lookup_join ─────────────────────────────────────────────────────────────
  await same('lookup with duplicate right keys (first wins, warned)', [{ type: 'lookup_join', datasetId: OTHER_ID, leftKey: 'sku', rightKey: 'sku', columns: ['label', 'cost'] }]);
  await same('lookup a number key against a text key', [{ type: 'lookup_join', datasetId: OTHER_ID, leftKey: 'units', rightKey: 'units', columns: ['label'], prefix: 'o_' }]);
  await same('lookup: clashing name and unknown column', [{ type: 'lookup_join', datasetId: OTHER_ID, leftKey: 'sku', rightKey: 'sku', columns: ['units', 'nope'] }]);
  await same('lookup: missing dataset', [{ type: 'lookup_join', datasetId: MISSING_ID, leftKey: 'sku', rightKey: 'sku', columns: ['label'] }]);

  // ── chains ──────────────────────────────────────────────────────────────────
  await same('filter → split → pivot → window', [
    { type: 'filter', column: 'units', op: '>', value: 1 },
    { type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'rows' },
    { type: 'pivot', key: 'region', value: 'price', fn: 'sum', groupBy: ['sku'] },
    { type: 'window', fn: 'running_sum', as: 'rs', column: 'East', orderBy: 'sku' },
  ]);
  await same('union → window → lookup', [
    { type: 'union', datasetId: OTHER_ID },
    { type: 'window', fn: 'row_number', as: 'rn', partitionBy: ['sku'] },
    { type: 'lookup_join', datasetId: OTHER_ID, leftKey: 'sku', rightKey: 'sku', columns: ['label'] },
  ]);
  await same('lookup → conditional → parse', [
    { type: 'lookup_join', datasetId: OTHER_ID, leftKey: 'sku', rightKey: 'sku', columns: ['cost'] },
    { type: 'conditional_column', name: 'priced', rules: [{ when: { column: 'cost', op: 'not_empty' }, then: 'yes' }], else: 'no' },
    { type: 'parse_date', column: 'day', format: 'YYYY-MM-DD' },
  ]);

  // ── bails on purpose ────────────────────────────────────────────────────────
  ok('a step reading a column typed from data by an earlier step declines to the fold',
    await runOnDuckDb(T, [{ type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'columns', count: 2 },
      { type: 'replace_values', column: 'tags_1', mode: 'exact', rules: [{ from: 'a', to: 'b' }] }], { force: true, ctx: CTX }) === null);
  // The fold typed a derived column over the rows it had at that step; dropping
  // rows later would move SQL's (deferred) decision — so these fold instead.
  ok('split, then a filter that drops rows, declines to the fold',
    await runOnDuckDb(T, [{ type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'rows' },
      { type: 'filter', column: 'units', op: '>', value: 1 }], { force: true }) === null);
  ok('union with a re-typed column, then dedupe_key, declines to the fold',
    await runOnDuckDb(T, [{ type: 'union', datasetId: OTHER_ID }, { type: 'dedupe_key', columns: ['sku'], keep: 'last' }], { force: true, ctx: CTX }) === null);
  ok('a calculated field before a pivot declines to the fold',
    await runOnDuckDb(T, [{ type: 'calculated_field', name: 'x', expression: '1' }, { type: 'pivot', key: 'region', value: 'units', fn: 'sum', groupBy: [] }], { force: true }) === null);

  // ── resident (Parquet in place) ─────────────────────────────────────────────
  await resident('split rows', [{ type: 'split_column', column: 'tags', mode: 'delimiter', delimiter: ',', into: 'rows' }]);
  await resident('pivot', [{ type: 'pivot', key: 'region', value: 'units', fn: 'sum', groupBy: ['city'] }]);
  await resident('filter + parse + window + replace', [
    { type: 'filter', column: 'units', op: '>', value: 2 },
    { type: 'parse_date', column: 'day', format: 'YYYY-MM-DD', as: 'iso' },
    { type: 'window', fn: 'lag', as: 'prev', column: 'units', orderBy: 'iso' },
    { type: 'replace_values', column: 'city', mode: 'contains', rules: [{ from: 'a', to: 'A' }] },
  ]);
  await resident('old steps only still report counts', [{ type: 'filter', column: 'units', op: '>', value: 2 }, { type: 'dedupe', columns: ['sku'] }]);
  ok('resident declines a union (the fold has the other table)',
    await runResidentPipeline((() => { const f = path.join(tmp, 'u.source.parquet'); pqSync.writeTable(f, T.columns, T.rows); return f; })(),
      T.columns, [{ type: 'union', datasetId: OTHER_ID }]) === null);

  duck.shutdown();
  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
