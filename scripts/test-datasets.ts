// Self-check for src/datasets.ts disk persistence (save/list/get/delete) plus
// the dual-UUID traversal guard. Like test-projects.ts, we stub the 'electron'
// module (via Module._load) to point userData at a fresh temp dir, then exercise
// the REAL datasets + projects modules against real disk. No framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

void assert; // parity with test-projects.ts (asserts done via ok())

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-datasets-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of ../src/datasets.ts + ../src/projects.ts.
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const combine: typeof import('../src/data/combine') = require('../src/data/combine');


async function main(): Promise<void> {
  await projects.init();
  await datasets.init(); // no-op stub

  // A real parent project to hang datasets under.
  const proj = await projects.createProject('Data project');
  ok('created a parent project', typeof proj.id === 'string' && proj.id.length > 0);

  // Empty to start.
  let list = await datasets.listDatasets(proj.id);
  ok('listDatasets is empty initially', Array.isArray(list) && list.length === 0);

  // save.
  const columns = [
    { name: 'city', type: 'text' as const },
    { name: 'pop', type: 'number' as const },
  ];
  const a = await datasets.saveDataset(proj.id, {
    name: '  Cities  ',
    sourceKind: 'csv',
    columns,
    rows: [['Paris', 2148327], ['Berlin', 3769495]],
  });
  ok('saveDataset returns a dataset', a !== null && typeof a.id === 'string' && a.id.length > 0);
  ok('saveDataset trims the name', a !== null && a.name === 'Cities');
  ok('saveDataset sets projectId', a !== null && a.projectId === proj.id);
  ok('saveDataset sets rowCount from rows', a !== null && a.rowCount === 2);
  ok('saveDataset sets sourceKind', a !== null && a.sourceKind === 'csv');
  ok('saveDataset sets schemaVersion 2', a !== null && a.schemaVersion === 2);
  ok('saveDataset sets createdAt === updatedAt', a !== null && a.createdAt === a.updatedAt);
  ok('dataset file written to disk',
    a !== null && fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'datasets', a.id + '.json')));

  // second dataset (created later → newer updatedAt).
  await new Promise((r) => setTimeout(r, 5));
  const b = await datasets.saveDataset(proj.id, {
    name: 'Sales',
    sourceKind: 'json',
    columns: [{ name: 'q', type: 'text' as const }],
    rows: [['x'], ['y'], ['z']],
  });
  ok('second saveDataset returns a dataset', b !== null);
  ok('dataset ids are unique', a !== null && b !== null && a.id !== b.id);

  // list — both, newest-updated first (b last).
  list = await datasets.listDatasets(proj.id);
  ok('listDatasets returns both datasets', list.length === 2);
  ok('listDatasets is newest-updated first', b !== null && list[0].id === b.id && a !== null && list[1].id === a.id);
  ok('summary carries columnCount', list[1].columnCount === 2);
  ok('summary carries rowCount', list[1].rowCount === 2);

  // get.
  const gotA = a !== null ? await datasets.getDataset(proj.id, a.id) : null;
  ok('getDataset returns the full dataset',
    gotA !== null && a !== null && gotA.id === a.id && gotA.rows.length === 2 && gotA.rows[0][0] === 'Paris');
  const gotMissing = await datasets.getDataset(proj.id, '00000000-0000-0000-0000-000000000000');
  ok('getDataset returns null for a missing uuid', gotMissing === null);

  // save under a UUID-shaped but nonexistent project → null (no orphans).
  const orphan = await datasets.saveDataset('00000000-0000-0000-0000-000000000000', {
    name: 'Orphan', sourceKind: 'csv', columns: [], rows: [],
  });
  ok('saveDataset rejects a nonexistent parent project', orphan === null);

  // delete.
  const del = b !== null ? await datasets.deleteDataset(proj.id, b.id) : false;
  ok('deleteDataset returns true', del === true);
  ok('deleteDataset removes the file',
    b !== null && !fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'datasets', b.id + '.json')));
  list = await datasets.listDatasets(proj.id);
  ok('listDatasets reflects the deletion', list.length === 1 && a !== null && list[0].id === a.id);

  // deleting a missing but WELL-FORMED uuid is a no-op success (fs.rm force).
  const delMissing = await datasets.deleteDataset(proj.id, '00000000-0000-0000-0000-000000000000');
  ok('deleteDataset of a missing uuid succeeds (force)', delMissing === true);

  // ── updateDataset: rename + retype-coercion ────────────────────────────────
  const editable = await datasets.saveDataset(proj.id, {
    name: 'Editable',
    sourceKind: 'csv',
    columns: [
      { name: 'name', type: 'text' as const },
      { name: 'amount', type: 'text' as const }, // stored as text: "10","20","oops"
    ],
    rows: [['a', '10'], ['b', '20'], ['c', 'oops']],
  });
  ok('updateDataset: fixture saved', editable !== null);
  const edId = editable !== null ? editable.id : '';

  // rename only (no type change) → name persists, cells untouched.
  await new Promise((r) => setTimeout(r, 5)); // ensure updatedAt can advance
  const renamed = await datasets.updateDataset(proj.id, edId, {
    columns: [
      { name: 'label', type: 'text' as const },
      { name: 'amount', type: 'text' as const },
    ],
  });
  ok('updateDataset: returns the updated dataset', renamed !== null);
  ok('updateDataset: rename persists', renamed !== null && renamed.columns[0].name === 'label');
  ok('updateDataset: rename leaves cells as-is', renamed !== null && renamed.rows[0][1] === '10');
  ok('updateDataset: updatedAt bumps past createdAt',
    renamed !== null && editable !== null &&
    new Date(renamed.updatedAt).getTime() > new Date(editable.createdAt).getTime());
  // persisted to disk (reload).
  const reloaded = await datasets.getDataset(proj.id, edId);
  ok('updateDataset: rename survives a reload', reloaded !== null && reloaded.columns[0].name === 'label');

  // retype text→number: numeric strings coerce to JS numbers, non-numeric → null.
  const retyped = await datasets.updateDataset(proj.id, edId, {
    columns: [
      { name: 'label', type: 'text' as const },
      { name: 'amount', type: 'number' as const },
    ],
  });
  ok('updateDataset: retype sets the new type', retyped !== null && retyped.columns[1].type === 'number');
  ok('updateDataset: retype text→number coerces "10" → 10', retyped !== null && retyped.rows[0][1] === 10);
  ok('updateDataset: retype text→number coerces "20" → 20', retyped !== null && retyped.rows[1][1] === 20);
  ok('updateDataset: retype nulls non-numeric "oops" (no NaN)', retyped !== null && retyped.rows[2][1] === null);

  // IDENTIFIER SAFETY on retype: a leading-zero id column retyped to number must
  // NOT corrupt "007" → 7 (strict isFiniteNumber gate) — it nulls instead.
  const idDs = await datasets.saveDataset(proj.id, {
    name: 'ids', sourceKind: 'csv',
    columns: [{ name: 'code', type: 'text' as const }],
    rows: [['007'], ['012'], ['12345678901234567890']],
  });
  const idRetyped = idDs && await datasets.updateDataset(proj.id, idDs.id, {
    columns: [{ name: 'code', type: 'number' as const }],
  });
  ok('updateDataset: retype does NOT corrupt "007" to 7 (nulls it)', idRetyped !== null && idRetyped.rows[0][0] === null);
  ok('updateDataset: retype does NOT lose precision on a 20-digit id', idRetyped !== null && idRetyped.rows[2][0] === null);

  // retype number→text: digits are kept (lossless back to string).
  const backToText = await datasets.updateDataset(proj.id, edId, {
    columns: [
      { name: 'label', type: 'text' as const },
      { name: 'amount', type: 'text' as const },
    ],
  });
  ok('updateDataset: retype number→text keeps digits', backToText !== null && backToText.rows[0][1] === '10');

  // guards: missing dataset → null; both ids UUID-guarded against traversal.
  ok('updateDataset: missing uuid → null',
    (await datasets.updateDataset(proj.id, '00000000-0000-0000-0000-000000000000', { columns: [] })) === null);
  ok('updateDataset: rejects a traversal projectId',
    (await datasets.updateDataset('..', edId, { columns: [] })) === null);
  ok('updateDataset: rejects a traversal datasetId',
    (await datasets.updateDataset(proj.id, '../SECRET', { columns: [] })) === null);

  // clean up the fixture so the deletion-count assertions below stay valid.
  await datasets.deleteDataset(proj.id, edId);

  // ── Week 6: transform pipeline persistence (updateSteps) ───────────────────
  const prep = await datasets.saveDataset(proj.id, {
    name: 'Prep',
    sourceKind: 'csv',
    columns: [
      { name: 'city', type: 'text' as const },
      { name: 'amount', type: 'number' as const },
    ],
    rows: [['Paris', 10], ['Berlin', 20], ['Paris', 5], ['Berlin', 20]],
  });
  ok('prep fixture saved', prep !== null);
  const prepId = prep !== null ? prep.id : '';
  ok('a fresh dataset has empty steps + no source', prep !== null && Array.isArray(prep.steps) && prep.steps.length === 0 && prep.source === undefined);
  ok('a fresh dataset reads schemaVersion 2', prep !== null && prep.schemaVersion === 2);

  const source = { columns: prep!.columns, rows: prep!.rows };

  // Add a filter step (amount > 5) → derived output matches applyPipeline exactly.
  const stepFilter = { type: 'filter' as const, column: 'amount', op: '>' as const, value: 5 };
  const r1 = await datasets.updateSteps(proj.id, prepId, [stepFilter]);
  ok('updateSteps returns dataset + output', r1 !== null && r1.dataset !== null && r1.output !== null);
  const expect1 = transforms.applyPipeline(source, [stepFilter]);
  ok('updateSteps derived rows match applyPipeline', r1 !== null && JSON.stringify(r1.output.rows) === JSON.stringify(expect1.rows));
  ok('updateSteps persisted rowCount reflects the filter', r1 !== null && r1.dataset.rowCount === 3);
  ok('updateSteps snapshots an immutable source', r1 !== null && r1.dataset.source !== undefined && r1.dataset.source!.rows.length === 4);

  // Reload → derived output survives and still equals applyPipeline(source, steps).
  const reloadedPrep = await datasets.getDataset(proj.id, prepId);
  ok('steps survive a reload', reloadedPrep !== null && reloadedPrep.steps!.length === 1 && reloadedPrep.steps![0].type === 'filter');
  ok('reloaded source survives', reloadedPrep !== null && reloadedPrep.source !== undefined && reloadedPrep.source!.rows.length === 4);
  const recomputed = transforms.applyPipeline(reloadedPrep!.source!, reloadedPrep!.steps!);
  ok('reloaded derived rows match a fresh recompute', reloadedPrep !== null && JSON.stringify(reloadedPrep.rows) === JSON.stringify(recomputed.rows));

  // Add a second step (dedupe) then REMOVE it → output reverts to the filter-only
  // output computed from the untouched source (full reversibility).
  const stepDedupe = { type: 'dedupe' as const };
  const r2 = await datasets.updateSteps(proj.id, prepId, [stepFilter, stepDedupe]);
  ok('two-step output dedupes (Berlin 20 collapses)', r2 !== null && r2.dataset.rowCount === 2);
  const r3 = await datasets.updateSteps(proj.id, prepId, [stepFilter]); // remove the dedupe
  ok('removing a step reverts to the filter-only output', r3 !== null && r3.dataset.rowCount === 3);
  ok('remove-then-recompute equals never-having-added', r3 !== null && JSON.stringify(r3.output.rows) === JSON.stringify(expect1.rows));

  // Clearing steps entirely → output reverts to the original source data.
  const r4 = await datasets.updateSteps(proj.id, prepId, []);
  ok('clearing all steps reverts to the original rows', r4 !== null && r4.dataset.rowCount === 4);
  ok('cleared output equals the source rows', r4 !== null && JSON.stringify(r4.dataset.rows) === JSON.stringify(source.rows));

  // Source is NOT mutated by applying steps (immutability).
  const afterAll = await datasets.getDataset(proj.id, prepId);
  ok('source rows unchanged after all the step churn', afterAll !== null && JSON.stringify(afterAll.source!.rows) === JSON.stringify(source.rows));

  // Reversibility fix: with a pipeline present, updateDataset + updateDatasetData
  // must edit SOURCE and recompute (not silently discard on the next recompute).
  await datasets.updateSteps(proj.id, prepId, [stepFilter]); // amount>5 → 3 rows, source snapshotted
  // (a) rename via updateDataset must persist into source and survive a recompute
  await datasets.updateDataset(proj.id, prepId, {
    columns: [{ name: 'town', type: 'text' as const }, { name: 'amount', type: 'number' as const }],
  });
  const afterRename = await datasets.getDataset(proj.id, prepId);
  ok('column edit persists into source when a pipeline exists',
    afterRename !== null && afterRename.source!.columns[0].name === 'town');
  const recomp = transforms.applyPipeline(afterRename!.source!, afterRename!.steps!);
  ok('derived still equals applyPipeline(source, steps) after a column edit',
    afterRename !== null && JSON.stringify(afterRename.rows) === JSON.stringify(recomp.rows));
  // (b) refresh via updateDatasetData replaces source and KEEPS the pipeline
  await datasets.updateDatasetData(proj.id, prepId, {
    columns: [{ name: 'town', type: 'text' as const }, { name: 'amount', type: 'number' as const }],
    rows: [['Rome', 100], ['Rome', 1]], // fresh source: 2 rows, one has amount<=5
  });
  const afterRefresh = await datasets.getDataset(proj.id, prepId);
  ok('refresh keeps the pipeline (still 1 filter step)',
    afterRefresh !== null && afterRefresh.steps!.length === 1);
  ok('refresh re-snapshots source (2 fresh rows)',
    afterRefresh !== null && afterRefresh.source!.rows.length === 2);
  ok('refresh derived re-runs the filter (amount>5 → 1 row)',
    afterRefresh !== null && afterRefresh.rowCount === 1 && afterRefresh.rows[0][0] === 'Rome' && afterRefresh.rows[0][1] === 100);

  // guards mirror the rest of the module.
  ok('updateSteps: missing uuid → null',
    (await datasets.updateSteps(proj.id, '00000000-0000-0000-0000-000000000000', [])) === null);
  ok('updateSteps: rejects a traversal projectId', (await datasets.updateSteps('..', prepId, [])) === null);
  ok('updateSteps: rejects a traversal datasetId', (await datasets.updateSteps(proj.id, '../SECRET', [])) === null);

  await datasets.deleteDataset(proj.id, prepId);

  // ── Week 6: combineTables append + join (pure, exercised via the module) ───
  const left = { columns: [{ name: 'id', type: 'text' as const }, { name: 'x', type: 'number' as const }], rows: [['a', 1], ['b', 2]] };
  const right = { columns: [{ name: 'id', type: 'text' as const }, { name: 'y', type: 'number' as const }], rows: [['a', 10], ['c', 30]] };
  const app = combine.combineTables(left, right, 'append');
  ok('combine append unions columns (id,x,y)', app.columns.map((c) => c.name).join(',') === 'id,x,y');
  ok('combine append stacks all rows', app.rowCount === 4);
  const joined = combine.combineTables(left, right, 'join', { left: 'id', right: 'id' });
  ok('combine join keeps only matching keys (a)', joined.rowCount === 1 && joined.rows[0][0] === 'a');
  ok('combine join concatenates right non-key column y', joined.columns.map((c) => c.name).includes('y'));

  // SECURITY: BOTH projectId and datasetId must be validated as UUIDs before any
  // fs op — a traversal in either would escape the project's datasets dir. Plant
  // a sentinel one level ABOVE the datasets dir and try to reach it via traversal.
  const sentinel = path.join(tmpUserData, 'projects', proj.id, 'SECRET.json');
  fs.writeFileSync(sentinel, 'keep');
  const outsideSentinel = path.join(tmpUserData, 'DO_NOT_DELETE.txt');
  fs.writeFileSync(outsideSentinel, 'keep');

  ok('saveDataset rejects a traversal projectId',
    (await datasets.saveDataset('..', { name: 'x', sourceKind: 'csv', columns: [], rows: [] })) === null);
  ok('saveDataset rejects a nested traversal projectId',
    (await datasets.saveDataset('../../foo', { name: 'x', sourceKind: 'csv', columns: [], rows: [] })) === null);
  ok('getDataset rejects a traversal projectId', (await datasets.getDataset('..', a !== null ? a.id : 'x')) === null);
  ok('getDataset rejects a traversal datasetId', (await datasets.getDataset(proj.id, '../SECRET')) === null);
  ok('getDataset rejects a nested traversal datasetId', (await datasets.getDataset(proj.id, '../../etc/passwd')) === null);
  ok('deleteDataset rejects a traversal projectId', (await datasets.deleteDataset('..', 'x')) === false);
  ok('deleteDataset rejects a traversal datasetId', (await datasets.deleteDataset(proj.id, '../SECRET')) === false);
  ok('deleteDataset rejects a nested traversal datasetId', (await datasets.deleteDataset(proj.id, '../../DO_NOT_DELETE')) === false);
  ok('listDatasets rejects a traversal projectId', (await datasets.listDatasets('..')).length === 0);

  ok('traversal ops did NOT touch the in-project sentinel', fs.existsSync(sentinel));
  ok('traversal ops did NOT touch files outside projects/', fs.existsSync(outsideSentinel));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' datasets check(s) FAILED'); process.exit(1); }
    console.log('\nAll datasets checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
