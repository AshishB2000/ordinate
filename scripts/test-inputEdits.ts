// Self-check for an input table's EDIT MODEL and its TYPE COERCION:
// src/data/inputTable/edits.ts (paste parsing, fill down, batches, undo) and
// src/data/inputTable/validate.ts (what a typed value becomes).
//
// Paste text is written the way Excel, Numbers and Google Sheets put a block on
// the clipboard — quoted cells with tabs, newlines and "" inside, CRLF, a
// trailing newline, ragged rows — plus the case a CSV parser gets wrong (a quote
// in the middle of prose). Coercion is pinned against parse.ts's own strict
// rules: 007, a zip and a 16-digit id are NOT numbers. And edits.js is loaded
// the renderer's way (a bare `module`/`exports`, cleared after load), because a
// function that reads `exports.X` at call time works under Node and throws in
// the hub.
//
//   npm run build:ts && node scripts/test-inputEdits.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');

const E: typeof import('../src/data/inputTable/edits') = require('../src/data/inputTable/edits');
const V: typeof import('../src/data/inputTable/validate') = require('../src/data/inputTable/validate');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');

type Cell = import('../src/data/inputTable/edits').Cell;
const J = (v: unknown): string => JSON.stringify(v);
const sameRows = (a: Cell[][], b: Cell[][]): boolean =>
  a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, j) => Object.is(v, b[i][j])));

// ── 1. Paste parsing ─────────────────────────────────────────────────────────
{
  ok('tabs and newlines split a block', J(E.parseTsv('a\tb\nc\td')) === J([['a', 'b'], ['c', 'd']]));
  ok('CRLF rows (Excel on Windows)', J(E.parseTsv('a\tb\r\nc\td\r\n')) === J([['a', 'b'], ['c', 'd']]));
  ok('a lone CR is a row break too', J(E.parseTsv('a\rb')) === J([['a'], ['b']]));
  ok('one trailing newline adds no row', E.parseTsv('x\ty\n').length === 1);
  ok('an empty line in the middle is an empty row', J(E.parseTsv('a\n\nb')) === J([['a'], [''], ['b']]));
  ok('a quoted cell keeps its tab', J(E.parseTsv('"a\tb"\tc')) === J([['a\tb', 'c']]));
  ok('a quoted cell keeps its newline', J(E.parseTsv('"line 1\nline 2"\tz\nq\tr')) === J([['line 1\nline 2', 'z'], ['q', 'r']]));
  ok('"" inside a quoted cell is one quote', J(E.parseTsv('"say ""hi"""\t1')) === J([['say "hi"', '1']]));
  ok('a quote mid-prose is text, not a quote', J(E.parseTsv('5" pipe\tx')) === J([['5" pipe', 'x']]));
  ok('a quote that does not close a cell is text', J(E.parseTsv('"ab"c\td')) === J([['"ab"c', 'd']]));
  ok('an unclosed quote is text to the end', J(E.parseTsv('"open\tx')) === J([['"open', 'x']]));
  ok('ragged rows keep their own length', J(E.parseTsv('a\tb\tc\nd\ne\tf')) === J([['a', 'b', 'c'], ['d'], ['e', 'f']]));
  ok('a trailing tab is an empty last cell', J(E.parseTsv('a\t')) === J([['a', '']]));
  ok('empty text is no rows', E.parseTsv('').length === 0);
  const block: Cell[][] = [['plain', 'tab\there', 'line\nbreak'], ['say "x"', 12.5, null]];
  const back = E.parseTsv(E.toTsv(block));
  ok('toTsv → parseTsv round-trips tabs, newlines and quotes',
    J(back) === J([['plain', 'tab\there', 'line\nbreak'], ['say "x"', '12.5', '']]), J(back));
}

