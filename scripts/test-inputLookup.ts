// Self-check for input-table LOOKUPS and the checks a typed table gets:
//
//   · the DIFFERENTIAL between the resident key read
//     (engine/lookupResident.lookupKeysResident) and its JS reference
//     (inputTable/lookup.lookupKeysJs) over the same Parquet bytes — every key,
//     in order, with Object.is — on a fixture built to break a sloppy one:
//     duplicates, '' / space / tab / NBSP cells, `007` beside `7`, a leading
//     BOM, `1` beside `1.0`, a non-number in a number column;
//   · `refTableFor` on a STORED dataset answers off the Parquet and never
//     hydrates it (datasets.getDataset spied);
//   · lookup validation in `checkTable`: members pass, strangers are flagged,
//     empties are not, a number lookup compares numbers, and a lookup that
//     cannot run says why instead of flagging every cell — the SAME outcomes a
//     `references` quality rule gives, because it is one;
//   · required cells, a quality rule on a base column, and a rule on a column
//     the base does not have (skipped here, checked on the output).
//
//   npm run build:ts && node scripts/test-inputLookup.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type RefTable = import('../src/analysis/qualityRules').RefTable;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-inputlookup-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: () => tmpUserData, getVersion: () => '0.0.0-test' }, ipcMain: { handle: () => {}, on: () => {} } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const lookup: typeof import('../src/data/inputTable/lookup') = require('../src/data/inputTable/lookup');
const resident: typeof import('../src/engine/lookupResident') = require('../src/engine/lookupResident');
const V: typeof import('../src/data/inputTable/validate') = require('../src/data/inputTable/validate');
const rules: typeof import('../src/analysis/qualityRules') = require('../src/analysis/qualityRules');

const sameKeys = (a: Array<string | number> | null, b: Array<string | number> | null): boolean =>
  !!a && !!b && a.length === b.length && a.every((k, i) => Object.is(k, b[i]));

