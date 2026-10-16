// Self-check for the version compare view's server half (docs/version-diff):
// src/analysis/versionDiff.ts (the pure structural diff), versionDiffParts.ts and
// src/ipc/versionDiff.ts (`versions:diff` / `versions:figures`).
//
//   1. STRUCTURE — fixtures: identical → empty; list order alone → empty; a layout
//      swap → moved; id-less cards matched by type + title; filters added, removed,
//      changed; a nested encoding change; a KPI measure change; the word diff.
//   2. WORDS — every change is a catalog sentence with no unfilled `{param}`, and the
//      summary line says the noun.
//   3. FIGURES ARE THE ENGINE'S — each side of a figure row is asserted with Object.is
//      against computeCardMetric / previewDefinition called directly under that
//      version's filters (differential, never a hand-written number), and a Live
//      failure stays typed.
//   4. AUTHOR — a version saved inside a request records who saved it.
//
// Negative controls: a changed card id is NOT matched (added + removed), different
// titles on id-less cards are not matched, an unworded field still reports
// "settings changed", and the two sides' figures genuinely differ (so the
// differential could fail).
//
//   npm run build:ts && node scripts/test-versionDiff.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-versiondiff-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const visualsMod: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const context: typeof import('../src/server/context') = require('../src/server/context');
const dashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const format: typeof import('../src/app/format') = require('../src/app/format');
const vd: typeof import('../src/analysis/versionDiff') = require('../src/analysis/versionDiff');
const parts: typeof import('../src/analysis/versionDiffParts') = require('../src/analysis/versionDiffParts');
const ipcDiff: typeof import('../src/ipc/versionDiff') = require('../src/ipc/versionDiff');
const { LiveFigureError }: typeof import('../src/engine/live/liveFigureError') = require('../src/engine/live/liveFigureError');

type Any = any; // any: stored-record fixtures and handler replies, read field by field
const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const kinds = (d: { changes: { kind: string }[] }): string => d.changes.map((c) => c.kind).join(',');
const titleOf = (c: Any): string => (c.type === 'metric' ? c.metric.label : c.type === 'text' ? c.heading || 'Text' : c.type === 'visual' ? 'Revenue by region' : c.type);

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DS = ID(900);

function base(): Any {
  return {
    name: 'Sales',
    filters: [],
    style: { theme: 'clean', density: 'comfortable', accent: 'blue' },
    sheets: [{
      id: ID(1),
      name: 'Overview',
      cards: [
        { id: ID(11), type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: DS, column: 'amount', aggregation: 'sum', label: 'Revenue', format: 'auto' } },
        { id: ID(12), type: 'metric', layout: { x: 3, y: 0, w: 3, h: 2 }, metric: { datasetId: DS, column: 'amount', aggregation: 'count', label: 'Orders', format: 'auto' } },
        { id: ID(13), type: 'text', layout: { x: 0, y: 2, w: 6, h: 2 }, heading: 'Notes', text: 'Sales were strong in March' },
        { id: ID(14), type: 'visual', layout: { x: 6, y: 2, w: 6, h: 4 }, visualId: ID(20) },
      ],
    }],
  };
}