// ── 2. Type coercion — parse.ts's rules, and the reason when refused ──────────
{
  const n = (v: Cell) => V.coerceInput(v, 'number');
  ok('"12" is 12', Object.is(n('12').value, 12) && !n('12').error);
  ok('" -3.5 " is -3.5 (trimmed)', Object.is(n(' -3.5 ').value, -3.5));
  ok('2.4e3 is 2400', Object.is(n('2.4e3').value, 2400));
  ok('a stored number stays itself', Object.is(n(7).value, 7));
  ok('007 is refused, not 7', n('007').value === null && /Leading zeros/.test(n('007').error || ''));
  ok('a zip with a leading zero is refused', n('02139').value === null && !!n('02139').error);
  ok('a 16-digit id is refused', n('1234567890123456').value === null && /15 digits/.test(n('1234567890123456').error || ''));
  ok('1,200 is refused with the separator reason', n('1,200').value === null && /thousands/.test(n('1,200').error || ''));
  ok('$5 is refused with the currency reason', /currency/.test(n('$5').error || ''));
  ok('abc is refused', n('abc').value === null && n('abc').error === 'Not a number');
  ok('whitespace is empty, not an error', n('   ').value === null && !n('   ').error);
  ok('the rule is parse.ts\'s isFiniteNumber', ['12', '007', '1e3', '0.5', '.5', '1,2', 'Infinity']
    .every((s) => (V.coerceInput(s, 'number').error === undefined) === parse.isFiniteNumber(s)));
  const d = (v: Cell) => V.coerceInput(v, 'date');
  ok('2026-03-31 is a date, kept as typed', d('2026-03-31').value === '2026-03-31');
  ok('3/31/2026 is a date', d('3/31/2026').value === '3/31/2026');
  ok('a bare year is not a date', d('2026').value === null && !!d('2026').error);
  ok('hello is not a date', !!d('hello').error);
  const t = (v: Cell) => V.coerceInput(v, 'text');
  ok('text keeps 007 verbatim', t('007').value === '007');
  ok('text keeps surrounding spaces', t(' a ').value === ' a ');
  ok('a number in a text column becomes its digits', t(12).value === '12');
  ok('whitespace-only text is empty', t(' \t').value === null);
  const cols = [{ name: 'n', type: 'number' as const }, { name: 't', type: 'text' as const }];
  ok('normalizeRows: valid values coerced, refused text kept as typed',
    J(V.normalizeRows(cols, [['12', 7], ['abc', null]])) === J([[12, '7'], ['abc', null]]));
}

// ── 3. Batches: atomic, and their inverse is exact ────────────────────────────
{
  const rows: Cell[][] = [['a', 1], ['b', 2]];
  const frozen = J(rows);
  const res = E.applyBatch(rows, { label: 'x', ops: [{ t: 'set', r: 0, c: 1, cells: [[5]] }, { t: 'ins', at: 2, rows: [['c']] }, { t: 'del', at: 0, n: 1 }] }, 2, 100)!;
  ok('ops apply in order', J(res.rows) === J([['b', 2], ['c', null]]), J(res.rows));
  ok('the input rows are never mutated', J(rows) === frozen);
  const back = E.applyBatch(res.rows, res.inverse, 2, 100)!;
  ok('the inverse restores the rows exactly', sameRows(back.rows, rows));
  const bad = [
    { label: 'x', ops: [{ t: 'set', r: 5, c: 0, cells: [['z']] }] },
    { label: 'x', ops: [{ t: 'set', r: 0, c: 1, cells: [['z', 'too wide']] }] },
    { label: 'x', ops: [{ t: 'set', r: 0, c: 0, cells: [[{}]] }] },
    { label: 'x', ops: [{ t: 'set', r: 0, c: 0, cells: [[NaN]] }] },
    { label: 'x', ops: [{ t: 'set', r: 0, c: 0, cells: [['x'.repeat(E.MAX_CELL_TEXT + 1)]] }] },
    { label: 'x', ops: [{ t: 'del', at: 1, n: 5 }] },
    { label: 'x', ops: [{ t: 'ins', at: 0, rows: [[1, 2, 3]] }] },
    { label: 'x', ops: [{ t: 'nuke' }] },
    { label: 'x', ops: [] },
    { label: 'x', ops: [{ t: 'set', r: 0, c: 0, cells: [['ok']] }, { t: 'del', at: 9, n: 1 }] },
  ];
  ok('every malformed batch is refused whole', bad.every((b) => E.applyBatch(rows, b, 2, 100) === null));
  ok('growing past the cap is refused', E.applyBatch(rows, { label: 'x', ops: [{ t: 'ins', at: 2, rows: [[], []] }] }, 2, 3) === null);
  ok('"" is stored as null (the app\'s empty)', E.applyBatch(rows, { label: 'x', ops: [{ t: 'set', r: 0, c: 0, cells: [['']] }] }, 2, 9)!.rows[0][0] === null);
}

