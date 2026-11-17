// The value index's suite helpers and its bench (scripts/test-askValueIndex.ts; docs/assistant/00-design.md, "Values,
// as built"). Not a test file itself (no `test-` prefix): the suite imports it.

import { ok } from './selfcheck';
import type * as RP from './rowPolicyHarness';

const fs: typeof import('fs') = require('fs');
const vs: typeof import('../src/engine/valueSearchResident') = require('../src/engine/valueSearchResident');
const vir: typeof import('../src/engine/valueIndexResident') = require('../src/engine/valueIndexResident');
const askValues: typeof import('../src/ipc/askValues') = require('../src/ipc/askValues');
const valueIndex: typeof import('../src/ipc/valueIndex') = require('../src/ipc/valueIndex');
const lifecycle: typeof import('../src/server/lifecycle') = require('../src/server/lifecycle');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');

type Cell = import('../src/data/transforms').Cell;
type Meta = import('../src/data/datasets').DatasetMeta;
const T = (name: string) => ({ name, type: 'text' as const });
const N = (name: string) => ({ name, type: 'number' as const });

/** A dataset's sidecar file (DATA_DIR here: no S3 in this suite). */
export const sidecarOf = (W: RP.World, id: string): Promise<string> => W.as('boss', async () => rec.valuesPath(W.P, id));
/** The sets of `ids`' sidecars, by dataset: the ones written (valueIndex sidecarsOf), read by the lookup with no word. */
export async function setsOf(W: RP.World, ids: readonly string[]): Promise<Map<string, import('../src/engine/valueIndexResident').ValueSet | null>> {
  const found = await W.as('boss', async () => {
    const metas = await metasOf(W, 'boss', ids);
    const at = await valueIndex.sidecarsOf(W.P, metas.map((m) => ({ id: m.id, version: m.storageVersion })));
    return vir.lookupValuesResident([...at].map(([datasetId, path]) => ({ datasetId, path, ranges: [] })));
  });
  return new Map([...(found ?? new Map()).entries()].map(([id, f]) => [id, f.set]));
}
/** A sidecar's value rows (of column `col`), read straight from the file; 0 when there is none. */
export async function rowsIn(W: RP.World, id: string, where = 'TRUE'): Promise<number> {
  const file = await sidecarOf(W, id);
  if (!fs.existsSync(file)) return 0;
  return W.as('boss', async () => Number((await duck.queryAsync(`SELECT CAST(count(*) AS DOUBLE) AS n FROM read_parquet('${file}') WHERE c0 <> '#' AND ${where}`))[0].n));
}

/** `fn` with the value search's DuckDB statements counted: scans and confirmations (`duck`), scans alone, lookups, and every statement naming `file` (`touched`). */
export async function counted<T>(fn: () => Promise<T>, file = '\0'): Promise<{ value: T; duck: number; scans: number; lookups: number; touched: number }> {
  const real = duck.queryAsync;
  let n = 0, scans = 0, lookups = 0, touched = 0;
  (duck as { queryAsync: unknown }).queryAsync = (sql: string, ...rest: unknown[]) => {
    if (sql.includes('QUALIFY row_number() OVER (PARTITION BY c ORDER BY o)')) n++;
    if (sql.includes('AND regexp_matches(v, ?)')) scans++;
    if (sql.startsWith(vir.LOOKUP_MARK)) lookups++;
    if (sql.includes(file)) touched++;
    return (real as (...a: unknown[]) => unknown)(sql, ...rest);
  };
  try {
    return { value: await fn(), duck: n, scans, lookups, touched };
  } finally {
    (duck as { queryAsync: unknown }).queryAsync = real;
  }
}

export const metasOf = (W: RP.World, who: string, ids: readonly string[]): Promise<Meta[]> =>
  W.as(who, async () => (await Promise.all(ids.map((id) => datasets.getDatasetMeta(W.P, id)))).filter((m): m is Meta => !!m));

// ── 7. The bench ─────────────────────────────────────────────────────────────

