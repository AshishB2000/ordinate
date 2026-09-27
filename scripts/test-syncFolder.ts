// Self-check for projects in a sync folder — src/app/syncFolder.ts (the
// symlink) and src/app/syncLock.ts (lock.json and conflict copies). All on
// temp dirs; no Electron beyond the userData path.
//
//   1. LOCK: acquire, a fresh lock from ANOTHER machine is "held" (even one with
//      the same host name), a stale one can be taken over, release only drops
//      our own, and a corrupt or future-dated lock never wedges a project.
//   2. CONFLICTS: Dropbox's and iCloud's conflict copies are found; ordinary
//      files that merely look numbered are not.
//   3. LINKED PROJECTS: a symlinked project is listed, opened and bundled like
//      any other, and deleting it removes the LINK — never the user's folder.
//   4. MOVES: move to a folder, open from a folder, move back — each verified,
//      byte for byte, and a crash mid-move is recovered at the next launch.
//
//   npm run build:ts && node scripts/test-syncFolder.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const Module: any = require('module');

const REPO = path.resolve(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sync-')));
const tmpUserData = path.join(tmp, 'userData');
const syncRoot = path.join(tmp, 'Dropbox');
fs.mkdirSync(tmpUserData);
fs.mkdirSync(syncRoot);
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getAppPath: () => REPO, getVersion: () => '9.9.9' },
      ipcMain: { handle: () => {} }, net: {}, dialog: {}, shell: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const lock: typeof import('../src/app/syncLock') = require('../src/app/syncLock');
const sync: typeof import('../src/app/syncFolder') = require('../src/app/syncFolder');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');

function treeHash(dir: string, skip: string[] = []): string {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (skip.includes(r)) continue;
      if (e.isDirectory()) walk(r);
      else out.push(r + ':' + crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, r))).digest('hex'));
    }
  };
  walk('');
  return out.sort().join('\n');
}

function put(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const isLink = (p: string): boolean => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };

async function lockChecks(): Promise<void> {
  const dir = path.join(tmp, 'lockdir');
  fs.mkdirSync(dir);
  const A = { host: 'Studio', machine: 'machine-a', pid: 101, appVersion: '1.0.0' };
  const B = { host: 'Laptop', machine: 'machine-b', pid: 202, appVersion: '1.0.0' };
  const twin = { host: 'Studio', machine: 'machine-c', pid: 303, appVersion: '1.0.0' };
  const t = Date.parse('2026-09-25T09:00:00Z');
  const min = 60 * 1000;

  ok('no lock.json: free', lock.lockState(dir, A, t).state === 'free');
  const l = lock.writeLock(dir, A, t);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'));
  ok('acquire writes the app, host, machine, pid, version and both times',
    disk.app === 'Ordinate' && disk.host === 'Studio' && disk.machine === 'machine-a' && disk.pid === 101
    && disk.appVersion === '1.0.0' && disk.openedAt === l.openedAt && disk.heartbeatAt === new Date(t).toISOString());
  ok('the same machine sees it as its own', lock.lockState(dir, A, t + min).state === 'mine');
  ok('another machine sees a FRESH lock as held', lock.lockState(dir, B, t + 4 * min).state === 'held');
  ok('…including a machine with the SAME host name', lock.lockState(dir, twin, t + min).state === 'held');
  lock.writeLock(dir, A, t + 2 * min);
  ok('a heartbeat moves heartbeatAt and keeps openedAt',
    lock.readLock(dir)!.openedAt === new Date(t).toISOString() && lock.readLock(dir)!.heartbeatAt === new Date(t + 2 * min).toISOString());
  ok('five minutes without a heartbeat: stale', lock.lockState(dir, B, t + 7 * min).state === 'stale');
  lock.releaseLock(dir, B);
  ok('release by a machine that does not hold it leaves the lock alone', !!lock.readLock(dir) && lock.readLock(dir)!.machine === 'machine-a');
  lock.writeLock(dir, B, t + 8 * min);
  const took = lock.readLock(dir)!;
  ok('a stale lock is taken over: new host, new openedAt', took.host === 'Laptop' && took.openedAt === new Date(t + 8 * min).toISOString());
  ok('…and the old owner now sees it as held', lock.lockState(dir, A, t + 9 * min).state === 'held');
  lock.releaseLock(dir, B);
  ok('release by the owner removes lock.json', !fs.existsSync(path.join(dir, 'lock.json')));

  fs.writeFileSync(path.join(dir, 'lock.json'), '{"app":"Ordinate","host":');
  ok('a corrupt lock.json is no lock', lock.lockState(dir, B, t).state === 'free');
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ app: 'Ordinate', host: 'Laptop', machine: 'machine-b', heartbeatAt: new Date(t + 3 * 24 * 60 * min).toISOString() }));
  ok('a heartbeat from the future (skewed clock) is stale, not held forever', lock.lockState(dir, A, t).state === 'stale');
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ app: 'Ordinate', host: 'Studio', heartbeatAt: new Date(t).toISOString() }));
  ok('a lock without a machine id falls back to the host name', lock.lockState(dir, A, t).state === 'mine' && lock.lockState(dir, B, t).state === 'held');
}

