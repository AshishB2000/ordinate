// Self-check for src/analysis/reportSpec.ts — the Report record.
//
// Same shape as test-analysis.ts: stub 'electron' through Module._load so
// userData points at a throwaway dir, then exercise the REAL modules against
// real disk.
//
// The three properties worth the attention, because they are the ones the whole
// feature rests on:
//
//   1. THE DEFAULT PAGE LIST. Given the sample dashboard's own shape — a KPI
//      strip, three half-width charts and a text note on one sheet — the
//      default report must come out as cover + summary + one sheet page + three
//      tile pages, and the tile pages must be the CHARTS, never the KPI tiles
//      or the note. This is the assertion the builder's whole left pane is
//      downstream of.
//   2. REORDER AND INCLUDE SURVIVE A ROUND TRIP. The page list is the record;
//      if sanitizePages reordered, re-keyed or re-included anything on load,
//      the author's edits would silently revert.
//   3. THE DUE CHECK. Pure, clock-injected, and gated on BOTH the interval and
//      the time of day — a "daily at 09:00" that fires at 02:00 is the bug.
//
//   npm run build:ts && node scripts/test-reportSpec.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-reportspec-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => tmpUserData }, net: {} };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const spec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const CARD = { kpi1: uuid(1), kpi2: uuid(2), chart1: uuid(3), chart2: uuid(4), chart3: uuid(5), note: uuid(6) };
const VISUAL = uuid(90);
const DATASET = uuid(91);

/**
 * The sample dashboard's own shape, card for card: a KPI strip of 3-wide metric
 * tiles, three half-width (6-wide) charts and a full-width text note — the
 * layout planBuild.ts produces for `buildStarterPlan('kpis', …)` when a sheet
 * has more than one visual (`chartW = GRID_COLS / 2`).
 */
