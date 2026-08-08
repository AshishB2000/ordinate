'use strict';

// Self-check for the compose chain — `composeTables` + the `left` join mode in
// src/transforms.ts.
//
// The composer canvas draws a left-to-right chain of tables. That picture is only
// honest if the engine behind it really is a left-to-right FOLD of the pairwise
// combine everyone already trusts — so the central assertion here is differential
// in the house style: folding N tables must equal nesting `combineTables` calls by
// hand, cell for cell, with `Object.is`. If those ever diverge, the canvas is
// drawing a graph the engine does not run.
//
// The rest pins the three things that could quietly go wrong:
//
//   - `'join'` MUST keep meaning `'inner'`. It is the spelling written into every
//     `origin: 'combined'` record already on disk; if the alias stops resolving,
//     refresh silently changes the row set of existing datasets.
//   - a `left` join keeps an unmatched left row and pads it with null — and pads
//     it with the RIGHT number of nulls, which is what a `.map(() => null)` over
//     the wrong array would get wrong without changing the row count.
//   - the row cap applies at EVERY step of the fold, not just the last one. A
//     many-to-many blow-up at step 1 must be bounded before it feeds step 2, and
//     its warning must survive to the caller rather than being swallowed.
//
//   npm run build:ts && node scripts/test-composeTables.js

// ponytail: compiled sibling of ../src/combine.ts.
const combine: typeof import('../src/combine') = require('../src/combine');
import type { Cell, TableData } from '../src/transforms';
import type { ParsedColumn } from '../src/parse';

const { combineTables, composeTables, normalizeCombineMode } = combine;

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

/** Build a TableData from a header row + cells; types come out of the strict sniffer. */
function table(names: string[], rows: Cell[][]): TableData {
  const columns: ParsedColumn[] = names.map((name) => ({ name, type: 'text' }));
  // Let combineTables' own retype path decide types by round-tripping through an
  // append with an empty table — keeps this fixture honest rather than asserting
  // types this file invented.
  const res = combineTables({ columns, rows }, { columns: [], rows: [] }, 'append');
  return { columns: res.columns, rows: res.rows };
}

/** Cell-for-cell equality with Object.is, the way every differential suite here does it. */
function sameTable(a: { columns: ParsedColumn[]; rows: Cell[][] }, b: { columns: ParsedColumn[]; rows: Cell[][] }): boolean {
  if (a.columns.length !== b.columns.length || a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.columns.length; i += 1) {
    if (!Object.is(a.columns[i].name, b.columns[i].name)) return false;
    if (!Object.is(a.columns[i].type, b.columns[i].type)) return false;
  }
  for (let r = 0; r < a.rows.length; r += 1) {
    if (a.rows[r].length !== b.rows[r].length) return false;
    for (let c = 0; c < a.rows[r].length; c += 1) {
      if (!Object.is(a.rows[r][c], b.rows[r][c])) return false;
    }
  }
  return true;
}

// ── The mode alias ───────────────────────────────────────────────────────────

ok("normalizeCombineMode maps 'join' → 'inner'", normalizeCombineMode('join') === 'inner');
ok('…and passes the three real modes through', normalizeCombineMode('append') === 'append'
  && normalizeCombineMode('inner') === 'inner' && normalizeCombineMode('left') === 'left');
ok('…and rejects anything else', normalizeCombineMode('right') === null
  && normalizeCombineMode('full') === null && normalizeCombineMode(undefined) === null);

const people = table(['id', 'name'], [['1', 'Ada'], ['2', 'Bo'], ['3', 'Cy']]);
const orders = table(['uid', 'total'], [['1', '10'], ['1', '15'], ['2', '20']]);

const viaAlias = combineTables(people, orders, 'join', { left: 'id', right: 'uid' });
const viaInner = combineTables(people, orders, 'inner', { left: 'id', right: 'uid' });
ok("'join' and 'inner' produce the identical table", sameTable(viaAlias, viaInner));
// Cy has no order, so inner keeps Ada twice and Bo once — and no Cy at all.
ok('inner drops the unmatched left row', viaInner.rows.length === 3
  && viaInner.rows.every((r) => r[1] !== 'Cy'));

// ── The left join ────────────────────────────────────────────────────────────

const viaLeft = combineTables(people, orders, 'left', { left: 'id', right: 'uid' });
ok('left keeps the unmatched row (3 matched + 1 unmatched)', viaLeft.rows.length === 4);

// Find it by SHAPE — every right column null — not by key value: combineTables
// re-types its output, so the '3' in the fixture comes back as the number 3.
const rightStart = people.columns.length;
const isPadded = (r: Cell[]): boolean => r.slice(rightStart).every((v) => v === null);
const unmatched = viaLeft.rows.find(isPadded);
ok('…and it is the row with no match (Cy)', Boolean(unmatched) && String(unmatched![1]) === 'Cy');
ok('…and exactly one row is padded', viaLeft.rows.filter(isPadded).length === 1);
ok('…with the row still the full output width',
  Boolean(unmatched) && unmatched!.length === viaLeft.columns.length);
