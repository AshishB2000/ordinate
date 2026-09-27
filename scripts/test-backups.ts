// Self-check for src/app/backups.ts — scheduled and safety backups, the
// manifest-only reader, and restore.
//
//   1. NAMES: a backup's file name round-trips its time and reason; nothing
//      else in the folder is ever mistaken for one.
//   2. RETENTION: scheduled backups are pruned to `keep`; safety copies are
//      kept apart (the last SAFETY_KEEP), so neither kind pushes the other out.
//   3. CADENCE: due-logic on an injected clock, including a clock that ran
//      backwards.
//   4. THE READER: peekManifest reads a real backup's manifest from the zip
//      directory alone; a truncated, empty or garbage file is skipped, never fatal.
//   5. RESTORE: always a NEW project, named "(restored <date>)", and the source
//      project is not touched — byte for byte.
//
//   npm run build:ts && node scripts/test-backups.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const Module: any = require('module');

const REPO = path.resolve(__dirname, '..');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-backups-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getAppPath: () => REPO, getVersion: () => '9.9.9' },
      ipcMain: { handle: () => {} }, net: {}, dialog: {}, shell: {}, BrowserWindow: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const backups: typeof import('../src/app/backups') = require('../src/app/backups');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const { sanitizeBackups }: typeof import('../src/app/backupSettings') = require('../src/app/backupSettings');

/** Every file under `dir` with its hash — "untouched" means this is equal before and after. */
function treeHash(dir: string): string {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r + ':' + crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, r))).digest('hex'));
    }
  };
  walk('');
  return out.sort().join('\n');
}

const at = (iso: string): Date => new Date(iso);

