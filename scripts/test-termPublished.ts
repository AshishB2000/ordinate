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
  const sentence = termMsg.termPurged(); // 05b reads terms: one with no record is refused as deleted for good

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

  // ── 05b: a dashboard term a tile cannot use is a note on the published tile ──
  const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
  const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const other = (await datasets.saveDataset(P, { name: 'Other', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['East', 1], ['West', 2]] }))!;
  const east = (await terms.saveTerm(P, { name: 'East only', datasetId: ds.id, filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }] }))!;
  const vis = async (datasetId: string) => (await visuals.saveVisual(P, { name: 'By region', datasetId, chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } }))!;
  const [vOwn, vOther] = [await vis(ds.id), await vis(other.id)];
  const card = (v: { id: string }, x: number) => ({ id: randomUUID(), type: 'visual', visualId: v.id, layout: { x, y: 2, w: 4, h: 3 } });
  const kpiOn = { id: randomUUID(), type: 'metric', metric: { datasetId: other.id, column: 'amount', aggregation: 'sum' }, layout: { x: 8, y: 0, w: 3, h: 2 } };
  const scoped = (await analysis.saveAnalysis(P, { name: 'Scoped', filters: [{ type: 'term', term: east.id }], sheets: [{ id: randomUUID(), name: 'Main', cards: [card(vOwn, 0), card(vOther, 4), kpiOn] }] } as never))!;
  const page = await buildDashboard(P, scoped.id, 1);
  const pay = (i: number) => (page ? page.sheets[0].cards[i].payloads[page.sheets[0].cards[i].variants[0]] : null) as { labels?: unknown[]; note?: string; value?: unknown } | null;
  const NOTE = termMsg.termNotApplied('East only', 'Other');
  ok('published: the term filters the tile on its own dataset, with no note', show(pay(0)?.labels) === show(['East']) && pay(0)?.note === undefined, show(pay(0)));
  ok('published: an unrelated chart and KPI keep their figures and carry the note', show(pay(1)?.labels) === show(['East', 'West']) && pay(1)?.note === NOTE
    && Object.is(pay(2)?.value, 3) && pay(2)?.note === NOTE, show([pay(1), pay(2)]));
  const sanitize: typeof import('../src/publish/sanitize') = require('../src/publish/sanitize');
  ok('the page sanitizer keeps the note, as a string', (sanitize.sanitizePayload(pay(1)) as { note?: string }).note === NOTE && (sanitize.sanitizePayload({ value: 1, display: '1', note: 5 }) as { note?: string }).note === undefined);

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

  // ── the same note wherever that chart goes: a story block pinned to the term, a report page, a subscription ──
  require('../src/ipc/visuals').register();
  require('../src/ipc/reports').register(); // reports:caption
  require('../src/ipc/analysesServer').register(); // analysis:tiles
  require('../src/ipc/dashboards').register(); // dashboard:metric
  const { pageDeps }: typeof import('../src/ipc/reportsServer') = require('../src/ipc/reportsServer');
  const { buildReportPages, storyVisual }: typeof import('../src/analysis/reportPages') = require('../src/analysis/reportPages');
  const { resolveFigures }: typeof import('../src/ipc/subscriptionFigures') = require('../src/ipc/subscriptionFigures');
  const { viewScope }: typeof import('../src/analysis/savedViews') = require('../src/analysis/savedViews');
  const pinned = [{ type: 'term', term: east.id }];
  const termStory = (await stories.saveStory(P, { name: 'Term story', blocks: [{ kind: 'visual', visualId: vOther.id, filters: pinned }, { kind: 'visual', visualId: vOwn.id, filters: pinned }] }))!;
  const sb = ((await buildStory(P, termStory.id))?.blocks ?? []) as Array<{ kind: string; data?: { labels?: unknown[]; note?: string } }>;
  ok('published story: a block over an unrelated dataset keeps its figures and carries the note', sb[0]?.kind === 'chart' && show(sb[0].data?.labels) === show(['East', 'West']) && sb[0].data?.note === NOTE, show(sb[0]));
  ok('NEGATIVE CONTROL: the block the term applies to is filtered, with no note', show(sb[1]?.data?.labels) === show(['East']) && sb[1]?.data?.note === undefined, show(sb[1]));
  const storyPage = sanitize.sanitizePage({ kind: 'story', story: { name: 'S', blocks: sb } }) as { story: { blocks: Array<{ data: { note?: string } }> } };
  ok('…and the story page sanitizer keeps it, as a string', storyPage.story.blocks[0].data.note === NOTE, show(storyPage.story.blocks[0]));
  const deps = pageDeps({}, P, false);
  const inApp = await storyVisual({ visualId: vOther.id, filters: pinned as never }, deps, P);
  ok('in-app story: the figure carries the note beside its chart', !!inApp?.chart && inApp.note === NOTE, show(inApp));
  ok('NEGATIVE CONTROL: …and none where the term applies', (await storyVisual({ visualId: vOwn.id, filters: pinned as never }, deps, P))?.note === undefined);
  const board = (await analysis.getAnalysis(P, scoped.id))!;
  const tileId = board.sheets[0].cards[1].id;
  const report = { id: randomUUID(), projectId: P, analysisId: scoped.id, name: 'R', pages: [{ kind: 'sheet', sheetIdx: 0, layout: 'full' }, { kind: 'tile', cardId: tileId, layout: 'full' }, { kind: 'tile', cardId: board.sheets[0].cards[0].id, layout: 'full' }], cover: {}, includeFilters: false } as never;
  const rp = await buildReportPages(report, board as never, viewScope(null, board as never), pageDeps({}, P));
  ok('report: the sheet page says the tile the term leaves out', String(rp[0]?.caption).includes(`By region: ${NOTE}`), show(rp[0]?.caption));
  ok('report: that tile\'s page says it after its caption', String(rp[1]?.caption).endsWith(NOTE) && !!rp[1]?.chart, show(rp[1]));
  ok('report: the sheet page says the KPI the term leaves out, with its figure', String(rp[0]?.caption).includes(`Sum · amount: ${NOTE}`) && show(rp[0]?.kpis) === show([{ label: 'Sum · amount', value: '3' }]), show(rp[0]));
  ok('NEGATIVE CONTROL: the tile the term applies to says no note', !String(rp[2]?.caption).includes(NOTE), show(rp[2]?.caption));
  const sent = (await resolveFigures(P, board, null, null)).visuals;
  ok('subscription: the unrelated chart keeps its figures and says the note', show(sent[1]?.data?.labels) === show(['East', 'West']) && String(sent[1]?.caption).endsWith(NOTE), show(sent[1]));
  ok('NEGATIVE CONTROL: …the chart the term applies to does not', show(sent[0]?.data?.labels) === show(['East']) && !String(sent[0]?.caption ?? '').includes(NOTE), show(sent[0]));
}

main()
  .catch((e) => { console.error('FAIL harness threw', e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(process.env.ORDINATE_LOCAL_DIR as string, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    finish();
  });
