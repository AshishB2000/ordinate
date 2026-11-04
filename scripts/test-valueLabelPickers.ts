// Self-check for VALUE LABELS in a filter picker (semantic layer PR 06, Task 5): `dataset:distinct` lists the
// stored values with the pairs beside them, and a search finds a value by its label, while every option still
// filters by the stored value.
//
// What is pinned here, and why each would break quietly:
//   1. RAW VALUES, PAIRS BESIDE. `values` are the stored values; `valueLabels` pairs only the values returned.
//   2. A SEARCH FINDS BY LABEL. `euro` finds `EU` (labelled "Europe"); each value once, counted once in `total`.
//   3. THE LOCK HOLDS. A label search asks again through the same row lock: a value outside it is never found.
//   4. BYTE-IDENTICAL. An unlabelled column's reply is today's, leaf by leaf (Object.is).
//   5. LIVE: the profile's list, filtered here (the sample has no `in` filter to run).
//
//   npm run build:ts && node scripts/test-valueLabelPickers.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-valuelabelpickers-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>; // any: each channel's own reply
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rowDoors: typeof import('../src/ipc/rowDoors') = require('../src/ipc/rowDoors');
const replies: typeof import('../src/ipc/valueLabelReplies') = require('../src/ipc/valueLabelReplies');
require('../src/ipc/catalog').register();
require('../src/ipc/datasets').register();
const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
const json = (v: unknown): string => JSON.stringify(v);