ok('left and inner agree on the matched rows',
  sameTable(
    { columns: viaLeft.columns, rows: viaLeft.rows.filter((r) => !isPadded(r)) },
    { columns: viaInner.columns, rows: viaInner.rows },
  ));

// A left join whose right side matches NOTHING is the left table plus null columns
// — the case where dropping unmatched rows would return zero rows and look like a
// broken join rather than an empty lookup.
const nomatch = combineTables(people, table(['uid', 'total'], [['9', '1']]), 'left', { left: 'id', right: 'uid' });
ok('left with no matches at all keeps every left row', nomatch.rows.length === 3);
ok('…and every added cell is null', nomatch.rows.every((r) => r[2] === null));

// ── The fold IS nested pairwise calls ────────────────────────────────────────

const regions = table(['name', 'region'], [['Ada', 'EU'], ['Bo', 'US'], ['Cy', 'APAC']]);

for (const mode of ['inner', 'left'] as const) {
  const folded = composeTables(people, [
    { table: orders, mode, on: { left: 'id', right: 'uid' } },
    { table: regions, mode, on: { left: 'name', right: 'name' } },
  ]);
  const step1 = combineTables(people, orders, mode, { left: 'id', right: 'uid' });
  const nested = combineTables(
    { columns: step1.columns, rows: step1.rows },
    regions, mode, { left: 'name', right: 'name' },
  );
  ok(`a three-table ${mode} fold equals the nested pairwise calls`, sameTable(folded, nested));
  ok(`…including rowCount (${folded.rowCount})`, folded.rowCount === nested.rows.length);
}

// Mixed modes in one chain — the canvas allows a per-link mode, so the fold must too.
const mixed = composeTables(people, [
  { table: orders, mode: 'left', on: { left: 'id', right: 'uid' } },
  { table: regions, mode: 'inner', on: { left: 'name', right: 'name' } },
]);
const mixStep1 = combineTables(people, orders, 'left', { left: 'id', right: 'uid' });
const mixNested = combineTables({ columns: mixStep1.columns, rows: mixStep1.rows }, regions, 'inner', { left: 'name', right: 'name' });
ok('a mixed left-then-inner chain equals its nested form', sameTable(mixed, mixNested));

// An append link in the middle of a chain folds like any other.
const more = table(['id', 'name'], [['4', 'Di']]);
const withAppend = composeTables(people, [
  { table: more, mode: 'append' },
  { table: regions, mode: 'left', on: { left: 'name', right: 'name' } },
]);
const appStep1 = combineTables(people, more, 'append');
const appNested = combineTables({ columns: appStep1.columns, rows: appStep1.rows }, regions, 'left', { left: 'name', right: 'name' });
ok('an append link folds identically too', sameTable(withAppend, appNested));

// ── Degenerate chains ────────────────────────────────────────────────────────

const alone = composeTables(people, []);
ok('a chain with no joins is the base table, unchanged', sameTable(alone, people));
ok('…and does not alias the caller\'s rows', alone.rows !== people.rows && alone.rows[0] !== people.rows[0]);
ok('…and reports no warnings', alone.warnings.length === 0);
ok('a non-array joins argument is treated as empty, not a throw',
  sameTable(composeTables(people, undefined as any), people));

// ── The cap holds at every step, and its warning survives ────────────────────

// 40 left rows × 40 right rows on one shared key = 1,600 matches, capped at 100.
const dupKey = (n: number, col: string): TableData =>
  table([col, col + '_v'], Array.from({ length: n }, (_, i) => ['k', String(i)] as Cell[]));

const capped = composeTables(dupKey(40, 'a'), [
  { table: dupKey(40, 'b'), mode: 'inner', on: { left: 'a', right: 'b' } },
  { table: dupKey(40, 'c'), mode: 'inner', on: { left: 'a', right: 'c' } },
], 100);
ok('the cap bounds the fold, not just its last step', capped.rows.length === 100);
ok('…and the cap warning reaches the caller', capped.warnings.some((w) => /row cap reached/i.test(w)));
ok('…once per capped step, so the count tells you where it happened',
  capped.warnings.filter((w) => /row cap reached/i.test(w)).length === 2);

// The point of capping mid-fold: step 2 sees a bounded input. Uncapped, 40×40×40
// would be 64,000 rows; the middle cap is what stops that being built at all.
const cappedStep1 = combineTables(dupKey(40, 'a'), dupKey(40, 'b'), 'inner', { left: 'a', right: 'b' }, 100);
ok('step 1 alone is already at the cap, so step 2 folded over 100 rows not 1,600',
  cappedStep1.rows.length === 100);

console.log('');
if (failures) {
  console.error(`${failures} compose check(s) FAILED.`);
  process.exit(1);
}
console.log('All compose checks passed.');
