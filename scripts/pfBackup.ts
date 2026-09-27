// Platform-depth smoke SECTION: backups and sync, driven through the REAL UI.
// Not a standalone smoke — the platform runner calls backupSection(s, fx) on
// its own launch and fixture.
//
//   Settings → General → Backups shows the folder main holds (set through main:
//   a native picker cannot be driven) → Back up now → a backup job runs in the
//   Jobs popover and finishes → the .ordinate file is on disk → Restore from
//   backup… lists it with the manifest's own counts → Restore → a NEW project
//   named "(restored …)" exists, and the source is still there.
//
//   Then the sync folder: the native pickers and the Trash are stubbed in main
//   (the only way to answer them from a test), the fixture's bare project is
//   moved to a "sync folder" from the switcher's row menu, shows the Synced
//   badge, holds a lock.json while open, and is moved back.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

// Hub globals are script-level `function`s — on window, so callable here.
declare const showSettingsPanel: (cat?: string) => Promise<void>;
declare const hideSettingsPanel: () => void;
declare const openProjectSwitcher: (trigger: HTMLElement) => Promise<void>;

type Win = Smoke['win'];

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(250);
  }
  return false;
}

const text = (win: Win, sel: string): Promise<string> =>
  win.evaluate((q: string) => (document.querySelector(q)?.textContent || '').trim(), sel);

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