function structure(): void {
  const a = base();
  let d = vd.diffVersions('dashboard', a, clone(a), titleOf);
  ok('identical versions → no changes', d.changes.length === 0 && vd.isEmptyDiff(d), show(d.changes));
  ok('…every tile on both sides is "same"', d.sheets[0].before!.every((t) => t.status === 'same') && d.sheets[0].after!.every((t) => t.status === 'same'));
  ok('…the sheet is not marked changed, and no figure is asked', d.sheets[0].changed === false && d.figures.length === 0);
  ok('…the summary says so', ipcDiff.summaryLine(d.counts) === 'No changes — these two versions are the same.', ipcDiff.summaryLine(d.counts));

  const shuffled = clone(a);
  shuffled.sheets[0].cards.reverse();
  d = vd.diffVersions('dashboard', a, shuffled, titleOf);
  ok('the cards list in another order, same layout → no changes (list order is not position)', d.changes.length === 0, kinds(d));

  const swapped = clone(a);
  swapped.sheets[0].cards[0].layout.x = 3;
  swapped.sheets[0].cards[1].layout.x = 0;
  d = vd.diffVersions('dashboard', a, swapped, titleOf);
  ok('a layout swap → two moves along the row', kinds(d) === 'card.movedWithin,card.movedWithin' && d.counts.moved === 2 && d.counts.changed === 0, kinds(d));
  ok('…both tiles are "moved" on each side', d.sheets[0].after!.filter((t) => t.status === 'moved').length === 2 && d.sheets[0].before!.filter((t) => t.status === 'moved').length === 2);

  const down = clone(a);
  down.sheets[0].cards[1].layout = { x: 0, y: 6, w: 3, h: 2 };
  d = vd.diffVersions('dashboard', a, down, titleOf);
  const mv = d.changes.find((c) => c.kind === 'card.movedRow');
  ok('a card dragged below the others → moved from row 1 to row 3 (rows are distinct tops, not grid units)', !!mv && mv.params.from === 1 && mv.params.to === 3, show(d.changes));
  ok('…worded with its title', !!mv && ipcDiff.sentence(mv) === '“Orders” moved from row 1 to row 3', mv && ipcDiff.sentence(mv));

  // Id-less cards (an old snapshot): matched by type + title.
  const strip = (r: Any): Any => { for (const c of r.sheets[0].cards) delete c.id; return r; };
  const na = strip(clone(a));
  const nb = strip(clone(a));
  nb.sheets[0].cards[2].text = 'Sales were weak in March';
  d = vd.diffVersions('dashboard', na, nb, titleOf);
  ok('id-less cards are matched by type + title: an edited note is ONE change, not an add and a remove', kinds(d) === 'card.text' && d.counts.changed === 1, kinds(d));
  ok('…with the word diff', show(d.changes[0].words) === show([{ op: 'same', text: 'Sales were' }, { op: 'del', text: 'strong' }, { op: 'add', text: 'weak' }, { op: 'same', text: 'in March' }]), show(d.changes[0].words));
  const renamed = strip(clone(a));
  renamed.sheets[0].cards[2].heading = 'Commentary';
  d = vd.diffVersions('dashboard', na, renamed, titleOf);
  ok('NEGATIVE CONTROL: id-less cards whose titles differ are not matched (added + removed)', d.counts.added === 1 && d.counts.removed === 1, kinds(d));
  const reid = clone(a);
  reid.sheets[0].cards[2].id = ID(99);
  d = vd.diffVersions('dashboard', a, reid, titleOf);
  ok('NEGATIVE CONTROL: a card whose id changed is not matched by its title', d.counts.added === 1 && d.counts.removed === 1, kinds(d));

  // Filters.
  const east = { type: 'filter', column: 'region', op: '=', value: 'East' };
  const fb = clone(a);
  fb.filters = [east];
  d = vd.diffVersions('dashboard', a, fb, titleOf);
  ok('a filter added → filter.added, counted', kinds(d) === 'filter.added' && d.counts.filters === 1, kinds(d));
  ok('…worded "Filter region = East was added"', ipcDiff.sentence(d.changes[0]) === 'Filter region = East was added', ipcDiff.sentence(d.changes[0]));
  ok('…and both KPI cards are asked for their figures (the scope moved)', d.figures.length === 2 && d.figures.every((f) => f.reason === 'filters'), show(d.figures));
  d = vd.diffVersions('dashboard', fb, a, titleOf);
  ok('the filter removed → filter.removed', kinds(d) === 'filter.removed' && ipcDiff.sentence(d.changes[0]) === 'Filter region = East was removed');
  const west = clone(fb);
  west.filters = [{ ...east, value: 'West' }];
  d = vd.diffVersions('dashboard', fb, west, titleOf);
  ok('the same column with another value → ONE filter.changed', kinds(d) === 'filter.changed' && ipcDiff.sentence(d.changes[0]) === 'Filter changed from region = East to region = West', ipcDiff.sentence(d.changes[0]));
  const two = clone(fb);
  two.filters = [{ type: 'filter', column: 'kind', op: '=', value: 'sale' }, east];
  d = vd.diffVersions('visual', { filters: [east] }, { filters: two.filters }, titleOf);
  ok('filter order is not a change; a new one is (visual filters)', kinds(d) === 'filter.added', kinds(d));

  // A KPI measure change.
  const avg = clone(a);
  avg.sheets[0].cards[0].metric.aggregation = 'avg';
  d = vd.diffVersions('dashboard', a, avg, titleOf);
  ok('a KPI aggregation change → card.measure, the tile "changed"', kinds(d) === 'card.measure' && d.sheets[0].after![0].status === 'changed', kinds(d));
  ok('…"Revenue: measure changed from sum(amount) to avg(amount)"', ipcDiff.sentence(d.changes[0]) === 'Revenue: measure changed from sum(amount) to avg(amount)', ipcDiff.sentence(d.changes[0]));
  ok('…and ONE figure is asked, the measure reason, both specs', d.figures.length === 1 && d.figures[0].reason === 'measure' && d.figures[0].before!.aggregation === 'sum' && d.figures[0].after!.aggregation === 'avg');

  // Nested encoding: a published card's snapshot, and a visual record.
  const snapA = clone(a);
  snapA.sheets[0].cards[3].visual = { name: 'Revenue by region', chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, filters: [] };
  const snapB = clone(snapA);
  snapB.sheets[0].cards[3].visual.encoding.values[0].aggregation = 'avg';
  d = vd.diffVersions('dashboard', snapA, snapB, titleOf);
  ok('a nested encoding change in a card snapshot → card.encoding', kinds(d) === 'card.encoding', kinds(d));
  snapB.sheets[0].cards[3].visual.chartType = 'line';
  d = vd.diffVersions('dashboard', snapA, snapB, titleOf);
  const ct = d.changes.find((c) => c.kind === 'card.chartType');
  ok('…and its chart type → "Revenue by region: chart changed from Bar to Line"', !!ct && ipcDiff.sentence(ct) === 'Revenue by region: chart changed from Bar to Line', ct && ipcDiff.sentence(ct));
  const va = { name: 'R', chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } };
  const vb = { name: 'R', chartType: 'column', encoding: { category: 'region', series: 'kind', values: [{ column: 'amount', aggregation: 'avg' }] } };
  d = vd.diffVersions('visual', va, vb, titleOf);
  ok('a visual version: chart, measure in and out, split — in that order', kinds(d) === 'visual.chartType,visual.measureAdded,visual.measureRemoved,visual.series', kinds(d));
  ok('…"Chart changed from Bar to Column"', ipcDiff.sentence(d.changes[0]) === 'Chart changed from Bar to Column', ipcDiff.sentence(d.changes[0]));

  // NEGATIVE CONTROL: a field no branch words is still reported.
  const img = clone(a);
  img.sheets[0].cards.push({ id: ID(15), type: 'image', layout: { x: 0, y: 8, w: 2, h: 2 }, image: { fit: 'cover' } });
  const img2 = clone(img);
  img2.sheets[0].cards[4].image.fit = 'contain';
  d = vd.diffVersions('dashboard', img, img2, titleOf);
  ok('NEGATIVE CONTROL: an unworded field change is "settings changed", never silence', kinds(d) === 'card.settings', kinds(d));

  // Sheets, title and the summary.
  const many = clone(a);
  many.name = 'Sales Q4';
  many.filters = [east];
  many.sheets[0].cards[0].metric.aggregation = 'max';
  many.sheets[0].cards[2].text = 'Different words entirely';
  many.sheets[0].cards[3].visualId = ID(21);
  many.sheets[0].cards.splice(1, 1);
  many.sheets[0].cards.push({ id: ID(16), type: 'text', layout: { x: 0, y: 10, w: 12, h: 2 }, heading: 'Footer', text: '' });
  many.sheets.push({ id: ID(2), name: 'Detail', cards: [] });
  const visTitles = (c: Any): string => (c.type === 'visual' ? (c.visualId === ID(20) ? 'Revenue by region' : 'Sales by month') : titleOf(c));
  d = vd.diffVersions('dashboard', a, many, visTitles);
  const line = ipcDiff.summaryLine(d.counts);
  ok('the summary line says the noun and counts each kind', line === '3 cards changed, 1 card added, 1 card removed, a filter changed, 2 other changes', line);
  ok('"Revenue by region" now shows "Sales by month"', d.changes.some((c) => ipcDiff.sentence(c) === '“Revenue by region” now shows “Sales by month”'));
  ok('the title change is worded', d.changes.some((c) => ipcDiff.sentence(c) === 'Title changed from “Sales” to “Sales Q4”'));
  ok('a new page has a pair with no before side', d.sheets.some((s) => s.name === 'Detail' && s.before === null && s.changed));
  ok('figures: the changed KPI and the removed one (with no after side)', d.figures.length === 2 && d.figures.some((f) => f.reason === 'removed' && f.after === null), show(d.figures));
  for (const c of d.changes) {
    const s = ipcDiff.sentence(c);
    if (!s || /[{}]/.test(s)) ok(`every sentence is filled in (${c.kind})`, false, s);
  }
  ok('every sentence is a finished one (no empty, no unfilled {param})', d.changes.every((c) => { const s = ipcDiff.sentence(c); return !!s && !/[{}]/.test(s); }));
  ok('a word diff past the cap is one removed run and one added run',
    parts.wordDiff('a '.repeat(500), 'b '.repeat(3)).length === 2);
}

