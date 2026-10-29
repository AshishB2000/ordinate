// Self-check for a formula's work budget (src/formula/formulaBudget.ts, NV-42):
// formula evaluation and the prepare fold run synchronously on the thread every
// org shares, so one evaluation over a table — and one whole fold — draws on a
// budget of WORK (tokens a row, text a call), and refuses past it with the
// catalog's sentence. Every refusal has its negative control: the same formula
// on a table it fits runs and gives the same values as before.
//
//   npm run build:ts && node scripts/test-formulaBudget.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Cell, TransformStep } from '../src/data/transforms';

const { compile }: typeof import('../src/formula/formula') = require('../src/formula/formula');
const { evaluateTable, lodValues }: typeof import('../src/formula/lod') = require('../src/formula/lod');
const budget: typeof import('../src/formula/formulaBudget') = require('../src/formula/formulaBudget');
const { applyPipeline }: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { formulaTooMuchWork }: typeof import('../src/data/workBudgetMessages') = require('../src/data/workBudgetMessages');

const COLS = [{ name: 'a', type: 'number' as const }, { name: 'd', type: 'text' as const }];
const rowsOf = (n: number): Cell[][] => Array.from({ length: n }, (_, i) => [i, `row ${i}`]);
const fnOf = (expr: string) => {
  const c = compile(expr);
  if (!c.ok) throw new Error(c.error);
  return c.fn;
};
const refusal = (f: () => unknown): string => {
  try {
    f();
    return 'ran';
  } catch (e) {
    return budget.isFormulaBudgetError(e) ? 'budget' : `THREW ${String(e)}`;
  }
};

// ── 1. The real budget bounds a heavy formula over a big table ───────────────
{
  const heavy = fnOf(Array.from({ length: 1000 }, () => '[a]').join(' + ')); // 1,999 tokens
  const t0 = Date.now();
  const got = refusal(() => evaluateTable(heavy, COLS, rowsOf(400_000)));
  const ms = Date.now() - t0;
  ok('a 2,000-token formula over 400k rows stops at the budget', got === 'budget', got);
  ok('…within seconds, not the ~10 s the whole table would take', ms < 6000, `${ms} ms`);
  const small = evaluateTable(heavy, COLS, rowsOf(1000));
  ok('negative control: the same formula over 1,000 rows runs and adds up', small.length === 1000 && small[7] === 7000);
}

// ── 2. Text: a call pays for what it reads and writes, and the pieces it splits ──
{
  const b = { left: 1_000_000 };
  ok('one long lower() per row exhausts a small budget',
    refusal(() => evaluateTable(fnOf('len(lower(space(100000)))'), COLS, rowsOf(1000), { budget: b })) === 'budget' && b.left < 0);
  const b2 = { left: 1_000_000 };
  const vals = evaluateTable(fnOf("concat(lower([d]), '!')"), COLS, rowsOf(1000), { budget: b2 });
  ok('negative control: an ordinary text formula costs a little a row', vals[3] === 'row 3!' && b2.left > 900_000, String(b2.left));
  const b3 = { left: 1_000_000 };
  ok('split pays per piece', refusal(() => evaluateTable(fnOf("split(replace(space(100000), ' ', ' x'), ' ', 2)"), COLS, rowsOf(100), { budget: b3 })) === 'budget');
}

// ── 3. Growing text is capped before it is built ─────────────────────────────
{
  const one = (expr: string, row: Cell[] = [1, 'abc']) => evaluateTable(fnOf(expr), COLS, [row])[0];
  ok('replace that would pass 1M characters is null', one("replace(space(100000), ' ', space(20))") === null);
  ok('regexp_replace that would pass 1M characters is null', one("regexp_replace(space(100000), '', space(20))") === null);
  ok('a $` reference counts the whole input', one("regexp_replace(space(2000), '', '$`')") === null);
  ok('concat past 1M characters is null', one('concat(space(100000), space(100000), space(100000), space(100000), space(100000), space(100000), space(100000), space(100000), space(100000), space(100000), space(100))') === null);
  ok('negative control: replace, regexp_replace and concat at ordinary sizes are unchanged',
    one("replace([d], 'b', 'XY')") === 'aXYc' && one("regexp_replace([d], '[ac]', '-')") === '-b-' &&
    one("concat([d], '-', [a])") === 'abc-1' && one("regexp_replace([d], 'b', '<$&>')") === 'a<b>c');
}

// ── 4. One budget for a whole fold, and the step says why it was skipped ─────
{
  const src = { columns: COLS, rows: rowsOf(2000) };
  const steps: TransformStep[] = [
    { type: 'calculated_field', name: 'x', expression: '[a] + [a] + [a]' },
    { type: 'calculated_field', name: 'y', expression: '[a] * 2' },
  ];
  const each = applyPipeline(src, steps, { budget: { left: 12_000 } }); // 2,000 rows × 5 tokens = 10,000, then 6,000 more
  ok('the second formula step is skipped once the fold\'s budget is spent', each.columns.map((c) => c.name).join() === 'a,d,x' &&
    each.warnings.join() === `Calculated field "y" skipped: ${formulaTooMuchWork()}`, JSON.stringify(each.warnings));
  const whole = applyPipeline(src, steps);
  ok('negative control: under the real budget both steps run', whole.columns.map((c) => c.name).join() === 'a,d,x,y' && whole.warnings.length === 0 &&
    whole.rows[5][2] === 15 && whole.rows[5][3] === 10);
}

// ── 5. LOD fill (the formula editor's preview) draws on it too ───────────────
{
  const fn = fnOf("{FIXED [d] : SUM(len(lower(space(100000))))}");
  ok('a non-bare LOD argument pays per row', refusal(() => lodValues(fn.lods, COLS, rowsOf(1000), { budget: { left: 1_000_000 } })) === 'budget');
  ok('negative control: a bare-column LOD reads cells, no budget spent',
    refusal(() => lodValues(fnOf('{FIXED [d] : SUM([a])}').lods, COLS, rowsOf(1000), { budget: { left: 1 } })) === 'ran');
}

// ── 6. Outside an evaluation nothing is counted and nothing throws ───────────
{
  const fn = fnOf('len(lower(space(100000)))');
  let v: unknown = 'threw';
  try { v = fn.evaluate({}); } catch (_) { /* a metric formula must never throw */ }
  ok('a lone evaluate (a metric formula, a plan preview) never throws', v === 100000);
}

finish();