async function conflictChecks(): Promise<void> {
  const dir = path.join(tmp, 'conflicts');
  const id = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  const files: Record<string, string> = {
    'project.json': '{}', 'lock.json': '{}',
    [`datasets/${id}.json`]: '{}', [`datasets/${id}.parquet`]: 'P', [`datasets/${id}.source.parquet`]: 'S',
    [`history/dashboard/${id}/2026-01-01T00-00-00-000Z.json`]: '{}',
    [`history/dashboard/${id}/2026-01-01T00-00-00-000Z-2.json`]: '{}',
    'notes 2.json': '{}', 'Q1 2026.json': '{}', [`visuals/${id}.json`]: '{}', [`analyses/${id}.json`]: '{}',
    'metrics/.keep': '', 'reports 2/x.json': '{}',
    // The conflict copies:
    [`datasets/${id} 2.json`]: '{}',
    [`datasets/${id}.source 2.parquet`]: 'S2',
    [`visuals/${id} (Ann's conflicted copy 2026-01-02).json`]: '{}',
    [`analyses/${id} (Case Conflict).json`]: '{}',
    'metrics 2/y.json': '{}',
    'lock (Laptop\'s conflicted copy 2026-01-02).json': '{}',
  };
  for (const [rel, data] of Object.entries(files)) put(path.join(dir, rel), data);
  const found = await lock.findConflicts(dir);
  const want = [
    `analyses/${id} (Case Conflict).json`, `datasets/${id} 2.json`, `datasets/${id}.source 2.parquet`,
    'metrics 2', `visuals/${id} (Ann's conflicted copy 2026-01-02).json`,
  ].sort();
  ok('iCloud "name 2.ext", Dropbox "conflicted copy" and "(Case Conflict)", and a duplicated folder are all found',
    JSON.stringify(found) === JSON.stringify(want), JSON.stringify(found));
  ok('"notes 2.json" with no "notes.json" is not a conflict', !found.includes('notes 2.json'));
  ok('"Q1 2026.json" and a version key ending "-2" are not conflicts',
    !found.includes('Q1 2026.json') && !found.some((f) => f.startsWith('history/')));
  ok('"reports 2" with no "reports" is not a conflict', !found.some((f) => f.startsWith('reports')));
  ok('a conflicted copy of lock.json is not the user\'s work, so it is not reported', !found.some((f) => f.startsWith('lock')));
  ok('a clean project reports nothing', (await lock.findConflicts(path.join(tmp, 'lockdir'))).length === 0);
  ok('a missing folder reports nothing, quietly', (await lock.findConflicts(path.join(tmp, 'nope'))).length === 0);
}

