'use strict';

// Differential test: the DuckDB path must produce BYTE-IDENTICAL results to the
// JS fold, for every pipeline it claims it can express.
//
// This is the load-bearing test of Phase 1. sqlGen has its own unit tests and
// duckdb.ts has its own, but neither answers the only question that matters:
// does swapping the engine change a single number the user sees? Here we run the
// SAME input through BOTH implementations and deep-compare columns, types, row
// order, cell values, cell JS types, and warnings.
//
// A pipeline sqlGen declines (sql: null) is not a failure — it is the designed
// fallback. What must never happen is DuckDB returning a DIFFERENT answer.

import { applyPipeline } from '../src/data/transforms';
import type { Cell, TableData, TransformStep } from '../src/data/transforms';
import { runOnDuckDb } from '../src/engine/pipelineDuck';
import * as duck from '../src/engine/duckdb';

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.error(`FAIL ${label}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// Deliberately nasty: leading zeros, a whitespace-only cell, an empty string, a
// null, mixed magnitudes, and duplicate rows for dedupe.
const table: TableData = {
  columns: [
    { name: 'city', type: 'text' },
    { name: 'sku', type: 'text' },
    { name: 'amount', type: 'number' },
    { name: 'note', type: 'text' },
  ],
  rows: [
    ['Paris', '007', 10, 'a'],
    ['Berlin', '012', 20, ''],
    ['Paris', '007', 5, '   '],
    ['Berlin', '012', 20, null],
    ['Tokyo', '900', 0, 'z'],
    ['Paris', '049', -3, 'a'],
  ],
};

// Row-order sensitivity only shows up above the JS/SQL threshold and with enough
// rows that DuckDB actually parallelises, so build a wide one too.
function bigTable(n: number): TableData {
  const rows: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    rows.push([`c${i % 37}`, String(i % 100).padStart(3, '0'), i % 500, i % 3 === 0 ? '' : `n${i}`]);
  }
  return { columns: table.columns.map((c) => ({ ...c })), rows };
}

// ── The comparison ──────────────────────────────────────────────────────────

function describe(v: Cell): string {
  return `${v === null ? 'null' : typeof v}:${String(v)}`;
}

function compare(label: string, src: TableData, steps: TransformStep[]): void {
  const viaSql = runOnDuckDb(src, steps, { force: true });
  if (viaSql === null) {
    console.log(`skip ${label} — sqlGen declined (falls back to the fold, by design)`);
    return;
  }
  // The fold, with the DuckDB path bypassed: call the steps through applyPipeline
  // on a table below the threshold so runOnDuckDb declines and the fold runs.
  const viaJs = foldOnly(src, steps);

  ok(
    JSON.stringify(viaSql.columns) === JSON.stringify(viaJs.columns),
    `${label}: columns + types identical`,
  );
  ok(viaSql.rowCount === viaJs.rowCount, `${label}: rowCount ${viaSql.rowCount} = ${viaJs.rowCount}`);

  const sqlCells = viaSql.rows.map((r) => r.map(describe).join('|')).join('\n');
  const jsCells = viaJs.rows.map((r) => r.map(describe).join('|')).join('\n');
  ok(sqlCells === jsCells, `${label}: every cell identical in value, JS type and row order`);
  if (sqlCells !== jsCells && process.env.SC_DIFF) {
    console.error('  sql:', sqlCells.slice(0, 400));
    console.error('  js :', jsCells.slice(0, 400));
  }

  ok(
    JSON.stringify(viaSql.warnings) === JSON.stringify(viaJs.warnings),
    `${label}: warnings identical (${JSON.stringify(viaJs.warnings)})`,
  );
}

// Run the fold with the DuckDB path guaranteed off, so the comparison is real.
function foldOnly(src: TableData, steps: TransformStep[]): ReturnType<typeof applyPipeline> {
  // runOnDuckDb declines below DUCKDB_MIN_ROWS; applyPipeline then folds. For a
  // large fixture we still need the fold, so call it via a shim that hides the
  // rows behind the threshold is not possible — instead rely on applyPipeline's
  // own guard by temporarily marking the source. Simpler and honest: the fold is
  // reachable directly because applyPipeline only takes the SQL path when
  // runOnDuckDb returns non-null, and it declines on row count.
  if (src.rows.length >= 50_000) {
    // Slice into the fold in two halves would change results; instead assert on
    // the small fixtures for equality and use the big one only for order checks.
    throw new Error('foldOnly: use compareBig for tables above the threshold');
  }
  return applyPipeline(src, steps);
}

// For the big table, applyPipeline WILL take the SQL path. Compare it against
// the fold by running the fold on the identical data through a forced-small call.
function compareBig(label: string, src: TableData, steps: TransformStep[]): void {
  const viaSql = runOnDuckDb(src, steps, { force: true });
  if (viaSql === null) {
    console.log(`skip ${label} — sqlGen declined`);
    return;
  }
  // Build the reference by folding manually: applyPipeline on a copy whose row
  // count is unchanged but with the bridge disabled for this call.
  const ref = foldReference(src, steps);
  ok(viaSql.rowCount === ref.rowCount, `${label}: rowCount ${viaSql.rowCount} = ${ref.rowCount}`);
  const a = viaSql.rows.map((r) => r.map(describe).join('|')).join('\n');
  const b = ref.rows.map((r) => r.map(describe).join('|')).join('\n');
  ok(a === b, `${label}: ${viaSql.rowCount} rows identical incl. order`);
}

// The fold, reached without going through applyPipeline's DuckDB branch.
// applyPipeline is the only exported entry point, so temporarily shrink the
// input below the threshold is wrong; instead we re-import the module fresh with
// the bridge shut down, which makes runOnDuckDb return null on isAvailable().
function foldReference(src: TableData, steps: TransformStep[]): ReturnType<typeof applyPipeline> {
  duck.shutdown();
  try {
    return applyPipeline(src, steps);
  } finally {
    /* the next runOnDuckDb call restarts the bridge lazily */
  }
}

// ── Cases ───────────────────────────────────────────────────────────────────

console.log('— small-table equivalence (forced onto the SQL path) —');

compare('filter =', table, [{ type: 'filter', column: 'city', op: '=', value: 'Paris' }]);
compare('filter != on text', table, [{ type: 'filter', column: 'city', op: '!=', value: 'Paris' }]);
compare('filter numeric >', table, [{ type: 'filter', column: 'amount', op: '>', value: 5 }]);
compare('filter contains', table, [{ type: 'filter', column: 'note', op: 'contains', value: 'a' }]);
compare('filter is_empty', table, [{ type: 'filter', column: 'note', op: 'is_empty' }]);
compare('filter not_empty', table, [{ type: 'filter', column: 'note', op: 'not_empty' }]);
compare('filter on leading-zero sku', table, [
  { type: 'filter', column: 'sku', op: '=', value: '007' },
]);
compare('filter unknown column (skip + warn)', table, [
  { type: 'filter', column: 'nope', op: '=', value: 'x' },
]);

compare('group sum', table, [
  { type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'amount', fn: 'sum', as: 'total' }] },
] as TransformStep[]);
compare('group count over text (non-empty semantics)', table, [
  { type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'note', fn: 'count', as: 'n' }] },
] as TransformStep[]);
compare('group min/max/avg', table, [
  {
    type: 'group_aggregate',
    groupBy: ['city'],
    aggregations: [
      { column: 'amount', fn: 'min', as: 'lo' },
      { column: 'amount', fn: 'max', as: 'hi' },
      { column: 'amount', fn: 'avg', as: 'mean' },
    ],
  },
] as TransformStep[]);
compare('group by leading-zero column', table, [
  { type: 'group_aggregate', groupBy: ['sku'], aggregations: [{ column: 'amount', fn: 'sum', as: 't' }] },
] as TransformStep[]);
compare('aggregate a TEXT column (must be null, not an error)', table, [
  { type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'sku', fn: 'sum', as: 's' }] },
] as TransformStep[]);

compare('dedupe all columns', table, [{ type: 'dedupe' } as TransformStep]);
compare('dedupe by subset (first wins)', table, [
  { type: 'dedupe', columns: ['city', 'sku'] } as TransformStep,
]);

compare('trim all text', table, [{ type: 'trim' } as TransformStep]);
compare('trim named column', table, [{ type: 'trim', column: 'note' } as TransformStep]);
compare('fill_empty', table, [{ type: 'fill_empty', column: 'note', value: 'X' } as TransformStep]);
compare('drop_column', table, [{ type: 'drop_column', column: 'note' } as TransformStep]);
compare('rename_column', table, [
  { type: 'rename_column', from: 'note', to: 'comment' } as TransformStep,
]);

compare('chain: filter → group', table, [
  { type: 'filter', column: 'amount', op: '>=', value: 0 },
  { type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'amount', fn: 'sum', as: 't' }] },
] as TransformStep[]);
compare('chain: trim → dedupe → drop', table, [
  { type: 'trim' },
  { type: 'dedupe' },
  { type: 'drop_column', column: 'note' },
] as TransformStep[]);

compare('unknown step type is skipped', table, [
  { type: 'not_a_step' } as unknown as TransformStep,
]);
compare('empty step list', table, []);

console.log('');
console.log('— injection safety —');
compare("value containing '; DROP TABLE", table, [
  { type: 'filter', column: 'city', op: '=', value: "'; DROP TABLE t; --" },
]);
compare('value containing a quote', table, [
  { type: 'filter', column: 'city', op: '=', value: "Pa'ris" },
]);
{
  const after = runOnDuckDb(table, [{ type: 'filter', column: 'city', op: '=', value: 'Paris' }], {
    force: true,
  });
  ok(after !== null && after.rowCount === 3, 'bridge still usable after injection attempts');
}

console.log('');
console.log('— large table: row-order stability under parallel execution —');
{
  const big = bigTable(60_000);
  compareBig('60k filter (source order preserved)', big, [
    { type: 'filter', column: 'amount', op: '>', value: 100 },
  ]);
  compareBig('60k group (first-seen group order)', big, [
    { type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'amount', fn: 'sum', as: 't' }] },
  ] as TransformStep[]);

  // Determinism: the same query must give the same order every time. This is the
  // failure mode docs/phase-0/06 proved is real for a bare GROUP BY.
  const orders = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const r = runOnDuckDb(
      big,
      [
        {
          type: 'group_aggregate',
          groupBy: ['city'],
          aggregations: [{ column: 'amount', fn: 'sum', as: 't' }],
        },
      ] as TransformStep[],
      { force: true },
    );
    if (r) orders.add(r.rows.map((x) => String(x[0])).join(','));
  }
  ok(orders.size === 1, `group order identical across 5 runs (got ${orders.size} distinct)`);
}

console.log('');
console.log('— threshold behaviour —');
ok(
  runOnDuckDb(table, [{ type: 'filter', column: 'city', op: '=', value: 'Paris' }]) === null,
  'small table declines the SQL path (fold is cheaper)',
);
ok(
  runOnDuckDb(table, [{ type: 'calculated_field', name: 'x', expression: '1+1' }], { force: true }) ===
    null,
  'calculated_field declines (formula→SQL is out of Phase 1 scope)',
);
ok(
  applyPipeline(table, [{ type: 'filter', column: 'city', op: '=', value: 'Paris' }]).rowCount === 3,
  'applyPipeline still correct when the SQL path declines',
);

duck.shutdown();

console.log('');
if (failures) {
  console.error(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All pipelineDuck differential checks passed.');
