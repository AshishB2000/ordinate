// Self-check for the snapshot diff — src/engine/snapshotDiff.ts (DuckDB, on the
// two Parquet files in place) against src/data/snapshotDiffJs.ts (the pure-JS
// reference that defines every rule).
//
// EVERY fixture is DIFFERENTIAL: both implementations run on the same two
// tables — DuckDB on the files parquetStore wrote, JS on the same cells — and
// must agree on every field with Object.is, key sets included. A few anchor
// checks pin the hand-countable answers too, so the two cannot agree on a bug.
// The fixtures are the ones that fail silently: duplicate keys, '' vs null vs
// whitespace, '007' vs '7' as keys, multiset rows, reordered and renamed
// columns, a leading BOM, a 0-column table, a page cap — then a seeded fuzz.
//
// The last section drives the SHIPPED `snapshots:diff` handler (electron
// stubbed) with a spy on datasets.getDataset: the diff must never hydrate.
//
//   npm run build:ts && node scripts/test-snapshotDiff.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapdiff-'));
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test', getAppPath: () => path.resolve(__dirname, '..') },
      dialog: {}, net: {}, nativeImage: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const sqlDiff: typeof import('../src/engine/snapshotDiff') = require('../src/engine/snapshotDiff');
const jsDiff: typeof import('../src/data/snapshotDiffJs') = require('../src/data/snapshotDiffJs');

let seq = 0;
function file(): string {
  seq += 1;
  return path.join(tmpUserData, `t${seq}.parquet`);
}

/** Deep equality: same key sets, same array lengths, Object.is on every leaf. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join('\u0000') !== kb.join('\u0000')) return false;
    return ka.every((k) => same((a as any)[k], (b as any)[k]));
  }
  return Object.is(a, b);
}

const cols = (...names: string[]): ParsedColumn[] => names.map((name) => ({ name, type: 'text' }));

interface Case {
  label: string;
  oldCols: ParsedColumn[];
  oldRows: Cell[][];
  newCols: ParsedColumn[];
  newRows: Cell[][];
  key: string | null;
  limit?: number;
}

/** Run both; assert they agree; return the (agreed) answer for anchor checks. */
async function both(c: Case): Promise<any> {
  const of = file();
  const nf = file();
  pqSync.writeTable(of, c.oldCols, c.oldRows);
  pqSync.writeTable(nf, c.newCols, c.newRows);
  const sql = await sqlDiff.diffParquet({ parquetPath: of, columns: c.oldCols }, { parquetPath: nf, columns: c.newCols }, c.key, c.limit);
  const js = jsDiff.diffTablesJs({ columns: c.oldCols, rows: c.oldRows }, { columns: c.newCols, rows: c.newRows }, c.key, c.limit);
  ok(`${c.label}: DuckDB answered (not the fallback)`, sql !== null);
  ok(`${c.label}: DuckDB and JS agree (Object.is, every field)`, same(sql, js),
    `\n  sql=${JSON.stringify(sql)}\n  js =${JSON.stringify(js)}`);
  return js;
}

