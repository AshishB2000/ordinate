// The Assistant and Explore on a semantic dataset (semantic layer part 7, b2/b3; docs/semantic-layer/07-portability.md
// D13): a layer's metrics are named by their mirrors, never by a column sum, over the real RPC route
// (scripts/liveRouteHarness.ts) and the fake layer as a connector (scripts/semanticFake.ts).
//
//   § answer    specMetrics names the mirrors; a spec naming one on its own dataset is that metric (no column), and its
//               card is the layer's figure. NEGATIVE CONTROL: a column sum there is still refused columnOnLayer.
//   § facts     the Assistant's facts for the dataset list its mirrors, each with the layer's figure
//   § explore   explore:suggest lists the mirrors as the measures and suggests charts of them, no column sums; each
//               suggestion draws, though its measure's `column` is the mirror's name (no field of the dataset).
//               NEGATIVE CONTROL: an extract's measures are still its number columns.
//
//   npm run build:ts && node scripts/test-semanticAssistant.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post } from './liveRouteHarness';
import type { Reply } from './liveRouteHarness';

const fake: typeof import('./semanticFake') = require('./semanticFake');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const spec: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');

const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);

void (async () => {
  fake.registerSemanticFake();
  adapters.registerTestSemanticAdapter('fake', { encode: (q, model) => ({ kind: 'semantic', body: { table: model, columns: H.fx.COLUMNS, query: q }, columns: sq.answerColumns(q) }) });
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(H.ORG_A, fn);
  const conn = await as(async () => (await H.connections.saveConnection(P, { name: 'Layer prod', connectorId: fake.SEMANTIC_FAKE_ID, values: {} }))!.id);
  const D = await as(async () => (await liveRecord.saveSemanticRecord(P, { name: 'Orders layer', connId: conn, columns: [], semantic: { backend: 'fake', model: 'live_typed', metrics: [], grains: [], syncedAt: '2026-11-01T00:00:00.000Z' } }))!.id);
  ok('the semantic dataset syncs its mirrors', (await post('dataset:syncLiveSchema', { projectId: P, datasetId: D })).value.ok === true);
  const mirrors = (await as(() => metrics.listMetrics(P))).filter((m) => m.datasetId === D);
  const revenue = mirrors.find((m) => m.name === 'revenue');
  if (!revenue) { ok('the revenue mirror exists', false, show(mirrors)); await close(); finish(); return; }

  // ── § answer ──
  const vocab = await as(() => answers.specMetrics(P));
  ok('specMetrics names the mirrors of the semantic dataset, as layer metrics', mirrors.every((m) => vocab.some((v) => v.id === m.id && v.external === true && !v.column)), show(vocab.filter((v) => v.datasetId === D)));
  const sets = await as(() => answers.specDatasets(P));
  const v = spec.validateAnswerSpec({ dataset: 'Orders layer', category: 'region', measures: [{ column: 'revenue' }], chartType: 'bar', title: 'Revenue by region' }, sets, { metrics: vocab });
  ok('a spec naming "revenue" on its semantic dataset is that mirror: no column, its id', v.ok && show(v.spec.measures) === show([{ column: '', aggregation: 'sum', metricId: revenue.id }]), show(v));
  const card = v.ok ? await as(() => answers.computeCard(P, v.spec)) : null;
  const chart = (await post('visual:data', { projectId: P, datasetId: D, encoding: { category: 'region', values: [{ column: '', aggregation: 'sum', metricId: revenue.id }] } })).value;
  ok('…and its card is the layer\'s figure, the chart door\'s own', !!card && 'card' in card && chart.ok === true && show((card.card as Reply).chart?.data?.series?.[0]?.values ?? (card.card as Reply).data?.series?.[0]?.values) === show(chart.data.series[0].values), show([card, chart.data?.series]));
  const column = spec.validateAnswerSpec({ dataset: 'Orders layer', category: 'region', measures: [{ column: 'qty', aggregation: 'sum' }], chartType: 'bar', title: 'Qty' }, sets, { metrics: vocab });
  const columnCard = column.ok ? await as(() => answers.computeCard(P, column.spec)) : null;
  ok('NEGATIVE CONTROL: a column sum on the semantic dataset is still refused (columnOnLayer)', !!columnCard && !('card' in columnCard) && /not a metric/.test(String((columnCard as Reply).reason ?? (columnCard as Reply).error)), show(columnCard));

  // ── § facts ──
  const facts = await as(() => copilotIpc.buildFacts(P, { kind: 'dataset', id: D }));
  const text = facts.text;
  ok('the Assistant\'s facts for the dataset list its mirrors, each with the layer\'s figure', mirrors.every((m) => String(text).includes(`"${m.name}"`)) && /Defined metrics/.test(String(text)), String(text).slice(0, 600));

  // ── § explore ──
  const sug = (await post('explore:suggest', { projectId: P, datasetId: D })).value;
  ok('explore:suggest lists the mirrors as the measures, each by its id', sug.ok === true && show(sug.measures.map((m: Reply) => m.metricId).sort()) === show(mirrors.map((m) => m.id).sort()), show(sug.measures));
  const asked = (sug.suggestions ?? []).flatMap((x: Reply) => x.encoding.values);
  ok('…its suggestions chart them by id (the name only labels them), never a column sum', asked.length > 0 && asked.every((m: Reply) => mirrors.some((x) => x.id === m.metricId && x.name === m.column)), show(sug.suggestions));
  ok('…and its dimensions keep every number field (none is a measure there)', sug.dimensions.some((d: Reply) => d.name === 'qty'), show(sug.dimensions));
  const drawn = sug.suggestions?.[0] ? (await post('visual:data', { projectId: P, datasetId: D, encoding: sug.suggestions[0].encoding })).value : null;
  ok('…and a suggestion draws', drawn?.ok === true, show(drawn));
  const extract = (await post('explore:suggest', { projectId: P, datasetId: s.extractId })).value;
  ok('NEGATIVE CONTROL: an extract\'s measures are still its number columns', extract.ok === true && extract.measures.length > 0 && extract.measures.every((m: Reply) => !m.metricId), show(extract.measures));

  await close();
  finish();
})();
