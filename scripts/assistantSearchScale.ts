// scripts/test-assistantSearch.ts, part 7: the Assistant's search at the scale of docs/assistant/00-design.md "Scale
// rules" — 2,000 datasets × 20 columns, 5,000 metrics, 2,000 terms (records cloned in SQL) and 10,000 column docs in one
// catalog.json. Measures the first build, one query, the counts and a catalog save, and holds the index to the
// reference on a few questions. Times are printed, never asserted: CI machines differ. Not a test file itself.

import type { Pool } from 'pg';
import { ok } from './selfcheck';

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const search: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const columnAccess: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');

type ModelHit = import('../src/ipc/assistantSearch').ModelHit;
type As = <T>(P: string | null, fn: () => Promise<T>) => Promise<T>;

const COLUMNS = ['region', 'city', 'country', 'segment', 'channel', 'product', 'category', 'brand', 'order_date', 'ship_date', 'customer_id', 'order_id',
  'quantity', 'unit_price', 'discount', 'sales_amount', 'profit', 'cost', 'returns', 'priority'];
const WORDS = "ARRAY['Sales', 'Orders', 'Returns', 'Inventory', 'Payroll', 'Leads', 'Tickets', 'Visits']";
const QUESTIONS = ['leads rate 117', 'territory', 'sales by region', 'zzz nothing'];

async function time<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const s = process.hrtime.bigint();
  const out = await fn();
  return [Number(process.hrtime.bigint() - s) / 1e6, out];
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const show = (label: string, msv: number, extra = ''): void => console.log(`  scale: ${label.padEnd(58)} ${msv.toFixed(1).padStart(8)} ms ${extra}`);

