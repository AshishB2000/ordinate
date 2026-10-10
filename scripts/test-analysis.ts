// Self-check for src/analysis/analysis.ts (the AUTHORING container).
//
// Point userData (ORDINATE_LOCAL_DIR) at a fresh temp dir, then exercise the REAL analysis + projects modules against real
// disk. No framework.
//
// Two properties get more attention than the CRUD, because they are the ones
// the whole design rests on and the ones that fail silently:
//
//   1. A SHEET IS A dashboards.Page. Not a parallel type, not a second
//      sanitiser — an analysis sheet reuses the SAME sanitizeCard/sanitizePage
//      whitelist a dashboard page did, so the garbage-card block here is the
//      canonical coverage for that shared sanitiser (including the two-shaped
//      visual card: a ref, an inline spec, or both).
//   2. THE DUAL-UUID PATH GUARD — an id is a filesystem path here, so a
//      traversal id or projectId must never escape the project's analyses dir.
//      Two sentinel files (one in-project, one outside) prove it.
//
//   npm run build:ts && node scripts/test-analysis.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-analysis-'));

process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the real modules.
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';
const VISUAL_ID = '22222222-2222-4222-8222-222222222222';
const DATASET_ID = '33333333-3333-4333-8333-333333333333';

function analysesDirOf(projectId: string): string {
  return path.join(tmpUserData, 'projects', projectId, 'analyses');
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

  // Click-to-filter: ON, written explicitly, for a NEW dashboard's sheets — unless the caller said otherwise.
  ok('a new analysis writes clickFilter: true on its sheets',
    noSheets !== null && noSheets.sheets[0].clickFilter === true && a !== null && a.sheets.every((s) => s.clickFilter === true));
  const optedOut = await analysis.saveAnalysis(proj.id, { name: 'No click', sheets: [{ name: 'S', cards: [], clickFilter: false }] });
  ok('…and keeps an explicit clickFilter: false', optedOut !== null && optedOut.sheets[0].clickFilter === false);
  if (optedOut) await analysis.deleteAnalysis(proj.id, optedOut.id);

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

  // ── 6. list — newest-updated first, with the summary shape ──────────────────
  await new Promise((r) => setTimeout(r, 5));
  const b = await analysis.saveAnalysis(proj.id, { name: 'Later analysis' });
  list = await analysis.listAnalyses(proj.id);
  ok('listAnalyses returns every saved analysis', list.length === 7, `(${list.length})`);
  ok('listAnalyses is newest-updated first', b !== null && list[0].id === b.id);
  ok('summary carries sheetCount', typeof list[0].sheetCount === 'number' && list[0].sheetCount === 1);

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
  // Negative control for the default above: an UPDATE never turns the switch on for a sheet that lacks it.
  ok('updateAnalysis leaves an absent clickFilter absent',
    reUpd !== null && reUpd.sheets.every((s) => !('clickFilter' in s)));
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
  ok('listAnalyses survives a corrupt analyses/*.json', Array.isArray(afterCorrupt) && afterCorrupt.length === 7,
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

  // ── 13. sanitizeCard through an analysis sheet: the TWO-SHAPED visual card ─
  // The shared dashboards.sanitizeCard whitelist, exercised via saveAnalysis: a
  // visual card may carry a ref (visualId), an inline spec (visual), or both,
  // and the inline spec is re-sanitized on load by the real visuals whitelist.
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

}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    if (failureCount()) { console.error('\n' + failureCount() + ' analysis check(s) FAILED'); process.exit(1); }
    console.log('\nAll analysis checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