async function linkChecks(): Promise<void> {
  // A project someone else synced here, linked by hand the way openFromFolder does.
  const id = 'c0ffee00-1111-4222-8333-444455556666';
  const shared = path.join(syncRoot, 'Shared.ordinate-project');
  const now = new Date().toISOString();
  put(path.join(shared, 'project.json'), JSON.stringify({ id, name: 'Shared', createdAt: now, updatedAt: now, schemaVersion: 1 }));
  put(path.join(shared, 'visuals', 'aaaaaaaa-1111-4222-8333-444455556666.json'), JSON.stringify({ id: 'aaaaaaaa-1111-4222-8333-444455556666' }));
  await projects.init();
  const local = await projects.createProject('Local');
  fs.symlinkSync(shared, path.join(tmpUserData, 'projects', id), 'junction');

  const listed = await projects.listProjects();
  ok('a symlinked project is listed beside a local one', listed.some((p) => p.id === id) && listed.some((p) => p.id === local.id));
  ok('…opened by id', (await projects.getProject(id))!.name === 'Shared');
  ok('…and reported as synced, to its real folder', sync.syncedTarget(id) === shared && sync.syncedTarget(local.id) === null);
  const out = await bundle.exportProject(id);
  ok('…and exported (walked through the link) like any other', !!out && out.manifest.counts.visuals === 1);
  ok('listSynced finds it, and knows its folder is there', JSON.stringify(await sync.listSynced()) === JSON.stringify([{ id, target: shared, available: true }]));

  ok('deleteProject on a synced project succeeds', await projects.deleteProject(id));
  ok('…removing the LINK', !fs.existsSync(path.join(tmpUserData, 'projects', id)) && !isLink(path.join(tmpUserData, 'projects', id)));
  ok('…and leaving the user\'s synced folder, and every file in it, alone',
    fs.existsSync(path.join(shared, 'project.json')) && fs.existsSync(path.join(shared, 'visuals', 'aaaaaaaa-1111-4222-8333-444455556666.json')));

  // A dangling link (Dropbox not running): skipped by the list, never fatal.
  fs.symlinkSync(path.join(syncRoot, 'Gone.ordinate-project'), path.join(tmpUserData, 'projects', 'dddddddd-1111-4222-8333-444455556666'), 'junction');
  ok('a link whose folder is unavailable is skipped by the list, not fatal', !(await projects.listProjects()).some((p) => p.id.startsWith('dddddddd')));
  ok('…and listSynced marks it unavailable', (await sync.listSynced()).some((s) => s.id.startsWith('dddddddd') && !s.available));
  await projects.deleteProject('dddddddd-1111-4222-8333-444455556666');
}