/** The first path where two replies differ, leaf by leaf with Object.is; '' when none. */
function differ(a: unknown, b: unknown, at = ''): string {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) ? '' : at || '(root)';
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = differ((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return '';
}

const L = [{ value: 'EU', label: 'Europe' }, { value: 'NA', label: 'North America' }];

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();
  const P = (await projects.createProject('value label pickers')).id;
  const save = async (name: string, rows: string[][]): Promise<string> => (await datasets.saveDataset(P, {
    name, sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'tier', type: 'text' }], rows,
  }))!.id;
  const D = await save('Orders', [['EU', 'gold'], ['APAC', 'silver'], ['NA', 'gold'], ['EU', 'silver']]);
  const distinct = (more: object = {}, datasetId = D): Promise<any> => call('dataset:distinct', { projectId: P, datasetId, column: 'region', ...more });

  // Today's replies, before any label: the baseline the unlabelled replies must equal.
  const before = { all: await distinct(), ap: await distinct({ search: 'ap' }), tier: await distinct({ column: 'tier' }) };
  ok('setup: region is labelled', (await call('catalog:setColumn', { projectId: P, datasetId: D, column: 'region', patch: { values: L } })).ok === true);

  // 1. Raw values, pairs beside.
  const all = await distinct();
  ok('picker: the stored values, with their pairs beside them', json(all.values) === '["EU","APAC","NA"]' && json(all.valueLabels) === '[["EU","Europe"],["NA","North America"]]' && all.total === 3, json(all));

  // 2. A search finds by label, each value once.
  const euro = await distinct({ search: 'euro' });
  ok('picker: the search finds a value by its label', json(euro.values) === '["EU"]' && json(euro.valueLabels) === '[["EU","Europe"]]' && euro.total === 1, json(euro));
  ok('picker: a search is case-insensitive on the label', json((await distinct({ search: 'NORTH' })).values) === '["NA"]');
  const ap = await distinct({ search: 'ap' });
  ok('picker: a search no label holds finds by the stored value, and carries no pairs', json(ap.values) === '["APAC"]' && !('valueLabels' in ap) && differ(ap, before.ap) === '', json(ap));
  const e = await distinct({ search: 'e' }); // "EU" holds e by its value, "Europe" by its label, "North America" by its label
  ok('picker: a value found by its value AND its label is listed and counted once', json(e.values) === '["EU","NA"]' && e.total === 2, json(e));
  const capped = await distinct({ search: 'e', limit: 1 });
  ok('picker: the label matches come after the value matches, capped at the limit; total counts them all', json(capped.values) === '["EU"]' && capped.total === 2 && json(capped.valueLabels) === '[["EU","Europe"]]', json(capped));
  ok('picker: a label of a value the dataset does not hold finds nothing', json((await call('catalog:setColumn', { projectId: P, datasetId: D, column: 'region', patch: { values: [...L, { value: 'LATAM', label: 'Latin America' }] } })).ok) === 'true'
    && json(await distinct({ search: 'latin' })) === '{"values":[],"total":0}');

  // A label that is also a stored value: the option says which (ruling F11), and picking it still sends the stored value.
  const C = await save('Clash', [['EU', 'gold'], ['Europe', 'gold']]);
  await call('catalog:setColumn', { projectId: P, datasetId: C, column: 'region', patch: { values: L } });
  const clash = await distinct({ search: 'euro' }, C);
  ok('picker: a label that is another stored value reads "Label (raw)"', json(clash.values) === '["Europe","EU"]' && json(clash.valueLabels) === '[["EU","Europe (EU)"]]' && clash.total === 2, json(clash));

  // 3. The lock holds: a label search asks again through the caller's row lock, never around it.
  const realLock = rowDoors.withLockOf;
  const lockTo = (value: string) => {
    (rowDoors as { withLockOf: unknown }).withLockOf = (_p: string, _d: string, body: (lock: unknown) => Promise<unknown>) =>
      body({ steps: [{ type: 'filter', column: 'region', op: '=', value }] });
  };
  lockTo('NA');
  const lockedEuro = await distinct({ search: 'euro' });
  const lockedAll = await distinct();
  lockTo('EU');
  const lockedOwn = await distinct({ search: 'euro' });
  (rowDoors as { withLockOf: unknown }).withLockOf = realLock;
  ok('lock: under region = NA, a search for "euro" finds no value and no pair', json(lockedEuro) === '{"values":[],"total":0}', json(lockedEuro));
  ok('lock: under region = NA, the list is NA alone with its own pair only', json(lockedAll) === '{"values":["NA"],"total":1,"valueLabels":[["NA","North America"]]}', json(lockedAll));
  ok('NEGATIVE CONTROL: under region = EU the same search finds EU', json(lockedOwn.values) === '["EU"]' && json(lockedOwn.valueLabels) === '[["EU","Europe"]]', json(lockedOwn));

  // 4. Byte-identical: an unlabelled column, and a labelled column with its list removed, answer as today.
  const tier = await distinct({ column: 'tier' });
  ok('byte-identical: an unlabelled column of a labelled project', differ(tier, before.tier) === '' && json(tier) === json(before.tier), json([tier, before.tier]));
  await call('catalog:setColumn', { projectId: P, datasetId: D, column: 'region', patch: { values: [] } });
  const cleared = await distinct();
  ok('byte-identical: the list removed, the reply is today\'s', differ(cleared, before.all) === '' && !('valueLabels' in cleared), json([cleared, before.all]));
  await call('catalog:setColumn', { projectId: P, datasetId: D, column: 'region', patch: { values: L } });

  // 5. Live: the profile's list ignores filters, so the label matches are taken from it here, and counted from it.
  const sample = { values: ['APAC', 'EU', 'NA'], total: 3, approximate: true as const, sampleRows: 40 };
  const asked: unknown[] = [];
  const live = async (r: { search?: string; limit?: number }) => {
    asked.push(r);
    const needle = (r.search ?? '').toLowerCase();
    const hits = sample.values.filter((v) => v.toLowerCase().includes(needle));
    return { ...sample, values: hits.slice(0, r.limit ?? 200), total: needle ? hits.length : sample.total };
  };
  const liveEuro = await replies.distinctWithLabels(P, D, 'region', { limit: 200, search: 'euro' }, live);
  ok('Live: a label search finds the sample\'s value by its label, counted from the sample', json(liveEuro) === json({ ...sample, values: ['EU'], total: 1, valueLabels: [['EU', 'Europe']] }), json(liveEuro));
  ok('Live: the second ask is the whole sample, unsearched', asked.length === 2 && (asked[1] as { search: string }).search === '', json(asked));
  const refusal = { ok: false as const, code: 'live_refused' as const, reason: 'notSynced' as const, error: 'Sync the schema first.' };
  ok('Live: a refusal passes through as it came', await replies.distinctWithLabels(P, D, 'region', { search: 'euro' }, async () => refusal) === refusal);
  ok('a gone dataset passes through as null', await replies.distinctWithLabels(P, D, 'region', {}, async () => null) === null);
}

void main()
  .catch((err: unknown) => { ok('unexpected error', false, err instanceof Error ? err.stack : err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
