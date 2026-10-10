// What a picker gets for a Live column's VALUES (docs/live-data/log.md, L2.6's
// leftover) over the real RPC route, on the fake warehouse:
//
//   refusals   `dataset:distinct` with no list to give answers 200, typed —
//              `{ok:false, code:'live_refused', reason, error}` — and says which
//              case it is, in the catalog's sentence: notSynced (no schema sync
//              yet), notSampled (the profile never measured the column),
//              notListed (a number, a date, a high-cardinality text). Never a
//              409 (an expected state is not a console error), never an empty
//              list, never the rows (the getDataset spy)
//   controls   NEGATIVE CONTROLS: a profiled low-cardinality column answers its
//              values; a search that matches nothing and a column the sample
//              found empty answer an EMPTY LIST (that is what they hold); the
//              extract answers as it always did
//   publish    a dashboard whose controls read a Live dataset publishes: the
//              listed column's control carries the sample's values, the
//              unlisted one is left out of the page and the plan says why —
//              NEGATIVE CONTROLS: with only the listed control, the plan says
//              nothing; without the profile's door, the publish is refused whole
//
//   npm run build:ts && node scripts/test-liveValues.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, post } from './liveRouteHarness';

const sync: typeof import('../src/engine/live/schemaSync') = require('../src/engine/live/schemaSync');
const pmsg: typeof import('../src/engine/liveProfileMessages') = require('../src/engine/liveProfileMessages');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const dashData: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');

