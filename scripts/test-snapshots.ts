// Self-check for data snapshots — src/data/snapshotNames.ts (names, retention,
// the as-of rule), src/data/snapshots.ts (keep + prune on refresh),
// src/data/asOf.ts (reading the past through the ordinary dataset reads) and
// src/data/snapshotRestore.ts (restore through the refresh path).
//
// Real modules, real disk, REAL refreshes of a real CSV (electron stubbed so
// userData is a temp dir, as in test-dataset-refresh.ts). What fails silently
// gets the attention: a stray or foreign file touched by a prune, a failed
// refresh that still keeps a "snapshot" of current data, an as-of answer
// served from the latest answer's cache entry, a past row written back as the
// present, and "no data yet" quietly drawn as the latest figure.
//
//   npm run build:ts && node scripts/test-snapshots.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapshots-'));
const tmpFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapshots-src-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test', getAppPath: () => path.resolve(__dirname, '..') },
      ipcMain: { handle: () => {}, on: () => {} },
      dialog: {}, net: {}, nativeImage: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const names: typeof import('../src/data/snapshotNames') = require('../src/data/snapshotNames');
const snapshots: typeof import('../src/data/snapshots') = require('../src/data/snapshots');
const asOf: typeof import('../src/data/asOf') = require('../src/data/asOf');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
const restore: typeof import('../src/data/snapshotRestore') = require('../src/data/snapshotRestore');
const answerKey: typeof import('../src/data/answerKey') = require('../src/data/answerKey');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const { computeCardMetric }: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const S1 = '2026-01-01T00-00-00-000Z';
const S2 = '2026-02-01T00-00-00-000Z';
const S3 = '2026-03-01T00-00-00-000Z';
const ms = (stamp: string): number => Date.parse(names.parseStamp(stamp) as string);
const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));

