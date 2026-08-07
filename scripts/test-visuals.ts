// Self-check for src/visuals.ts disk persistence (save/list/get/update/delete)
// plus the dual-UUID traversal guard and the save-time dataset existence check.
// Like test-datasets.ts, we stub the 'electron' module (via Module._load) to point
// userData at a fresh temp dir, then exercise the REAL visuals + datasets +
// projects modules against real disk. No framework.

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-visuals-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const visuals: typeof import('../src/visuals') = require('../src/visuals');
const datasets: typeof import('../src/datasets') = require('../src/datasets');
const projects: typeof import('../src/projects') = require('../src/projects');

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

async function main(): Promise<void> {
  await projects.init();
  await visuals.init(); // no-op stub

  const proj = await projects.createProject('Viz project');
  ok('created a parent project', typeof proj.id === 'string' && proj.id.length > 0);

  // A real dataset for visuals to reference.
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Cities',
    sourceKind: 'csv',
    columns: [{ name: 'city', type: 'text' }, { name: 'pop', type: 'number' }],
    rows: [['Paris', 2148327], ['Berlin', 3769495]],
  });
  ok('created a referenced dataset', ds !== null);
  const dsId = ds !== null ? ds.id : '';

  // Empty to start.
  let list = await visuals.listVisuals(proj.id);
  ok('listVisuals is empty initially', Array.isArray(list) && list.length === 0);

  // ── save + round-trip ──────────────────────────────────────────────────────
  const encoding = { category: 'city', values: [{ column: 'pop', aggregation: 'sum' as const }] };
  const a = await visuals.saveVisual(proj.id, { name: '  Population  ', datasetId: dsId, chartType: 'column', encoding });
  ok('saveVisual returns a visual', a !== null && typeof a.id === 'string' && a.id.length > 0);
  ok('saveVisual trims the name', a !== null && a.name === 'Population');
  ok('saveVisual sets projectId', a !== null && a.projectId === proj.id);
  ok('saveVisual sets datasetId', a !== null && a.datasetId === dsId);
  ok('saveVisual sets chartType', a !== null && a.chartType === 'column');
  ok('saveVisual sanitizes the encoding', a !== null && a.encoding.category === 'city' && a.encoding.values.length === 1);
  ok('saveVisual sets schemaVersion 2', a !== null && a.schemaVersion === 2);
  ok('saveVisual defaults overrides to {}', a !== null && JSON.stringify(a.overrides) === '{}');
  ok('saveVisual defaults filters to []', a !== null && Array.isArray(a.filters) && a.filters.length === 0);
  ok('saveVisual sets createdAt === updatedAt', a !== null && a.createdAt === a.updatedAt);
  ok('visual file written to disk',
    a !== null && fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'visuals', a.id + '.json')));

  // get the full visual back.
  const gotA = a !== null ? await visuals.getVisual(proj.id, a.id) : null;
  ok('getVisual returns the full visual', gotA !== null && a !== null && gotA.id === a.id && gotA.encoding.category === 'city');
  ok('getVisual returns null for a missing uuid', (await visuals.getVisual(proj.id, MISSING_UUID)) === null);

  // second visual (later → newer updatedAt).
  await new Promise((r) => setTimeout(r, 5));
  const b = await visuals.saveVisual(proj.id, {
    name: 'By region', datasetId: dsId, chartType: 'pie',
    encoding: { category: 'city', values: [{ column: 'pop', aggregation: 'count' as const }] },
  });
  ok('second saveVisual returns a visual', b !== null);
  ok('visual ids are unique', a !== null && b !== null && a.id !== b.id);

  // list — both, newest-updated first (b first).
  list = await visuals.listVisuals(proj.id);
  ok('listVisuals returns both visuals', list.length === 2);
  ok('listVisuals is newest-updated first', b !== null && list[0].id === b.id && a !== null && list[1].id === a.id);
  ok('summary carries chartType', list[0].chartType === 'pie');
  ok('summary carries datasetId', list[0].datasetId === dsId);

  // ── update ─────────────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 5));
  const upd = a !== null ? await visuals.updateVisual(proj.id, a.id, {
    name: 'Pop (bars)', chartType: 'bar',
    encoding: { category: 'city', values: [{ column: 'pop', aggregation: 'max' as const }] },
  }) : null;
  ok('updateVisual returns the updated visual', upd !== null);
  ok('updateVisual applies the new name', upd !== null && upd.name === 'Pop (bars)');
  ok('updateVisual applies the new chartType', upd !== null && upd.chartType === 'bar');
  ok('updateVisual applies the new encoding', upd !== null && upd.encoding.values[0].aggregation === 'max');
  ok('updateVisual keeps datasetId immutable', upd !== null && upd.datasetId === dsId);
  ok('updateVisual bumps updatedAt past createdAt',
    upd !== null && a !== null && new Date(upd.updatedAt).getTime() > new Date(a.createdAt).getTime());
  const reUpd = a !== null ? await visuals.getVisual(proj.id, a.id) : null;
  ok('update survives a reload', reUpd !== null && reUpd.chartType === 'bar');
  ok('updateVisual of a missing uuid → null', (await visuals.updateVisual(proj.id, MISSING_UUID, { name: 'x' })) === null);

  // ── delete ─────────────────────────────────────────────────────────────────
  const del = b !== null ? await visuals.deleteVisual(proj.id, b.id) : false;
  ok('deleteVisual returns true', del === true);
  ok('deleteVisual removes the file',
    b !== null && !fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'visuals', b.id + '.json')));
  list = await visuals.listVisuals(proj.id);
  ok('listVisuals reflects the deletion', list.length === 1 && a !== null && list[0].id === a.id);
  ok('deleteVisual of a missing uuid succeeds (force)', (await visuals.deleteVisual(proj.id, MISSING_UUID)) === true);

  // ── overrides + filters: sanitize, persist, reload ─────────────────────────
  const ovRaw = {
    title: 'My chart',
    color: null,
    legendPosition: 'top',
    showLegend: 1, // truthy → coerced to true
    numberFormat: 'currency',
    sort: 'sideways', // off the allowed set → dropped
    hiddenSeries: [0, 'x', 2], // non-number dropped
    periodIdx: 3,
    bogusKey: 'nope', // unknown key → dropped
  };
  const filtersRaw = [
    { type: 'filter', column: 'city', op: '=', value: 'Paris' },
    { type: 'group_aggregate', groupBy: ['city'], aggregations: [] }, // non-filter → dropped
    { type: 'filter', column: 'pop', op: 'not-an-op' }, // invalid op → dropped
  ];
  const withOv = await visuals.saveVisual(proj.id, {
    name: 'Styled', datasetId: dsId, chartType: 'column', encoding,
    overrides: ovRaw, filters: filtersRaw,
  });
  ok('saveVisual persists sanitized overrides', withOv !== null
    && withOv.overrides.title === 'My chart'
    && withOv.overrides.color === null
    && withOv.overrides.legendPosition === 'top'
    && withOv.overrides.showLegend === true
    && withOv.overrides.numberFormat === 'currency'
    && withOv.overrides.periodIdx === 3);
  ok('saveVisual clamps an off-list enum (sort dropped)', withOv !== null && withOv.overrides.sort === undefined);
  ok('saveVisual drops unknown override keys', withOv !== null && (withOv.overrides as any).bogusKey === undefined);
  ok('saveVisual coerces hiddenSeries to finite numbers', withOv !== null
    && JSON.stringify(withOv.overrides.hiddenSeries) === JSON.stringify([0, 2]));
  ok('saveVisual keeps only filter steps', withOv !== null
    && withOv.filters.length === 1 && withOv.filters[0].column === 'city' && withOv.filters[0].op === '=');
  const reOv = withOv !== null ? await visuals.getVisual(proj.id, withOv.id) : null;
  ok('overrides survive a reload', reOv !== null && reOv.overrides.title === 'My chart' && reOv.overrides.numberFormat === 'currency');
  ok('filters survive a reload', reOv !== null && reOv.filters.length === 1 && reOv.filters[0].column === 'city');

  // updateVisual threads overrides/filters; omitted → kept.
  const updOv = withOv !== null ? await visuals.updateVisual(proj.id, withOv.id, { overrides: { title: 'Renamed' } }) : null;
  ok('updateVisual replaces overrides when provided', updOv !== null && updOv.overrides.title === 'Renamed' && updOv.overrides.numberFormat === undefined);
  ok('updateVisual keeps filters when omitted', updOv !== null && updOv.filters.length === 1);

  // ── v1 → v2 migration: a legacy file (no overrides/filters) loads as v2 ─────
  {
    const legacyId = '11111111-1111-4111-8111-111111111111';
    const legacyFile = path.join(tmpUserData, 'projects', proj.id, 'visuals', legacyId + '.json');
    const legacy = {
      id: legacyId, projectId: proj.id, name: 'Legacy', datasetId: dsId,
      chartType: 'line', encoding, createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z', schemaVersion: 1,
    };
    fs.writeFileSync(legacyFile, JSON.stringify(legacy));
    const migrated = await visuals.getVisual(proj.id, legacyId);
    ok('v1 file loads with schemaVersion 2', migrated !== null && migrated.schemaVersion === 2);
    ok('v1 file gets empty overrides {}', migrated !== null && JSON.stringify(migrated.overrides) === '{}');
    ok('v1 file gets empty filters []', migrated !== null && Array.isArray(migrated.filters) && migrated.filters.length === 0);
    ok('v1 migration preserves name/chartType/encoding', migrated !== null && migrated.name === 'Legacy' && migrated.chartType === 'line');
  }

  // ── duplicateVisual: independent copy, source untouched ─────────────────────
  const dup = withOv !== null ? await visuals.duplicateVisual(proj.id, withOv.id) : null;
  ok('duplicateVisual returns a copy', dup !== null);
  ok('duplicate has a NEW id', dup !== null && withOv !== null && dup.id !== withOv.id);
  ok('duplicate name gets " (copy)" suffix', dup !== null && dup.name === 'Styled (copy)');
  ok('duplicate copies datasetId/chartType/encoding', dup !== null && withOv !== null
    && dup.datasetId === withOv.datasetId && dup.chartType === withOv.chartType
    && dup.encoding.category === withOv.encoding.category);
  ok('duplicate copies overrides + filters', dup !== null
    && dup.overrides.title === 'Renamed' && dup.filters.length === 1 && dup.filters[0].column === 'city');
  ok('duplicate is schemaVersion 2', dup !== null && dup.schemaVersion === 2);
  // Mutating the copy must not change the source (independent files).
  if (dup !== null) await visuals.updateVisual(proj.id, dup.id, { name: 'Changed copy', overrides: {} });
  const srcAfter = withOv !== null ? await visuals.getVisual(proj.id, withOv.id) : null;
  ok('editing the copy leaves the source untouched', srcAfter !== null && srcAfter.name === 'Styled' && srcAfter.overrides.title === 'Renamed');
  ok('duplicateVisual of a missing uuid → null', (await visuals.duplicateVisual(proj.id, MISSING_UUID)) === null);
  ok('duplicateVisual rejects a traversal id', (await visuals.duplicateVisual(proj.id, '../SECRET')) === null);

  // Clean up the extra visuals so the later count-based checks are unaffected.
  if (withOv !== null) await visuals.deleteVisual(proj.id, withOv.id);
  if (dup !== null) await visuals.deleteVisual(proj.id, dup.id);
  await visuals.deleteVisual(proj.id, '11111111-1111-4111-8111-111111111111');

  // ── save rejects a nonexistent parent project / missing dataset ────────────
  ok('saveVisual rejects a nonexistent parent project',
    (await visuals.saveVisual(MISSING_UUID, { name: 'x', datasetId: dsId, chartType: 'column', encoding })) === null);
  ok('saveVisual rejects a missing dataset',
    (await visuals.saveVisual(proj.id, { name: 'x', datasetId: MISSING_UUID, chartType: 'column', encoding })) === null);
  ok('saveVisual rejects a non-UUID datasetId',
    (await visuals.saveVisual(proj.id, { name: 'x', datasetId: '../SECRET', chartType: 'column', encoding })) === null);

  // ── favorite: back-compat default + the two-key sort ───────────────────────
  // The key was added WITHOUT a schema bump, on the argument that an absent
  // `favorite` already means "not a favourite". That argument only holds if a v2
  // file written before it existed still loads — so write one by hand, with the
  // key physically removed, and read it back.
  const legacyId = a !== null ? a.id : '';
  const legacyPath = path.join(tmpUserData, 'projects', proj.id, 'visuals', legacyId + '.json');
  const legacyRaw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  delete legacyRaw.favorite;
  ok('the hand-written v2 file really has no favorite key', !('favorite' in legacyRaw));
  fs.writeFileSync(legacyPath, JSON.stringify(legacyRaw, null, 2));

  const legacy = await visuals.getVisual(proj.id, legacyId);
  ok('a v2 file with no favorite key loads as favorite:false',
    legacy !== null && legacy.favorite === false);
  ok('…and is still schemaVersion 2 — no migration was needed',
    legacy !== null && legacy.schemaVersion === 2);

  // Sort: favourites first, then updatedAt desc. Favourite the OLDER visual, so
  // "favourites first" and "newest first" DISAGREE — otherwise the assertion
  // would pass under either comparator and prove nothing.
  const newer = await visuals.saveVisual(proj.id, { name: 'Newer', datasetId: dsId, chartType: 'bar', encoding });
  const before = await visuals.listVisuals(proj.id);
  ok('the newer visual sorts first while nothing is favourited',
    before.length === 2 && newer !== null && before[0].id === newer.id);
  const oldest = before[before.length - 1];
  const pinned = await visuals.updateVisual(proj.id, oldest.id, { favorite: true });
  ok('updateVisual accepts favorite in the patch', pinned !== null && pinned.favorite === true);

  let sorted = await visuals.listVisuals(proj.id);
  ok('listVisuals puts favourites first, ahead of newer non-favourites',
    sorted[0].id === oldest.id);
  ok('VisualSummary carries favorite',
    sorted[0].favorite === true && sorted.slice(1).every((s) => s.favorite === false));

  // A patch that OMITS favorite must not clear it — every other write path
  // (rename, the debounced override autosave, a chart-type switch) sends one.
  await visuals.updateVisual(proj.id, oldest.id, { name: 'Renamed while pinned' });
  sorted = await visuals.listVisuals(proj.id);
  ok('a patch without favorite leaves it set',
    sorted[0].id === oldest.id && sorted[0].favorite === true);

  await visuals.updateVisual(proj.id, oldest.id, { favorite: false });
  sorted = await visuals.listVisuals(proj.id);
  ok('unfavouriting drops it back into updatedAt order',
    sorted.every((s) => s.favorite === false));

  // A duplicate of a favourite starts unpinned — otherwise "copy to tweak it"
  // puts two near-identical cards at the top of the gallery.
  await visuals.updateVisual(proj.id, oldest.id, { favorite: true });
  const favDup = await visuals.duplicateVisual(proj.id, oldest.id);
  ok('a duplicate of a favourite is NOT itself a favourite',
    favDup !== null && favDup.favorite === false);

  // Leave the project as the traversal checks below expect to find it.
  if (favDup !== null) await visuals.deleteVisual(proj.id, favDup.id);
  if (newer !== null) await visuals.deleteVisual(proj.id, newer.id);
  await visuals.updateVisual(proj.id, oldest.id, { favorite: false, name: 'Population' });

  // ── SECURITY: dual-UUID traversal guard ────────────────────────────────────
  // Plant a sentinel above the visuals dir and one outside projects/; every op
  // with a traversal id in EITHER position must refuse to touch them.
  const sentinel = path.join(tmpUserData, 'projects', proj.id, 'SECRET.json');
  fs.writeFileSync(sentinel, 'keep');
  const outsideSentinel = path.join(tmpUserData, 'DO_NOT_DELETE.txt');
  fs.writeFileSync(outsideSentinel, 'keep');

  ok('saveVisual rejects a traversal projectId',
    (await visuals.saveVisual('..', { name: 'x', datasetId: dsId, chartType: 'column', encoding })) === null);
  ok('getVisual rejects a traversal projectId', (await visuals.getVisual('..', a !== null ? a.id : 'x')) === null);
  ok('getVisual rejects a traversal id', (await visuals.getVisual(proj.id, '../SECRET')) === null);
  ok('getVisual rejects a nested traversal id', (await visuals.getVisual(proj.id, '../../etc/passwd')) === null);
  ok('updateVisual rejects a traversal projectId', (await visuals.updateVisual('..', a !== null ? a.id : 'x', { name: 'x' })) === null);
  ok('updateVisual rejects a traversal id', (await visuals.updateVisual(proj.id, '../SECRET', { name: 'x' })) === null);
  ok('deleteVisual rejects a traversal projectId', (await visuals.deleteVisual('..', 'x')) === false);
  ok('deleteVisual rejects a traversal id', (await visuals.deleteVisual(proj.id, '../SECRET')) === false);
  ok('deleteVisual rejects a nested traversal id', (await visuals.deleteVisual(proj.id, '../../DO_NOT_DELETE')) === false);
  ok('listVisuals rejects a traversal projectId', (await visuals.listVisuals('..')).length === 0);

  ok('traversal ops did NOT touch the in-project sentinel', fs.existsSync(sentinel));
  ok('traversal ops did NOT touch files outside projects/', fs.existsSync(outsideSentinel));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' visuals check(s) FAILED'); process.exit(1); }
    console.log('\nAll visuals checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