async function engine(): Promise<void> {
  const pid = (await projects.createProject('Version diff')).id;
  const cols = [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }] as Any;
  const rows = [['East', 120], ['West', 40], ['East', 7], ['North', 15], ['West', 3]];
  const ds = (await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: cols, rows } as Any))!.id;
  const vis = await visualsMod.saveVisual(pid, { name: 'Revenue by region', datasetId: ds, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as Any);
  const rec = base();
  for (const c of rec.sheets[0].cards) { if (c.metric) c.metric.datasetId = ds; if (c.type === 'visual') c.visualId = vis!.id; }
  const created = await analysis.saveAnalysis(pid, rec);
  if (!created) throw new Error('could not create the analysis');

  // Two versions saved by Priya, inside a request — the author is kept.
  const priya = { user: { email: 'priya@acme.com', role: 'editor' as const }, org: { id: 'desktop' } };
  const first = await context.runInContext(priya, 't1', () => versions.record(pid, 'dashboard', created, { now: new Date(Date.now() - 60_000) }));
  const edited = clone(created) as Any;
  edited.filters = [{ type: 'filter', column: 'region', op: '=', value: 'East' }];
  edited.sheets[0].cards[0].metric.format = 'currency';
  const second = await context.runInContext(priya, 't2', () => versions.record(pid, 'dashboard', edited));
  ok('a version saved inside a request records who saved it', first?.by === 'priya@acme.com' && second?.by === 'priya@acme.com', show(first));
  const anon = await versions.record(pid, 'dashboard', { ...clone(edited), name: 'Anon' });
  ok('…and one saved outside a request (the desktop context) carries no author', !!anon && anon.by === undefined, show(anon));

  const input = { projectId: pid, type: 'dashboard', id: created.id, from: first!.key, to: second!.key };
  const diff = await handlers.get('versions:diff')!({}, input);
  ok('versions:diff answers', diff && diff.ok === true, show(diff));
  ok('…with each side\'s time and author', diff.from.savedAt === first!.savedAt && diff.to.by === 'priya@acme.com');
  ok('…the summary line', diff.summary === '1 card changed, a filter changed', diff.summary);
  ok('…the visual card named by its Visual record (no figure asked for it)', diff.figures === 2 && diff.changes.every((c: Any) => typeof c.text === 'string' && c.text.length > 0), show(diff.changes));
  ok('…a layout pair for the sheet', diff.sheets.length === 1 && diff.sheets[0].after.length === 4);

  const figs = await handlers.get('versions:figures')!({}, input);
  ok('versions:figures answers with two rows', figs && figs.ok === true && figs.figures.length === 2, show(figs));
  const scopeA: Any[] = [];
  const scopeB: Any[] = [{ type: 'filter', column: 'region', op: '=', value: 'East' }];
  const rev = figs.figures.find((f: Any) => f.title === 'Revenue');
  const direct = async (agg: Any, filters: Any[]) => (await dashboards.computeCardMetric(pid, ds, { column: 'amount', aggregation: agg }, filters)).value;
  const ra = await direct('sum', scopeA);
  const rb = await direct('sum', scopeB);
  ok('DIFFERENTIAL: the before figure IS computeCardMetric under the before filters', rev && Object.is(rev.before.value, ra), show(rev));
  ok('DIFFERENTIAL: the after figure IS computeCardMetric under the after filters', rev && Object.is(rev.after.value, rb), show(rev));
  ok('NEGATIVE CONTROL: the two scopes really give different figures', !Object.is(ra, rb) && rev.moved === true);
  ok('…each formatted by the card\'s own format, by the shared formatter', rev.before.display === format.formatValue(ra, 'auto') && rev.after.display === format.formatValue(rb, 'currency'), show(rev));
  ok('…with the reason in words', rev.reason === 'filters changed' || rev.reason === 'measure changed', rev.reason);

  // A Live failure stays typed (D6): the door throws LiveFigureError.
  const realDoor = dashboards.computeCardMetric;
  (dashboards as Any).computeCardMetric = async () => { throw new LiveFigureError({ ok: false, code: 'live_timeout', error: 'The warehouse took too long to answer.' } as Any); };
  try {
    const live = await handlers.get('versions:figures')!({}, input);
    const side = live.figures[0].before;
    ok('a Live failure keeps its code and the catalog sentence', side.ok === false && side.code === 'live_timeout' && side.error === 'The warehouse took too long to answer.', show(side));
  } finally {
    (dashboards as Any).computeCardMetric = realDoor;
  }
  (dashboards as Any).computeCardMetric = async () => { throw new Error('SELECT secret FROM warehouse'); };
  try {
    const plain = await handlers.get('versions:figures')!({}, input);
    ok('NEGATIVE CONTROL: any other failure never leaks its text', plain.figures[0].before.ok === false && !/secret/.test(show(plain)), show(plain));
  } finally {
    (dashboards as Any).computeCardMetric = realDoor;
  }

  const gone = await handlers.get('versions:diff')!({}, { ...input, from: '2001-01-01T00-00-00-000Z' });
  ok('a version that is not there → ok:false with a sentence', gone.ok === false && /gone/.test(gone.error), show(gone));

  // A metric version: its own value under each definition, through previewDefinition.
  const m = await metricsMod.saveMetric(pid, { name: 'Total', datasetId: ds, definition: { column: 'amount', aggregation: 'sum' }, filters: [], format: { kind: 'number', decimals: 0, compact: false } } as Any);
  if (!m || !('id' in m)) throw new Error('could not save the metric ' + show(m));
  const mv1 = await versions.record(pid, 'metric', m);
  const mv2 = await versions.record(pid, 'metric', { ...m, definition: { column: 'amount', aggregation: 'max' } });
  const mIn = { projectId: pid, type: 'metric', id: m.id, from: mv1!.key, to: mv2!.key };
  const mdiff = await handlers.get('versions:diff')!({}, mIn);
  ok('a metric version: "Definition changed from …"', mdiff.ok && mdiff.changes[0].kind === 'metric.definition' && mdiff.figures === 1, show(mdiff));
  const mf = await handlers.get('versions:figures')!({}, mIn);
  const pa = await ipcMetrics.previewDefinition(pid, ds, { column: 'amount', aggregation: 'sum' }, [], m.format);
  const pb = await ipcMetrics.previewDefinition(pid, ds, { column: 'amount', aggregation: 'max' }, [], m.format);
  ok('DIFFERENTIAL: a metric version\'s figures ARE previewDefinition\'s', Object.is(mf.figures[0].before.value, pa.value) && Object.is(mf.figures[0].after.value, pb.value) && mf.figures[0].after.display === pb.display, show(mf));
}

async function main(): Promise<void> {
  require('../src/ipc/versions').register();
  ok('both channels are registered', handlers.has('versions:diff') && handlers.has('versions:figures'));
  await projects.init();
  structure();
  await engine();
}

main()
  .catch((err) => ok('no exception', false, err && err.stack))
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    finish();
  });