function csv(name: string, rows: number): string {
  const p = path.join(tmpFiles, name);
  const lines = ['city,visits'];
  for (let i = 0; i < rows; i++) lines.push(`c${i},${(i + 1) * 10}`);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

async function importCsv(projectId: string, name: string, file: string) {
  const { parseFile } = require('../src/data/fileImport');
  const parsed = await parseFile(file, 'csv');
  return datasets.saveDataset(projectId, { name, sourceKind: 'csv', columns: parsed.columns, rows: parsed.rows, origin: { kind: 'file', path: file } });
}

function pureChecks(): void {
  // ── Stamps: format ⇄ parse, strictly ─────────────────────────────────────
  ok('stamp: an ISO time formats without colons', names.stampOf('2026-09-26T21:44:03.123Z') === '2026-09-26T21-44-03-123Z');
  ok('stamp: parses back to the same ISO time', names.parseStamp('2026-09-26T21-44-03-123Z') === '2026-09-26T21:44:03.123Z');
  const t = Date.UTC(2031, 11, 31, 23, 59, 59, 999);
  ok('stamp: round-trips an arbitrary time', names.parseStamp(names.stampOf(new Date(t).toISOString()) as string) === new Date(t).toISOString());
  for (const bad of ['2026-02-30T00-00-00-000Z', '2026-09-26T24-00-00-000Z', '2026-09-26T21-44-03Z', '2026-13-01T00-00-00-000Z',
    '../2026-09-26T21-44-03-123Z', ' 2026-09-26T21-44-03-123Z', '2026-09-26T21:44:03.123Z', '', 'x']) {
    ok(`stamp: refuses ${JSON.stringify(bad)}`, names.parseStamp(bad) === null);
  }
  ok('stamp: a non-time is null', names.stampOf('not a date') === null && names.stampOf(undefined) === null);

  // ── Names: only <uuid>.<stamp>.parquet (and its .source companion) ────────
  ok('name: a snapshot matches', JSON.stringify(names.matchName(ID, `${ID}.${S1}.parquet`)) === JSON.stringify({ stamp: S1, source: false }));
  ok('name: its source companion matches', JSON.stringify(names.matchName(ID, `${ID}.${S1}.source.parquet`)) === JSON.stringify({ stamp: S1, source: true }));
  for (const bad of [`${OTHER}.${S1}.parquet`, `${ID}.parquet`, `${ID}.source.parquet`, `${ID}.snapshots.json`,
    `${ID}.${S1}.parquet.1234.tmp`, `${ID}.${S1}.PARQUET`, `${ID}..parquet`, `${ID}.2026-02-30T00-00-00-000Z.parquet`,
    `${ID}.${S1}/../../x.parquet`, `${ID}.${S1}.x.parquet`, `x${ID}.${S1}.parquet`, `${ID.toUpperCase()}.${S1}.parquet`]) {
    ok(`name: refuses ${bad.replace(ID, '<id>').replace(OTHER, '<other>')}`, names.matchName(ID, bad) === null);
  }
  ok('name: a non-uuid id matches nothing', names.matchName('../..', `../...${S1}.parquet`) === null);
  ok('name: snapshotFiles picks exactly its own files',
    JSON.stringify(names.snapshotFiles(ID, [`${ID}.${S1}.parquet`, `${ID}.snapshots.json`, `${ID}.parquet`, `${OTHER}.${S1}.parquet`, 'junk']))
      === JSON.stringify([`${ID}.${S1}.parquet`, `${ID}.snapshots.json`]));

  // ── Retention ────────────────────────────────────────────────────────────
  ok('keep: bounded to 0..100, whole, default 10', names.sanitizeKeep(3.7) === 3 && names.sanitizeKeep(-1) === 0
    && names.sanitizeKeep(1e9) === 100 && names.sanitizeKeep('5') === 10 && names.sanitizeKeep(NaN) === 10);
  ok('prune plan: oldest go first', JSON.stringify(names.planPrune([S2, S1, S3], 2)) === JSON.stringify([S1]));
  ok('prune plan: 0 keeps none', names.planPrune([S2, S1, S3], 0).length === 3);
  ok('prune plan: never names a non-stamp', JSON.stringify(names.planPrune(['junk', S1], 0)) === JSON.stringify([S1]));

  // ── Eligibility ──────────────────────────────────────────────────────────
  ok('eligible: a schedule or a connection, nothing else',
    names.isEligible({ autoRefresh: { every: 'daily' } }) && names.isEligible({ origin: { kind: 'connection' } })
      && !names.isEligible({ origin: { kind: 'file' } }) && !names.isEligible(null));

  // ── The as-of rule ───────────────────────────────────────────────────────
  const stamps = [S2, S1, S3];
  const cur = ms(S3) + 1000;
  const pick = (at: number): string => {
    const p = names.pickAsOf(stamps, cur, at);
    return p.kind === 'snapshot' ? p.stamp : p.kind;
  };
  ok('as-of: before the first version there is no data', pick(ms(S1) - 1) === 'none');
  ok('as-of: exactly at a stamp is that snapshot', pick(ms(S1)) === S1 && pick(ms(S2)) === S2);
  ok('as-of: between two stamps is the older (newest <= t)', pick(ms(S1) + 5) === S1 && pick(ms(S3) + 500) === S3);
  ok('as-of: at or after the current fetch is current (a tie goes to current)', pick(cur) === 'current' && pick(cur + 1e9) === 'current');
  ok('as-of: an unreadable time is current', pick(NaN) === 'current' && names.pickAsOf(stamps, NaN, ms(S1)).kind === 'current');
  ok('as-of: a hostile stamp in the list is ignored', names.pickAsOf(['../x', S1], cur, ms(S2)).kind === 'snapshot');
}

async function main(): Promise<void> {
  pureChecks();
  await projects.init();
  const pid = (await projects.createProject('Snapshots')).id;
  const dir = path.join(tmpUserData, 'projects', pid, 'datasets');

  // ── Retention and pruning over five REAL refreshes ───────────────────────
  const file = csv('visits.csv', 1);
  const ds = (await importCsv(pid, 'Visits', file))!;
  await datasets.setAutoRefresh(pid, ds.id, { every: 'daily' });
  fs.mkdirSync(dir, { recursive: true });
  const strays = [`${OTHER}.${S1}.parquet`, `${ds.id}.notastamp.parquet`, `${ds.id}.${S1}.parquet.junk`, 'notes.txt'];
  for (const s of strays) fs.writeFileSync(path.join(dir, s), 'stray');
  ok('setKeep: 3', (await snapshots.setKeep(pid, ds.id, 3))?.keep === 3);
  for (let i = 1; i <= 5; i++) {
    await sleep(5); // distinct fetch times
    csv('visits.csv', i + 1);
    const r = await refresh.refreshDataset(pid, ds.id);
    ok(`refresh ${i} succeeds`, r.ok, JSON.stringify(r));
  }
  let list = await snapshots.list(pid, ds.id);
  ok('cap 3, five refreshes: exactly 3 snapshots remain', list.length === 3, String(list.length));
  ok('…the 3 NEWEST (the tables of 5, 4 and 3 rows, newest first)', JSON.stringify(list.map((s) => s.rowCount)) === JSON.stringify([5, 4, 3]));
  ok('…with the column types kept beside them', list[0].columns.map((c) => `${c.name}:${c.type}`).join() === 'city:text,visits:number');
  ok('stray and foreign files are never touched', strays.every((s) => fs.readFileSync(path.join(dir, s), 'utf8') === 'stray'));
  ok('…and never listed', list.every((s) => names.matchName(ds.id, path.basename(s.parquetPath)) !== null));
  ok('no temp file is left behind', !fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));

  // A failed refresh keeps nothing.
  const origin = path.join(tmpFiles, 'visits.csv');
  fs.renameSync(origin, origin + '.moved');
  ok('a failed refresh fails', !(await refresh.refreshDataset(pid, ds.id)).ok);
  fs.renameSync(origin + '.moved', origin);
  ok('…and keeps no snapshot of the data that is still current', JSON.stringify((await snapshots.list(pid, ds.id)).map((s) => s.stamp))
    === JSON.stringify(list.map((s) => s.stamp)));

  ok('lowering the cap prunes at once', (await snapshots.setKeep(pid, ds.id, 1))!.removed.length === 2
    && (await snapshots.list(pid, ds.id)).map((s) => s.rowCount).join() === '5');
  await snapshots.setKeep(pid, ds.id, 0);
  await sleep(5);
  await refresh.refreshDataset(pid, ds.id);
  ok('0 keeps none, even after a refresh', (await snapshots.list(pid, ds.id)).length === 0
    && !fs.readdirSync(dir).some((n) => names.matchName(ds.id, n)));
  ok('the cap is bounded', (await snapshots.setKeep(pid, ds.id, 500))!.keep === 100);
  ok('stray files survived every prune', strays.every((s) => fs.existsSync(path.join(dir, s))));

  // An unscheduled file dataset is not eligible: a manual refresh keeps nothing.
  const plain = (await importCsv(pid, 'Plain', csv('plain.csv', 2)))!;
  await sleep(5);
  await refresh.refreshDataset(pid, plain.id);
  ok('no schedule, no connection: a refresh keeps no snapshot', (await snapshots.list(pid, plain.id)).length === 0);

  // ── As of: the ordinary reads answer from the past ───────────────────────
  await snapshots.setKeep(pid, ds.id, 10);
  csv('visits.csv', 2);
  await sleep(5);
  await refresh.refreshDataset(pid, ds.id); // current: 2 rows (10 + 20)
  const before = await datasets.getDatasetMeta(pid, ds.id);
  csv('visits.csv', 3);
  await sleep(5);
  await refresh.refreshDataset(pid, ds.id); // current: 3 rows (10 + 20 + 30); snapshot: the 2-row table
  const [snap] = await snapshots.list(pid, ds.id);
  const t1 = Date.parse(before!.lastRefreshedAt as string);
  ok('as-of fixture: the 2-row table is kept, stamped with its own fetch time', snap && snap.rowCount === 2 && snap.at === before!.lastRefreshedAt);

  const at1 = await asOf.runAsOf(pid, t1 + 1, () => datasets.getDatasetMeta(pid, ds.id));
  ok('getDatasetMeta as of the snapshot reads the snapshot', at1.value?.rowCount === 2 && !at1.missing);
  const res1 = await asOf.runAsOf(pid, t1, () => datasets.residentSource(pid, ds.id));
  ok('residentSource as of the snapshot is the snapshot file', res1.value?.parquetPath === snap.parquetPath);
  const rows1 = await asOf.runAsOf(pid, t1, () => datasets.getDataset(pid, ds.id));
  ok('getDataset as of the snapshot hydrates the snapshot rows', JSON.stringify(rows1.value?.rows) === JSON.stringify([['c0', 10], ['c1', 20]]));
  const now1 = await asOf.runAsOf(pid, Date.now() + 1000, () => datasets.getDatasetMeta(pid, ds.id));
  ok('as of now reads the current table', now1.value?.rowCount === 3);
  const early = await asOf.runAsOf(pid, Date.parse(ds.createdAt) - 60_000, () => datasets.getDatasetMeta(pid, ds.id));
  ok('before the first version: null, and flagged missing', early.value === null && early.missing);

  const sum = { column: 'visits', aggregation: 'sum' as const };
  const latest = await computeCardMetric(pid, ds.id, sum, []);
  ok('the latest KPI is 60', latest.ok && latest.value === 60);
  const past = await asOf.runAsOf(pid, t1, () => computeCardMetric(pid, ds.id, sum, []));
  ok('the same KPI as of the snapshot is 30 — not the cached latest answer', past.value.ok && past.value.value === 30, JSON.stringify(past.value));
  ok('the latest KPI is still 60 after it (no cross-talk the other way)', (await computeCardMetric(pid, ds.id, sum, [])).value === 60);
  const amb = await asOf.runAsOf(pid, t1, async () => answerKey.ambient());
  ok('the answer-cache key carries the as-of time inside a scope, and not outside',
    amb.value.asOf === new Date(t1).toISOString() && answerKey.ambient().asOf === undefined);

  const missing = await asOf.withAsOf(pid, new Date(Date.parse(ds.createdAt) - 60_000).toISOString(), () => computeCardMetric(pid, ds.id, sum, []));
  ok('withAsOf before the first version answers "No data as of …", never the latest', (missing as any).ok === false
    && /^No data as of /.test((missing as any).error) && typeof (missing as any).asOfMissing === 'string', JSON.stringify(missing));
  ok('withAsOf refuses an unreadable time', ((await asOf.withAsOf(pid, 'yesterday-ish', async () => ({ ok: true }))) as any).ok === false);
  ok('withAsOf with no time is the ordinary read', ((await asOf.withAsOf(pid, undefined, async () => ({ ok: true }))) as any).ok === true);

  let refused = false;
  try {
    await asOf.runAsOf(pid, t1, () => datasets.updateDatasetData(pid, ds.id, { columns: before!.columns, rows: [['x', 1]] }));
  } catch (_) {
    refused = true;
  }
  ok('a write inside an as-of read is refused, and the table is untouched', refused && (await datasets.getDatasetMeta(pid, ds.id))!.rowCount === 3);

  // ── Restore: through the refresh path ────────────────────────────────────
  const count0 = (await snapshots.list(pid, ds.id)).length;
  const updated0 = (await datasets.getDatasetMeta(pid, ds.id))!.updatedAt;
  await sleep(5);
  const r = await restore.restoreSnapshot(pid, ds.id, snap.stamp);
  ok('restore succeeds', r.ok, JSON.stringify(r));
  const after = await datasets.getDataset(pid, ds.id);
  ok('restore: the dataset now has the snapshot rows', JSON.stringify(after?.rows) === JSON.stringify([['c0', 10], ['c1', 20]]));
  const listAfter = await snapshots.list(pid, ds.id);
  ok('restore: the replaced table became one more snapshot', listAfter.length === count0 + 1 && listAfter[0].rowCount === 3);
  ok('restore: updatedAt and the fetch time moved', after!.updatedAt !== updated0 && after!.lastRefreshedAt! > listAfter[0].at);
  ok('restore: the latest KPI follows (cache dropped)', (await computeCardMetric(pid, ds.id, sum, [])).value === 30);
  ok('restore: an unknown stamp is refused', !(await restore.restoreSnapshot(pid, ds.id, S1)).ok);

  // A pipeline: the snapshot's SOURCE is restored and the current steps re-derive.
  const piped = (await importCsv(pid, 'Piped', csv('piped.csv', 3)))!;
  await datasets.setAutoRefresh(pid, piped.id, { every: 'daily' });
  await datasets.updateSteps(pid, piped.id, [{ type: 'filter', column: 'visits', op: '>', value: 10 } as any]);
  csv('piped.csv', 5);
  await sleep(5);
  await refresh.refreshDataset(pid, piped.id); // derived: 4 rows (20..50); snapshot: derived 2 rows + source 3
  const [ps] = await snapshots.list(pid, piped.id);
  ok('pipeline: the snapshot keeps the source beside the table', ps && ps.rowCount === 2 && ps.sourcePath !== null && fs.existsSync(ps.sourcePath!));
  await sleep(5);
  const pr = await restore.restoreSnapshot(pid, piped.id, ps.stamp);
  const pAfter = await datasets.getDataset(pid, piped.id);
  ok('pipeline: restore re-derives from the kept source (3 source rows, 2 after the filter)', pr.ok
    && pAfter?.source?.rows.length === 3 && pAfter.rows.length === 2 && (pAfter.steps || []).length === 1);

  // ── Trash carries the snapshots, and brings them back ────────────────────
  const kept = fs.readdirSync(dir).filter((n) => names.matchName(ds.id, n) || n === names.indexName(ds.id));
  ok('trash fixture: snapshot files on disk', kept.length >= 3);
  await trash.trashRecord(pid, 'dataset', ds.id);
  const trashDir = path.join(tmpUserData, 'projects', pid, 'trash', 'dataset');
  ok('trash: every snapshot file moved with the dataset', kept.every((n) => !fs.existsSync(path.join(dir, n)) && fs.existsSync(path.join(trashDir, n))));
  ok('trash: stray files stayed where they were', strays.every((s) => fs.existsSync(path.join(dir, s))));
  await trash.restore(pid, 'dataset', ds.id);
  ok('trash: restoring the dataset brings its snapshots back', (await snapshots.list(pid, ds.id)).length === listAfter.length);
  await datasets.deleteDataset(pid, piped.id);
  ok('delete: a deleted dataset leaves no snapshot file behind', !fs.readdirSync(dir).some((n) => names.snapshotFiles(piped.id, [n]).length));
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(tmpFiles, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' snapshot check(s) FAILED'); process.exit(1); }
    console.log('\nAll snapshot checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