async function moveChecks(): Promise<void> {
  const p = await projects.createProject('Sales: Q3/Q4');
  const dir = path.join(tmpUserData, 'projects', p.id);
  put(path.join(dir, 'datasets', 'aaaaaaaa-0000-4000-8000-000000000001.json'), '{"id":"x"}');
  put(path.join(dir, 'datasets', 'aaaaaaaa-0000-4000-8000-000000000001.parquet'), 'PAR1' + 'x'.repeat(5000));
  put(path.join(dir, 'history', 'dataset', 'aaaaaaaa-0000-4000-8000-000000000001', '2026-01-01T00-00-00-000Z.json'), '{}');
  const before = treeHash(dir);

  const inside = await sync.moveToFolder(p.id, path.join(tmpUserData, 'backups'));
  ok('a folder inside Ordinate\'s own storage is refused', !inside.ok, inside.error);
  const moved = await sync.moveToFolder(p.id, syncRoot);
  ok('move to a sync folder succeeds', moved.ok === true, moved.error);
  const target = path.join(syncRoot, 'Sales Q3 Q4.ordinate-project');
  ok('…into "<Name>.ordinate-project", a name every file system takes', moved.target === target, moved.target);
  ok('…leaving a LINK where the project was', isLink(dir) && sync.syncedTarget(p.id) === target);
  ok('…every file there, byte for byte', treeHash(target) === before && treeHash(dir) === before);
  ok('…still listed and opened as the same project', (await projects.getProject(p.id))!.name === 'Sales: Q3/Q4'
    && (await projects.listProjects()).some((x) => x.id === p.id));
  ok('…and nothing left in staging', !fs.existsSync(path.join(tmpUserData, 'sync-staging')) || fs.readdirSync(path.join(tmpUserData, 'sync-staging')).length === 0);
  ok('moving a synced project again is refused', !(await sync.moveToFolder(p.id, syncRoot)).ok);

  const twin = await projects.createProject('Sales: Q3/Q4');
  const t2 = await sync.moveToFolder(twin.id, syncRoot);
  ok('a second project of the same name gets "<Name> 2" — never merged into the first', t2.ok && t2.target === path.join(syncRoot, 'Sales Q3 Q4 2.ordinate-project'), t2.target);

  // Open from folder: this Mac already has that id — refused, the link untouched.
  const dup = await sync.openFromFolder(target);
  ok('opening a folder whose project is already here is refused, naming it', !dup.ok && /already/.test(dup.error || '') && /Sales/.test(dup.error || ''), dup.error);
  const notProject = path.join(syncRoot, 'Holiday photos');
  fs.mkdirSync(notProject);
  ok('a folder with no project.json is refused', !(await sync.openFromFolder(notProject)).ok);
  put(path.join(syncRoot, 'Bad.ordinate-project', 'project.json'), JSON.stringify({ id: '../../etc', name: 'x' }));
  ok('a project.json whose id is not a UUID is refused', !(await sync.openFromFolder(path.join(syncRoot, 'Bad.ordinate-project'))).ok);
  const fresh = path.join(syncRoot, 'From laptop.ordinate-project');
  const fid = 'feedface-1111-4222-8333-444455556666';
  put(path.join(fresh, 'project.json'), JSON.stringify({ id: fid, name: 'From laptop', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', schemaVersion: 1 }));
  const opened = await sync.openFromFolder(fresh);
  ok('a synced project from another machine opens by linking — nothing copied', opened.ok && !!opened.project && opened.project.id === fid
    && isLink(path.join(tmpUserData, 'projects', fid)) && sync.syncedTarget(fid) === fresh);

  // Move back: copied home, link replaced by a real folder, lock.json not carried.
  lock.writeLock(target, { host: 'Studio', machine: 'm', pid: 1, appVersion: '1' });
  const discarded: string[] = [];
  const back = await sync.moveBack(p.id, async (d) => { discarded.push(d); });
  ok('move back succeeds', back.ok === true, back.error);
  ok('…the project is a real folder again, not a link', !isLink(dir) && fs.statSync(dir).isDirectory() && sync.syncedTarget(p.id) === null);
  ok('…with every file, byte for byte, and no lock.json', treeHash(dir) === before && !fs.existsSync(path.join(dir, 'lock.json')));
  ok('…and the synced folder handed to the discard (the Trash)', discarded.join() === target);
  ok('moving back a local project is refused', !(await sync.moveBack(p.id, async () => {})).ok);
  const kept = await sync.moveBack(twin.id, async () => { throw new Error('Trash unavailable'); });
  ok('a Trash that fails still leaves the project home, and says what was left behind',
    kept.ok && kept.leftBehind === path.join(syncRoot, 'Sales Q3 Q4 2.ordinate-project') && !isLink(path.join(tmpUserData, 'projects', twin.id)));

  // A crash between "set the original aside" and "link": the next launch puts it back.
  const lost = await projects.createProject('Crashed mid-move');
  const lostDir = path.join(tmpUserData, 'projects', lost.id);
  const staged = path.join(tmpUserData, 'sync-staging', `${lost.id}-${crypto.randomUUID()}`);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.renameSync(lostDir, staged);
  const spare = path.join(tmpUserData, 'sync-staging', `${p.id}-${crypto.randomUUID()}`);
  put(path.join(spare, 'project.json'), '{}');
  await sync.recoverStaging();
  ok('a project set aside by a crashed move is put back at launch', (await projects.getProject(lost.id))!.name === 'Crashed mid-move');
  ok('…while a staged copy of a project that is still here is swept', !fs.existsSync(spare) && (await projects.getProject(p.id))!.name === 'Sales: Q3/Q4');
}

async function main(): Promise<void> {
  await lockChecks();
  await conflictChecks();
  await linkChecks();
  await moveChecks();
  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