async function main(): Promise<void> {
  // ── 1. Keyed: added / removed / changed, with the changed cell ────────────
  const base = await both({
    label: 'keyed basics',
    oldCols: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }, { name: 'amount', type: 'number' }],
    oldRows: [['1', 'a', 10], ['2', 'b', 20], ['3', 'c', 30]],
    newCols: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }, { name: 'amount', type: 'number' }],
    newRows: [['1', 'a', 10], ['2', 'b', 25], ['4', 'd', 40]],
    key: 'id',
  });
  ok('keyed basics: 1 added, 1 removed, 1 changed, 1 unchanged',
    same(base.counts, { added: 1, removed: 1, changed: 1, unchanged: 1 }), JSON.stringify(base.counts));
  ok('keyed basics: the changed cell is amount 20 → 25',
    same(base.changed, [{ ordOld: 1, ordNew: 1, key: '2', cells: [{ column: 'amount', old: '20', new: '25' }] }]), JSON.stringify(base.changed));
  ok('keyed basics: added is id 4 at new row 2, removed is id 3 at old row 2',
    same(base.added, [{ ord: 2, values: ['4', 'd', '40'] }]) && same(base.removed, [{ ord: 2, values: ['3', 'c', '30'] }]));

  // ── 2. Duplicate keys: the first row of a key, by file order, and a count ─
  const dup = await both({
    label: 'duplicate keys',
    oldCols: cols('id', 'v'), oldRows: [['1', 'x'], ['1', 'y'], ['2', 'z'], ['2', 'z2'], ['2', 'z3']],
    newCols: cols('id', 'v'), newRows: [['1', 'y'], ['2', 'z'], ['2', 'w']],
    key: 'id',
  });
  ok('duplicate keys: counted per side (old 3, new 1)', same(dup.duplicates, { old: 3, new: 1 }), JSON.stringify(dup.duplicates));
  ok('duplicate keys: key 1 compares its FIRST rows (x → y); key 2 is unchanged',
    dup.counts.changed === 1 && dup.counts.unchanged === 1 && dup.changed[0].cells[0].old === 'x');

  // ── 3. Empty is null, '' or whitespace — all equal; ' a' is not 'a' ───────
  const empt = await both({
    label: 'empty vs null vs whitespace',
    oldCols: cols('k', 'v'),
    oldRows: [['k1', ''], ['k2', null], ['k3', '   '], ['k4', '\t'], ['k5', ' '], ['k6', 'a'], ['k7', '﻿'], ['', 'e1'], [null, 'e2']],
    newCols: cols('k', 'v'),
    newRows: [['k1', null], ['k2', ' '], ['k3', ''], ['k4', null], ['k5', '\r\n'], ['k6', ' a'], ['k7', null], ['  ', 'e1']],
    key: 'k',
  });
  ok('empties: only k6 changed (" a" vs "a"); the empty keys are one key', empt.counts.changed === 1 && empt.changed[0].key === 'k6'
    && empt.counts.removed === 0 && empt.duplicates.old === 1, JSON.stringify(empt.counts));

  // ── 4. No type inference: '007' and '7' are different keys and values ────
  const zero = await both({
    label: "'007' vs '7'",
    oldCols: cols('code', 'v'), oldRows: [['007', 'a'], ['7', 'b'], ['x', '1.0']],
    newCols: cols('code', 'v'), newRows: [['7', 'a'], ['007', 'b'], ['x', '1']],
    key: 'code',
  });
  ok("'007' vs '7': three keys matched, all three changed", zero.counts.changed === 3 && zero.counts.added === 0, JSON.stringify(zero.counts));

  // ── 5. Full row is a multiset; the later copy is the removed one ──────────
  const multi = await both({
    label: 'full-row multiset',
    oldCols: cols('a', 'b'), oldRows: [['a', '1'], ['a', '1'], ['b', '2'], ['a', '1']],
    newCols: cols('a', 'b'), newRows: [['a', '1'], ['b', '2'], ['c', '3']],
    key: null,
  });
  ok('multiset: two of three (a,1) removed — the later ones — and (c,3) added',
    same(multi.counts, { added: 1, removed: 2, changed: 0, unchanged: 2 })
      && same(multi.removed.map((r: any) => r.ord), [1, 3]), JSON.stringify(multi));

  // ── 6. Columns are matched by name: a reorder is not a change ─────────────
  const order = await both({
    label: 'column order (full row)',
    oldCols: cols('x', 'y'), oldRows: [['1', 'a'], ['2', 'b']],
    newCols: cols('y', 'x'), newRows: [['b', '2'], ['a', '1']],
    key: null,
  });
  ok('column order: a reordered table is unchanged', order.counts.added === 0 && order.counts.removed === 0);
  await both({ label: 'column order (keyed)', oldCols: cols('x', 'y'), oldRows: [['1', 'a']], newCols: cols('y', 'x'), newRows: [['b', '1']], key: 'x' });
  const renamed = await both({
    label: 'added and removed columns',
    oldCols: cols('id', 'a', 'b'), oldRows: [['1', 'p', 'q']],
    newCols: cols('id', 'b', 'c'), newRows: [['1', 'q', 'r']],
    key: 'id',
  });
  ok('added/removed columns are reported, and only shared ones compared',
    same(renamed.addedColumns, ['c']) && same(renamed.removedColumns, ['a']) && same(renamed.columns, ['id', 'b']) && renamed.counts.unchanged === 1);

  // ── 7. A leading BOM survives the bridge; bounded pages keep file order ───
  await both({ label: 'leading BOM', oldCols: cols('k', 'v'), oldRows: [['1', '﻿x']], newCols: cols('k', 'v'), newRows: [['1', 'x'], ['﻿2', 'y']], key: 'k' });
  const many: Cell[][] = [];
  for (let i = 0; i < 130; i++) many.push([String(i), 'v' + (i % 3)]);
  const capped = await both({ label: 'page cap', oldCols: cols('k', 'v'), oldRows: [], newCols: cols('k', 'v'), newRows: many, key: null, limit: 50 });
  ok('page cap: 130 counted, 50 shown, in file order', capped.counts.added === 130 && capped.added.length === 50 && capped.added[49].ord === 49);

  // ── 8. Degenerate tables ─────────────────────────────────────────────────
  await both({ label: 'no shared columns', oldCols: cols('a'), oldRows: [['1'], ['2']], newCols: cols('b'), newRows: [['1'], ['2'], ['3']], key: null });
  await both({ label: '0-column table', oldCols: [], oldRows: [[], []], newCols: cols('a'), newRows: [['1']], key: null });
  await both({ label: 'both empty', oldCols: cols('a'), oldRows: [], newCols: cols('a'), newRows: [], key: 'a' });
  const bad = await sqlDiff.diffParquet({ parquetPath: file(), columns: cols('a') }, { parquetPath: file(), columns: cols('b') }, 'a');
  ok('a key that is not in both versions is an error, from both', bad !== null && 'error' in bad
    && 'error' in jsDiff.diffTablesJs({ columns: cols('a'), rows: [] }, { columns: cols('b'), rows: [] }, 'a'));

  // ── 9. Seeded fuzz over the troublesome alphabet ─────────────────────────
  let s = 7;
  const rnd = (n: number): number => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  const alphabet: Cell[] = ['', null, ' ', '007', '7', 'a', 'a ', ' ', '\t', 'b', '1.0', '1'];
  const table = (): Cell[][] => Array.from({ length: rnd(25) }, () => [alphabet[rnd(alphabet.length)], alphabet[rnd(alphabet.length)], alphabet[rnd(4)]]);
  let agreed = 0;
  for (let i = 0; i < 40; i++) {
    const c: Case = { label: `fuzz ${i}`, oldCols: cols('k', 'v', 'w'), oldRows: table(), newCols: cols('w', 'k', 'v'), newRows: table(), key: [null, 'k', 'v', 'w'][rnd(4)], limit: 1 + rnd(6) };
    c.newRows = c.newRows.map((r) => [r[2], r[0], r[1]]);
    const of = file();
    const nf = file();
    pqSync.writeTable(of, c.oldCols, c.oldRows);
    pqSync.writeTable(nf, c.newCols, c.newRows);
    const a = await sqlDiff.diffParquet({ parquetPath: of, columns: c.oldCols }, { parquetPath: nf, columns: c.newCols }, c.key, c.limit);
    const b = jsDiff.diffTablesJs({ columns: c.oldCols, rows: c.oldRows }, { columns: c.newCols, rows: c.newRows }, c.key, c.limit);
    if (same(a, b)) agreed++;
    else ok(`fuzz ${i} agrees`, false, `\n  case=${JSON.stringify(c)}\n  sql=${JSON.stringify(a)}\n  js =${JSON.stringify(b)}`);
  }
  ok('fuzz: DuckDB and JS agree on 40 random pairs', agreed === 40, `${agreed}/40`);

  // ── 10. The shipped handler never hydrates the dataset ───────────────────
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const snapshots: typeof import('../src/data/snapshots') = require('../src/data/snapshots');
  require('../src/ipc/snapshots').register({});
  await projects.init();
  const proj = await projects.createProject('Diff');
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Stock', sourceKind: 'csv', columns: cols('sku', 'qty'), rows: [['007', '1'], ['7', '2']],
  });
  await snapshots.withForcedKeep(proj.id, ds!.id, () => datasets.updateDatasetData(proj.id, ds!.id, { columns: cols('sku', 'qty'), rows: [['007', '3'], ['8', '1']] }));
  const [kept] = await snapshots.list(proj.id, ds!.id);
  ok('handler fixture: one snapshot kept by the update', Boolean(kept));
  const real = datasets.getDataset;
  let hydrated = 0;
  (datasets as any).getDataset = async (...args: any[]): Promise<any> => { hydrated++; return (real as any)(...args); };
  const res = await handlers.get('snapshots:diff')!({}, { projectId: proj.id, datasetId: ds!.id, stamp: kept && kept.stamp, key: 'sku' });
  (datasets as any).getDataset = real;
  ok('snapshots:diff answers through the handler', res && res.ok === true
    && same(res.diff.counts, { added: 1, removed: 1, changed: 1, unchanged: 0 }), JSON.stringify(res));
  ok('snapshots:diff never hydrates the dataset (getDataset not called)', hydrated === 0, `${hydrated} call(s)`);
  const bogus = await handlers.get('snapshots:diff')!({}, { projectId: proj.id, datasetId: ds!.id, stamp: '../../etc', key: 'sku' });
  ok('snapshots:diff refuses a stamp that is not one', bogus && bogus.ok === false);
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' snapshot-diff check(s) FAILED'); process.exit(1); }
    console.log('\nAll snapshot-diff checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