const { fx, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const distinct = (datasetId: string, column: string, more: object = {}) => post('dataset:distinct', { projectId: P, datasetId, column, ...more });
  /** The typed refusal, exactly: a 200, the reason, the catalog's sentence, and no list at all. */
  const refusedAs = (r: { status: number; body: string; value: Reply }, reason: string, sentence: string): boolean =>
    r.status === 200 && show(r.value) === show({ ok: false, code: 'live_refused', reason, error: sentence })
    && !r.body.includes(H.SECRET_CANARY) && !r.body.includes('live_typed') && !r.body.includes(L);

  // ── 1. Never synced ───────────────────────────────────────────────────────
  const never = await distinct(L, 'region');
  ok('not synced yet: a typed refusal (200) that says so — no list, no table name, no secret', refusedAs(never, 'notSynced', pmsg.liveValuesNotSynced()), `${never.status} ${never.body}`);

  // ── 2. Synced: the list, or why there is none ─────────────────────────────
  const synced = await H.as(ORG_A, () => sync.syncLiveSchema(P, L));
  ok('the schema sync profiles the fixture', synced.ok && synced.sample.ok, show(synced).slice(0, 200));
  const region = await distinct(L, 'region');
  ok('NEGATIVE CONTROL: a profiled low-cardinality column still answers its values, flagged a sample\'s', region.status === 200 && region.value.ok === undefined
    && show(region.value.values) === '["North","South","West","East"]' && region.value.total === 4 && region.value.approximate === true, region.body.slice(0, 200));
  const none = await distinct(L, 'region', { search: 'zzz' });
  ok('NEGATIVE CONTROL: a search that matches nothing is an empty list, not a refusal', none.status === 200 && show(none.value.values) === '[]' && none.value.total === 0, none.body);
  const limit = String(require('../src/data/liveProfile').LOW_CARDINALITY);
  for (const [column, what] of [['amt', 'a number'], ['d', 'a date'], ['many', 'a high-cardinality text']] as const) {
    const r = await distinct(L, column);
    ok(`not listed (${what} column): a typed refusal naming the limit, never an empty list`, refusedAs(r, 'notListed', pmsg.liveValuesNotListed(limit)) && r.body.includes(limit), `${r.status} ${r.body}`);
  }

  // A profile that never measured a column (the sample was skipped), and one the sample found empty.
  const other = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_typed' }, fx.COLUMNS));
  const wrote = await H.as(ORG_A, () => H.liveDataset.writeSchemaSync(P, other.liveId, {
    columns: fx.COLUMNS, missingColumns: [], syncedAt: new Date().toISOString(), changed: false,
    profile: { skipped: 'failed', columns: [{ name: 'cat', filled: 0, distinct: 0 }] },
  }));
  const unsampled = await distinct(other.liveId, 'region');
  ok('not sampled (the last sync read no sample of it): a typed refusal that says so', wrote === true && unsampled.status === 200
    && show(unsampled.value) === show({ ok: false, code: 'live_refused', reason: 'notSampled', error: pmsg.liveValuesNotSampled() }), `${unsampled.status} ${unsampled.body}`);
  const empty = await distinct(other.liveId, 'cat');
  ok('NEGATIVE CONTROL: a column the sample found empty answers an empty list — that is what it holds', empty.status === 200 && show(empty.value.values) === '[]'
    && empty.value.total === 0 && empty.value.approximate === true, empty.body);
  const ext = await distinct(s.extractId, 'region');
  ok('NEGATIVE CONTROL: the extract answers its values, unflagged', ext.status === 200 && Array.isArray(ext.value.values) && ext.value.values.length > 0 && ext.value.approximate === undefined, ext.body.slice(0, 200));
  ok('THE SPY: no answer above hydrated a Live dataset', !hydrated.includes(L) && !hydrated.includes(other.liveId), show(hydrated));

  // ── 3. The publish path ───────────────────────────────────────────────────
  const control = (datasetId: string, column: string, label: string, x: number) => ({ type: 'control', control: { kind: 'dropdown', datasetId, column, label }, layout: { x, y: 0, w: 3, h: 1 } });
  const kpi = { type: 'metric', metric: { datasetId: L, column: 'amt', aggregation: 'sum', label: 'Total' }, layout: { x: 0, y: 1, w: 3, h: 2 } };
  const save = (name: string, cards: unknown[]) => H.as(ORG_A, () => analysis.saveAnalysis(P, { name, sheets: [{ name: 'One', cards }] } as unknown as Parameters<typeof analysis.saveAnalysis>[1]));
  const board = await save('Live controls', [control(L, 'region', 'Region', 0), control(L, 'amt', 'Amount', 3), control(other.liveId, 'region', 'Other region', 6), kpi]);
  const plain = await save('Listed only', [control(L, 'region', 'Region', 0), kpi]);
  if (!board || !plain) throw new Error('boards not saved');
  const from = hydrated.length;
  const built = await H.as(ORG_A, () => dashData.buildDashboard(P, board.id, 256)).catch((err: unknown) => err as Error);
  const page = built && !(built instanceof Error) ? built : null;
  ok('publish: the dashboard builds (no refusal thrown), and its Live KPI is computed per option', !!page && page.keys.length === 5
    && page.sheets[0].cards[0]?.variants.length === 5, built instanceof Error ? built.message : show(page?.keys));
  ok('publish: the listed column\'s control carries the sample\'s values; the two unlisted controls are left out, never an empty "All"',
    show(page?.controls.map((c) => [c.label, c.options])) === show([['Region', ['All', 'North', 'South', 'West', 'East']]]), show(page?.controls));
  const plan = (await post('publish:plan', { projectId: P, dashboardIds: [board.id], storyIds: [], scorecardIds: [], options: {} })).value;
  const said = plan.plan?.pages?.[0]?.unlisted;
  ok('publish: the plan says which controls are left out and why, in the catalog\'s sentences', plan.ok === true
    && show(said) === show([{ control: 'Amount', reason: pmsg.liveValuesNotListed(limit) }, { control: 'Other region', reason: pmsg.liveValuesNotSampled() }]), show(plan).slice(0, 400));
  const plainPlan = (await post('publish:plan', { projectId: P, dashboardIds: [plain.id], storyIds: [], scorecardIds: [], options: {} })).value;
  ok('NEGATIVE CONTROL: with only the listed control, the plan leaves nothing out', plainPlan.ok === true && plainPlan.plan?.pages?.[0]?.combos === 5
    && !('unlisted' in plainPlan.plan.pages[0]), show(plainPlan).slice(0, 300));
  ok('publish never hydrated a Live dataset', !hydrated.slice(from).includes(L) && !hydrated.slice(from).includes(other.liveId));
  // What the profile's door prevents: without it the control's values are read from rows a Live dataset does not have.
  const lp: { liveDistinct: unknown } = require('../src/ipc/liveProfile');
  const door = lp.liveDistinct;
  lp.liveDistinct = async () => null;
  const without = await H.as(ORG_A, () => dashData.planDashboard(P, plain.id, 256)).then(() => 'planned', (err: unknown) => (H.liveDataset.isLiveDatasetError(err) ? 'refused' : 'threw'));
  lp.liveDistinct = door;
  ok('NEGATIVE CONTROL: without the profile\'s door, the same publish is refused whole (the safety net), so the checks above test the door', without === 'refused', without);

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