/** 12 datasets of 1,000,000 rows and five text columns, the index against the scan, timed and printed (VALUE_INDEX_BENCH=1). */
export async function bench(W: RP.World): Promise<void> {
  const cols = [T('region'), T('product'), T('customer'), T('store'), T('order_id'), N('amount')];
  const ids = await W.as('boss', async () => {
    const out: string[] = [];
    for (let k = 0; k < 12; k++) out.push((await datasets.saveDataset(W.P, { name: `Big ${k}`, sourceKind: 'csv', columns: cols, rows: [['East', 'p', 'c', 's', 'o', 1]] }))!.id);
    return out;
  });
  await lifecycle.settleWork(); // their own builds, of one row each, before their tables are replaced below
  const at = new Map(await W.as('boss', async () => ids.map((id) => [id, rec.parquetPath(W.P, id)] as const)));
  const file = (id: string): string => at.get(id)!;
  let t = Date.now();
  await W.as('boss', () => duck.execAsync(`COPY (SELECT (['East','West','North','South'])[1 + (i % 4)] AS c0,
    'Product ' || (i % 1000) || ' ' || (['Chair','Desk','Lamp','Westwood Sofa'])[1 + (i % 4)] AS c1, 'Customer ' || ((i * 7919) % 8000) || ' Corp' AS c2,
    'Store ' || (i % 500) AS c3, 'ORD-' || i AS c4, CAST(i % 997 AS VARCHAR) AS c5 FROM range(1000000) r(i)) TO '${file(ids[0])}' (FORMAT PARQUET)`));
  for (const id of ids.slice(1)) fs.copyFileSync(file(ids[0]), file(id));
  console.log(`  bench: 12 datasets of 1,000,000 rows (4, 1,000, 8,000, 500 and 1,000,000 distinct text values) in ${Date.now() - t} ms`);
  const times: number[] = [];
  for (const id of ids) {
    t = Date.now();
    if (!(await W.as('boss', () => valueIndex.buildValueIndex(W.P, id)))) throw new Error('bench: a build');
    times.push(Date.now() - t);
  }
  const src = { parquetPath: file(ids[0]), columns: cols };
  t = Date.now();
  const found = await W.as('boss', () => vir.distinctValuesResident(src.parquetPath, cols, [0, 1, 2, 3, 4]));
  const engine = Date.now() - t;
  const nRows = await rowsIn(W, ids[0]);
  const bytes = fs.statSync(await sidecarOf(W, ids[0])).size;
  console.log(`  bench: a build ${Math.min(...times)} to ${Math.max(...times)} ms (its DuckDB statements: the counts, the id shape, the values: ${engine} ms, ${found?.reduce((n, c) => n + (c.values?.length ?? 0), 0)} values, a sidecar of ${nRows} rows, ${Math.round(bytes / 1024)} KiB, beside a table of ${Math.round(fs.statSync(file(ids[0])).size / 1024)} KiB)`);
  const metas = await metasOf(W, 'boss', ids);
  const q = 'sales in south'; // one value a dataset (region South): 12 lines, one from each of the 12
  const timed = async (on: boolean, who = 'boss', question = q) => {
    askValues._setValueIndex(on);
    try {
      const r = await counted(async () => {
        const t0 = Date.now();
        const text = (await W.as(who, () => askValues.askValueFacts(W.P, metas, [], question))).text;
        return { text, ms: Date.now() - t0 };
      });
      return { ...r.value, duck: r.duck, lookups: r.lookups, datasets: new Set(r.value.text.split('\n').slice(1).map((l) => l.split('.')[0])).size };
    } finally {
      askValues._setValueIndex(true);
    }
  };
  const line = (label: string, r: Awaited<ReturnType<typeof timed>>) =>
    console.log(`  bench: ${label}: ${r.ms} ms, ${r.lookups} lookup, ${r.duck} DuckDB statements, ${r.datasets} of 12 datasets with a value`);
  for (let k = 0; k < 2; k++) {
    line('an admin\'s ask over the 12, the index, "sales in south": no id in it, so no order_id (id-like) is scanned', await timed(true));
    line('the same ask, the scan (before the index)', await timed(false));
  }
  for (let k = 0; k < 2; k++) line('"sales of order 48213": each order_id scanned for 48213 within the budget', await timed(true, 'boss', 'sales of order 48213'));
  for (let k = 0; k < 2; k++) line('"sales in south in 2024": a year is no id token, so no order_id is scanned', await timed(true, 'boss', 'sales in south in 2024'));
  const mark = (level: 'personal' | 'none') => W.as('boss', async () => { for (const id of ids) await catalog.setColumn(W.P, id, 'order_id', { sensitivity: level }); });
  await mark('personal'); // order_id withheld: every column the ask may search is held
  for (let k = 0; k < 2; k++) line('the same ask, every searchable column held (order_id marked personal)', await timed(true));
  t = Date.now();
  await W.as('boss', () => vs.searchValuesResident(src, [0, 1, 2, 3, 4], ['westwood', 'sofa', 'corp'], []));
  const scanOne = Date.now() - t;
  const files = await Promise.all(ids.map(async (id) => ({ datasetId: id, path: await sidecarOf(W, id) })));
  for (const words of [['south', 'westwood'], ['corp', 'sofa'], ['westwood', 'sofa', 'customer', 'corp']]) {
    const ms: number[] = [];
    let n = 0;
    for (let k = 0; k < 3; k++) {
      t = Date.now();
      const found2 = await W.as('boss', () => vir.lookupValuesResident(files.map((f) => ({ ...f, ranges: words.map(vs.keyRange) }))));
      ms.push(Date.now() - t);
      n = [...(found2?.values() ?? [])].reduce((a, f) => a + [...f.columns.values()].reduce((m, c) => m + c.values.length, 0), 0);
    }
    console.log(`  bench: the lookup alone for the 12, "${words.join(' ')}": ${Math.min(...ms)} to ${Math.max(...ms)} ms (${n} candidates)`);
  }
  console.log(`  bench: one scan of one dataset ${scanOne} ms`);
  // A row lock on every one: the confirmations.
  for (const id of ids) {
    const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: W.P, datasetId: id, policy: { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } });
    if (set.body?.ok !== true) throw new Error(`bench: setRowPolicy ${set.text}`);
  }
  const sets = await setsOf(W, ids);
  const fresh = metas.every((m) => sets.get(m.id)?.stamp === vir.stampOf(m));
  line(`east, a row lock on each of the 12 (sets still fresh: ${fresh}), every searchable column held, "sales in east": the confirmations`, await timed(true, 'east', 'sales in east'));
  await mark('none');
  line('east, "sales in east", order_id back (id-like): the confirmations alone', await timed(true, 'east', 'sales in east'));
  line('east, "sales in east for order 48212": each order_id scanned too (one statement a dataset: the confirmation and the scan)', await timed(true, 'east', 'sales in east for order 48212'));

  // What a write still costs: it returns before its build; the dataset's next write waits for that build.
  const big = Array.from({ length: 200_000 }, (_, i) => [['East', 'West', 'North', 'South'][i % 4], `Product ${i % 1000}`, `Customer ${(i * 7919) % 8000} Corp`, `Store ${i % 500}`, `ORD-${i}`, i % 997] as Cell[]);
  const write = async () => { const t0 = Date.now(); await W.as('boss', () => datasets.updateDatasetData(W.P, ids[0], { columns: cols, rows: big })); return Date.now() - t0; };
  const first = await write();
  t = Date.now();
  await lifecycle.settleWork();
  const build = Date.now() - t;
  const next = await Promise.all([write(), write()]); // the second waits for the first's write and build
  await lifecycle.settleWork();
  console.log(`  bench: a write of 200,000 rows ${first} ms, returned before its build; the build after it ${build} ms; two writes at once ${next.join(' and ')} ms (the second waited for the first's build)`);
  ok('bench: ran', true);
}