async function main(): Promise<void> {
  // ── 1. names ────────────────────────────────────────────────────────────────
  const t0 = at('2026-09-25T14:05:00.123Z');
  ok('a scheduled backup is named by its time', backups.backupFileName(t0) === '2026-09-25T14-05-00-123Z.ordinate');
  ok('a safety copy says what it was taken before', backups.backupFileName(t0, 'before-import') === '2026-09-25T14-05-00-123Z-before-import.ordinate');
  const back = backups.parseBackupName(backups.backupFileName(t0, 'before-restore'));
  ok('…and the name parses back to the same time and reason', !!back && back.at.getTime() === t0.getTime() && back.reason === 'before-restore');
  for (const other of ['notes.txt', 'Sales.ordinate', '2026-09-25T14-05-00-123Z.ordinate.partial', '2026-09-25T14-05-00-123Z-before-lunch.ordinate', '../2026-09-25T14-05-00-123Z.ordinate']) {
    ok(`"${other}" is not a backup`, backups.parseBackupName(other) === null);
  }

  // ── 2. retention ────────────────────────────────────────────────────────────
  const day = (n: number, reason?: 'before-import' | 'before-restore'): string =>
    backups.backupFileName(new Date(Date.UTC(2026, 0, 1 + n, 9)), reason);
  const names = [
    ...Array.from({ length: 10 }, (_, i) => day(i)),
    ...Array.from({ length: 7 }, (_, i) => day(i, i % 2 ? 'before-import' : 'before-restore')),
    'notes.txt', 'Sales.ordinate',
  ];
  const gone = new Set(backups.planPrune(names, 7));
  ok('keep 7: the three oldest scheduled backups go', [0, 1, 2].every((i) => gone.has(day(i))) && [3, 9].every((i) => !gone.has(day(i))));
  ok(`safety copies are pruned to their own ${backups.SAFETY_KEEP}, oldest first`,
    gone.has(day(0, 'before-restore')) && gone.has(day(1, 'before-import')) && !gone.has(day(2, 'before-restore'))
    && [...gone].filter((n) => /before/.test(n)).length === 7 - backups.SAFETY_KEEP);
  ok('…ten safety copies never push out a scheduled backup',
    backups.planPrune([...names.slice(10), ...Array.from({ length: 10 }, (_, i) => day(20 + i, 'before-import')), day(40)], 1).every((n) => n !== day(40)));
  ok('nothing that is not a backup is ever pruned', !gone.has('notes.txt') && !gone.has('Sales.ordinate'));
  ok('keep 0 still keeps the newest one', backups.planPrune([day(1), day(2)], 0).join() === day(1));

  // Settings off disk: bad values fall back, a relative folder is refused.
  const s = sanitizeBackups({ folder: 'relative/dir', cadence: 'hourly', keep: 9999, lastRunAt: 'yesterday' });
  ok('sanitized settings: relative folder, unknown cadence, absurd keep, bad date all refused',
    s.folder === '' && s.cadence === 'daily' && s.keep === 100 && s.lastRunAt === undefined, JSON.stringify(s));

  // ── 3. cadence ──────────────────────────────────────────────────────────────
  const last = '2026-09-25T09:00:00.000Z';
  const due = (cadence: any, lastRunAt: string | undefined, now: string): boolean =>
    backups.isDue({ folder: '', cadence, keep: 7, lastRunAt }, at(now));
  ok('never run: due at once', due('daily', undefined, '2026-09-25T09:00:00Z'));
  ok('off: never due', !due('off', undefined, '2030-01-01T00:00:00Z'));
  ok('daily: not due 23h59m later', !due('daily', last, '2026-09-26T08:59:00Z'));
  ok('daily: due 24h later', due('daily', last, '2026-09-26T09:00:00Z'));
  ok('weekly: not due after 6 days', !due('weekly', last, '2026-10-01T09:00:00Z'));
  ok('weekly: due after 7 days', due('weekly', last, '2026-10-02T09:00:00Z'));
  ok('a clock that ran backwards counts as due', due('daily', last, '2026-09-20T09:00:00Z'));
  const next = backups.nextDue({ folder: '', cadence: 'daily', keep: 7, lastRunAt: last }, at('2026-09-25T12:00:00Z'));
  ok('the next daily falls 24h after the last', !!next && next.toISOString() === '2026-09-26T09:00:00.000Z');

  // ── backing up real projects ────────────────────────────────────────────────
  const seeded = await sample.seedSampleProject();
  const pid = seeded.projectId!;
  const other = await projects.createProject('Scratch: a/b <c>');
  const root = path.join(tmpUserData, 'my backups');
  for (let i = 0; i < 4; i++) await backups.backupAll(root, 2, new Date(Date.UTC(2026, 8, 20 + i, 9)));
  const folders = fs.readdirSync(root).sort();
  ok('one folder per project, named for it and its id',
    folders.length === 2 && folders.some((f) => f === `My project — ${pid.slice(0, 8)}`)
    && folders.some((f) => f === `Scratch a b c — ${other.id.slice(0, 8)}`), JSON.stringify(folders));
  const mine = path.join(root, `My project — ${pid.slice(0, 8)}`);
  ok('four runs, keep 2: two backups left, the newest two',
    fs.readdirSync(mine).sort().join() === [backups.backupFileName(new Date(Date.UTC(2026, 8, 22, 9))), backups.backupFileName(new Date(Date.UTC(2026, 8, 23, 9)))].join());
  ok('no .partial left behind', !fs.readdirSync(mine).some((n) => n.endsWith('.partial')));

  // A safety copy survives the schedule's pruning.
  const safety = await backups.backupProject(root, pid, 'before-import', new Date(Date.UTC(2026, 8, 1, 9)));
  await backups.backupAll(root, 2, new Date(Date.UTC(2026, 8, 24, 9)));
  ok('a safety copy — the OLDEST file there — survives scheduled pruning', !!safety && fs.existsSync(safety.file));
  for (let i = 0; i < 6; i++) await backups.backupProject(root, pid, 'before-restore', new Date(Date.UTC(2026, 8, 2 + i, 9)));
  ok(`…and safety copies are capped at ${backups.SAFETY_KEEP} on their own`,
    fs.readdirSync(mine).filter((n) => /before-/.test(n)).length === backups.SAFETY_KEEP);

  // A renamed project's folder is renamed with it, not forked.
  await projects.renameProject(other.id, 'Renamed');
  await backups.backupAll(root, 2, new Date(Date.UTC(2026, 8, 25, 9)));
  const renamed = fs.readdirSync(root).filter((f) => f.endsWith(other.id.slice(0, 8)));
  ok('a renamed project keeps ONE folder, under its new name, with its history',
    renamed.length === 1 && renamed[0] === `Renamed — ${other.id.slice(0, 8)}` && fs.readdirSync(path.join(root, renamed[0])).length === 2, JSON.stringify(renamed));

  // Cancelling stops the run and says so.
  let cancelled = false;
  try {
    await backups.backupAll(root, 2, new Date(), { checkCancelled: () => { const e = new Error('Cancelled'); e.name = 'JobCancelled'; throw e; } });
  } catch (e: any) { cancelled = e && e.name === 'JobCancelled'; }
  ok('a cancel stops the run (JobCancelled), not recorded as a project failure', cancelled);

  // Nothing written at all is a failure, not an empty success.
  const blocked = path.join(tmpUserData, 'a-file-not-a-folder');
  fs.writeFileSync(blocked, 'x');
  let threw = false;
  try { await backups.backupAll(blocked, 2, new Date()); } catch (_) { threw = true; }
  ok('a folder that cannot be written fails the run', threw);
  const unplugged = path.join(tmpUserData, 'Volumes', 'USB stick', 'Backups');
  let why = '';
  try { await backups.backupAll(unplugged, 2, new Date()); } catch (e: any) { why = e.message; }
  ok('a folder on a drive that is not connected fails — and is NOT re-created on this disk',
    /not available/.test(why) && !fs.existsSync(path.join(tmpUserData, 'Volumes')), why);

  // ── 4. the manifest-only reader ─────────────────────────────────────────────
  const newest = path.join(mine, backups.backupFileName(new Date(Date.UTC(2026, 8, 24, 9))));
  const exported = await bundle.exportProject(pid);
  const peeked = await bundle.peekManifest(newest);
  ok('peekManifest reads a real backup\'s manifest', !!peeked && peeked.project.name === 'My project'
    && JSON.stringify(peeked.counts) === JSON.stringify(exported!.manifest.counts), JSON.stringify(peeked && peeked.counts));
  const bytes = fs.readFileSync(newest);
  const junkDir = path.join(root, 'Junk — 00000000');
  fs.mkdirSync(junkDir);
  fs.writeFileSync(path.join(junkDir, backups.backupFileName(at('2026-01-01T00:00:00Z'))), bytes.subarray(0, Math.floor(bytes.length / 2)));
  fs.writeFileSync(path.join(junkDir, backups.backupFileName(at('2026-01-02T00:00:00Z'))), Buffer.from('not a zip at all'));
  fs.writeFileSync(path.join(junkDir, backups.backupFileName(at('2026-01-03T00:00:00Z'))), Buffer.alloc(0));
  fs.writeFileSync(path.join(junkDir, backups.backupFileName(at('2026-01-04T00:00:00Z'))),
    bundle.writeZip([{ name: 'project.json', data: Buffer.from('{}') }]));
  const damaged = Buffer.from(bytes);
  damaged[50] ^= 0xff; // inside manifest.json's own bytes: the CRC catches it
  fs.writeFileSync(path.join(junkDir, backups.backupFileName(at('2026-01-05T00:00:00Z'))), damaged);
  fs.writeFileSync(path.join(junkDir, 'README.txt'), 'not a backup');
  ok('a truncated bundle reads as no manifest', (await bundle.peekManifest(path.join(junkDir, backups.backupFileName(at('2026-01-01T00:00:00Z'))))) === null);
  const listed = await backups.listBackups(root);
  ok('the list holds every readable backup, newest first',
    listed.items.length === fs.readdirSync(mine).length + 2 && listed.items.every((it, i, a) => i === 0 || a[i - 1].at >= it.at));
  ok('truncated, garbage, empty, manifest-less and damaged files are skipped and counted — never fatal',
    listed.skipped === 5 && !listed.items.some((it) => it.id.startsWith('Junk')), String(listed.skipped));
  const entry = listed.items.find((it) => it.id.endsWith(path.basename(newest)))!;
  ok('an entry carries its project, date, reason and record counts',
    !!entry && entry.projectName === 'My project' && entry.reason === 'scheduled' && entry.counts.datasets === 1 && entry.counts.visuals === 3 && entry.size > 0);
  ok('a missing folder lists nothing, quietly', (await backups.listBackups(path.join(tmpUserData, 'nope'))).items.length === 0);

  // Ids resolve back under the root, and nowhere else.
  ok('a listed id resolves to its file', backups.resolveBackup(root, entry.id) === newest);
  for (const bad of ['../x/' + path.basename(newest), 'a/b/' + path.basename(newest), '/etc/' + path.basename(newest),
    `${path.basename(mine)}/notes.txt`, '..\\x\\' + path.basename(newest), `../${path.basename(newest)}`, 42]) {
    ok(`a crafted id (${String(bad).slice(0, 30)}) resolves to nothing`, backups.resolveBackup(root, bad) === null);
  }

  // ── 5. restore ──────────────────────────────────────────────────────────────
  const srcDir = path.join(tmpUserData, 'projects', pid);
  const before = treeHash(srcDir);
  const count0 = (await projects.listProjects()).length;
  const r = await backups.restoreBackup(newest);
  ok('restore succeeds', r.ok === true, r.error);
  ok('…into a NEW project', !!r.project && r.project.id !== pid && (await projects.listProjects()).length === count0 + 1);
  ok('…named for the backup\'s date', !!r.project && r.project.name === 'My project (restored Sep 24, 2026)', r.project && r.project.name);
  const nds = (await datasets.listDatasets(r.project!.id))[0];
  const rows = nds ? await datasets.getDataset(r.project!.id, nds.id) : null;
  ok('…with its table: every row reads back', !!rows && rows.rowCount === 5000);
  ok('the source project is untouched, byte for byte', treeHash(srcDir) === before);
  ok('a damaged backup restores nothing', !(await backups.restoreBackup(path.join(junkDir, backups.backupFileName(at('2026-01-02T00:00:00Z'))))).ok
    && (await projects.listProjects()).length === count0 + 1);

  // The IPC layer's safety copy lands in the default folder, named for why.
  const ipc: typeof import('../src/ipc/backups') = require('../src/ipc/backups');
  await ipc.safetyBackup('before-restore', pid);
  const defaultMine = path.join(tmpUserData, 'backups', `My project — ${pid.slice(0, 8)}`);
  ok('safetyBackup writes a -before-restore copy to <userData>/backups',
    fs.existsSync(defaultMine) && fs.readdirSync(defaultMine).some((n) => n.endsWith('-before-restore.ordinate')));
  await ipc.safetyBackup('before-import', '../../etc');
  ok('…and a crafted project id writes nothing', fs.readdirSync(path.join(tmpUserData, 'backups')).length === 1);

  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
