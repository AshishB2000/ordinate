// Self-check for version history — src/app/versions.ts and the restore handler
// in src/ipc/versions.ts. (Named for the feature: scripts/test-history.ts is
// the capture-history suite and predates this one.)
//
// Four properties, each of which fails silently if it breaks:
//
//   1. EVERY SAVE THROUGH THE REAL IPC HANDLER IS A VERSION — asserted by
//      driving `analysis:update` itself, not versions.record, so a hook that
//      falls off the handler is caught.
//   2. A SAVE THAT CHANGED NOTHING IS NOT A VERSION.
//   3. CAP AND PRUNE — 50 per record, oldest gone first.
//   4. RESTORE IS APPEND-ONLY — it writes a NEW version and leaves every old
//      file byte-for-byte as it was; a dataset restore changes the pipeline
//      and never the source Parquet.
//
//   npm run build:ts && node scripts/test-versionHistory.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-versions-'));
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const ipcHandlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getAppPath: () => path.resolve(__dirname, '..') },
      dialog: {}, shell: {}, net: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
require('../src/ipc/analyses').register();
require('../src/ipc/versions').register();

const call = (ch: string, payload: unknown): Promise<any> => {
  const fn = ipcHandlers.get(ch);
  if (!fn) throw new Error('no handler for ' + ch);
  return fn({}, payload);
};

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Versions');
  const pid = proj.id;

  // ── 1 + 2: saves through the real handler ───────────────────────────────────
  const created = await analysis.saveAnalysis(pid, {
    name: 'Sales',
    sheets: [{ name: 'Overview', cards: [{ type: 'text', heading: 'Hello', layout: { x: 0, y: 0, w: 6, h: 2 } }] }],
  });
  if (!created) throw new Error('could not create the analysis');
  ok('a store-level write (the sample seeder\'s path) records no version',
    (await versions.list(pid, 'dashboard', created.id)).length === 0);

  const sheets = created.sheets;
  let res = await call('analysis:update', { projectId: pid, id: created.id, name: 'Sales', sheets, filters: [] });
  ok('first save → one version', res.ok && (await versions.list(pid, 'dashboard', created.id)).length === 1);

  const withTile = JSON.parse(JSON.stringify(sheets));
  withTile[0].cards.push({ type: 'text', heading: 'Second', layout: { x: 6, y: 0, w: 6, h: 2 } });
  res = await call('analysis:update', { projectId: pid, id: created.id, name: 'Sales', sheets: withTile, filters: [] });
  let list = await versions.list(pid, 'dashboard', created.id);
  ok('second save with a change → two versions, newest first',
    list.length === 2 && list[0].savedAt >= list[1].savedAt, JSON.stringify(list.map((v) => v.summary)));
  ok('…whose summary is "Added 1 tile"', list[0].summary === 'Added 1 tile', list[0].summary);
  ok('…and the first says it is the first', list[1].summary === 'First saved version', list[1].summary);
  ok('a dashboard version carries a layout thumbnail of its first sheet',
    Array.isArray(list[0].thumb) && list[0].thumb.length === 2 && list[0].thumb[1].x === 6);

  const saved = res.analysis;
  await call('analysis:update', { projectId: pid, id: created.id, name: 'Sales', sheets: saved.sheets, filters: [] });
  ok('a save that changed nothing is not a version',
    (await versions.list(pid, 'dashboard', created.id)).length === 2);

  // ── 4: restore is append-only ───────────────────────────────────────────────
  const dir = path.join(tmpUserData, 'projects', pid, 'history', 'dashboard', created.id);
  const before = new Map(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
  const oldest = list[1];
  const restored = await call('versions:restore', { projectId: pid, type: 'dashboard', id: created.id, key: oldest.key });
  ok('restore succeeds', restored && restored.ok === true, JSON.stringify(restored));
  const now = await analysis.getAnalysis(pid, created.id);
  ok('…the record on disk is the old content (the tile is gone)',
    !!now && now.sheets[0].cards.length === 1 && now.sheets[0].cards[0].heading === 'Hello');
  list = await versions.list(pid, 'dashboard', created.id);
  ok('…and a THIRD version exists', list.length === 3, String(list.length));
  ok('…marked as restored from the one it brought back', list[0].restoredFrom === oldest.savedAt);
  ok('…whose summary is the diff it made', list[0].summary === 'Removed 1 tile', list[0].summary);
  ok('…and every earlier version file is byte-for-byte untouched',
    [...before].every(([n, body]) => fs.readFileSync(path.join(dir, n), 'utf8') === body));
  const undo = await call('versions:restore', { projectId: pid, type: 'dashboard', id: created.id, key: list[1].key });
  ok('undoing a restore is restoring the version before it',
    undo.ok && (await analysis.getAnalysis(pid, created.id))!.sheets[0].cards.length === 2
    && (await versions.list(pid, 'dashboard', created.id)).length === 4);

  // A record with no history whose first save CHANGES it keeps its pre-edit
  // state as the first version — the seeded sample's first edit is undoable.
  const legacy = await analysis.saveAnalysis(pid, { name: 'Legacy', sheets: [] });
  if (!legacy) throw new Error('could not create the legacy analysis');
  await call('analysis:rename', { projectId: pid, id: legacy.id, name: 'Legacy renamed' });
  const legacyList = await versions.list(pid, 'dashboard', legacy.id);
  ok('a first save that changes a history-less record keeps its prior state too',
    legacyList.length === 2 && legacyList[0].summary === 'Renamed the dashboard'
    && legacyList[1].summary === 'First saved version' && legacyList[1].savedAt === legacy.updatedAt,
    JSON.stringify(legacyList.map((v) => [v.summary, v.savedAt])));

  // ── 3: cap and prune ────────────────────────────────────────────────────────
  const capId = '30000000-0000-4000-8000-000000000001';
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < versions.MAX_VERSIONS + 7; i++) {
    await versions.record(pid, 'metric', { id: capId, name: 'M' + i, definition: { column: 'x', aggregation: 'sum' } },
      { now: new Date(t0 + i * 1000) });
  }
  const capped = await versions.list(pid, 'metric', capId);
  ok(`capped at ${versions.MAX_VERSIONS}`, capped.length === versions.MAX_VERSIONS, String(capped.length));
  ok('…the OLDEST were pruned (the survivors start at save #8)',
    capped[capped.length - 1].savedAt === new Date(t0 + 7000).toISOString(), capped[capped.length - 1].savedAt);
  ok('…and the newest is the last save', capped[0].savedAt === new Date(t0 + (versions.MAX_VERSIONS + 6) * 1000).toISOString());
  ok('…with exactly that many files on disk',
    fs.readdirSync(path.join(tmpUserData, 'projects', pid, 'history', 'metric', capId)).length === versions.MAX_VERSIONS);

  // Two saves in one millisecond keep both.
  const burstId = '30000000-0000-4000-8000-000000000002';
  const t1 = new Date(t0);
  await versions.record(pid, 'visual', { id: burstId, name: 'a' }, { now: t1 });
  await versions.record(pid, 'visual', { id: burstId, name: 'b' }, { now: t1 });
  ok('two saves in the same millisecond are two versions', (await versions.list(pid, 'visual', burstId)).length === 2);
  // Overlapping (un-awaited) saves are serialized per record, not raced.
  await Promise.all([1, 2, 3, 4].map((n) => versions.record(pid, 'visual', { id: burstId, name: 'n' + n })));
  ok('four overlapping saves are four versions', (await versions.list(pid, 'visual', burstId)).length === 6);

  // ── Path guards ─────────────────────────────────────────────────────────────
  ok('a traversal record id lists nothing', (await versions.list(pid, 'dashboard', '../../x')).length === 0);
  ok('a traversal project id records nothing',
    (await versions.record('../..', 'dashboard', { id: created.id, name: 'x' })) === null);
  ok('an unknown type records nothing',
    (await versions.record(pid, 'alert' as never, { id: created.id, name: 'x' })) === null);
  ok('a malformed version key reads nothing',
    (await versions.get(pid, 'dashboard', created.id, '../../../config')) === null);
  ok('restore refuses an unknown type',
    (await call('versions:restore', { projectId: pid, type: 'project', id: created.id, key: list[0].key })).ok === false);

  // ── A dataset's version is its pipeline, never its source ───────────────────
  const ds = await datasets.saveDataset(pid, {
    name: 'Orders', sourceKind: 'csv',
    columns: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }],
    rows: [[1, 2], [3, 4], [5, 6]],
  } as never);
  if (!ds) throw new Error('could not save the dataset');
  const stepA = { type: 'calculated_field', name: 'Sum', expression: '[a] + [b]' };
  const stepB = { type: 'calculated_field', name: 'Diff', expression: '[b] - [a]' };
  let up = await datasets.updateSteps(pid, ds.id, [stepA]);
  await versions.record(pid, 'dataset', { id: ds.id, steps: up!.dataset.steps });
  up = await datasets.updateSteps(pid, ds.id, [stepA, stepB]);
  await versions.record(pid, 'dataset', { id: ds.id, steps: up!.dataset.steps });
  const dsList = await versions.list(pid, 'dataset', ds.id);
  ok('a pipeline edit reads as the field it added', dsList[0].summary === 'Added calculated field Diff', dsList[0].summary);
  const srcFile = path.join(tmpUserData, 'projects', pid, 'datasets', ds.id + '.source.parquet');
  const srcBefore = fs.readFileSync(srcFile);
  const dsRestore = await call('versions:restore', { projectId: pid, type: 'dataset', id: ds.id, key: dsList[1].key });
  const meta = await datasets.getDatasetMeta(pid, ds.id);
  ok('restoring a dataset version restores its pipeline',
    dsRestore.ok && !!meta && Array.isArray(meta.steps) && meta.steps.length === 1
    && meta.columns.map((c) => c.name).join() === 'a,b,Sum', JSON.stringify(meta && meta.columns));
  ok('…and leaves the source Parquet byte-for-byte alone', Buffer.compare(srcBefore, fs.readFileSync(srcFile)) === 0);

  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