// ── 8. Id-like columns ───────────────────────────────────────────────────────

/** `n` letters, no digit: `i` in base 26, least significant first (as the SQL below spells it). */
const letters = (i: number, n: number): string => Array.from({ length: n }, (_, k) => String.fromCharCode(97 + (Math.floor(i / 26 ** k) % 26))).join('');
const lettersSql = (n: number): string => Array.from({ length: n }, (_, k) => `chr(CAST(97 + (i // ${26 ** k}) % 26 AS INTEGER))`).join(' || ');

/** Section 8 of scripts/test-askValueIndex.ts: which columns past the cap are id-like, and what an ask then scans. */
export async function idLike(W: RP.World): Promise<void> {
  const { accounts, ship } = await W.as('boss', async () => {
    const save = async (name: string, columns: Array<{ name: string; type: 'text' }>, rows: Cell[][]) => (await datasets.saveDataset(W.P, { name, sourceKind: 'csv', columns, rows }))!.id;
    // 50,000 rows: a customer name a row (every one distinct, as ids are, but names), a model name with a number a row,
    // a code that is one token with a digit but repeats (12,000 values), a tier.
    const a = await save('Accounts', [T('name'), T('model'), T('batch'), T('tier')],
      Array.from({ length: 50_000 }, (_, i) => [i === 31_337 ? 'Acme Corp' : `Client ${letters(i, 4)}`, `Widget ${i} Pro`, `B-${i % 12_000}`, ['Gold', 'Silver', 'Bronze'][i % 3]]));
    const s = await save('Shipments', [T('ref'), T('email'), T('region'), T('zip')], [['ORD-0', 'aaaaa@acme.com', 'East', '00000']]);
    return { accounts: a, ship: s };
  });
  await lifecycle.settleWork(); // their builds, set off by the saves
  const table = await W.as('boss', async () => rec.parquetPath(W.P, ship));
  // 1,000,000 rows: an order id and an email (letters, one domain) a row, a region, a ZIP code of 5,000 values.
  await W.as('boss', () => duck.execAsync(`COPY (SELECT 'ORD-' || i AS c0, ${lettersSql(5)} || '@acme.com' AS c1, (['East','West','North','South'])[1 + (i % 4)] AS c2,
    lpad(CAST(i % 5000 AS VARCHAR), 5, '0') AS c3 FROM range(1000000) r(i)) TO '${table}' (FORMAT PARQUET)`));
  if (!(await W.as('boss', () => valueIndex.buildValueIndex(W.P, ship)))) throw new Error('fixture: the Shipments build');
  const sets = await setsOf(W, [accounts, ship]);
  const a = sets.get(accounts), sh = sets.get(ship);
  ok('id-like: past the cap, the ids and the emails are id-like; near-distinct names, model names with a number and a repeated code are not; ZIP codes under the cap stay held',
    sh?.idLike.join() === '0,1' && sh?.indexed.join() === '2,3' && a?.idLike.join() === '' && a?.indexed.join() === '3', JSON.stringify({ a, sh }));

  const ask = (who: string, ids: readonly string[], q: string, on = true) => counted(async () => {
    askValues._setValueIndex(on);
    try {
      return (await W.as(who, async () => askValues.askValueFacts(W.P, await metasOf(W, who, ids), [], q))).text;
    } finally {
      askValues._setValueIndex(true);
    }
  }, table);
  const acme = await ask('boss', [accounts], 'sales for acme widget');
  ok('id-like: a 50,000-name column is still scanned: Acme is found, and a model name with a number (the same as the scan)',
    acme.scans === 1 && acme.value.includes('- Accounts.name = "Acme Corp"') && acme.value.includes('- Accounts.model = "Widget 0 Pro"') && acme.value === (await ask('boss', [accounts], 'sales for acme widget', false)).value, JSON.stringify(acme));

  const none = await ask('boss', [ship], 'sales in south for acme');
  const scanned = await ask('boss', [ship], 'sales in south for acme', false);
  ok('id-like: no digit or @ in the question: no statement at all against the table of ids (the lookup alone), the region answered from the index',
    none.touched === 0 && none.duck === 0 && none.lookups === 1 && none.value.includes('- Shipments.region = "South"') && !none.value.includes('Shipments.email'), JSON.stringify(none));
  ok('id-like: …CONTROL: the scan reads it, and finds an email by its domain (what the index path no longer finds: the loss)',
    scanned.touched === 1 && scanned.value.includes('- Shipments.email = "aaaaa@acme.com"'), JSON.stringify(scanned));

  const year = await ask('boss', [ship], 'sales in south in 2024');
  ok('id-like: a year is no id: "sales in south in 2024" sends no statement against it, no ref listed (CONTROL: "order 48213" does, below)',
    year.touched === 0 && year.value.includes('- Shipments.region = "South"') && !year.value.includes('Shipments.ref'), JSON.stringify(year));
  const order = await ask('boss', [ship], 'order 48213');
  ok('id-like: "order 48213" scans the id columns for 48213 alone and finds ORD-48213 (not ORD-482130)',
    order.scans === 1 && order.touched === 1 && order.value.endsWith('\n- Shipments.ref = "ORD-48213"'), JSON.stringify(order));
  const bare = await ask('boss', [accounts, ship], '48213?');
  ok('id-like: an id alone ("48213?") is still looked for, in the id-like columns only (one scan: none of Accounts)',
    bare.scans === 1 && bare.value.endsWith('\n- Shipments.ref = "ORD-48213"') && (await ask('boss', [accounts, ship], '48213?', false)).value === '', JSON.stringify(bare));
  const email = `${letters(777_777, 5)}@acme.com`;
  const mail = await ask('boss', [ship], `who is ${email}?`);
  ok(`id-like: an email far down (${email}, row 777,777, a domain every row shares) is found, that one alone`,
    mail.scans === 1 && mail.value.split('\n').filter((l) => l.includes('Shipments.email')).join() === `- Shipments.email = "${email}"`, JSON.stringify(mail));

  // A row lock: east sees East's rows only (row 48213 is West's, 48212 East's).
  const rule = await W.call('boss', 'dataset:setRowPolicy', { projectId: W.P, datasetId: ship, policy: { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } });
  if (rule.body?.ok !== true) throw new Error(`fixture: Shipments' rule ${rule.text}`);
  const west = await ask('east', [ship], 'order 48213');
  const own = await ask('east', [ship], 'order 48212');
  ok('id-like: east is never told an id of West\'s rows (CONTROL: the admin is, above, and east its own)',
    west.scans === 1 && !west.value.includes('ORD-48213') && own.value.includes('- Shipments.ref = "ORD-48212"'), JSON.stringify({ west, own }));
  const both = await ask('east', [ship], 'north for order 48212'); // North: an index value to confirm, none of east's rows
  ok('id-like: …the id scanned in the same statement as east\'s confirmation, over every row of the lock (not only those holding North)',
    both.duck === 1 && both.scans === 1 && !both.value.includes('North') && both.value.includes('- Shipments.ref = "ORD-48212"'), JSON.stringify(both));

  // A stale sidecar, its flag still set, and then none: the dataset is scanned as before (the email found by its domain).
  const file = await sidecarOf(W, ship);
  const older: import('../src/engine/valueIndexResident').ValueSet = { version: vir.VALUE_INDEX_VERSION, stamp: 'older', indexed: [2, 3], idLike: [0, 1], marked: [] };
  await W.as('boss', () => parquetStore.writeTableAsync(file, vir.SIDECAR_COLUMNS, vir.sidecarRows(older, [])));
  const stale = await ask('boss', [ship], 'sales for acme');
  fs.rmSync(file);
  const gone = await ask('boss', [ship], 'sales for acme');
  ok('id-like: a stale sidecar (its flag set) or none: the table is scanned as before, the email found by its domain',
    [stale, gone].every((r) => r.lookups <= 1 && r.scans === 1 && r.touched === 1 && r.value.includes('- Shipments.email = "aaaaa@acme.com"')), JSON.stringify({ stale, gone }));
  await W.as('boss', async () => { await datasets.deleteDataset(W.P, accounts); await datasets.deleteDataset(W.P, ship); });
}
