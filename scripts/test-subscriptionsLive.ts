// A subscription over a LIVE dataset (docs/live-data/00-plan.md L2.4): every
// figure it sends comes through the doors — the warehouse answers, nothing is
// hydrated, the statements are counted — over the real RPC route in server mode
// against the fake warehouse (scripts/liveRouteHarness.ts).
//
//   doors      a dashboard of a Live KPI and a Live chart: `subscription:preview`
//              and a real send carry the figures the door channels give for the
//              same cards (and the extract of the same rows gives), dated by
//              the warehouse — and `datasets.getDataset` is never asked for the
//              Live dataset (spy). NEGATIVE CONTROL: the extract's dashboard IS
//              allowed to read its table, and the spy can see it
//   counted    the send ran warehouse statements through the one door (the
//              fake's spy), and a second one inside the cache age runs none
//   failure    the warehouse down → each card says why, typed, in the catalog's
//              words; no zero, no SQL, no dataset id in the message
//
//   npm run build:ts && node scripts/test-subscriptionsLive.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, hydrated, post } from './liveRouteHarness';
import * as B from './subscriptionHarness';

const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const fmt: typeof import('../src/app/format') = require('../src/app/format');
const say: typeof import('../src/analysis/subscriptionText') = require('../src/analysis/subscriptionText');