// ── 4. Paste → one batch ─────────────────────────────────────────────────────
{
  const rows: Cell[][] = [['a', null, null], ['b', null, null]];
  const one = (r: number, c: number) => ({ r0: r, c0: c, r1: r, c1: c });
  const p = E.pasteBatch('1\t2\n3\t4\n5\t6\n', one(1, 1), rows.length, 3, 100)!;
  const res = E.applyBatch(rows, p.batch, 3, 100)!;
  ok('a 3×2 block lands at the active cell and adds the rows it needs',
    J(res.rows) === J([['a', null, null], ['b', '1', '2'], [null, '3', '4'], [null, '5', '6']]), J(res.rows));
  ok('the paste reports its range', J(p.range) === J({ r0: 1, c0: 1, r1: 3, c1: 2 }));
  ok('it is labelled by what it did', p.batch.label === 'Paste 6 cells');
  const wide = E.pasteBatch('x\ty\tz', one(0, 2), rows.length, 3, 100)!;
  ok('columns past the last one are dropped and counted', wide.clipped === 2 && wide.batch.label === 'Paste 1 cell');
  const capped = E.pasteBatch('1\n2\n3\n4', one(1, 0), rows.length, 3, 3)!;
  ok('rows past the cap are dropped and counted', capped.clipped === 2 && E.applyBatch(rows, capped.batch, 3, 3)!.rows.length === 3);
  const fill = E.pasteBatch('Q', { r0: 0, c0: 1, r1: 1, c1: 2 }, rows.length, 3, 100)!;
  ok('one value pasted on a range fills the range',
    J(E.applyBatch(rows, fill.batch, 3, 100)!.rows) === J([['a', 'Q', 'Q'], ['b', 'Q', 'Q']]));
  const ghost = E.pasteBatch('new', one(2, 0), rows.length, 3, 100)!;
  ok('pasting on the new-row line appends a row', E.applyBatch(rows, ghost.batch, 3, 100)!.rows.length === 3);
  ok('empty clipboard text is no batch', E.pasteBatch('', one(0, 0), 2, 3, 100) === null);
}

// ── 5. Fill down (⌘D) — a plain copy, never a series ─────────────────────────
{
  const rows: Cell[][] = [[1, 'x'], [2, 'y'], [null, null], [null, 'z']];
  const b = E.fillDownBatch(rows, { r0: 0, c0: 0, r1: 3, c1: 1 })!;
  const res = E.applyBatch(rows, b, 2, 100)!;
  ok('the first row is copied over the rest of the selection', J(res.rows) === J([[1, 'x'], [1, 'x'], [1, 'x'], [1, 'x']]));
  ok('1, 2 is NOT extrapolated to 3, 4', res.rows[2][0] === 1 && res.rows[3][0] === 1);
  ok('one batch, labelled', b.ops.length === 1 && b.label === 'Fill down 6 cells');
  const single = E.fillDownBatch(rows, { r0: 2, c0: 1, r1: 2, c1: 1 })!;
  ok('a one-row selection copies the row above into it', E.applyBatch(rows, single, 2, 100)!.rows[2][1] === 'y');
  ok('the top row has nothing above it to fill from', E.fillDownBatch(rows, { r0: 0, c0: 0, r1: 0, c1: 1 }) === null);
  const same: Cell[][] = [[4], [4], [4]];
  ok('a fill that changes nothing is no batch', E.fillDownBatch(same, { r0: 0, c0: 0, r1: 2, c1: 0 }) === null);
  ok('"4" over 4 is no change either', E.fillDownBatch([['4'], [4]], { r0: 0, c0: 0, r1: 1, c1: 0 }) === null);
}

