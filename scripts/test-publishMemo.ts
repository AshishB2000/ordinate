// The read memo a publish runs under (first-run pass, F8) — recordFs.withReadMemo.
//
// Publishing computes every tile for every filter-bar combination, and each
// computation asked for the same records again and re-hydrated the same table:
// 8 tiles × 156 combinations was 9,438 Postgres transactions and 35 s, cold, on
// 5,000 rows. Under the memo it is 229 transactions and 4.7 s.
//
//   1. DIFFERENTIAL: a dashboard built under the memo is byte-identical (wire
//      encoding, so NaN / -0 / undefined count) to one built without it;
//   2. a table is hydrated once under the memo, however often it is asked for —
//      NEGATIVE CONTROL: outside it, once per ask;
//   3. any write through recordFs forgets what was read, so nothing stale is
//      served after it — NEGATIVE CONTROL: a memo that did not forget would
//      hand back the old name;
//   4. a failed read is not remembered, and a nested scope shares the outer one.
//
//   npm run build:ts && node scripts/test-publishMemo.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-publish-memo-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const { buildDashboard } = require('../src/publish/dashboardData') as typeof import('../src/publish/dashboardData');

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Publish memo');
  const rows: (string | number)[][] = [];
  for (let i = 0; i < 600; i++) rows.push(['region' + (i % 3), String(i % 5).padStart(3, '0'), (i % 17) - 3]);
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'sku', type: 'text' }, { name: 'amount', type: 'number' }], rows,
  });
  if (!ds) { ok('fixture: the dataset saved', false); return; }
  const v = await visuals.saveVisual(proj.id, { datasetId: ds.id, name: 'By sku', chartType: 'column', encoding: { category: 'sku', values: [{ column: 'amount', aggregation: 'sum' }] } } as never);
  const dash = await analysis.saveAnalysis(proj.id, {
    name: 'Sales overview',
    sheets: [{ id: randomUUID(), name: 'Main', cards: [
      { id: randomUUID(), type: 'control', layout: { x: 0, y: 0, w: 3, h: 1 }, control: { kind: 'dropdown', label: 'Region', datasetId: ds.id, column: 'region' } },
      { id: randomUUID(), type: 'control', layout: { x: 3, y: 0, w: 3, h: 1 }, control: { kind: 'dropdown', label: 'Sku', datasetId: ds.id, column: 'sku' } },
      { id: randomUUID(), type: 'visual', visualId: v!.id, layout: { x: 0, y: 1, w: 6, h: 4 } },
      { id: randomUUID(), type: 'metric', metric: { datasetId: ds.id, column: 'amount', aggregation: 'sum', label: 'Total' }, layout: { x: 6, y: 1, w: 3, h: 2 } },
      { id: randomUUID(), type: 'metric', metric: { datasetId: ds.id, column: 'amount', aggregation: 'avg', label: 'Average' }, layout: { x: 9, y: 1, w: 3, h: 2 } },
    ] }],
  } as never); // a record literal the saver sanitizes
  if (!v || !dash) { ok('fixture: the visual and the dashboard saved', false); return; }

  // Every table hydration goes through parquetStore.readTableAsync: count them.
  let hydrations = 0;
  const realRead = parquetStore.readTableAsync;
  (parquetStore as { readTableAsync: typeof realRead }).readTableAsync = ((...args: Parameters<typeof realRead>) => { hydrations += 1; return realRead(...args); }) as typeof realRead;

  // ── 1. Differential: the same dashboard with and without the memo ──────
  const plain = await buildDashboard(proj.id, dash.id, 256);
  const memoed = await recordFs.withReadMemo(() => buildDashboard(proj.id, dash.id, 256));
  ok('fixture: 2 controls → (3 + All) × (5 + All) = 24 combinations', plain?.keys.length === 24, String(plain?.keys.length));
  ok('differential: built under the memo, the dashboard is byte-identical', wire.encode(plain) === wire.encode(memoed));
  ok('…and it is not empty: 3 tiles, each with an answer per combination',
    !!memoed && memoed.sheets[0].cards.filter((c) => Array.isArray((c as { variants?: unknown }).variants) && (c as { variants: unknown[] }).variants.length === 24).length === 3);

  // ── 2. A table is hydrated once under the memo ─────────────────────────
  hydrations = 0;
  const [a, b] = await recordFs.withReadMemo(async () => [await datasets.getDataset(proj.id, ds.id), await datasets.getDataset(proj.id, ds.id)]);
  const under = hydrations;
  ok('under the memo: two asks, one hydration, the same table', under >= 1 && a !== null && a === b && a.rows.length === 600, `hydrations=${under}`);
  hydrations = 0;
  const c = await datasets.getDataset(proj.id, ds.id);
  const d = await datasets.getDataset(proj.id, ds.id);
  ok('NEGATIVE CONTROL: outside it, each ask hydrates again', hydrations === 2 * under && c !== d, `hydrations=${hydrations}`);

  // ── 3. A write forgets everything read before it ───────────────────────
  // The write: `sku` declared a number, then text again (updateDataset re-types the stored column).
  const skuType = (cols: { name: string; type: string }[] | undefined): string | undefined => cols?.find((x) => x.name === 'sku')?.type;
  const retype = async (type: 'text' | 'number'): Promise<void> => {
    const now = await datasets.getDatasetMeta(proj.id, ds.id);
    await datasets.updateDataset(proj.id, ds.id, { columns: now!.columns.map((x) => (x.name === 'sku' ? { ...x, type } : x)) });
  };
  const seen = await recordFs.withReadMemo(async () => {
    const before = await datasets.getDataset(proj.id, ds.id);
    await retype('number');
    const after = await datasets.getDataset(proj.id, ds.id);
    return { before: skuType(before?.columns), after: skuType(after?.columns), fresh: before !== after };
  });
  ok('after a write, the next read is fresh', seen.before === 'text' && seen.after === 'number' && seen.fresh, JSON.stringify(seen));
  const stale = await recordFs.withReadMemo(async () => {
    const kept = await recordFs.memoRead('k', async () => skuType((await datasets.getDatasetMeta(proj.id, ds.id))?.columns));
    await retype('text');
    // `kept` is what a memo that did not forget would answer again.
    const asked = await recordFs.memoRead('k', async () => skuType((await datasets.getDatasetMeta(proj.id, ds.id))?.columns));
    return { kept, asked };
  });
  ok('NEGATIVE CONTROL: the value held from before the write is the old type; the memo gives the new one',
    stale.kept === 'number' && stale.asked === 'text', JSON.stringify(stale));

  // ── 4. memoRead's own rules ─────────────────────────────────────────────
  let reads = 0;
  const read = async (): Promise<number> => { reads += 1; return reads; };
  ok('outside a scope: every call reads', (await recordFs.memoRead('n', read)) === 1 && (await recordFs.memoRead('n', read)) === 2);
  reads = 0;
  const nested = await recordFs.withReadMemo(async () => {
    const x = await recordFs.memoRead('n', read);
    const y = await recordFs.withReadMemo(() => recordFs.memoRead('n', read)); // the outer memo, not a new one
    return [x, y];
  });
  ok('inside: one read, and a nested scope shares it', nested[0] === 1 && nested[1] === 1 && reads === 1, `${nested} reads=${reads}`);
  let tries = 0;
  const failing = async (): Promise<string> => { tries += 1; if (tries === 1) throw new Error('first try fails'); return 'ok'; };
  const retried = await recordFs.withReadMemo(async () => {
    const first = await recordFs.memoRead('f', failing).catch(() => 'failed');
    return [first, await recordFs.memoRead('f', failing)];
  });
  ok('a failed read is not remembered: the next ask reads again', retried[0] === 'failed' && retried[1] === 'ok' && tries === 2, `${retried} tries=${tries}`);
}

main()
  .catch((e) => ok('publish memo suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