export async function scaleLeg(pool: Pool, asAdmin: As, asViewer: As, same: (a: readonly ModelHit[] | null, b: readonly ModelHit[] | null) => boolean): Promise<void> {
  const seed = await asAdmin(null, async () => {
    const P = (await projects.createProject('Assistant search at scale')).id;
    const ds = (await datasets.saveDataset(P, { name: 'Scale ledger', sourceKind: 'csv', columns: COLUMNS.map((name) => ({ name, type: 'text' as const })), rows: [COLUMNS.map(() => 'x')] }))!.id;
    const m = (await metrics.saveMetric(P, { name: 'Scale rate', datasetId: ds, definition: { column: 'quantity', aggregation: 'count' }, description: 'How often it happens' }))!.id;
    const t = (await terms.saveTerm(P, { name: 'Scale segment', aliases: ['cohort'], datasetId: ds, filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] }))!.id;
    return { P, ds, m, t };
  });
  const { P } = seed;
  // Each clone gets a name of its own ("Returns rate 1234"), as bench-lists did with ids.
  const clone = (kind: string, id: string, n: number, name: string, noun: string) => pool.query(
    `INSERT INTO records (org_id, path, body)
     SELECT r.org_id, replace(r.path, $2, g.id), regexp_replace(replace(r.body, $2, g.id), $4, '"name": "' || (${WORDS})[1 + g.n % 8] || ' ' || $5 || ' ' || g.n || '"')
     FROM records r, (SELECT gen_random_uuid()::text AS id, n FROM generate_series(1, $3) n) g WHERE r.org_id = 'acme' AND r.path = $1`,
    [`projects/${P}/${kind}/${id}.json`, id, n, `"name":\\s*"${name}"`, noun]);
  const [cloned] = await time(async () => {
    await clone('datasets', seed.ds, 1999, 'Scale ledger', 'ledger');
    await clone('metrics', seed.m, 4999, 'Scale rate', 'rate');
    await clone('terms', seed.t, 1999, 'Scale segment', 'segment');
  });
  const ids = (await pool.query(`SELECT substring(path from '([^/]+)\\.json$') AS id FROM records WHERE path LIKE $1 ORDER BY path`, [`projects/${P}/datasets/%`])).rows.map((r: { id: string }) => r.id);
  show(`cloned ${ids.length} datasets, 5,000 metrics, 2,000 terms`, cloned);

  // One catalog.json: a description per dataset and five column docs each (10,000).
  const raw = {
    records: Object.fromEntries(ids.map((id: string, i: number) => [`dataset:${id}`, { description: `Rows from the ${['billing', 'shipping', 'support', 'marketing'][i % 4]} system` }])),
    columns: Object.fromEntries(ids.map((id: string) => [id, {
      region: { aliases: ['territory'], description: 'Where it shipped' }, customer_id: { aliases: ['client number'] }, profit: { description: 'Revenue minus cost' },
      channel: { displayName: 'Sales channel' }, discount: { description: 'Percent off the list price' },
    }])),
  };
  const [wrote] = await asAdmin(null, () => time(() => recordFs.writeFile(`${appPaths.userData()}/projects/${P}/catalog.json`, JSON.stringify(catalog.sanitizeCatalog(raw)))));
  show('catalog.json written whole (10,000 column docs)', wrote, `${(Buffer.byteLength(JSON.stringify(catalog.sanitizeCatalog(raw))) / 1048576).toFixed(1)} MiB`);

  const [build, first] = await asAdmin(P, () => time(() => search.indexedModel(P, 'leads rate 117', { limit: 12 })));
  const rows = Number((await pool.query('SELECT count(*) FROM assistant_search WHERE project_id = $1', [P])).rows[0].count);
  show('first query: builds all five sources', build, `${rows.toLocaleString('en-US')} index rows`);
  ok('scale: the first query builds the index and finds the metric asked for', first?.[0]?.name === 'Leads rate 117', JSON.stringify(first?.slice(0, 2)));

  // Right after a build Postgres has no statistics on the new rows yet (autovacuum analyzes within a minute or so).
  for (const stats of ['no planner statistics yet', 'after ANALYZE']) {
    if (stats === 'after ANALYZE') await pool.query('ANALYZE assistant_search');
    for (const q of QUESTIONS) {
      const runs: number[] = [];
      let hits = 0;
      for (let i = 0; i < 7; i++) {
        const [t, out] = await asAdmin(P, () => time(() => search.indexedModel(P, q, { limit: 12 })));
        runs.push(t);
        hits = out?.length ?? -1;
      }
      show(`query "${q}", ${stats}`, median(runs), `${hits} results, median of 7`);
    }
    const countRuns: number[] = [];
    for (let i = 0; i < 5; i++) countRuns.push((await asAdmin(P, () => time(() => search.indexedCount(P))))[0]);
    show(`counts per kind, ${stats}`, median(countRuns), 'median of 5');
  }

  const [saved] = await asAdmin(null, () => time(() => catalog.setColumn(P, ids[7], 'segment', { aliases: ['tier'] })));
  show('a column doc saved (one dataset rewritten of 2,000)', saved);
  const catalogBody = (await pool.query('SELECT body FROM records WHERE path = $1', [`projects/${P}/catalog.json`])).rows[0].body as string;
  const [described, parts] = await time(async () => search.describeModelRecord({ projectId: P, source: 'catalog', id: '' }, catalogBody));
  show('…of which the describer, on the event loop', described, `${parts.length.toLocaleString('en-US')} parts`);
  const tier = await asAdmin(P, () => search.indexedModel(P, 'tier', { limit: 5 }));
  ok('scale: the saved column doc is found by the next query', tier?.length === 1 && tier[0].id === 'segment' && tier[0].datasetId === ids[7], tier);

  // A column hidden from the viewer on one dataset: each metric and term is then checked for them.
  await asAdmin(null, () => record.serialized(record.datasetFilePath(P, ids[3]), (raw) => {
    raw.columnAccess = columnAccess.buildColumnAccess(raw, [{ column: 'profit', visibleTo: [{ userId: '00000000-0000-4000-8000-000000000001' }] }], 'ana@acme.test', new Date().toISOString());
    return true;
  }));
  const [viewerQuery] = await asViewer(P, () => time(() => search.indexedModel(P, 'leads rate 117', { limit: 12 })));
  show('a question whose results are metrics, for a viewer with a hidden column', viewerQuery);
  const [viewerCounts, vc] = await asViewer(P, () => time(() => search.indexedCount(P)));
  show('counts, for a viewer with a hidden column', viewerCounts, JSON.stringify(vc));
  const [refMs] = await asAdmin(P, () => time(() => search.referenceModel(P, 'leads rate 117', { limit: 12 })));
  show('the reference: every store read, for one question', refMs);
  for (const [who, as] of [['admin', asAdmin], ['viewer', asViewer]] as const) {
    const unequal: string[] = [];
    await as(P, () => recordFs.withReadMemo(async () => {
      for (const q of QUESTIONS) {
        const [r, i] = [await search.referenceModel(P, q, { limit: 12 }), await search.indexedModel(P, q, { limit: 12 })];
        if (!same(r, i)) unequal.push(`${q}: ${JSON.stringify(r.slice(0, 3))} vs ${JSON.stringify(i?.slice(0, 3))}`);
      }
    }));
    ok(`scale: the differential holds for the ${who}`, unequal.length === 0, unequal);
  }
  await asAdmin(null, () => projects.deleteProject(P));
}
