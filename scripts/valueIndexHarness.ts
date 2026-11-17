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

/** `fn` with the value search's DuckDB statements counted: scans and confirmations (`duck`), scans alone, lookups. */
export async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; duck: number; scans: number; lookups: number }> {
  const real = duck.queryAsync;
  let n = 0, scans = 0, lookups = 0;
  (duck as { queryAsync: unknown }).queryAsync = (sql: string, ...rest: unknown[]) => {
    if (sql.includes('QUALIFY row_number() OVER (PARTITION BY c ORDER BY o)')) n++;
    if (sql.includes('AND regexp_matches(v, ?)')) scans++;
    if (sql.startsWith(vir.LOOKUP_MARK)) lookups++;
    return (real as (...a: unknown[]) => unknown)(sql, ...rest);
  };
  try {
    return { value: await fn(), duck: n, scans, lookups };
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
  console.log(`  bench: a build ${Math.min(...times)} to ${Math.max(...times)} ms (its two DuckDB statements ${engine} ms, ${found?.reduce((n, c) => n + (c.values?.length ?? 0), 0)} values, a sidecar of ${nRows} rows, ${Math.round(bytes / 1024)} KiB, beside a table of ${Math.round(fs.statSync(file(ids[0])).size / 1024)} KiB)`);
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
    line('an admin\'s ask over the 12, the index, each order_id (past the cap) scanned within the budget', await timed(true));
    line('the same ask, the scan (before this change)', await timed(false));
  }
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
  line('east, each order_id scanned too (one statement a dataset: the confirmation and the scan)', await timed(true, 'east', 'sales in east'));

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
