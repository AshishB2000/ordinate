// A published dashboard or story with ONE tile this pod cannot draw because of a glossary term (semantic layer
// part 1, PR 05a): that tile is refused with the term's sentence, as a Live figure error is, and the rest of the
// page still publishes with its figures. A term anywhere a KPI reads (here: a saved metric's own filters, which a
// later release may write) used to throw out of the whole build.
//
//   npm run build:ts && node scripts/test-termPublished.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-term-published-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const termMsg: typeof import('../src/data/termMessages') = require('../src/data/termMessages');
const { buildDashboard }: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const { buildStory }: typeof import('../src/publish/storyData') = require('../src/publish/storyData');

const show = (v: unknown): string => JSON.stringify(v);

async function main(): Promise<void> {
  await projects.init();
  const P = (await projects.createProject('Term published')).id;
  const ds = (await datasets.saveDataset(P, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
    rows: [['East', 10], ['West', 20], ['East', 30]],
  }))!;
  const term = { type: 'term', term: randomUUID() };
  const withTerm = (await metrics.saveMetric(P, { name: 'East sales', datasetId: ds.id, definition: { column: 'amount', aggregation: 'sum' }, filters: [term] }))!;
  const plain = (await metrics.saveMetric(P, { name: 'All sales', datasetId: ds.id, definition: { column: 'amount', aggregation: 'sum' } }))!;
  ok('fixture: the saved metric keeps the term a later release wrote', show((await metrics.getMetric(P, withTerm.id))!.filters) === show([term]));
  const sentence = termMsg.termUnreadable();

  // ── a published dashboard ──────────────────────────────────────────────
  const kpi = (metricId: string, x: number) => ({ id: randomUUID(), type: 'metric', metric: { datasetId: ds.id, column: 'amount', aggregation: 'sum', metricId }, layout: { x, y: 0, w: 3, h: 2 } });
  const dash = (await analysis.saveAnalysis(P, { name: 'Sales', sheets: [{ id: randomUUID(), name: 'Main', cards: [kpi(withTerm.id, 0), kpi(plain.id, 3)] }] } as never))!; // a record literal the saver sanitizes
  let built: Awaited<ReturnType<typeof buildDashboard>> = null;
  let threw = '';
  try {
    built = await buildDashboard(P, dash.id, 1);
  } catch (err) {
    threw = String((err as Error)?.message);
  }
  ok('dashboard: a term KPI does not fail the whole page', !!built && !threw, threw);
  const cards = built ? built.sheets[0].cards : [];
  const payloadOf = (i: number) => (cards[i] ? cards[i].payloads[cards[i].variants[0]] : null) as { value?: unknown; error?: string } | null;
  ok('dashboard: the term KPI is refused with the term\'s sentence, and carries no figure', payloadOf(0)?.error === sentence && !('value' in (payloadOf(0) || {})), show(payloadOf(0)));
  ok('NEGATIVE CONTROL: the plain KPI beside it carries its figure', Object.is(payloadOf(1)?.value, 60), show(payloadOf(1)));

  // ── a published story ──────────────────────────────────────────────────
  const story = (await stories.saveStory(P, { name: 'Sales story', blocks: [
    { kind: 'metric', metricId: withTerm.id, filters: [] },
    { kind: 'metrics_row', metricIds: [withTerm.id, plain.id], filters: [] },
    { kind: 'metric', metricId: plain.id, filters: [] },
  ] }))!;
  let told: Awaited<ReturnType<typeof buildStory>> = null;
  threw = '';
  try {
    told = await buildStory(P, story.id);
  } catch (err) {
    threw = String((err as Error)?.message);
  }
  ok('story: a term metric does not fail the whole story', !!told && !threw, threw);
  const blocks = (told ? told.blocks : []) as Array<{ kind: string; reason?: string; metrics?: Array<{ name: string; value: unknown }> }>;
  ok('story: a block of only the term metric says the term\'s sentence', blocks[0]?.kind === 'broken' && blocks[0].reason === sentence, show(blocks[0]));
  ok('story: a row leaves the term metric out and keeps the plain one\'s figure', blocks[1]?.kind === 'metrics' && show(blocks[1].metrics!.map((m) => [m.name, m.value])) === show([['All sales', 60]]), show(blocks[1]));
  ok('NEGATIVE CONTROL: a plain metric block carries its figure', blocks[2]?.kind === 'metrics' && Object.is(blocks[2].metrics![0].value, 60), show(blocks[2]));
}

main()
  .catch((e) => { console.error('FAIL harness threw', e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(process.env.ORDINATE_LOCAL_DIR as string, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    finish();
  });