// ── 6. The other batches, and the undo stack ─────────────────────────────────
{
  const rows: Cell[][] = [['a', 1], ['b', 2], ['c', 3]];
  ok('typing the same value is no batch', E.editBatch(rows, 0, 1, '1', 'n', 100) === null);
  ok('typing on the new-row line appends and writes', J(E.applyBatch(rows, E.editBatch(rows, 3, 0, 'd', 'k', 100)!, 2, 100)!.rows[3]) === J(['d', null]));
  ok('typing nothing on the new-row line adds nothing', E.editBatch(rows, 3, 0, '', 'k', 100) === null);
  ok('clear skips an already-empty selection', E.clearBatch([[null]], { r0: 0, c0: 0, r1: 0, c1: 0 }) === null);
  ok('delete rows is one op', J(E.deleteRowsBatch(2, 0, 3)!.ops) === J([{ t: 'del', at: 0, n: 3 }]));
  ok('add row stops at the cap', E.insertRowsBatch(3, 1, 3, 3) === null && E.insertRowsBatch(3, 5, 3, 5)!.label === 'Add 2 rows');

  const h = E.histNew();
  for (let i = 0; i < E.UNDO_CAP + 5; i++) E.histPush(h, { label: 'e' + i, forward: { label: 'e' + i, ops: [] }, inverse: { label: 'e' + i, ops: [] } });
  ok('the stack keeps the newest UNDO_CAP steps', h.past.length === E.UNDO_CAP && h.past[0].label === 'e5');
  const u = E.histUndo(h)!;
  ok('undo hands back the newest step and arms redo', u.label === 'e' + (E.UNDO_CAP + 4) && E.histLabels(h).redo === u.label);
  E.histPush(h, { label: 'new', forward: { label: 'new', ops: [] }, inverse: { label: 'new', ops: [] } });
  ok('a new step abandons the redo branch', E.histRedo(h) === null && E.histLabels(h).undo === 'new');
}

// ── 7. Loaded the renderer's way ─────────────────────────────────────────────
{
  const code = fs.readFileSync(path.join(__dirname, '../src/data/inputTable/edits.js'), 'utf8');
  const sandbox: any = { module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  let loaded = true;
  try { vm.runInContext(code, sandbox); } catch (_) { loaded = false; }
  const api = sandbox.module.exports;
  sandbox.module = undefined; // inputBind.ts clears both, exactly like this
  sandbox.exports = undefined;
  ok('edits.js loads with no require', loaded && typeof api.applyBatch === 'function');
  let works = false;
  try {
    const plan = api.pasteBatch('1\t2', { r0: 0, c0: 0, r1: 0, c1: 0 }, 0, 2, 10);
    const h = api.histNew();
    const res = api.applyBatch([], plan.batch, 2, 10);
    api.histPush(h, { label: plan.batch.label, forward: plan.batch, inverse: res.inverse });
    works = res.rows.length === 1 && api.histUndo(h) !== null && api.fillDownBatch([[1], [null]], { r0: 0, c0: 0, r1: 1, c1: 0 }) !== null;
  } catch (_) { works = false; }
  ok('every function still works once `exports` is gone', works);
}

finish();
