// Self-check for src/analysis.ts (the AUTHORING container) and the implicit
// wrap in src/ipc/analyses.ts.
//
// Style follows test-dashboards.ts: stub the 'electron' module via Module._load
// so userData points at a fresh temp dir, then exercise the REAL analysis +
// dashboards + projects modules against real disk. No framework.
//
// Four properties get more attention than the CRUD, because they are the ones
// the whole design rests on and the ones that fail silently:
//
//   1. A SHEET IS A dashboards.Page. Not a parallel type, not a second
//      sanitiser. The garbage-card block here is deliberately the same shape as
//      test-dashboards.ts's, so a fork of the sanitiser shows up as a diff
//      between two suites rather than as a quiet behaviour change.
//   2. READING DOES NOT REWRITE. A planted pre-migration dashboard is read back
//      through the real store and the bytes on disk must be identical
//      afterwards. If a read migrates, "wrap on edit" is a fiction.
//   0. PUBLISHING IS A SNAPSHOT, NOT A LINK. §14 is the gate for the whole
//      feature: publish, then edit the analysis EVERY way that could leak —
//      including editing and then DELETING the referenced Visual — and assert
//      the dashboard file is BYTE-IDENTICAL. The comparison is on the file's
//      bytes (Object.is over the string), not a field-by-field walk, because a
//      walk can only check the fields somebody thought of.
//   3. THE WRAP ORDER. The analysis is written FIRST and the dashboard stamped
//      SECOND, so a crash between them leaves an orphan analysis rather than a
//      dashboard pointing at nothing. Asserted by checking the dashboard's
//      analysisId resolves to a real analysis, and that a second call is
//      idempotent rather than creating a duplicate.
//   4. THE DUAL-UUID PATH GUARD, with the same two sentinel files
//      test-dashboards.ts plants — an id is a filesystem path here.
//
// src/ipc/analyses.ts is imported DIRECTLY rather than mirrored: register() is
// the only thing that touches ipcMain and is never called, so the import is
// inert and the exported `wrapDashboardInAnalysis` under test is the real
// handler body, not a copy of it (the src/ipc/mosaic.ts precedent).
//
//   npm run build:ts && node scripts/test-analysis.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-analysis-'));

// §14k drives one REAL ipc handler (`dashboard:explainAnomalies`), so the
// ipcMain stub captures what register() hands it instead of dropping it.
const ipcHandlers = new Map<string, (e: unknown, payload: unknown) => Promise<any>>();

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData },
      ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<any>) => { ipcHandlers.set(ch, fn); } },
      net: {},
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const dashboardExport: typeof import('../src/analysis/dashboardExport') = require('../src/analysis/dashboardExport');
const analysesIpc: typeof import('../src/ipc/analyses') = require('../src/ipc/analyses');


const MISSING_UUID = '00000000-0000-0000-0000-000000000000';
const VISUAL_ID = '22222222-2222-4222-8222-222222222222';
const DATASET_ID = '33333333-3333-4333-8333-333333333333';

function analysesDirOf(projectId: string): string {
  return path.join(tmpUserData, 'projects', projectId, 'analyses');
}
function dashboardsDirOf(projectId: string): string {
  return path.join(tmpUserData, 'projects', projectId, 'dashboards');
}
function visualsDirOf(projectId: string): string {
  return path.join(tmpUserData, 'projects', projectId, 'visuals');
}

// Plant a REAL v2 visual record on disk. Written directly rather than through
// visuals.saveVisual because that (correctly) refuses a visual whose dataset
// does not exist, and this suite deliberately keeps datasets/DuckDB out of the
// picture — nothing here reads a row. Every MUTATION below goes through the
// real store (visuals.updateVisual / visuals.deleteVisual).
function plantVisual(projectId: string, id: string, over: Record<string, unknown>): void {
  fs.mkdirSync(visualsDirOf(projectId), { recursive: true });
  const rec = {
    id,
    projectId,
    name: 'Planted visual',
    datasetId: DATASET_ID,
    chartType: 'column',
    encoding: { category: 'city', values: [{ column: 'pop', aggregation: 'sum' }] },
    overrides: { title: 'Original title', showLegend: true },
    filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 2,
    ...over,
  };
  fs.writeFileSync(path.join(visualsDirOf(projectId), id + '.json'), JSON.stringify(rec, null, 2), 'utf8');
}

// The six fields a CardVisual is Pick<>ed from — the shape publish copies.
function specOf(v: any): string {
  return JSON.stringify({
    datasetId: v.datasetId,
    name: v.name,
    chartType: v.chartType,
    encoding: v.encoding,
    overrides: v.overrides,
    filters: v.filters,
  });
}

