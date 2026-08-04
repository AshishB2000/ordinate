// Self-check for src/dashboards.ts disk persistence (save/list/get/update/delete)
// plus the dual-UUID traversal guard, the save-time parent-project check, and the
// defensive page/card/layout sanitizers. Like test-visuals.ts, we stub the
// 'electron' module (via Module._load) to point userData at a fresh temp dir, then
// exercise the REAL dashboards + projects modules against real disk. No framework.

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-dashboards-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const dashboards: typeof import('../src/dashboards') = require('../src/dashboards');
const projects: typeof import('../src/projects') = require('../src/projects');

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';
const VISUAL_ID = '22222222-2222-4222-8222-222222222222';
const DATASET_ID = '33333333-3333-4333-8333-333333333333';

async function main(): Promise<void> {
  await projects.init();
  await dashboards.init(); // no-op stub

  const proj = await projects.createProject('Dash project');
  ok('created a parent project', typeof proj.id === 'string' && proj.id.length > 0);

  ok('GRID_COLS is exported as 12', dashboards.GRID_COLS === 12);

  // Empty to start.
  let list = await dashboards.listDashboards(proj.id);
  ok('listDashboards is empty initially', Array.isArray(list) && list.length === 0);

  // ── save + round-trip ──────────────────────────────────────────────────────
  const pages = [
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
  const a = await dashboards.saveDashboard(proj.id, { name: '  Q3 board  ', pages });
  ok('saveDashboard returns a dashboard', a !== null && typeof a.id === 'string' && a.id.length > 0);
  ok('saveDashboard trims the name', a !== null && a.name === 'Q3 board');
  ok('saveDashboard sets projectId', a !== null && a.projectId === proj.id);
  ok('saveDashboard sets schemaVersion 3', a !== null && a.schemaVersion === 3);
  ok('saveDashboard defaults analysisId to null', a !== null && a.analysisId === null);
  ok('saveDashboard defaults publishedAt to null', a !== null && a.publishedAt === null);
  ok('saveDashboard defaults filters to [] when none supplied', a !== null && Array.isArray(a.filters) && a.filters.length === 0);
  ok('saveDashboard sets createdAt === updatedAt', a !== null && a.createdAt === a.updatedAt);
  ok('saveDashboard keeps the one page', a !== null && a.pages.length === 1);
  ok('saveDashboard trims a page name', a !== null && a.pages[0].name === 'Overview');
  ok('saveDashboard keeps all three well-formed cards', a !== null && a.pages[0].cards.length === 3);
  ok('dashboard file written to disk',
    a !== null && fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'dashboards', a.id + '.json')));

  // ── pages/cards persist + reload ────────────────────────────────────────────
  const gotA = a !== null ? await dashboards.getDashboard(proj.id, a.id) : null;
  ok('getDashboard round-trips', gotA !== null && a !== null && gotA.id === a.id);
  ok('reload preserves the page name', gotA !== null && gotA.pages[0].name === 'Overview');
  ok('reload preserves card count', gotA !== null && gotA.pages[0].cards.length === 3);
  const visualCard = gotA ? gotA.pages[0].cards.find((c) => c.type === 'visual') : undefined;
  const metricCard = gotA ? gotA.pages[0].cards.find((c) => c.type === 'metric') : undefined;
  const textCard = gotA ? gotA.pages[0].cards.find((c) => c.type === 'text') : undefined;
  ok('reload preserves the visual card visualId', visualCard !== undefined && visualCard.visualId === VISUAL_ID);
  ok('reload preserves the metric spec', metricCard !== undefined && metricCard.metric !== undefined
    && metricCard.metric.datasetId === DATASET_ID && metricCard.metric.column === 'pop'
    && metricCard.metric.aggregation === 'sum' && metricCard.metric.label === 'Total');
  ok('reload preserves the text card', textCard !== undefined && textCard.heading === 'Notes' && textCard.text === 'A note.');
  ok('reload preserves a card layout', textCard !== undefined && textCard.layout.x === 0 && textCard.layout.w === 12 && textCard.layout.h === 2);
  ok('getDashboard returns null for a missing uuid', (await dashboards.getDashboard(proj.id, MISSING_UUID)) === null);

  // ── layout clamping on save ──────────────────────────────────────────────────
  const overflow = await dashboards.saveDashboard(proj.id, {
    name: 'Clamp test',
    pages: [{ id: MISSING_UUID, name: 'P', cards: [
      { type: 'text', text: 'x', layout: { x: 10, y: -3, w: 8, h: 0 } }, // x+w>12 → w shrinks to 2; y<0→0; h<1→1
    ] }],
  });
  const clampCard = overflow !== null ? overflow.pages[0].cards[0] : null;
  ok('sanitizeLayout shrinks overflowing width (x+w≤12)', clampCard !== null && clampCard.layout.x === 10 && clampCard.layout.w === 2);
  ok('sanitizeLayout clamps negative y to 0', clampCard !== null && clampCard.layout.y === 0);
  ok('sanitizeLayout clamps h<1 to 1', clampCard !== null && clampCard.layout.h === 1);

  // ── list — newest-updated first ──────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 5));
  const b = await dashboards.saveDashboard(proj.id, { name: 'Board B' });
  ok('second saveDashboard returns a dashboard', b !== null);
  ok('saveDashboard with no pages gets one default page', b !== null && b.pages.length === 1 && b.pages[0].name === 'Page 1');
  list = await dashboards.listDashboards(proj.id);
  ok('listDashboards returns all three', list.length === 3);
  ok('listDashboards is newest-updated first', b !== null && list[0].id === b.id);
  ok('summary carries pageCount', typeof list[0].pageCount === 'number' && list[0].pageCount === 1);

  // ── update ────────────────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 5));
  const upd = a !== null ? await dashboards.updateDashboard(proj.id, a.id, {
    name: 'Q3 renamed',
    pages: [
      { id: '44444444-4444-4444-4444-444444444444', name: 'Overview', cards: [] },
      { id: '66666666-6666-4666-8666-666666666666', name: 'Detail', cards: [] },
    ],
  }) : null;
  ok('updateDashboard returns the updated dashboard', upd !== null);
  ok('updateDashboard applies the new name', upd !== null && upd.name === 'Q3 renamed');
  ok('updateDashboard replaces the pages array', upd !== null && upd.pages.length === 2 && upd.pages[1].name === 'Detail');
  ok('updateDashboard bumps updatedAt past createdAt',
    upd !== null && a !== null && new Date(upd.updatedAt).getTime() > new Date(a.createdAt).getTime());
  const reUpd = a !== null ? await dashboards.getDashboard(proj.id, a.id) : null;
  ok('update survives a reload', reUpd !== null && reUpd.pages.length === 2);
  const keepName = a !== null ? await dashboards.updateDashboard(proj.id, a.id, { pages: [] }) : null;
  ok('updateDashboard keeps the name when only pages patched', keepName !== null && keepName.name === 'Q3 renamed');
  ok('updateDashboard with empty pages → one default page', keepName !== null && keepName.pages.length === 1);
  ok('updateDashboard of a missing uuid → null', (await dashboards.updateDashboard(proj.id, MISSING_UUID, { name: 'x' })) === null);

  // ── sanitize drops garbage cards ─────────────────────────────────────────────
  const garbage = await dashboards.saveDashboard(proj.id, {
    name: 'Garbage',
    pages: [{ id: MISSING_UUID, name: 'G', cards: [
      { type: 'bogus', layout: { x: 0, y: 0, w: 2, h: 2 } },            // unknown type → dropped
      { type: 'visual', layout: { x: 0, y: 0, w: 2, h: 2 } },           // visual w/o visualId → dropped
      { type: 'visual', visualId: 'not-a-uuid', layout: {} },           // bad visualId → dropped
      { type: 'metric', metric: { column: 'x', aggregation: 'sum' }, layout: {} }, // no datasetId → dropped
      { type: 'metric', metric: { datasetId: DATASET_ID, column: 'x', aggregation: 'median' }, layout: {} }, // bad agg → dropped
      { type: 'text', layout: {} },                                     // no heading/text → dropped
      'not-an-object',                                                  // non-object → dropped
      null,                                                             // null → dropped
      { type: 'text', text: 'keep me', layout: { x: 0, y: 0, w: 4, h: 1 } }, // the ONE valid card
    ] }],
  });
  ok('sanitize drops every garbage card, keeps the one valid card',
    garbage !== null && garbage.pages[0].cards.length === 1 && garbage.pages[0].cards[0].text === 'keep me');
  ok('a kept card gets a generated UUID id when missing',
    garbage !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(garbage.pages[0].cards[0].id));

  // ── Week 10: dashboard-wide filters persist + reload + sanitize ──────────────
  const withFilters = await dashboards.saveDashboard(proj.id, {
    name: 'Filtered board',
    pages: [{ id: MISSING_UUID, name: 'P', cards: [] }],
    filters: [
      { type: 'filter', column: 'region', op: '=', value: 'West' },
      { type: 'filter', column: 'pop', op: '>=', value: 100 },
      // non-filter transform step → dropped (dashboard filters are row predicates only)
      { type: 'group_aggregate', groupBy: ['region'], aggregations: [] },
      { type: 'filter', column: 'x', op: 'bogus_op' },            // bad op → dropped
      'not-an-object',                                            // junk → dropped
    ] as any,
  });
  ok('saveDashboard persists dashboard filters (filter-only)',
    withFilters !== null && withFilters.filters.length === 2);
  ok('saveDashboard drops non-filter transform steps from filters',
    withFilters !== null && withFilters.filters.every((f) => f.type === 'filter'));
  ok('saveDashboard keeps the filter column/op/value verbatim',
    withFilters !== null && withFilters.filters[0].column === 'region'
    && withFilters.filters[0].op === '=' && withFilters.filters[0].value === 'West'
    && withFilters.filters[1].column === 'pop' && withFilters.filters[1].op === '>=' && withFilters.filters[1].value === 100);
  ok('saveDashboard with filters is schemaVersion 3', withFilters !== null && withFilters.schemaVersion === 3);

  const reFiltered = withFilters !== null ? await dashboards.getDashboard(proj.id, withFilters.id) : null;
  ok('dashboard filters survive a reload',
    reFiltered !== null && reFiltered.filters.length === 2
    && reFiltered.filters[0].column === 'region' && reFiltered.filters[1].value === 100);

  // updateDashboard: patch filters, and leave them untouched when the patch omits them.
  const updFilters = withFilters !== null ? await dashboards.updateDashboard(proj.id, withFilters.id, {
    filters: [{ type: 'filter', column: 'year', op: '=', value: 2024 }],
  }) : null;
  ok('updateDashboard replaces the filters array', updFilters !== null && updFilters.filters.length === 1 && updFilters.filters[0].column === 'year');
  const updNoFilters = withFilters !== null ? await dashboards.updateDashboard(proj.id, withFilters.id, { name: 'Renamed only' }) : null;
  ok('updateDashboard keeps existing filters when the patch omits them',
    updNoFilters !== null && updNoFilters.filters.length === 1 && updNoFilters.filters[0].column === 'year');

  // Backward-compat: a v1 dashboard.json (no `filters`, schemaVersion 1) loads as
  // filters:[] and schemaVersion 3, rendering identically to Week 9.
  const v1Id = '77777777-7777-4777-8777-777777777777';
  const v1Path = path.join(tmpUserData, 'projects', proj.id, 'dashboards', v1Id + '.json');
  fs.writeFileSync(v1Path, JSON.stringify({
    id: v1Id, projectId: proj.id, name: 'Legacy v1', schemaVersion: 1,
    pages: [{ id: MISSING_UUID, name: 'Legacy', cards: [] }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  const v1Loaded = await dashboards.getDashboard(proj.id, v1Id);
  ok('v1 dashboard (no filters) loads as filters:[]', v1Loaded !== null && Array.isArray(v1Loaded.filters) && v1Loaded.filters.length === 0);
  ok('v1 dashboard is upgraded to schemaVersion 3 on load', v1Loaded !== null && v1Loaded.schemaVersion === 3);

  // ── A READ MUST STAY A READ (the property the analysis wrap rests on) ────────
  // A v2 record (filters present, no analysisId/publishedAt) plants on disk and
  // is read back through get AND list. Both must report the v3 defaults IN
  // MEMORY and leave the BYTES ON DISK untouched — the implicit-analysis wrap is
  // triggered by an EDIT, so if a read silently rewrote the file the whole lazy
  // design would be a fiction.
  const v2Id = '88888888-8888-4888-8888-888888888888';
  const v2Path = path.join(tmpUserData, 'projects', proj.id, 'dashboards', v2Id + '.json');
  const v2Bytes = JSON.stringify({
    id: v2Id, projectId: proj.id, name: 'Legacy v2', schemaVersion: 2,
    pages: [{ id: '99999999-9999-4999-8999-999999999999', name: 'Legacy', cards: [] }],
    filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }, null, 2);
  fs.writeFileSync(v2Path, v2Bytes, 'utf8');
  const v2Loaded = await dashboards.getDashboard(proj.id, v2Id);
  ok('v2 dashboard loads', v2Loaded !== null && v2Loaded.name === 'Legacy v2');
  ok('v2 dashboard reads analysisId as null', v2Loaded !== null && v2Loaded.analysisId === null);
  ok('v2 dashboard reads publishedAt as null', v2Loaded !== null && v2Loaded.publishedAt === null);
  ok('v2 dashboard is upgraded to schemaVersion 3 in memory', v2Loaded !== null && v2Loaded.schemaVersion === 3);
  ok('v2 dashboard keeps its filters', v2Loaded !== null && v2Loaded.filters.length === 1 && v2Loaded.filters[0].column === 'region');
  await dashboards.listDashboards(proj.id);
  ok('getDashboard + listDashboards did NOT rewrite the v2 file (bytes identical)',
    fs.readFileSync(v2Path, 'utf8') === v2Bytes);
  const stillV2 = JSON.parse(fs.readFileSync(v2Path, 'utf8'));
  ok('the v2 file on disk is still schemaVersion 2', stillV2.schemaVersion === 2);
  ok('the v2 file on disk still has no analysisId', stillV2.analysisId === undefined);

  // ── ATOMIC WRITE: no .tmp sibling survives a successful write ────────────────
  // src/dashboards.ts writes a temp sibling then renames. Nothing asserted the
  // temp file was gone afterwards, so a rename that silently degraded to a copy
  // would leave litter in the project folder unnoticed.
  const dashDir = path.join(tmpUserData, 'projects', proj.id, 'dashboards');
  const strays = fs.readdirSync(dashDir).filter((f) => f.includes('.tmp'));
  ok('no .tmp sibling survives a successful dashboard write', strays.length === 0);

  // ── CORRUPT FILE IS SKIPPED, NOT FATAL ──────────────────────────────────────
  // The filename guard was tested; the JSON-parse guard was not. A UUID-named
  // file full of garbage must be skipped and the good dashboards still returned.
  const corruptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  fs.writeFileSync(path.join(dashDir, corruptId + '.json'), '{ this is not: json', 'utf8');
  const truncatedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  fs.writeFileSync(path.join(dashDir, truncatedId + '.json'), '{"id":', 'utf8');
  const noIdId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  fs.writeFileSync(path.join(dashDir, noIdId + '.json'), '{"name":"no id here"}', 'utf8');
  const afterCorrupt = await dashboards.listDashboards(proj.id);
  ok('listDashboards survives a corrupt dashboards/*.json',
    Array.isArray(afterCorrupt) && afterCorrupt.length > 0);
  ok('listDashboards skips the corrupt records',
    !afterCorrupt.some((d) => d.id === corruptId || d.id === truncatedId || d.id === noIdId));
  ok('listDashboards still returns the good records',
    b !== null && afterCorrupt.some((d) => d.id === b.id) && afterCorrupt.some((d) => d.id === v2Id));
  ok('getDashboard of a corrupt record returns null (never throws)',
    (await dashboards.getDashboard(proj.id, corruptId)) === null);

  // ── delete ────────────────────────────────────────────────────────────────────
  const del = b !== null ? await dashboards.deleteDashboard(proj.id, b.id) : false;
  ok('deleteDashboard returns true', del === true);
  ok('deleteDashboard removes the file',
    b !== null && !fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'dashboards', b.id + '.json')));
  ok('deleteDashboard of a missing uuid succeeds (force)', (await dashboards.deleteDashboard(proj.id, MISSING_UUID)) === true);

  // ── save rejects a nonexistent parent project ────────────────────────────────
  ok('saveDashboard rejects a nonexistent parent project',
    (await dashboards.saveDashboard(MISSING_UUID, { name: 'x' })) === null);
  ok('saveDashboard rejects a traversal projectId',
    (await dashboards.saveDashboard('..', { name: 'x' })) === null);

  // ── SECURITY: dual-UUID traversal guard ──────────────────────────────────────
  const sentinel = path.join(tmpUserData, 'projects', proj.id, 'SECRET.json');
  fs.writeFileSync(sentinel, 'keep');
  const outsideSentinel = path.join(tmpUserData, 'DO_NOT_DELETE.txt');
  fs.writeFileSync(outsideSentinel, 'keep');

  ok('getDashboard rejects a traversal projectId', (await dashboards.getDashboard('..', a !== null ? a.id : 'x')) === null);
  ok('getDashboard rejects a traversal id', (await dashboards.getDashboard(proj.id, '../SECRET')) === null);
  ok('getDashboard rejects a nested traversal id', (await dashboards.getDashboard(proj.id, '../../etc/passwd')) === null);
  ok('updateDashboard rejects a traversal projectId', (await dashboards.updateDashboard('..', a !== null ? a.id : 'x', { name: 'x' })) === null);
  ok('updateDashboard rejects a traversal id', (await dashboards.updateDashboard(proj.id, '../SECRET', { name: 'x' })) === null);
  ok('deleteDashboard rejects a traversal projectId', (await dashboards.deleteDashboard('..', 'x')) === false);
  ok('deleteDashboard rejects a traversal id', (await dashboards.deleteDashboard(proj.id, '../SECRET')) === false);
  ok('deleteDashboard rejects a nested traversal id', (await dashboards.deleteDashboard(proj.id, '../../DO_NOT_DELETE')) === false);
  ok('listDashboards rejects a traversal projectId', (await dashboards.listDashboards('..')).length === 0);

  ok('traversal ops did NOT touch the in-project sentinel', fs.existsSync(sentinel));
  ok('traversal ops did NOT touch files outside projects/', fs.existsSync(outsideSentinel));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' dashboards check(s) FAILED'); process.exit(1); }
    console.log('\nAll dashboards checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
