// A Live dataset's calculated fields (semantic layer part 8, step 04), end to end on the fake warehouse.
//
// § record   `setLiveCalcs` stores them at the record's top level; `applyLive` shows them as typed
//            columns at the end of `meta.columns`, never in `raw.columns`; a schema sync neither
//            removes, misses nor profiles them; the Schema reply lists warehouse columns only.
//
//   npm run build:ts && node scripts/test-liveCalcs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const sync: typeof import('../src/engine/live/schemaSync') = require('../src/engine/live/schemaSync');
const liveCalcs: typeof import('../src/data/liveCalcs') = require('../src/data/liveCalcs');

const { ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);
/** A record or meta as the suites read it, with the columns the typed helpers need. */
type Rec = Reply & { columns: import('../src/data/parse').ParsedColumn[] };
const CALCS = [
  { name: 'Margin', expression: '[amt] - [qty]', type: 'number' as const },
  { name: 'Band', expression: "IF [amt] > 10 THEN 'big' ELSE 'small' END", type: 'text' as const },
];

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const meta = (d = L) => H.as(ORG_A, () => H.datasets.getDatasetMeta(P, d)) as Promise<Rec>;
  const raw = (d = L): Promise<Rec> => H.as(ORG_A, async () => JSON.parse(await fs.promises.readFile(rec.datasetFilePath(P, d), 'utf8')));
  const liveSchema = async (d = L): Promise<Reply> => (await post('dataset:liveSchema', { projectId: P, datasetId: d })).value;

  // ── § record ─────────────────────────────────────────────────────────────
  const e0 = (await meta()).live.epoch;
  const columns0 = (await meta()).columns;
  const written = await H.as(ORG_A, () => H.liveDataset.setLiveCalcs(P, L, CALCS));
  ok('setLiveCalcs answers the Live block', !!written && written.epoch === e0);
  ok('meta.columns ends with the calcs, typed; raw.columns has none',
    show((await meta()).columns.slice(-2)) === show([{ name: 'Margin', type: 'number' }, { name: 'Band', type: 'text' }])
    && !(await raw()).columns.some((c: Reply) => c.name === 'Margin'), show((await meta()).columns));
  ok('…and the declared columns come first, unchanged', show((await meta()).columns.slice(0, -2)) === show(columns0));
  ok('the calcs are stored at the top level, verbatim', show((await raw()).calculated) === show(CALCS) && !('calculated' in (await raw()).live));
  ok('the write leaves the epoch alone', (await meta()).live.epoch === e0);
  ok('declaredColumns: meta.columns minus the calcs', show(liveCalcs.declaredColumns(await meta())) === show(columns0));
  ok('calcColumns: name and type', show(liveCalcs.calcColumns(CALCS)) === show([{ name: 'Margin', type: 'number' }, { name: 'Band', type: 'text' }]));
  const twice = { columns: [...columns0], mode: 'live' } as Rec;
  H.liveDataset.applyLive(twice, { mode: 'live', live: (await raw()).live, calculated: CALCS, columns: columns0 } as Reply);
  H.liveDataset.applyLive(twice, { mode: 'live', live: (await raw()).live, calculated: CALCS, columns: twice.columns } as Reply);
  ok('applyLive twice == once (a column named like a calc is replaced, never doubled)', show(twice.columns) === show((await meta()).columns), show(twice.columns));
  const shared = (await raw()).columns;
  const target = { columns: shared } as Rec;
  H.liveDataset.applyLive(target, { mode: 'live', live: (await raw()).live, calculated: CALCS } as Reply);
  ok('applyLive never appends into the stored array it was handed', shared.length === columns0.length && target.columns !== shared);

  const calls0 = H.fake.calls.length;
  const synced = (await H.as(ORG_A, () => sync.syncLiveSchema(P, L))) as Reply;
  const sqls = H.fake.calls.slice(calls0).map((c) => c.sql);
  ok('a schema sync keeps the calcs: none removed, none missing, none profiled',
    synced.ok === true && !synced.removed.includes('Margin') && !synced.missing.includes('Margin') && sqls.length > 0
    && !sqls.some((q) => q.includes('Margin') || q.includes('Band')) && show((await meta()).live.calculated) === show(CALCS), show(synced));
  ok('…and the sync reports no column change at all', synced.added.length === 0 && synced.removed.length === 0 && synced.retyped.length === 0);
  ok('…and the record still holds them at the top level only', show((await raw()).calculated) === show(CALCS) && !(await raw()).columns.some((c: Reply) => c.name === 'Band'));
  const schema = await liveSchema();
  ok('dataset:liveSchema lists warehouse columns only', schema.ok === true && !schema.columns.some((c: Reply) => c.name === 'Margin') && schema.columns.length === columns0.length, show(schema).slice(0, 300));
  ok('NEGATIVE CONTROL: diffColumns over meta.columns would report the calcs removed',
    sync.diffColumns((await meta()).columns, columns0).removed.includes('Margin'));

  const cleared = await H.as(ORG_A, () => H.liveDataset.setLiveCalcs(P, L, []));
  ok('setLiveCalcs([]) deletes the key; meta.columns is the warehouse\'s again', !!cleared && !('calculated' in (await raw())) && show((await meta()).columns) === show(columns0));
  ok('NEGATIVE CONTROL: setLiveCalcs on an extract answers false', (await H.as(ORG_A, () => H.liveDataset.setLiveCalcs(P, s.extractId, CALCS))) === false
    && !('calculated' in (await raw(s.extractId))));

  await close();
  finish();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  finish();
});