async function main(): Promise<void> {
  await projects.init();
  await analysis.init(); // no-op stub

  const proj = await projects.createProject('Analysis project');
  ok('created a parent project', typeof proj.id === 'string' && proj.id.length > 0);

  // ── 1. empty to start ───────────────────────────────────────────────────────
  let list = await analysis.listAnalyses(proj.id);
  ok('listAnalyses is empty initially', Array.isArray(list) && list.length === 0);

  // ── 2. create + round-trip ──────────────────────────────────────────────────
  const sheets = [
    {
      id: '44444444-4444-4444-4444-444444444444',
      name: '  Overview  ',
      cards: [
        { id: '55555555-5555-4555-8555-555555555555', type: 'visual', visualId: VISUAL_ID, layout: { x: 0, y: 0, w: 6, h: 6 } },
        { type: 'metric', metric: { datasetId: DATASET_ID, column: 'pop', aggregation: 'sum', label: 'Total' }, layout: { x: 6, y: 0, w: 3, h: 2 } },
        { type: 'text', heading: 'Notes', text: 'A note.', layout: { x: 0, y: 6, w: 12, h: 2 } },
      ],
    },
  ];
  const a = await analysis.saveAnalysis(proj.id, { name: '  Q3 analysis  ', sheets });
  ok('saveAnalysis returns an analysis', a !== null && typeof a.id === 'string' && a.id.length > 0);
  ok('saveAnalysis trims the name', a !== null && a.name === 'Q3 analysis');
  ok('saveAnalysis sets projectId', a !== null && a.projectId === proj.id);
  ok('saveAnalysis sets schemaVersion 1', a !== null && a.schemaVersion === 1);
  ok('saveAnalysis sets createdAt === updatedAt', a !== null && a.createdAt === a.updatedAt);
  ok('saveAnalysis defaults filters to []', a !== null && Array.isArray(a.filters) && a.filters.length === 0);
  ok('saveAnalysis defaults publishedDashboardIds to []',
    a !== null && Array.isArray(a.publishedDashboardIds) && a.publishedDashboardIds.length === 0);
  ok('saveAnalysis defaults lastPublishedAt to null', a !== null && a.lastPublishedAt === null);
  ok('saveAnalysis keeps the one sheet', a !== null && a.sheets.length === 1);
  ok('analysis file written under analyses/',
    a !== null && fs.existsSync(path.join(analysesDirOf(proj.id), a.id + '.json')));

  // A sheet IS a dashboards.Page: the SAME sanitizers run.
  ok('sheet name is trimmed by the shared sanitizer', a !== null && a.sheets[0].name === 'Overview');
  ok('all three well-formed cards survive', a !== null && a.sheets[0].cards.length === 3);

  const gotA = a !== null ? await analysis.getAnalysis(proj.id, a.id) : null;
  ok('getAnalysis round-trips', gotA !== null && a !== null && gotA.id === a.id);
  const vCard = gotA ? gotA.sheets[0].cards.find((c) => c.type === 'visual') : undefined;
  const mCard = gotA ? gotA.sheets[0].cards.find((c) => c.type === 'metric') : undefined;
  const tCard = gotA ? gotA.sheets[0].cards.find((c) => c.type === 'text') : undefined;
  ok('reload preserves the visual card visualId', vCard !== undefined && vCard.visualId === VISUAL_ID);
  ok('reload preserves the metric spec',
    mCard !== undefined && mCard.metric !== undefined && mCard.metric.datasetId === DATASET_ID
    && mCard.metric.column === 'pop' && mCard.metric.aggregation === 'sum' && mCard.metric.label === 'Total');
  ok('reload preserves the text card', tCard !== undefined && tCard.heading === 'Notes' && tCard.text === 'A note.');
  ok('reload preserves a card layout', tCard !== undefined && tCard.layout.x === 0 && tCard.layout.w === 12 && tCard.layout.h === 2);
  ok('getAnalysis returns null for a missing uuid', (await analysis.getAnalysis(proj.id, MISSING_UUID)) === null);

  // ── 3. the shared Page sanitizer, exercised through sheets ──────────────────
  const clamped = await analysis.saveAnalysis(proj.id, {
    name: 'Clamp',
    sheets: [{ id: MISSING_UUID, name: 'S', cards: [
      { type: 'text', text: 'x', layout: { x: 10, y: -3, w: 8, h: 0 } },
    ] }],
  });
  const cc = clamped !== null ? clamped.sheets[0].cards[0] : null;
  ok('sheet layout clamping shrinks overflowing width (x+w≤12)', cc !== null && cc.layout.x === 10 && cc.layout.w === 2);
  ok('sheet layout clamping raises negative y to 0', cc !== null && cc.layout.y === 0);
  ok('sheet layout clamping raises h<1 to 1', cc !== null && cc.layout.h === 1);

  const garbage = await analysis.saveAnalysis(proj.id, {
    name: 'Garbage',
    sheets: [{ id: MISSING_UUID, name: 'G', cards: [
      { type: 'bogus', layout: { x: 0, y: 0, w: 2, h: 2 } },            // unknown type → dropped
      { type: 'visual', layout: { x: 0, y: 0, w: 2, h: 2 } },           // visual w/o visualId → dropped
      { type: 'visual', visualId: 'not-a-uuid', layout: {} },           // bad visualId → dropped
      { type: 'metric', metric: { column: 'x', aggregation: 'sum' }, layout: {} }, // no datasetId → dropped
      { type: 'metric', metric: { datasetId: DATASET_ID, column: 'x', aggregation: 'median' }, layout: {} }, // bad agg → dropped
      { type: 'text', layout: {} },                                     // no heading/text → dropped
      'not-an-object',
      null,
      { type: 'text', text: 'keep me', layout: { x: 0, y: 0, w: 4, h: 1 } }, // the ONE valid card
    ] }],
  });
  ok('a sheet drops every garbage card, keeps the one valid card',
    garbage !== null && garbage.sheets[0].cards.length === 1 && garbage.sheets[0].cards[0].text === 'keep me');

  const noSheets = await analysis.saveAnalysis(proj.id, { name: 'Bare' });
  ok('an analysis with no sheets gets one default sheet',
    noSheets !== null && noSheets.sheets.length === 1 && noSheets.sheets[0].name === 'Page 1');
  const emptySheets = await analysis.saveAnalysis(proj.id, { name: 'Empty', sheets: [] });
  ok('an empty sheets array still yields one sheet', emptySheets !== null && emptySheets.sheets.length === 1);

  // ── 4. filters — filter-only, same rule as a dashboard ──────────────────────
  const filtered = await analysis.saveAnalysis(proj.id, {
    name: 'Filtered',
    filters: [
      { type: 'filter', column: 'region', op: '=', value: 'West' },
      { type: 'filter', column: 'pop', op: '>=', value: 100 },
      { type: 'group_aggregate', groupBy: ['region'], aggregations: [] }, // not a filter → dropped
      { type: 'filter', column: 'x', op: 'bogus_op' },                    // bad op → dropped
      'not-an-object',
    ],
  });
  ok('saveAnalysis persists filter-only steps', filtered !== null && filtered.filters.length === 2);
  ok('saveAnalysis drops non-filter transform steps',
    filtered !== null && filtered.filters.every((f) => f.type === 'filter'));
  ok('saveAnalysis keeps column/op/value verbatim',
    filtered !== null && filtered.filters[0].column === 'region' && filtered.filters[0].op === '='
    && filtered.filters[0].value === 'West' && filtered.filters[1].value === 100);
  const reFiltered = filtered !== null ? await analysis.getAnalysis(proj.id, filtered.id) : null;
  ok('analysis filters survive a reload',
    reFiltered !== null && reFiltered.filters.length === 2 && reFiltered.filters[1].column === 'pop');

  // ── 5. publishedDashboardIds — UUID-shaped, de-duplicated, provenance only ──
  const DASH_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const provenance = await analysis.saveAnalysis(proj.id, {
    name: 'Provenance',
    publishedDashboardIds: [DASH_A, DASH_A, 'not-a-uuid', '../escape', 42, null],
    lastPublishedAt: '2026-01-02T00:00:00.000Z',
  });
  ok('publishedDashboardIds keeps only UUID-shaped ids, de-duplicated',
    provenance !== null && provenance.publishedDashboardIds.length === 1 && provenance.publishedDashboardIds[0] === DASH_A);
  ok('lastPublishedAt round-trips', provenance !== null && provenance.lastPublishedAt === '2026-01-02T00:00:00.000Z');
  ok('sanitizePublishedIds rejects a traversal string directly',
    analysis.sanitizePublishedIds(['../../etc/passwd', DASH_A]).length === 1);

  // ── 6. list — newest-updated first, with the summary shape ──────────────────
  await new Promise((r) => setTimeout(r, 5));
  const b = await analysis.saveAnalysis(proj.id, { name: 'Later analysis' });
  list = await analysis.listAnalyses(proj.id);
  ok('listAnalyses returns every saved analysis', list.length === 8, `(${list.length})`);
  ok('listAnalyses is newest-updated first', b !== null && list[0].id === b.id);
  ok('summary carries sheetCount', typeof list[0].sheetCount === 'number' && list[0].sheetCount === 1);
  const provSummary = list.find((s) => provenance !== null && s.id === provenance.id);
  ok('summary carries publishedCount', provSummary !== undefined && provSummary.publishedCount === 1);
  ok('summary carries lastPublishedAt', provSummary !== undefined && provSummary.lastPublishedAt === '2026-01-02T00:00:00.000Z');

  // ── 7. update — full array replace, never a patch-merge ─────────────────────
  await new Promise((r) => setTimeout(r, 5));
  const upd = a !== null ? await analysis.updateAnalysis(proj.id, a.id, {
    name: 'Q3 renamed',
    sheets: [
      { id: '44444444-4444-4444-4444-444444444444', name: 'Overview', cards: [] },
      { id: '66666666-6666-4666-8666-666666666666', name: 'Detail', cards: [] },
    ],
  }) : null;
  ok('updateAnalysis returns the updated analysis', upd !== null);
  ok('updateAnalysis applies the new name', upd !== null && upd.name === 'Q3 renamed');
  ok('updateAnalysis REPLACES the sheets array', upd !== null && upd.sheets.length === 2 && upd.sheets[1].name === 'Detail');
  ok('updateAnalysis bumps updatedAt past createdAt',
    upd !== null && a !== null && new Date(upd.updatedAt).getTime() > new Date(a.createdAt).getTime());
  ok('updateAnalysis leaves createdAt alone', upd !== null && a !== null && upd.createdAt === a.createdAt);
  const reUpd = a !== null ? await analysis.getAnalysis(proj.id, a.id) : null;
  ok('the update survives a reload', reUpd !== null && reUpd.sheets.length === 2);
  const keepName = a !== null ? await analysis.updateAnalysis(proj.id, a.id, { sheets: [] }) : null;
  ok('updateAnalysis keeps the name when only sheets are patched', keepName !== null && keepName.name === 'Q3 renamed');
  ok('updateAnalysis with empty sheets → one default sheet', keepName !== null && keepName.sheets.length === 1);
  const keepFilters = filtered !== null ? await analysis.updateAnalysis(proj.id, filtered.id, { name: 'Renamed only' }) : null;
  ok('updateAnalysis keeps existing filters when the patch omits them',
    keepFilters !== null && keepFilters.filters.length === 2);
  ok('updateAnalysis of a missing uuid → null',
    (await analysis.updateAnalysis(proj.id, MISSING_UUID, { name: 'x' })) === null);

  // ── 8. ATOMIC WRITE: no .tmp sibling survives a successful write ────────────
  ok('no .tmp sibling survives a successful analysis write',
    fs.readdirSync(analysesDirOf(proj.id)).every((f) => !f.includes('.tmp')));
  ok('every file in analyses/ is a <uuid>.json',
    fs.readdirSync(analysesDirOf(proj.id)).every((f) => /^[0-9a-f-]{36}\.json$/i.test(f)));

  // ── 9. CORRUPT FILE IS SKIPPED, NOT FATAL ──────────────────────────────────
  const corruptId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  fs.writeFileSync(path.join(analysesDirOf(proj.id), corruptId + '.json'), '{ nope: not json', 'utf8');
  const noIdId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  fs.writeFileSync(path.join(analysesDirOf(proj.id), noIdId + '.json'), '{"name":"no id"}', 'utf8');
  fs.writeFileSync(path.join(analysesDirOf(proj.id), 'not-a-uuid.json'), '{"id":"x"}', 'utf8');
  const afterCorrupt = await analysis.listAnalyses(proj.id);
  ok('listAnalyses survives a corrupt analyses/*.json', Array.isArray(afterCorrupt) && afterCorrupt.length === 8,
    `(${afterCorrupt.length})`);
  ok('listAnalyses skips the corrupt records',
    !afterCorrupt.some((s) => s.id === corruptId || s.id === noIdId));
  ok('listAnalyses still returns the good records', b !== null && afterCorrupt.some((s) => s.id === b.id));
  ok('getAnalysis of a corrupt record returns null (never throws)',
    (await analysis.getAnalysis(proj.id, corruptId)) === null);

  // ── 10. delete — and it must not touch published dashboards ────────────────
  const doomed = await analysis.saveAnalysis(proj.id, { name: 'Doomed' });
  const del = doomed !== null ? await analysis.deleteAnalysis(proj.id, doomed.id) : false;
  ok('deleteAnalysis returns true', del === true);
  ok('deleteAnalysis removes the file',
    doomed !== null && !fs.existsSync(path.join(analysesDirOf(proj.id), doomed.id + '.json')));
  ok('deleteAnalysis of a missing uuid succeeds (force)',
    (await analysis.deleteAnalysis(proj.id, MISSING_UUID)) === true);

  // ── 11. save rejects a nonexistent / traversal parent project ──────────────
  ok('saveAnalysis rejects a nonexistent parent project',
    (await analysis.saveAnalysis(MISSING_UUID, { name: 'x' })) === null);
  ok('saveAnalysis rejects a traversal projectId',
    (await analysis.saveAnalysis('..', { name: 'x' })) === null);

  // ── 12. SECURITY: the dual-UUID traversal guard ────────────────────────────
  const sentinel = path.join(tmpUserData, 'projects', proj.id, 'SECRET.json');
  fs.writeFileSync(sentinel, 'keep');
  const outsideSentinel = path.join(tmpUserData, 'DO_NOT_DELETE.txt');
  fs.writeFileSync(outsideSentinel, 'keep');

  const anyId = a !== null ? a.id : MISSING_UUID;
  ok('getAnalysis rejects a traversal projectId', (await analysis.getAnalysis('..', anyId)) === null);
  ok('getAnalysis rejects a traversal id', (await analysis.getAnalysis(proj.id, '../SECRET')) === null);
  ok('getAnalysis rejects a nested traversal id', (await analysis.getAnalysis(proj.id, '../../etc/passwd')) === null);
  ok('getAnalysis rejects an absolute-path id', (await analysis.getAnalysis(proj.id, '/etc/passwd')) === null);
  ok('updateAnalysis rejects a traversal projectId', (await analysis.updateAnalysis('..', anyId, { name: 'x' })) === null);
  ok('updateAnalysis rejects a traversal id', (await analysis.updateAnalysis(proj.id, '../SECRET', { name: 'x' })) === null);
  ok('deleteAnalysis rejects a traversal projectId', (await analysis.deleteAnalysis('..', 'x')) === false);
  ok('deleteAnalysis rejects a traversal id', (await analysis.deleteAnalysis(proj.id, '../SECRET')) === false);
  ok('deleteAnalysis rejects a nested traversal id', (await analysis.deleteAnalysis(proj.id, '../../DO_NOT_DELETE')) === false);
  ok('listAnalyses rejects a traversal projectId', (await analysis.listAnalyses('..')).length === 0);

  ok('traversal ops did NOT touch the in-project sentinel', fs.existsSync(sentinel));
  ok('traversal ops did NOT touch files outside projects/', fs.existsSync(outsideSentinel));

  // ── 13. THE LAZY WRAP ──────────────────────────────────────────────────────
  // A PRE-MIGRATION dashboard, written byte-for-byte the way the store wrote one
  // before this feature existed: schemaVersion 2, no analysisId, no publishedAt.
  const legacyId = '12121212-1212-4121-8121-121212121212';
  const legacyBytes = JSON.stringify({
    id: legacyId,
    projectId: proj.id,
    name: 'Legacy standalone',
    pages: [
      { id: '13131313-1313-4131-8131-131313131313', name: 'Overview', cards: [
        { id: '14141414-1414-4141-8141-141414141414', type: 'visual', visualId: VISUAL_ID, layout: { x: 0, y: 0, w: 6, h: 6 } },
        { id: '15151515-1515-4151-8151-151515151515', type: 'metric', metric: { datasetId: DATASET_ID, column: 'pop', aggregation: 'avg', label: 'Mean pop', format: 'compact' }, layout: { x: 6, y: 0, w: 3, h: 2 } },
      ] },
      { id: '16161616-1616-4161-8161-161616161616', name: 'Detail', cards: [
        { id: '17171717-1717-4171-8171-171717171717', type: 'text', heading: 'Notes', text: 'Legacy note.', layout: { x: 0, y: 0, w: 12, h: 2 } },
      ] },
    ],
    filters: [{ type: 'filter', column: 'year', op: '=', value: 2024 }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
    schemaVersion: 2,
  }, null, 2);
  fs.mkdirSync(dashboardsDirOf(proj.id), { recursive: true });
  const legacyPath = path.join(dashboardsDirOf(proj.id), legacyId + '.json');
  fs.writeFileSync(legacyPath, legacyBytes, 'utf8');

  // 13a. READING DOES NOT REWRITE. This is the property the whole design rests
  // on: if a read migrated, "wrap on edit" would be a fiction.
  const legacyRead = await dashboards.getDashboard(proj.id, legacyId);
  await dashboards.listDashboards(proj.id);
  ok('a legacy dashboard reads back', legacyRead !== null && legacyRead.name === 'Legacy standalone');
  ok('a legacy dashboard reports analysisId null in memory', legacyRead !== null && legacyRead.analysisId === null);
  ok('a legacy dashboard reports publishedAt null in memory', legacyRead !== null && legacyRead.publishedAt === null);
  ok('a legacy dashboard reports schemaVersion 3 in memory', legacyRead !== null && legacyRead.schemaVersion === 3);
  ok('READING a legacy dashboard leaves the file byte-identical',
    fs.readFileSync(legacyPath, 'utf8') === legacyBytes);

  // 13b. The wrap itself.
  const analysesBefore = (await analysis.listAnalyses(proj.id)).length;
  const wrapped = await analysesIpc.wrapDashboardInAnalysis(proj.id, legacyId);
  ok('wrapDashboardInAnalysis succeeds', wrapped.ok === true);
  if (!wrapped.ok) throw new Error('wrap failed — nothing after this can be checked');
  ok('the wrap reports created:true the first time', wrapped.created === true);
  const wrapAnalysis = wrapped.analysis;

  ok('the analysis takes the dashboard name', wrapAnalysis.name === 'Legacy standalone');
  ok('EVERY page becomes a sheet', wrapAnalysis.sheets.length === 2);
  ok('sheet names survive', wrapAnalysis.sheets[0].name === 'Overview' && wrapAnalysis.sheets[1].name === 'Detail');
  ok('sheet ids survive', wrapAnalysis.sheets[0].id === '13131313-1313-4131-8131-131313131313');
  ok('card ids survive the wrap', wrapAnalysis.sheets[0].cards[0].id === '14141414-1414-4141-8141-141414141414');
  ok('the visual card survives with its visualId', wrapAnalysis.sheets[0].cards[0].visualId === VISUAL_ID);
  const wrappedMetric = wrapAnalysis.sheets[0].cards[1];
  ok('the metric card survives whole',
    wrappedMetric.metric !== undefined && wrappedMetric.metric.datasetId === DATASET_ID
    && wrappedMetric.metric.column === 'pop' && wrappedMetric.metric.aggregation === 'avg'
    && wrappedMetric.metric.label === 'Mean pop' && wrappedMetric.metric.format === 'compact');
  ok('the text card survives whole',
    wrapAnalysis.sheets[1].cards[0].heading === 'Notes' && wrapAnalysis.sheets[1].cards[0].text === 'Legacy note.');
  ok('card layouts survive', wrapAnalysis.sheets[0].cards[0].layout.w === 6 && wrapAnalysis.sheets[0].cards[0].layout.h === 6);
  ok('dashboard filters become analysis filters',
    wrapAnalysis.filters.length === 1 && wrapAnalysis.filters[0].column === 'year' && wrapAnalysis.filters[0].value === 2024);
  ok('the source dashboard is recorded as published provenance',
    wrapAnalysis.publishedDashboardIds.length === 1 && wrapAnalysis.publishedDashboardIds[0] === legacyId);
  ok('lastPublishedAt is the dashboard updatedAt', wrapAnalysis.lastPublishedAt === '2026-01-05T00:00:00.000Z');
  ok('exactly ONE analysis was created by the wrap',
    (await analysis.listAnalyses(proj.id)).length === analysesBefore + 1);

  // 13c. The ORDER: the analysis exists before the dashboard points at it, so
  // the stamped id must always resolve.
  const stamped = await dashboards.getDashboard(proj.id, legacyId);
  ok('the dashboard is stamped with the analysis id', stamped !== null && stamped.analysisId === wrapAnalysis.id);
  ok('the stamped analysisId RESOLVES to a real analysis',
    stamped !== null && stamped.analysisId !== null && (await analysis.getAnalysis(proj.id, stamped.analysisId)) !== null);
  ok('the dashboard is stamped with publishedAt', stamped !== null && stamped.publishedAt === '2026-01-05T00:00:00.000Z');
  ok('the stamped dashboard is now schemaVersion 3 ON DISK',
    JSON.parse(fs.readFileSync(legacyPath, 'utf8')).schemaVersion === 3);
  ok('the wrap left the dashboard pages untouched',
    stamped !== null && stamped.pages.length === 2 && stamped.pages[0].cards.length === 2);

  // 13d. IDEMPOTENT: a second call returns the SAME analysis, creating nothing.
  const again = await analysesIpc.wrapDashboardInAnalysis(proj.id, legacyId);
  ok('a second wrap succeeds', again.ok === true);
  if (!again.ok) throw new Error('second wrap failed');
  ok('a second wrap reports created:false', again.created === false);
  ok('a second wrap returns the SAME analysis id', again.analysis.id === wrapAnalysis.id);
  ok('a second wrap creates no extra analysis',
    (await analysis.listAnalyses(proj.id)).length === analysesBefore + 1);

  // 13e. The analysis is now INDEPENDENT of the dashboard — editing it must not
  // reach back into the snapshot. (The full publish guarantee is a later phase;
  // this pins the deep copy the wrap makes.)
  await analysis.updateAnalysis(proj.id, wrapAnalysis.id, {
    sheets: [{ id: '13131313-1313-4131-8131-131313131313', name: 'Renamed sheet', cards: [] }],
  });
  const untouched = await dashboards.getDashboard(proj.id, legacyId);
  ok('editing the analysis does NOT change the dashboard pages',
    untouched !== null && untouched.pages.length === 2 && untouched.pages[0].name === 'Overview'
    && untouched.pages[0].cards.length === 2);

  // 13f. Failure modes are graceful, never throws.
  const missingDash = await analysesIpc.wrapDashboardInAnalysis(proj.id, MISSING_UUID);
  ok('wrapping a missing dashboard returns { ok:false }', missingDash.ok === false);
  const traversalWrap = await analysesIpc.wrapDashboardInAnalysis(proj.id, '../SECRET');
  ok('wrapping a traversal dashboard id returns { ok:false }', traversalWrap.ok === false);
  const traversalProject = await analysesIpc.wrapDashboardInAnalysis('..', legacyId);
  ok('wrapping under a traversal projectId returns { ok:false }', traversalProject.ok === false);
  ok('the failed wraps touched no sentinel', fs.existsSync(sentinel) && fs.existsSync(outsideSentinel));

  // 13g. A dashboard stamped with a DELETED analysis re-wraps rather than
  // returning a dangling pointer.
  await analysis.deleteAnalysis(proj.id, wrapAnalysis.id);
  const reWrapped = await analysesIpc.wrapDashboardInAnalysis(proj.id, legacyId);
  ok('a stale analysisId re-wraps instead of dangling', reWrapped.ok === true);
  if (reWrapped.ok) {
    ok('the re-wrap creates a NEW analysis', reWrapped.analysis.id !== wrapAnalysis.id && reWrapped.created === true);
    const reStamped = await dashboards.getDashboard(proj.id, legacyId);
    ok('the dashboard now points at the new analysis',
      reStamped !== null && reStamped.analysisId === reWrapped.analysis.id);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 14. PUBLISH — the snapshot guarantee
  // ════════════════════════════════════════════════════════════════════════════
  const V1 = '77777777-7777-4777-8777-777777777777';
  const V2 = '88888888-8888-4888-8888-888888888888';
  const DS2 = '99999999-9999-4999-8999-999999999999';
  const SHEET1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  const SHEET2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
  const CARD_V1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  const CARD_M = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
  const CARD_T = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
  const CARD_V2 = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4';

  plantVisual(proj.id, V1, { name: 'Population by city' });
  plantVisual(proj.id, V2, { name: 'Revenue by month', datasetId: DS2, chartType: 'line' });

  const sheet1Cards = [
    { id: CARD_V1, type: 'visual', visualId: V1, layout: { x: 0, y: 0, w: 6, h: 6 } },
    { id: CARD_M, type: 'metric', metric: { datasetId: DATASET_ID, column: 'pop', aggregation: 'sum', label: 'Total' }, layout: { x: 6, y: 0, w: 3, h: 2 } },
    { id: CARD_T, type: 'text', heading: 'Notes', text: 'Before publish.', layout: { x: 0, y: 6, w: 12, h: 2 } },
  ];
  const pub = await analysis.saveAnalysis(proj.id, {
    name: 'Publishable',
    sheets: [
      { id: SHEET1, name: 'Overview', cards: sheet1Cards },
      { id: SHEET2, name: 'Detail', cards: [{ id: CARD_V2, type: 'visual', visualId: V2, layout: { x: 0, y: 0, w: 12, h: 6 } }] },
    ],
    filters: [{ type: 'filter', column: 'year', op: '=', value: 2025 }],
  });
  ok('created the analysis to publish', pub !== null);
  if (!pub) throw new Error('could not create the publishable analysis');

  // 14a. Publish.
  const published = await analysesIpc.publishAnalysis(proj.id, pub.id, {});
  ok('publishAnalysis succeeds', published.ok === true);
  if (!published.ok) throw new Error('publish failed — nothing after this can be checked');
  const dash1 = published.dashboard;
  ok('publish reports created:true the first time', published.created === true);
  ok('the published dashboard takes the analysis name', dash1.name === 'Publishable');
  ok('the published dashboard is stamped with analysisId', dash1.analysisId === pub.id);
  ok('the published dashboard is stamped with publishedAt', typeof dash1.publishedAt === 'string' && dash1.publishedAt !== '');
  ok('the published dashboard is schemaVersion 3', dash1.schemaVersion === 3);
  ok('EVERY sheet becomes a page', dash1.pages.length === 2);
  ok('sheet names carry over', dash1.pages[0].name === 'Overview' && dash1.pages[1].name === 'Detail');
  ok('CARD IDS are preserved across publish', dash1.pages[0].cards[0].id === CARD_V1 && dash1.pages[1].cards[0].id === CARD_V2);
  ok('analysis-wide filters are copied by value',
    dash1.filters.length === 1 && dash1.filters[0].column === 'year' && dash1.filters[0].value === 2025);
  ok('the metric card survives publish whole',
    dash1.pages[0].cards[1].metric !== undefined && dash1.pages[0].cards[1].metric.column === 'pop');
  ok('the text card survives publish whole', dash1.pages[0].cards[2].text === 'Before publish.');

  // 14b. DENORMALISATION: the Visual's definition is inline, by value.
  const inlined1 = dash1.pages[0].cards[0];
  const inlined2 = dash1.pages[1].cards[0];
  ok('a published visual card carries an inline visual', inlined1.visual !== undefined);
  ok('a published visual card KEEPS its visualId (republish source)', inlined1.visualId === V1);
  const srcV1 = await visuals.getVisual(proj.id, V1);
  const srcV2 = await visuals.getVisual(proj.id, V2);
  ok('the inlined spec DEEP-EQUALS its source Visual',
    srcV1 !== null && inlined1.visual !== undefined && specOf(inlined1.visual) === specOf(srcV1));
  ok('the second sheet\'s visual is inlined too',
    srcV2 !== null && inlined2.visual !== undefined && specOf(inlined2.visual) === specOf(srcV2));
  ok('the inline spec carries the dataset, encoding, chartType, name, overrides and filters',
    inlined1.visual !== undefined && inlined1.visual.datasetId === DATASET_ID
    && inlined1.visual.name === 'Population by city' && inlined1.visual.chartType === 'column'
    && inlined1.visual.encoding.category === 'city' && inlined1.visual.encoding.values[0].column === 'pop'
    && inlined1.visual.overrides.title === 'Original title'
    && inlined1.visual.filters.length === 1 && inlined1.visual.filters[0].column === 'region');

  // 14c. Provenance on the analysis side.
  const afterPub = await analysis.getAnalysis(proj.id, pub.id);
  ok('the analysis records the published dashboard id',
    afterPub !== null && afterPub.publishedDashboardIds.length === 1 && afterPub.publishedDashboardIds[0] === dash1.id);
  ok('the analysis records lastPublishedAt', afterPub !== null && afterPub.lastPublishedAt === dash1.publishedAt);
  ok('publishing is NOT an analysis content edit (updatedAt is not bumped)',
    afterPub !== null && afterPub.updatedAt === pub.updatedAt);

  // ── 14d. THE GATE: BYTE-IDENTICAL AFTER EVERY EDIT ────────────────────────
  // The comparison is on the FILE'S BYTES, with Object.is over the string. A
  // field-by-field walk can only check the fields somebody thought of.
  const dash1Path = path.join(dashboardsDirOf(proj.id), dash1.id + '.json');
  const publishedBytes = fs.readFileSync(dash1Path, 'utf8');
  const stillIdentical = (): boolean => Object.is(fs.readFileSync(dash1Path, 'utf8'), publishedBytes);
  ok('the published dashboard is on disk', publishedBytes.length > 0);

  // (i) rename a sheet
  let editedSheets: any[] = [
    { id: SHEET1, name: 'RENAMED SHEET', cards: sheet1Cards },
    { id: SHEET2, name: 'Detail', cards: [{ id: CARD_V2, type: 'visual', visualId: V2, layout: { x: 0, y: 0, w: 12, h: 6 } }] },
  ];
  await analysis.updateAnalysis(proj.id, pub.id, { sheets: editedSheets });
  ok('BYTE-IDENTICAL after renaming a sheet', stillIdentical());

  // (ii) move a card, add a card, remove a card
  editedSheets = [
    {
      id: SHEET1,
      name: 'RENAMED SHEET',
      cards: [
        { id: CARD_V1, type: 'visual', visualId: V1, layout: { x: 6, y: 4, w: 6, h: 4 } }, // MOVED + resized
        sheet1Cards[1],                                                                    // metric kept
        { id: 'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5', type: 'text', heading: 'Added', text: 'After publish.', layout: { x: 0, y: 8, w: 12, h: 2 } },
        // the original text card is REMOVED
      ],
    },
    { id: SHEET2, name: 'Detail', cards: [{ id: CARD_V2, type: 'visual', visualId: V2, layout: { x: 0, y: 0, w: 12, h: 6 } }] },
  ];
  await analysis.updateAnalysis(proj.id, pub.id, { sheets: editedSheets });
  ok('BYTE-IDENTICAL after moving, adding and removing cards', stillIdentical());

  // (iii) change the analysis-wide filters
  await analysis.updateAnalysis(proj.id, pub.id, {
    filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }],
  });
  ok('BYTE-IDENTICAL after changing the analysis-wide filters', stillIdentical());

  // (iv) rename the analysis itself
  await analysis.updateAnalysis(proj.id, pub.id, { name: 'Renamed after publish' });
  ok('BYTE-IDENTICAL after renaming the analysis', stillIdentical());

  // (v) EDIT THE REFERENCED VISUAL — the one a reference-by-id would have leaked,
  //     and the reason the inline snapshot exists at all.
  const editedV1 = await visuals.updateVisual(proj.id, V1, {
    name: 'EDITED name',
    chartType: 'pie',
    encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'avg' }] },
    overrides: { title: 'EDITED title', showLegend: false },
    filters: [{ type: 'filter', column: 'year', op: '>=', value: 2000 }],
  });
  ok('the source visual really was edited', editedV1 !== null && editedV1.chartType === 'pie');
  ok('BYTE-IDENTICAL after editing the referenced Visual', stillIdentical());
  const afterVisualEdit = await dashboards.getDashboard(proj.id, dash1.id);
  const frozen = afterVisualEdit !== null ? afterVisualEdit.pages[0].cards[0] : null;
  ok('the published card still reports the OLD chartType',
    frozen !== null && frozen.visual !== undefined && frozen.visual.chartType === 'column');
  ok('the published card still reports the OLD encoding, name and overrides',
    frozen !== null && frozen.visual !== undefined && frozen.visual.encoding.category === 'city'
    && frozen.visual.name === 'Population by city' && frozen.visual.overrides.title === 'Original title');

  // (vi) DELETE the referenced Visual outright.
  ok('the referenced visual is deleted', (await visuals.deleteVisual(proj.id, V1)) === true);
  ok('the source visual is really gone', (await visuals.getVisual(proj.id, V1)) === null);
  ok('BYTE-IDENTICAL after deleting the referenced Visual', stillIdentical());
  const afterVisualDelete = await dashboards.getDashboard(proj.id, dash1.id);
  const orphan = afterVisualDelete !== null ? afterVisualDelete.pages[0].cards[0] : null;
  ok('a published card whose Visual was DELETED still loads', orphan !== null && orphan.visual !== undefined);
  ok('…and still carries everything a render needs (dataset + encoding + chartType)',
    orphan !== null && orphan.visual !== undefined && orphan.visual.datasetId === DATASET_ID
    && orphan.visual.chartType === 'column' && orphan.visual.encoding.values[0].column === 'pop');
  ok('…and its layout is unchanged, so nothing reflows',
    orphan !== null && orphan.layout.x === 0 && orphan.layout.y === 0 && orphan.layout.w === 6 && orphan.layout.h === 6);

  // ── 14e. A PUBLISHED DASHBOARD IS READ-ONLY, ENFORCED IN MAIN ──────────────
  ok('updateDashboard REFUSES a write to a published snapshot',
    (await dashboards.updateDashboard(proj.id, dash1.id, { name: 'hacked', pages: [] })) === null);
  ok('the refused write did not touch one byte', stillIdentical());
  ok('a rename of a published snapshot is refused too',
    (await dashboards.updateDashboard(proj.id, dash1.id, { name: 'hacked' })) === null);
  ok('still byte-identical after the refused rename', stillIdentical());
  // …while a legacy (unpublished) dashboard is still writable exactly as before.
  const standalone = await dashboards.saveDashboard(proj.id, { name: 'Standalone', pages: [] });
  ok('an UNPUBLISHED dashboard is still writable',
    standalone !== null && (await dashboards.updateDashboard(proj.id, standalone.id, { name: 'Renamed fine' })) !== null);

  // ── 14f. REPUBLISH updates the same dashboard ─────────────────────────────
  await new Promise((r) => setTimeout(r, 5));
  const re = await analysesIpc.publishAnalysis(proj.id, pub.id, { dashboardId: dash1.id });
  ok('republish succeeds', re.ok === true);
  if (!re.ok) throw new Error('republish failed');
  ok('republish targets the SAME dashboard id', re.dashboard.id === dash1.id);
  ok('republish reports created:false', re.created === false);
  ok('republish DOES change the file', !stillIdentical());
  ok('republish keeps the dashboard name when none is given', re.dashboard.name === 'Publishable');
  ok('republish picks up the renamed sheet', re.dashboard.pages[0].name === 'RENAMED SHEET');
  ok('republish picks up the added card and the removal', re.dashboard.pages[0].cards.length === 3
    && re.dashboard.pages[0].cards[2].text === 'After publish.');
  ok('republish picks up the moved card layout', re.dashboard.pages[0].cards[0].layout.x === 6);
  ok('republish picks up the new analysis-wide filters',
    re.dashboard.filters.length === 1 && re.dashboard.filters[0].column === 'region');
  ok('republish bumps publishedAt', re.dashboard.publishedAt !== dash1.publishedAt);
  ok('a card whose Visual is GONE republishes as visualId-only (placeholder, no reflow)',
    re.dashboard.pages[0].cards[0].visual === undefined && re.dashboard.pages[0].cards[0].visualId === V1
    && re.dashboard.pages[0].cards[0].layout.w === 6);
  ok('a card whose Visual still exists is re-inlined',
    srcV2 !== null && re.dashboard.pages[1].cards[0].visual !== undefined
    && specOf(re.dashboard.pages[1].cards[0].visual) === specOf(srcV2));
  const provAfterRe = await analysis.getAnalysis(proj.id, pub.id);
  ok('republish does not add a second provenance id',
    provAfterRe !== null && provAfterRe.publishedDashboardIds.length === 1);

  // A dashboardId that is NOT in this analysis's provenance is refused: it
  // publishes a NEW dashboard rather than overwriting someone else's.
  const foreignPath = standalone !== null ? path.join(dashboardsDirOf(proj.id), standalone.id + '.json') : '';
  const foreignBytes = foreignPath ? fs.readFileSync(foreignPath, 'utf8') : '';
  const hijack = await analysesIpc.publishAnalysis(proj.id, pub.id, { dashboardId: standalone !== null ? standalone.id : MISSING_UUID });
  ok('publishing at a FOREIGN dashboardId does not overwrite it',
    hijack.ok === true && Object.is(fs.readFileSync(foreignPath, 'utf8'), foreignBytes));
  ok('…it publishes a new dashboard instead',
    hijack.ok === true && standalone !== null && hijack.dashboard.id !== standalone.id && hijack.created === true);
  const dash2Id = hijack.ok ? hijack.dashboard.id : '';

  // ── 14g. publishedDashboardIds PRUNES on write ────────────────────────────
  const beforePrune = await analysis.getAnalysis(proj.id, pub.id);
  ok('both published dashboards are recorded',
    beforePrune !== null && beforePrune.publishedDashboardIds.length === 2
    && beforePrune.publishedDashboardIds.indexOf(dash1.id) === 0
    && beforePrune.publishedDashboardIds.indexOf(dash2Id) === 1);
  ok('the first published dashboard is deleted', (await dashboards.deleteDashboard(proj.id, dash1.id)) === true);
  const afterPrune = await analysesIpc.publishAnalysis(proj.id, pub.id, {});
  ok('a publish after a dashboard was deleted succeeds', afterPrune.ok === true);
  const pruned = await analysis.getAnalysis(proj.id, pub.id);
  ok('the DELETED dashboard id is pruned on publish',
    pruned !== null && !pruned.publishedDashboardIds.includes(dash1.id));
  ok('the live ids survive the prune',
    pruned !== null && pruned.publishedDashboardIds.length === 2 && pruned.publishedDashboardIds[0] === dash2Id);

  // ── 14h. failure modes are graceful, never throw ──────────────────────────
  ok('publishing a missing analysis returns { ok:false }',
    (await analysesIpc.publishAnalysis(proj.id, MISSING_UUID, {})).ok === false);
  ok('publishing under a traversal projectId returns { ok:false }',
    (await analysesIpc.publishAnalysis('..', pub.id, {})).ok === false);
  ok('publishing a traversal analysis id returns { ok:false }',
    (await analysesIpc.publishAnalysis(proj.id, '../SECRET', {})).ok === false);
  ok('the failed publishes touched no sentinel', fs.existsSync(sentinel) && fs.existsSync(outsideSentinel));

  // ── 14i. sanitizeCard: the TWO-SHAPED visual card ─────────────────────────
  const shapes = await analysis.saveAnalysis(proj.id, {
    name: 'Card shapes',
    sheets: [{ id: MISSING_UUID, name: 'S', cards: [
      { type: 'visual', layout: {} },                                              // neither → dropped
      { type: 'visual', visual: { name: 'no dataset' }, layout: {} },              // inline w/o datasetId → dropped
      { type: 'visual', visual: 'not-an-object', layout: {} },                     // garbage inline → dropped
      { type: 'visual', visualId: 'not-a-uuid', layout: {} },                      // bad ref, no inline → dropped
      { type: 'visual', visualId: 'not-a-uuid', visual: { datasetId: DATASET_ID, chartType: 'bar' }, layout: { x: 0, y: 0, w: 4, h: 4 } }, // inline alone is enough
      { type: 'visual', visualId: VISUAL_ID, visual: { datasetId: DATASET_ID, chartType: 'evil', encoding: { category: 'c', values: [{ column: 'v', aggregation: 'BOGUS' }] }, overrides: { legendPosition: 'nowhere', apiKey: 'SECRET-abc' }, filters: [{ type: 'group_aggregate' }, { type: 'filter', column: 'a', op: '=', value: 1 }] }, layout: { x: 4, y: 0, w: 4, h: 4 } },
    ] }],
  });
  const shaped = shapes !== null ? shapes.sheets[0].cards : [];
  ok('a visual card with NEITHER a ref nor an inline spec is dropped', shaped.length === 2);
  ok('an inline spec ALONE keeps the card (no valid visualId needed)',
    shaped[0] !== undefined && shaped[0].visualId === undefined && shaped[0].visual !== undefined
    && shaped[0].visual.datasetId === DATASET_ID);
  const hardened = shaped[1];
  ok('the inline spec is re-sanitized on load by the REAL visuals.ts whitelist',
    hardened !== undefined && hardened.visual !== undefined
    && hardened.visual.encoding.values[0].aggregation === 'sum'      // bad agg clamped
    && hardened.visual.overrides.legendPosition === undefined        // bad enum dropped
    && !('apiKey' in hardened.visual.overrides)                      // unknown key dropped
    && hardened.visual.filters.length === 1);                        // non-filter step dropped
  ok('sanitizeCardVisual rejects a spec with no datasetId', dashboards.sanitizeCardVisual({ name: 'x' }) === null);
  ok('sanitizeCardVisual rejects a non-object', dashboards.sanitizeCardVisual('nope') === null
    && dashboards.sanitizeCardVisual(null) === null);

  // ── 14j. EXPORT still produces a complete, self-sufficient, secret-free
  //         bundle from an inline-visual card ───────────────────────────────
  // The export builder (renderer/hub/dashboards.ts buildVisualExportCard) reads
  // datasetId/encoding/chartType/name/overrides/filters off the resolved visual
  // — all six of which the inline snapshot carries, which is what "self-
  //   sufficient" means here. sanitizeBundle is the SECURITY CONTROL and is
  // exercised for real, with a sentinel planted in the card.
  const liveCard = re.dashboard.pages[1].cards[0];
  ok('an inline card supplies every field the export builder reads',
    liveCard.visual !== undefined && typeof liveCard.visual.datasetId === 'string' && liveCard.visual.datasetId !== ''
    && typeof liveCard.visual.chartType === 'string' && typeof liveCard.visual.name === 'string'
    && liveCard.visual.encoding !== undefined && liveCard.visual.overrides !== undefined
    && Array.isArray(liveCard.visual.filters));
  const EXPORT_SECRET = 'SECRET-apiKey-abc123XYZ';
  const exportHtml = dashboardExport.buildSelfContainedHtml({
    name: re.dashboard.name,
    pages: [{
      name: re.dashboard.pages[1].name,
      cards: [
        {
          kind: 'chart',
          layout: liveCard.layout,
          chartType: 'line',
          title: liveCard.visual !== undefined ? liveCard.visual.name : '',
          data: { labels: ['Jan', 'Feb'], series: [{ label: 'Revenue', values: [10, 20] }] },
          // the whole inline snapshot smuggled onto the card → must be dropped
          visual: liveCard.visual,
          apiKey: EXPORT_SECRET,
          logo: 'https://example.com/logo.png',
        },
        { kind: 'image', layout: { x: 0, y: 6, w: 6, h: 4 }, png: 'data:image/png;base64,iVBORw0KGgo=' },
        { kind: 'image', layout: { x: 6, y: 6, w: 6, h: 4 }, png: 'https://example.com/evil.png' },
      ],
    }],
  }, 'window.Chart=function(){};/*FAKE-UMD*/');
  ok('the export from an inline card inlines the chart data',
    exportHtml.includes('"Revenue"') && exportHtml.includes('FAKE-UMD'));
  ok('the export carries the inline card TITLE (from the frozen name)',
    exportHtml.includes('Revenue by month'));
  ok('the export leaks NO secret from an inline-visual card', !exportHtml.includes(EXPORT_SECRET));
  ok('the export drops the smuggled inline visual spec (datasetId never ships)',
    !exportHtml.includes(DS2));
  ok('the export references NO http(s) URL (the https PNG is dropped)', !/https?:\/\//i.test(exportHtml));
  ok('the export keeps only the data:image PNG', exportHtml.includes('data:image/png;base64,iVBORw0KGgo='));

  // ── 14k. THE NO-RESOLVE PROOF ─────────────────────────────────────────────
  // `dashboard:explainAnomalies` is the one main-process consumer that walks a
  // dashboard's visual cards to find their datasets. On a PUBLISHED card the
  // dataset id is inline, and resolving `visualId` instead would silently make
  // the snapshot follow a Visual it no longer follows. This drives the REAL
  // handler (captured off the ipcMain stub) with a spy on visuals.getVisual —
  // the same discipline test-metricRewire uses to prove a table was never
  // hydrated: a fast/frozen path that quietly stops firing fails loudly instead
  // of passing green and inert. No model is configured, and none is needed:
  // the referenced datasets do not exist, so the handler returns an empty list
  // without ever calling one.
  const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
  dashIpc.register();
  const explain = ipcHandlers.get('dashboard:explainAnomalies');
  ok('captured the real dashboard:explainAnomalies handler', explain !== undefined);

  const inlineOnly = await analysis.saveAnalysis(proj.id, {
    name: 'Inline only',
    sheets: [{ id: SHEET2, name: 'S', cards: [{ id: CARD_V2, type: 'visual', visualId: V2, layout: { x: 0, y: 0, w: 6, h: 6 } }] }],
  });
  const pubInline = inlineOnly !== null ? await analysesIpc.publishAnalysis(proj.id, inlineOnly.id, {}) : { ok: false as const, error: 'x' };
  ok('published an all-inline dashboard for the spy', pubInline.ok === true);

  const realGetVisual = visuals.getVisual;
  let getVisualCalls = 0;
  (visuals as any).getVisual = (...args: [string, string]) => { getVisualCalls++; return realGetVisual(...args); };
  try {
    if (explain && pubInline.ok) {
      const r = await explain({}, { projectId: proj.id, id: pubInline.dashboard.id });
      ok('explainAnomalies answers on a published dashboard with no model configured', r && r.ok === true);
      ok('the anomalies walk NEVER resolves visualId on an inlined card (0 getVisual calls)', getVisualCalls === 0);
      // …and the legacy shape still resolves, because it has no inline spec.
      await explain({}, { projectId: proj.id, id: legacyId });
      ok('…and it STILL resolves visualId for a legacy visualId-only card', getVisualCalls === 1);
    }
  } finally {
    (visuals as any).getVisual = realGetVisual;
  }
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' analysis check(s) FAILED'); process.exit(1); }
    console.log('\nAll analysis checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
