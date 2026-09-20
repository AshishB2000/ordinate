// Self-check for src/history.ts — thread persistence, the id traversal guard,
// and the atomic (temp→rename) write. Stubs the 'electron' module (via
// Module._load) to point userData at a fresh temp dir, then exercises the REAL
// history module against real disk. No framework — ok() counter, process.exit(1).

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-history-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled sibling of ../src/history.ts.
const history: typeof import('../src/app/history') = require('../src/app/history');


async function main(): Promise<void> {
  await history.init();

  // ── Round-trip save/load ────────────────────────────────────────────────────
  await history.saveThread({ id: '1700000000000', title: 'First', createdAt: 'a', updatedAt: 'b', cropPath: null, messages: [{ role: 'user' }] });
  const loaded = await history.loadThread('1700000000000');
  ok('save+load round-trips a thread', loaded && loaded.title === 'First');
  ok('load preserves messages', loaded && Array.isArray(loaded.messages) && loaded.messages.length === 1);

  // Overwrite (atomic re-save) must not leave a stray .tmp behind.
  await history.saveThread({ id: '1700000000000', title: 'Renamed', updatedAt: 'c' });
  const reloaded = await history.loadThread('1700000000000');
  ok('atomic overwrite updates the thread', reloaded && reloaded.title === 'Renamed');
  const dirFiles = fs.readdirSync(path.join(tmpUserData, 'history', '1700000000000'));
  ok('atomic write leaves no .tmp file behind', !dirFiles.some((f) => f.endsWith('.tmp')));

  // ── Captures are PROJECT records ─────────────────────────────────────────────
  // Start from an empty store: the round-trip thread above has no projectId and
  // would be a fourth, undated entry in every count below.
  await history.deleteThread('1700000000000');
  // Three entries: two written before captures had a project (no projectId),
  // one already owned. The migration must adopt exactly the first two, the
  // listing must be scoped, and running it twice must change nothing.
  const PROJ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PROJ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await history.saveThread({ id: '1700000000001', title: 'Legacy one', updatedAt: '2026-01-01T00:00:00Z' });
  await history.saveThread({ id: '1700000000002', title: 'Legacy two', updatedAt: '2026-01-02T00:00:00Z' });
  await history.saveThread({ id: '1700000000003', title: 'Owned', projectId: PROJ_B, updatedAt: '2026-01-03T00:00:00Z' });

  const adopted = await history.migrateProjectIds(PROJ_A);
  ok('migration adopts every entry with no projectId', adopted === 2, String(adopted));
  ok('...and gives them the project it was handed',
    (await history.loadThread('1700000000001')).projectId === PROJ_A
    && (await history.loadThread('1700000000002')).projectId === PROJ_A);
  ok('...and leaves an entry that already has one alone',
    (await history.loadThread('1700000000003')).projectId === PROJ_B);

  const again = await history.migrateProjectIds(PROJ_A);
  ok('migration is idempotent — a second pass adopts nothing', again === 0, String(again));

  const inA = await history.loadAllSummaries(PROJ_A);
  ok('load is project-scoped', inA.length === 2 && inA.every((x) => x.projectId === PROJ_A),
    JSON.stringify(inA.map((x) => x.id)));
  ok('...newest first', inA[0].id === '1700000000002');
  const inB = await history.loadAllSummaries(PROJ_B);
  ok('...and the other project sees only its own', inB.length === 1 && inB[0].id === '1700000000003');
  const unscoped = await history.loadAllSummaries();
  ok('no project id means every entry (main\'s own crop-path cache)', unscoped.length === 3);

  // The dataset a capture produced is recorded on the capture, so the grid can
  // badge it and the page can offer "New visual".
  await history.setDatasetId('1700000000003', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  ok('setDatasetId is carried into the summary',
    (await history.loadAllSummaries(PROJ_B))[0].datasetId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

  // ── Delete removes the IMAGE, not just the record ────────────────────────────
  // The crop is the capture; a delete that left the PNG on disk would be a
  // "deleted" screenshot still sitting in userData.
  const cropPath = await history.saveCrop('1700000000004',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
  await history.saveThread({ id: '1700000000004', title: 'With a crop', projectId: PROJ_A, cropPath, updatedAt: '2026-01-04T00:00:00Z' });
  ok('saveCrop wrote the image', fs.existsSync(cropPath));
  await history.deleteThread('1700000000004');
  ok('deleteThread removes the crop image too', !fs.existsSync(cropPath));
  ok('...and the record with it', (await history.loadThread('1700000000004')) === null);

  // ── Traversal guard: a malformed id must never escape the history dir ─────────
  // Plant a sentinel file OUTSIDE the history dir; a "../"-style id must not reach it.
  const sentinel = path.join(tmpUserData, 'SECRET.txt');
  fs.writeFileSync(sentinel, 'keep me', 'utf8');

  const evilRead = await history.loadThread('../SECRET' as any);
  ok('loadThread rejects a traversal id (returns null)', evilRead === null);

  const evilDelete = await history.deleteThread('../SECRET.txt' as any);
  ok('deleteThread rejects a traversal id (returns false)', evilDelete === false);
  ok('sentinel outside history dir untouched', fs.existsSync(sentinel));

  const slashId = await history.deleteThread('a/b' as any);
  ok('deleteThread rejects an id with a separator', slashId === false);

  // ── Valid delete still works ─────────────────────────────────────────────────
  const okDelete = await history.deleteThread('1700000000003');
  ok('deleteThread removes a valid thread', okDelete === true && (await history.loadThread('1700000000003')) === null);
}

main()
  .catch((e) => { ok('unexpected error', false, e); })
  .finally(() => {
    Module._load = origLoad;
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* noop */ }
    if (failureCount()) { console.error('\n' + failureCount() + ' history check(s) FAILED'); process.exit(1); }
    console.log('\nAll history checks passed.');
  });
