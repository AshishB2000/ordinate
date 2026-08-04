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

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-analysis-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    // ipcMain/net are present but inert — register() is never called here.
    return {
      app: { getPath: (_name: string) => tmpUserData },
      ipcMain: { handle: () => {} },
      net: {},
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const analysis: typeof import('../src/analysis') = require('../src/analysis');
const dashboards: typeof import('../src/dashboards') = require('../src/dashboards');
const projects: typeof import('../src/projects') = require('../src/projects');
const analysesIpc: typeof import('../src/ipc/analyses') = require('../src/ipc/analyses');

let failures = 0;
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else { console.error('FAIL ' + label + (extra ? '  ' + extra : '')); failures++; }
}

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';
const VISUAL_ID = '22222222-2222-4222-8222-222222222222';
const DATASET_ID = '33333333-3333-4333-8333-333333333333';

function analysesDirOf(projectId: string): string {
  return path.join(tmpUserData, 'projects', projectId, 'analyses');
}
function dashboardsDirOf(projectId: string): string {
  return path.join(tmpUserData, 'projects', projectId, 'dashboards');
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
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' analysis check(s) FAILED'); process.exit(1); }
    console.log('\nAll analysis checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