export async function backupSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const folder = path.join(s.userData, 'Backups chosen in smoke');
  fs.mkdirSync(folder, { recursive: true });
  // The folder, as the native picker would have set it. Schedule off, so the
  // scheduler cannot write a backup of its own in the middle of the checks.
  await app.evaluate((_e, f: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const config = req('./src/app/config.js');
    config.save({ backups: { ...config.get().backups, folder: f, cadence: 'off' } });
  }, folder);

  // ── Settings → General → Backups ────────────────────────────────────────────
  await win.evaluate(() => { void showSettingsPanel('general'); });
  const shown = await until(win, async () => (await text(win, '#bk-path')).includes('Backups chosen in smoke'), 10_000);
  ok('backups: Settings → General shows the Backups section with the chosen folder', shown, await text(win, '#bk-path'));
  ok('backups: the schedule reads Off', await win.evaluate(() =>
    document.querySelector('#bk-cadence .stp-seg-opt.active')?.textContent === 'Off'));

  // ── Back up now ─────────────────────────────────────────────────────────────
  ok('backups: "Back up now" is clickable', await click(win, '#bk-now'));
  const finished = await until(win, async () => {
    const snap = await win.evaluate(() => (window as any).hubPlatform.listJobs());
    return (snap.recent || []).some((j: any) => j.kind === 'backup' && j.label === 'Back up all projects' && j.state === 'done');
  });
  ok('backups: the backup job finishes', finished);
  await until(win, async () => (await text(win, '#bk-card .bk-card-title')).startsWith('Last backup'), 5000);
  ok('backups: the status card says when', /^Last backup (just now|\d+ min ago)$/.test(await text(win, '#bk-card .bk-card-title')),
    await text(win, '#bk-card .bk-card-title'));

  await win.evaluate(() => { hideSettingsPanel(); });
  await click(win, '#topbar-jobs');
  const inPopover = await until(win, () => win.evaluate(() => [...document.querySelectorAll('#jp-pop .jp-row--done .jp-name')]
    .some((n) => (n.textContent || '').includes('Back up all projects'))), 5000);
  ok('backups: the Jobs popover lists the finished backup', inPopover);
  await win.keyboard.press('Escape');

  const dir = path.join(folder, fs.readdirSync(folder).find((n) => n.startsWith('Smoke test — ')) || 'missing');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.ordinate')) : [];
  ok('backups: the Smoke test project\'s .ordinate file is on disk', files.length === 1, JSON.stringify(fs.readdirSync(folder)));
  const file = path.join(dir, files[0] || 'missing');
  const manifest = await app.evaluate((_e, f: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/app/bundle.js').peekManifest(f);
  }, file);
  ok('backups: its manifest names the project and counts its datasets', !!manifest && manifest.project.name === 'Smoke test' && manifest.counts.datasets >= 1);

  // ── Restore from backup… ────────────────────────────────────────────────────
  await win.evaluate(() => { void showSettingsPanel('general'); });
  await until(win, () => click(win, '#bk-restore-open'), 5000);
  const listed = await until(win, () => win.evaluate(() => document.querySelectorAll('.bk-modal .bk-row').length > 0), 10_000);
  ok('backups: Restore from backup… lists the backup', listed);
  const row = await win.evaluate(() => {
    const g = [...document.querySelectorAll('.bk-modal .bk-group')]
      .find((x) => x.querySelector('.bk-group-name')?.textContent === 'Smoke test');
    const r = g?.querySelector('.bk-row') as HTMLElement | null;
    return r ? { id: r.dataset.id || '', counts: r.querySelector('.bk-row-counts')?.textContent || '' } : null;
  });
  const n = manifest ? manifest.counts.datasets : -1;
  ok('backups: the row shows the manifest\'s own counts',
    !!row && row.counts.includes(`${n} dataset${n === 1 ? '' : 's'}`), row && row.counts);
  await win.evaluate((id: string) => {
    (document.querySelector(`.bk-modal .bk-row[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.click();
  }, row ? row.id : '');
  ok('backups: picking a row enables Restore', await click(win, '.bk-modal .bk-go'));
  const done = await until(win, () => win.evaluate(() => !!document.querySelector('.bk-modal .bk-done')), 60_000);
  const doneText = await text(win, '.bk-modal .bk-done .bk-empty-t');
  ok('backups: the dialog says what the restore became', done && /^Restored as “Smoke test \(restored .+\)”$/.test(doneText), doneText);
  const after = await win.evaluate(() => (window as any).hub.listProjects());
  const restored = after.find((p: any) => /^Smoke test \(restored /.test(p.name));
  ok('backups: a NEW project exists under that name', !!restored && restored.id !== fx.projectId);
  ok('backups: …and the source project is still there', after.some((p: any) => p.id === fx.projectId && p.name === 'Smoke test'));
  await click(win, '.bk-modal .bk-cancel');
  await win.evaluate(() => { hideSettingsPanel(); });

  // ── Sync folder ─────────────────────────────────────────────────────────────
  const syncParent = path.join(s.userData, '..', path.basename(s.userData) + '-Dropbox');
  fs.mkdirSync(syncParent, { recursive: true });
  const trashed: string[] = [];
  await app.evaluate((electron, f: string) => {
    // ponytail: test stubs over Electron's own dialog and shell.
    (electron.dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    (electron.shell as any).trashItem = async (p: string) => { (globalThis as any).__trashed = ((globalThis as any).__trashed || []).concat(p); };
  }, syncParent);

  const openRowMenu = async (projectId: string): Promise<boolean> => {
    await win.evaluate(() => { void openProjectSwitcher(document.getElementById('as-project-btn') || document.body); });
    await until(win, () => win.evaluate(() => !!document.querySelector('.pj-pop')), 3000);
    return win.evaluate((id: string) => {
      const more = document.querySelector(`.pj-row[data-project-id="${id}"] .pj-more`) as HTMLElement | null;
      if (!more) return false;
      more.click();
      return true;
    }, projectId);
  };
  const menuClick = (label: string): Promise<boolean> => win.evaluate((l: string) => {
    const b = [...document.querySelectorAll('.pj-menu .chart-menu-item')].find((x) => (x.textContent || '').trim() === l) as HTMLElement | undefined;
    if (!b) return false;
    b.click();
    return true;
  }, label);
  const modalOk = (): Promise<boolean> => click(win, '.sy-modal .ws-modal-actions .btn-primary');

  ok('sync: the bare project\'s ⋯ menu opens', await openRowMenu(fx.bareProjectId));
  ok('sync: …and offers "Move to sync folder…"', await menuClick('Move to sync folder…'));
  await until(win, () => win.evaluate(() => !!document.querySelector('.sy-modal')), 3000);
  ok('sync: the explainer asks first, then picks the folder', await modalOk());
  const target = path.join(syncParent, 'Empty gallery.ordinate-project');
  const moved = await until(win, () => fs.existsSync(path.join(target, 'project.json')), 20_000);
  ok('sync: the project moved into "<Name>.ordinate-project"', moved);
  const linkPath = path.join(s.userData, 'projects', fx.bareProjectId);
  ok('sync: …and userData holds a LINK to it', fs.lstatSync(linkPath).isSymbolicLink());

  await win.evaluate(() => { void openProjectSwitcher(document.getElementById('as-project-btn') || document.body); });
  const badge = await until(win, () => win.evaluate((id: string) =>
    (document.querySelector(`.pj-row[data-project-id="${id}"] .sy-badge`)?.textContent || '') === 'Synced', fx.bareProjectId), 5000);
  ok('sync: the switcher row wears the Synced badge', badge);
  await win.evaluate((id: string) => { (document.querySelector(`.pj-row[data-project-id="${id}"]`) as HTMLElement | null)?.click(); }, fx.bareProjectId);
  const locked = await until(win, () => fs.existsSync(path.join(target, 'lock.json')), 10_000);
  const lock = locked ? JSON.parse(fs.readFileSync(path.join(target, 'lock.json'), 'utf8')) : null;
  ok('sync: opening it writes lock.json naming this machine', !!lock && lock.app === 'Ordinate' && typeof lock.host === 'string' && !!lock.machine);
  // Its table is Parquet read by DuckDB, whose allow-list resolves symlinks —
  // the read that fails if the synced folder was not put on that list.
  const rows = await win.evaluate(async (pid: string) => {
    const hub = (window as any).hub;
    const list = await hub.listDatasets(pid);
    const ds = list && list[0] ? await hub.getDataset(pid, list[0].id) : null;
    return ds && Array.isArray(ds.rows) ? ds.rows.length : -1;
  }, fx.bareProjectId);
  ok('sync: …and its table still reads through the link', rows === 3, String(rows));

  // Back to the main project: the lock is released.
  await win.evaluate((id: string) => { void (window as any).pjSwitchTo(id); }, fx.projectId);
  ok('sync: switching away releases the lock', await until(win, () => !fs.existsSync(path.join(target, 'lock.json')), 10_000));

  ok('sync: the ⋯ menu now offers "Move back to this …"', await openRowMenu(fx.bareProjectId)
    && await win.evaluate(() => [...document.querySelectorAll('.pj-menu .chart-menu-item')].some((b) => /^Move back to this /.test((b.textContent || '').trim()))));
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.pj-menu .chart-menu-item')].find((x) => /^Move back to this /.test((x.textContent || '').trim())) as HTMLElement | undefined;
    b?.click();
  });
  await until(win, () => win.evaluate(() => !!document.querySelector('.sy-modal')), 3000);
  ok('sync: move back asks first', await modalOk());
  const home = await until(win, () => { try { return !fs.lstatSync(linkPath).isSymbolicLink(); } catch (_) { return false; } }, 20_000);
  ok('sync: the project is a real folder in userData again', home && fs.existsSync(path.join(linkPath, 'project.json')));
  const gone = await app.evaluate(() => (globalThis as any).__trashed || []);
  trashed.push(...gone);
  ok('sync: …and the synced folder went to the (stubbed) Trash', trashed.length === 1 && fs.realpathSync(path.dirname(trashed[0])) === fs.realpathSync(syncParent));

  ok('backups+sync: no renderer console errors', s.errors.length === errors0, s.errors.slice(errors0).join('\n'));
}