async function main(): Promise<void> {
  // ── 1. The differential ────────────────────────────────────────────────────
  const cols: ParsedColumn[] = [
    { name: 'region', type: 'text' },
    { name: 'code', type: 'number' },
    { name: 'day', type: 'date' },
  ];
  const rows: Cell[][] = [
    ['north', 1, '2026-01-05'],
    ['007', 1.0, '2026-01-05'],
    ['7', 2.5, '1/5/2026'],
    ['', null, ''],
    [' ', null, ' '],
    ['\t', null, '\t'],
    [' ', null, null],
    ['﻿bom', -3, '2026-02-01'],
    ['north', 2.5, '2026-01-05'],
    [null, 1e21, null],
    ['south', 0, 'not a date'],
  ];
  const file = path.join(tmpUserData, 'keys.parquet');
  const bridge = parquetStore.isSupported();
  if (!bridge) {
    ok('# no DuckDB bridge — JS reference only', true);
  } else {
    pqSync.writeTable(file, cols, rows);
    const hydrated = pqSync.readTable(file, cols)!.rows;
    for (const c of cols) {
      const js = lookup.lookupKeysJs(cols, hydrated, c.name);
      const sql = await resident.lookupKeysResident({ parquetPath: file, columns: cols }, c.name);
      ok(`resident keys of ${c.type} column "${c.name}" ≡ the JS reference`, sameKeys(sql, js), JSON.stringify({ sql, js }));
    }
    ok('text keys keep 007 apart from 7, first-seen, no empties',
      JSON.stringify(lookup.lookupKeysJs(cols, hydrated, 'region')) === JSON.stringify(['north', '007', '7', '﻿bom', 'south']));
    ok('number keys fold 1 and 1.0, skip empties', JSON.stringify(lookup.lookupKeysJs(cols, hydrated, 'code')) === JSON.stringify([1, 2.5, -3, 1e21, 0]));
    ok('a missing column is null on both paths',
      lookup.lookupKeysJs(cols, hydrated, 'nope') === null && (await resident.lookupKeysResident({ parquetPath: file, columns: cols }, 'nope')) === null);
  }

  // ── 2. refTableFor on a stored dataset never hydrates it ───────────────────
  await projects.init();
  const pid = (await projects.createProject('Lookups')).id;
  const sales = await datasets.saveDataset(pid, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
    rows: [['east', 10], ['west', 20], ['east', 30], ['north', null]],
  });
  const realGet = datasets.getDataset;
  let hydrations = 0;
  (datasets as any).getDataset = async (...args: [string, string]) => { hydrations++; return realGet(...args); };
  const ref = await lookup.refTableFor(pid, sales!.id, 'region');
  (datasets as any).getDataset = realGet;
  if (bridge) ok('refTableFor answered without hydrating the key dataset', hydrations === 0, `getDataset ×${hydrations}`);
  ok('refTableFor is one column, one row per key', JSON.stringify(ref) === JSON.stringify({
    columns: [{ name: 'region', type: 'text' }], rows: [['east'], ['west'], ['north']],
  }), JSON.stringify(ref));
  const gone = await lookup.refTableFor(pid, crypto.randomUUID(), 'region');
  ok('a dataset that is gone is null', gone === null);
  const noCol = await lookup.refTableFor(pid, sales!.id, 'nope');
  ok('a column that is gone keeps the columns and no rows (the rule names it)', !!noCol && noCol.rows.length === 0 && noCol.columns.length === 2);

  // ── 3. Lookup validation, as a references rule ─────────────────────────────
  const salesId = sales!.id;
  const inCols = [
    { name: 'region', type: 'text' as const, lookup: { datasetId: salesId, column: 'region' } },
    { name: 'target', type: 'number' as const, required: true },
  ];
  const ctx = (refTable: RefTable | null, extra: Partial<import('../src/data/inputTable/validate').CheckContext> = {}) => ({
    lookups: new Map([[0, refTable]]), lookupNames: new Map([[salesId, 'Sales']]), rules: [], refs: new Map(), ...extra,
  });
  const table: Cell[][] = [['east', 100], ['mars', 200], [null, 300], ['East', 50], ['west', null]];
  const res = V.checkTable(inCols, table, ctx(ref));
  const lookups = res.issues.filter((i) => i.kind === 'lookup');
  ok('a value outside the key set is flagged, case-sensitively', JSON.stringify(lookups.map((i) => i.r)) === JSON.stringify([1, 3]), JSON.stringify(lookups));
  ok('the flag says where the keys come from', lookups[0].message === 'Not a value of Sales · region');
  ok('an empty lookup cell is not a lookup failure', !lookups.some((i) => i.r === 2));
  const req = res.issues.filter((i) => i.kind === 'required');
  ok('an empty required cell is flagged', req.length === 1 && req[0].r === 4 && req[0].c === 1);
  ok('flags are counted per cell', res.failCells === 3 && res.warnCells === 0);

  // The same verdict a references rule gives — they are one definition.
  const refRule = { id: crypto.randomUUID(), kind: 'references' as const, column: 'region', args: { datasetId: salesId, column: 'region' }, severity: 'fail' as const };
  const viaRule = rules.evaluateRuleJs(refRule, inCols, res.stored, ref);
  ok('lookup failures ≡ the references rule\'s failing rows', viaRule.failing === lookups.length);

  const numRef: RefTable = { columns: [{ name: 'code', type: 'number' }], rows: [[1], [2.5]] };
  const numCols = [{ name: 'code', type: 'number' as const, lookup: { datasetId: salesId, column: 'code' } }];
  const nres = V.checkTable(numCols, [['1.0'], [2.5], ['3']], ctx(numRef));
  ok('a number lookup compares numbers: "1.0" is 1', JSON.stringify(nres.issues.map((i) => i.r)) === JSON.stringify([2]));

  const mismatch = V.checkTable([{ name: 'region', type: 'text', lookup: { datasetId: salesId, column: 'code' } }], [['x']], ctx(numRef));
  ok('a text lookup of a number key cannot run, and says so — no cell flagged', mismatch.issues.length === 0 && /types must match/.test(mismatch.notes[0] || ''), JSON.stringify(mismatch.notes));
  const lost = V.checkTable(inCols, [['east', 1]], ctx(null));
  ok('a lookup whose dataset is gone says so — no cell flagged', lost.issues.length === 0 && /no longer exists/.test(lost.notes[0] || ''));
  const typed = V.checkTable(inCols, [['east', 'abc']], ctx(ref));
  ok('text in a number column is stored as null, kept in the overlay, flagged once',
    typed.stored[0][1] === null && JSON.stringify(typed.block) === JSON.stringify({ invalid: [[0, 1, 'abc']] })
    && typed.issues.length === 1 && typed.issues[0].kind === 'type');

  // ── 4. The dataset's own quality rules ─────────────────────────────────────
  const range = { id: crypto.randomUUID(), kind: 'range' as const, column: 'target', args: { min: 0, max: 250 }, severity: 'warn' as const };
  const derived = { id: crypto.randomUUID(), kind: 'not_null' as const, column: 'margin', args: {}, severity: 'fail' as const };
  const count = { id: crypto.randomUUID(), kind: 'row_count' as const, args: { min: 10 }, severity: 'fail' as const };
  const rres = V.checkTable(inCols, table, ctx(ref, { rules: [range, derived, count] }));
  const ruleHits = rres.issues.filter((i) => i.kind === 'rule');
  ok('a range rule flags the cell it fails, with the rule\'s severity', ruleHits.length === 1 && ruleHits[0].r === 2 && ruleHits[0].severity === 'warn' && ruleHits[0].ruleId === range.id);
  ok('a rule on a column the base does not have is left to the output check', !rres.notes.some((n) => /margin/.test(n)));
  ok('a row-count rule is a note about the table', rres.notes.some((n) => /Row count/.test(n)));
  ok('a warn-only cell counts as warn', rres.warnCells === 1);
}

main()
  .catch((err) => ok('threw', false, err && err.stack))
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp */ }
    if (failureCount()) { console.error('\n' + failureCount() + ' input-lookup check(s) FAILED'); process.exit(1); }
    void duck;
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