function sampleSheets(): any[] {
  const metric = (id: string, label: string) => ({
    id, type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 },
    metric: { datasetId: DATASET, column: 'revenue', aggregation: 'sum', label },
  });
  const chart = (id: string, x: number) => ({
    id, type: 'visual', layout: { x, y: 2, w: 6, h: 6 }, visualId: VISUAL,
  });
  return [{
    id: uuid(80), name: 'Overview',
    cards: [
      metric(CARD.kpi1, 'Revenue'), metric(CARD.kpi2, 'Profit'),
      chart(CARD.chart1, 0), chart(CARD.chart2, 6), chart(CARD.chart3, 0),
      { id: CARD.note, type: 'text', layout: { x: 0, y: 14, w: 12, h: 2 }, heading: 'About', text: 'Sample.' },
    ],
  }];
}

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Reports project');
  const pid = proj!.id;
  const analysisId = uuid(70);

  // ── 1. the default page list ───────────────────────────────────────────────
  const sheets = dashboards.sanitizePages(sampleSheets());
  ok('the fixture survives the dashboard sanitizer intact (6 cards)',
    sheets.length === 1 && sheets[0].cards.length === 6, sheets[0] && sheets[0].cards.length);

  const pages = spec.defaultPages(sheets);
  ok('default report = cover, summary, one sheet page, three tile pages',
    pages.map((p) => p.kind).join(',') === 'cover,summary,sheet,tile,tile,tile',
    pages.map((p) => p.kind).join(','));
  ok('the tile pages are the three CHARTS, in sheet order',
    pages.filter((p) => p.kind === 'tile').map((p) => p.cardId).join(',')
    === [CARD.chart1, CARD.chart2, CARD.chart3].join(','));
  ok('a 3-wide KPI tile does not earn a page of its own',
    !pages.some((p) => p.cardId === CARD.kpi1 || p.cardId === CARD.kpi2));
  ok('a text note does not earn a page of its own',
    !pages.some((p) => p.cardId === CARD.note));
  ok('the sheet page points at sheet 0',
    pages.filter((p) => p.kind === 'sheet').every((p) => p.sheetIdx === 0));
  ok('every default page is included and full-bleed',
    pages.every((p) => p.include === true && p.layout === 'full'));
  ok('every page id is a distinct UUID',
    new Set(pages.map((p) => p.id)).size === pages.length
    && pages.every((p) => /^[0-9a-f-]{36}$/i.test(p.id)));

  ok('two sheets produce two sheet pages, in order',
    spec.defaultPages([...sheets, { id: uuid(81), name: 'Detail', cards: [] }] as never)
      .filter((p) => p.kind === 'sheet').map((p) => p.sheetIdx).join(',') === '0,1');
  ok('a dashboard with no sheets still gets a cover and a summary',
    spec.defaultPages([]).map((p) => p.kind).join(',') === 'cover,summary');
  ok('isBigChart is the cut, at half a sheet inclusive', [
    spec.isBigChart({ id: uuid(9), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 6 } } as never) === true,
    spec.isBigChart({ id: uuid(9), type: 'visual', layout: { x: 0, y: 0, w: 12, h: 6 } } as never) === true,
    spec.isBigChart({ id: uuid(9), type: 'visual', layout: { x: 0, y: 0, w: 5, h: 6 } } as never) === false,
    spec.isBigChart({ id: uuid(9), type: 'metric', layout: { x: 0, y: 0, w: 12, h: 6 } } as never) === false,
  ].every(Boolean));

  // ── 2. save / reorder / include, through real disk ─────────────────────────
  const saved = await spec.saveReport(pid, {
    analysisId, name: 'Quarterly review', format: 'pptx', pages,
    cover: { title: 'Quarterly review', subtitle: 'Q3', logo: true },
  });
  ok('saveReport writes a record', !!saved && !!saved.id);
  ok('the record lands in the project reports dir',
    fs.existsSync(path.join(tmpUserData, 'projects', pid, 'reports', saved!.id + '.json')));
  ok('format is kept as chosen', saved!.format === 'pptx');
  ok('paper defaults to portrait Letter',
    saved!.paper.size === 'letter' && saved!.paper.orientation === 'portrait');
  ok('filters print by default, narrative does not',
    saved!.includeFilters === true && saved!.narrative === false);

  // Reorder: move the last tile page to the front, and drop the summary out.
  const reordered = [...saved!.pages];
  reordered.unshift(reordered.pop()!);
  reordered.find((p) => p.kind === 'summary')!.include = false;
  reordered.find((p) => p.kind === 'tile')!.caption = 'My own sentence';
  const patched = await spec.updateReport(pid, saved!.id, { pages: reordered });
  const reread = await spec.getReport(pid, saved!.id);

  ok('a reorder survives the write and the read back, id for id',
    reread!.pages.map((p) => p.id).join(',') === reordered.map((p) => p.id).join(','),
    reread!.pages.map((p) => p.kind).join(','));
  ok('the reordered list starts with the moved tile page',
    reread!.pages[0].kind === 'tile' && reread!.pages[0].cardId === CARD.chart3);
  ok('an excluded page is KEPT in the record, just not included',
    reread!.pages.some((p) => p.kind === 'summary' && p.include === false));
  ok('an author caption survives the round trip',
    reread!.pages[0].caption === 'My own sentence');
  ok('the summary counts only INCLUDED pages',
    (await spec.listReports(pid))[0].pageCount === reread!.pages.length - 1);
  ok('updateReport bumps updatedAt', patched!.updatedAt >= saved!.updatedAt);

  // ── 3. defensive clamping ─────────────────────────────────────────────────
  const junk = await spec.saveReport(pid, {
    analysisId: '../../etc', name: '   ', format: 'exe',
    paper: { size: 'a4', orientation: 'landscape' },
    pages: [
      { kind: 'nope' }, null, 'cover', 42,
      { kind: 'sheet', sheetIdx: -3 },
      { kind: 'tile', cardId: '../escape' },
      { kind: 'notes', notes: 'hello', layout: 'half', include: false },
    ],
    schedule: { cadence: 'yearly', at: '99:99', folder: 'relative/path' },
  });
  ok('a non-UUID analysisId is dropped, not stored', junk!.analysisId === '');
  ok('a blank name falls back', junk!.name === 'Untitled report');
  ok('an unknown format falls back to pdf', junk!.format === 'pdf');
  ok('a paper choice is kept', junk!.paper.size === 'a4' && junk!.paper.orientation === 'landscape');
  ok('garbage pages are dropped, the three real ones kept',
    junk!.pages.map((p) => p.kind).join(',') === 'sheet,tile,notes', junk!.pages.length);
  ok('a negative sheetIdx is clamped to 0', junk!.pages[0].sheetIdx === 0);
  ok('a traversal cardId is dropped', junk!.pages[1].cardId === undefined);
  ok('a notes page keeps its text, its half layout and its exclusion',
    junk!.pages[2].notes === 'hello' && junk!.pages[2].layout === 'half' && junk!.pages[2].include === false);
  ok('an unknown cadence becomes off', junk!.schedule!.cadence === 'off');
  ok('an impossible time falls back to 09:00', junk!.schedule!.at === '09:00');
  ok('a relative folder is refused', junk!.schedule!.folder === '');
  ok('a cover with no title still has one', junk!.cover.title === 'Report');

  ok('getReport refuses a traversal id',
    (await spec.getReport(pid, '../../../etc/passwd')) === null
    && (await spec.getReport('..', saved!.id)) === null);
  ok('deleteReport removes the file', (await spec.deleteReport(pid, junk!.id))
    && (await spec.getReport(pid, junk!.id)) === null);
  ok('saving into a project that does not exist is refused',
    (await spec.saveReport(uuid(99), { name: 'ghost' })) === null);

  // ── 4. filenames ──────────────────────────────────────────────────────────
  ok('filename = slug + local date + ext',
    spec.reportFilename('Quarterly Review!', 'pptx', new Date(2026, 2, 7, 13, 0))
    === 'quarterly-review-2026-03-07.pptx');
  ok('a late-evening local time keeps the LOCAL day, not the UTC one',
    spec.reportFilename('r', 'pdf', new Date(2026, 0, 1, 23, 30)) === 'r-2026-01-01.pdf');
  ok('an unnameable name still produces a file',
    spec.reportFilename('!!!', 'pdf', new Date(2026, 0, 1)) === 'report-2026-01-01.pdf');
  ok('the extension cannot smuggle a path',
    spec.reportFilename('r', '../x', new Date(2026, 0, 1)) === 'r-2026-01-01.x');

  // ── 5. the due check ──────────────────────────────────────────────────────
  const at9 = (cadence: string, lastRunAt?: string) =>
    ({ schedule: { cadence, at: '09:00', folder: '/tmp/out' }, lastRunAt } as never);
  const noon = new Date(2026, 5, 10, 12, 0).getTime();
  const dawn = new Date(2026, 5, 10, 2, 0).getTime();
  const day = 24 * 60 * 60 * 1000;

  ok('a never-run daily is due once the hour has passed',
    spec.scheduleDue([at9('daily')], noon).length === 1);
  ok('…and NOT before it', spec.scheduleDue([at9('daily')], dawn).length === 0);
  ok('a daily that ran 25 hours ago is due again',
    spec.scheduleDue([at9('daily', new Date(noon - 25 * 60 * 60 * 1000).toISOString())], noon).length === 1);
  ok('a daily that ran this morning is not',
    spec.scheduleDue([at9('daily', new Date(noon - 60 * 60 * 1000).toISOString())], noon).length === 0);
  ok('weekly waits a week',
    spec.scheduleDue([at9('weekly', new Date(noon - 6 * day).toISOString())], noon).length === 0
    && spec.scheduleDue([at9('weekly', new Date(noon - 8 * day).toISOString())], noon).length === 1);
  ok('monthly waits thirty days',
    spec.scheduleDue([at9('monthly', new Date(noon - 29 * day).toISOString())], noon).length === 0
    && spec.scheduleDue([at9('monthly', new Date(noon - 31 * day).toISOString())], noon).length === 1);
  ok('cadence off is never due', spec.scheduleDue([at9('off')], noon).length === 0);
  ok('no folder is never due',
    spec.scheduleDue([{ schedule: { cadence: 'daily', at: '09:00', folder: '' } } as never], noon).length === 0);
  ok('a corrupt lastRunAt self-heals to due, never to never',
    spec.scheduleDue([at9('daily', 'not a date')], noon).length === 1);
  ok('no schedule at all is never due', spec.scheduleDue([{} as never], noon).length === 0);
  ok('scheduleDue survives a non-array', spec.scheduleDue(null as never, noon).length === 0);

  if (!failureCount()) console.log('\nAll report-spec checks passed.');
}

main()
  .catch((e) => { console.error('FAIL harness threw', e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    finish();
  });