const { fake, ORG_A } = H;
const ENC = { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] };
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  B.openLoopback();
  const rx = await B.receiver();
  B.channels.useChannelSecrets(B.memoryStore());

  /** A dashboard of one KPI and one bar chart over `datasetId`. */
  const board = (name: string, datasetId: string) => H.as(ORG_A, async () => {
    const v = await visuals.saveVisual(P, { name: `${name} by region`, datasetId, chartType: 'bar', encoding: ENC, filters: [] } as never);
    const card = (type: string, x: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 3, h: 4 }, ...extra });
    const a = await analysis.saveAnalysis(P, { name, sheets: [{ name: 'One', cards: [card('metric', 0, { metric: { datasetId, column: 'amt', aggregation: 'sum', label: 'Amount' } }), card('visual', 3, { visualId: v!.id })] }] });
    return a!.id;
  });
  const liveBoard = await board('Live board', s.liveId);
  const copyBoard = await board('Copy board', s.extractId);
  const draft = (analysisId: string, channelIds: string[] = []) => ({
    name: 'Live send', analysisId, content: { mode: 'all', cardIds: [] }, schedule: { cadence: 'daily', at: '08:00' }, timezone: 'UTC',
    channelIds, message: { title: '', note: '', includeLink: false }, conditions: { skipUnchanged: false, onlyWhenRefreshed: false },
  });

  try {
    // ── the doors ─────────────────────────────────────────────────────────
    H.queryCache.clear();
    fake.calls.length = 0;
    const from = hydrated.length;
    const pv = await post('subscription:preview', { projectId: P, draft: draft(liveBoard) });
    const model = pv.value.slack?.model;
    ok('Live: the preview answers with a message', pv.status === 200 && pv.value.ok === true && !!model, pv.body.slice(0, 300));
    ok('Live: `datasets.getDataset` was never asked for the Live dataset', !hydrated.slice(from).includes(s.liveId), hydrated.slice(from).join());
    ok(`Live: the figures came from the warehouse, through the one door (${fake.calls.length} statements)`, fake.calls.length >= 2);
    const kpi = (await post('dashboard:metric', { projectId: P, datasetId: s.liveId, column: 'amt', aggregation: 'sum' })).value;
    const chart = (await post('visual:data', { projectId: P, datasetId: s.liveId, encoding: ENC })).value;
    ok('Live: the KPI IS the door\'s figure (dashboard:metric), dated live', kpi.ok === true && kpi.asOf?.mode === 'live' && model.kpis[0].value === fmt.formatValue(kpi.value, 'auto'), show([model.kpis[0], kpi.value]));
    const top = chart.data.labels.map((l: string, i: number) => [l, chart.data.series[0].values[i]] as [string, number | null]).sort((a: [string, number | null], b: [string, number | null]) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity));
    ok('Live: the chart\'s rows ARE the door\'s (visual:data) — biggest first, formatted', model.sections[0].rows.length > 0
      && model.sections[0].rows.every((r: string[], i: number) => r[0] === String(top[i][0] ?? '').replace(/\s+/g, ' ').trim() && r[1] === (top[i][1] === null ? '—' : fmt.formatValue(top[i][1], 'auto'))), show([model.sections[0].rows.slice(0, 3), top.slice(0, 3)]));
    ok('Live: the message is dated by the warehouse\'s answer', model.subtitle.some((x: string) => x.startsWith('Data as of ')), show(model.subtitle));

    const copy = (await post('subscription:preview', { projectId: P, draft: draft(copyBoard) })).value.slack.model;
    ok('Live = extract: the same rows as a copy send the same KPI and the same top rows', copy.kpis[0].value === model.kpis[0].value && JSON.stringify(copy.sections[0].rows) === JSON.stringify(model.sections[0].rows), show([copy.kpis[0], model.kpis[0]]));

    // ── a real send, counted ──────────────────────────────────────────────
    const ch = (await post('channel:save', { name: 'Ops', kind: 'slack', webhookUrl: rx.url() })).value.channel.id;
    const sub = (await post('subscription:save', { projectId: P, subscription: draft(liveBoard, [ch]) })).value.subscription.id;
    H.queryCache.clear();
    fake.calls.length = 0;
    const before = hydrated.length;
    const sent = await post('subscription:sendNow', { projectId: P, id: sub });
    ok('Live: Send now posts the message, with the warehouse\'s figure in it', sent.value.ok === true && rx.hits.length === 1 && JSON.stringify(rx.hits[0].body).includes(model.kpis[0].value), show(sent.value));
    ok('Live: the send hydrated nothing', !hydrated.slice(before).includes(s.liveId));
    const again = fake.calls.length;
    await post('subscription:sendNow', { projectId: P, id: sub });
    ok(`Live: a second send inside the cache age asks the warehouse nothing more (${again} then ${fake.calls.length})`, rx.hits.length === 2 && fake.calls.length === again);

    // ── the warehouse down ────────────────────────────────────────────────
    H.queryCache.clear();
    const SQL_CANARY = 'SELECT_canary_41c7';
    fake.hook = () => { throw new Error(`connection refused while running ${SQL_CANARY} on 10.1.2.3`); };
    const down = await H.capturingWarn(() => post('subscription:preview', { projectId: P, draft: draft(liveBoard) }));
    fake.hook = null;
    const dm = down.value.value.slack?.model;
    ok('Live, warehouse down: each card says why in the catalog\'s words — never a zero, never a blank figure',
      !!dm && dm.kpis[0].value !== '0' && dm.kpis[0].value !== '—' && dm.kpis[0].value.length > 10 && dm.sections[0].rows.length === 0 && typeof dm.sections[0].note === 'string' && dm.sections[0].note.length > 10, show(dm));
    ok('Live, warehouse down: the warehouse\'s own text, the address and the dataset id stay out of the message',
      !down.value.body.includes(SQL_CANARY) && !down.value.body.includes('10.1.2.3') && !down.value.body.includes(s.liveId) && dm.kpis[0].value !== say.noFigure());

    // ── negative control ──────────────────────────────────────────────────
    H.queryCache.clear();
    const start = hydrated.length;
    const calls = fake.calls.length;
    await post('subscription:preview', { projectId: P, draft: draft(copyBoard) });
    ok('NEGATIVE CONTROL: the same preview over the COPY asks the warehouse nothing — the statements above were the Live dataset\'s', fake.calls.length === calls);
    await H.as(ORG_A, () => H.datasets.getDataset(P, s.extractId));
    ok('NEGATIVE CONTROL: the spy is live — a real hydration is seen', hydrated.slice(start).includes(s.extractId), show(hydrated.slice(start)));
  } finally {
    await rx.close();
    B.channels.useChannelSecrets(null);
    await close();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
