// Settings (T2.14) — the SERVER forms of the desktop handlers that cannot load
// on a server, plus the org backup. MAIN (server) only: registered by
// src/server/app.ts registerHandlers(); the desktop keeps src/ipc/providers.ts
// (rules / auto-refresh / notifications beside its key handling, which needs
// Electron's net) and src/ipc/backups.ts (a folder on this machine, a schedule).
//
// Backups on the server are DOWNLOAD and RESTORE, an org admin's:
//
//   download  every project of the org as its ordinary .ordinate bundle,
//             zipped together with a `backup.json` that lists them, handed to
//             the browser as a T0.4 download token. Unmasked — a backup must
//             restore what was there — which is why it is admin-only and audited.
//   restore   the same file uploaded again. Each project comes back as a NEW
//             project ("Sales (restored Oct 4, 2026)"), exactly as a desktop
//             restore does: what is there now is never overwritten.
//
// The schedule and the folder are the desktop's; on a server the operator
// backs up Postgres and the volume or bucket (plan §8).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ipcMain } from './bus';
import * as appPaths from '../app/paths';
import * as config from '../app/config';
import * as jobs from '../app/jobs';
import * as projects from '../app/projects';
import * as bundle from '../app/bundle';
import { folderName, restoredName } from '../app/backups';
import { LOGO_MAX_BYTES, readLogoDataUrl, saveLogo } from '../app/branding';
import { FileTokenError, offerDownload, resolveUpload, type Upload } from '../server/files';
import { ctx } from '../server/context';

export const BACKUP_FORMAT = 'ordinate-backup';
export const BACKUP_VERSION = 1;
const MANIFEST = 'backup.json';
const EXPIRED = { ok: false, error: 'That upload has expired. Choose the file again.' };

interface BackupManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  projects: Array<{ file: string; name: string; counts: Record<string, number> }>;
}

/** The upload behind a token, or null when it is unknown, used or expired. */
function upload(token: unknown): Upload | null {
  try {
    return resolveUpload(token);
  } catch (err) {
    if (err instanceof FileTokenError) return null;
    throw err;
  }
}

/** Every project → one zip in the org's temp(). The file is the download route's to delete. */
async function writeBackup(job: { progress(p: number, note?: string): void; checkCancelled(): void }) {
  const list = await projects.listProjects();
  const entries: bundle.ZipEntry[] = [];
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    appVersion: (require('../../package.json') as { version: string }).version,
    exportedAt: new Date().toISOString(),
    projects: [],
  };
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const note = `${p.name} (${i + 1} of ${list.length})`;
    // ponytail: every bundle is held in memory until the zip is written — fine
    // for an org's records and Parquet up to a few GB; stream entries to disk if
    // an org outgrows that.
    const out = await bundle.exportProject(p.id, {
      onProgress: (f) => job.progress((i + f) / Math.max(1, list.length), note),
      checkCancelled: () => job.checkCancelled(),
    });
    if (!out) continue; // removed while the backup ran
    const file = `${folderName(p)}.ordinate`;
    entries.push({ name: file, data: out.bytes });
    manifest.projects.push({ file, name: p.name, counts: out.manifest.counts });
  }
  entries.unshift({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  const bytes = await bundle.writeZipAsync(entries);
  const file = path.join(appPaths.temp(), `backup-${randomUUID()}.zip`);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, bytes, { mode: 0o600 });
  return { file, count: manifest.projects.length, at: manifest.exportedAt };
}

/** A backup file's projects, checked as a whole before anything is imported. */
export async function readBackup(bytes: Buffer): Promise<{ manifest: BackupManifest; bundles: Map<string, Buffer> } | { error: string }> {
  let entries: bundle.ZipEntry[];
  try {
    entries = await bundle.readZipAsync(bytes);
  } catch (_) {
    return { error: 'That file is not an Ordinate backup.' };
  }
  const head = entries.find((e) => e.name === MANIFEST);
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(head ? head.data.toString('utf8') : '') as BackupManifest;
  } catch (_) {
    return { error: 'That file is not an Ordinate backup (no readable backup.json).' };
  }
  if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_VERSION || !Array.isArray(manifest.projects)) {
    return { error: 'That is not an Ordinate backup, or it is from a newer version.' };
  }
  const bundles = new Map<string, Buffer>();
  for (const e of entries) if (e.name !== MANIFEST) bundles.set(e.name, e.data);
  // The listed projects and the files present must be the same set: a file
  // the manifest does not name is how a crafted backup would smuggle one in,
  // and a listed file that is missing is a truncated backup.
  const listed = new Set(manifest.projects.map((p) => (p && typeof p.file === 'string' ? p.file : '')));
  const same = listed.size === manifest.projects.length && listed.size === bundles.size && [...bundles.keys()].every((n) => listed.has(n) && /^[^/\\]+\.ordinate$/.test(n));
  if (!same) return { error: 'The backup does not match its own list of projects — it was refused as a whole.' };
  return { manifest, bundles };
}

export function register(): void {
  // ── Assistant rules, auto-refresh, alert notifications (config, per org) ──
  ipcMain.handle('rules:set', (_e, { text }: { text: string }) => config.setGlobalRules(text));
  ipcMain.handle('autorefresh:set', (_e, on: boolean) => config.setAutoRefreshEnabled(on));
  ipcMain.handle('notifications:set', (_e, { fields }: { fields: { alerts?: boolean; alertExplain?: boolean } }) =>
    config.setNotifications(fields));

  // ── The workspace logo, uploaded ─────────────────────────────────────────
  ipcMain.handle('branding:setLogo', async (_e, { fileToken }: { fileToken: string }) => {
    const up = upload(fileToken);
    if (!up) return EXPIRED;
    try {
      const st = await fs.promises.stat(up.path);
      if (st.size > LOGO_MAX_BYTES) return { ok: false, error: `That logo is ${Math.round(st.size / 1024)} KB — the limit is ${LOGO_MAX_BYTES / 1024} KB.` };
      const saved = await saveLogo(appPaths.userData(), 'workspace', await fs.promises.readFile(up.path));
      if (!saved.ok) return saved;
      config.save({ branding: { ...config.get().branding, logo: saved.kind } });
      return { ok: true, dataUrl: await readLogoDataUrl(appPaths.userData(), 'workspace') };
    } finally {
      up.done();
    }
  });

  // ── Backups ──────────────────────────────────────────────────────────────
  ipcMain.handle('backups:download', async () => {
    const job = jobs.submit({
      kind: 'backup',
      label: 'Back up all projects',
      run: (j) => writeBackup(j),
      resultOf: (r) => ({ message: `${r.count} project${r.count === 1 ? '' : 's'} backed up` }),
    });
    try {
      const r = await job.done;
      const stamp = r.at.slice(0, 10);
      return { ok: true, count: r.count, ...offerDownload(r.file, `Ordinate backup ${ctx().org.id} ${stamp}.zip`) };
    } catch (err) {
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err instanceof Error ? err.message : 'The backup failed.' };
    }
  });

  ipcMain.handle('backups:restore', async (_e, { fileToken }: { fileToken: string; confirm: 'restore' }) => {
    const up = upload(fileToken);
    if (!up) return EXPIRED;
    try {
      const read = await readBackup(await fs.promises.readFile(up.path));
      if ('error' in read) return { ok: false, error: read.error };
      const { manifest, bundles } = read;
      const at = new Date(manifest.exportedAt);
      const when = Number.isFinite(at.getTime()) ? at : new Date();
      const job = jobs.submit({
        kind: 'restore',
        label: 'Restore a backup',
        run: async (j) => {
          const restored: Array<{ id: string; name: string }> = [];
          const failed: Array<{ name: string; error: string }> = [];
          for (let i = 0; i < manifest.projects.length; i++) {
            const p = manifest.projects[i];
            const name = restoredName(String(p.name || 'Project'), when);
            const r = await bundle.importBundle(bundles.get(p.file) as Buffer, {
              name,
              onProgress: (f, note) => j.progress((i + f) / manifest.projects.length, note),
              checkCancelled: () => j.checkCancelled(),
            });
            if (r.ok && r.project) restored.push({ id: r.project.id, name: r.project.name });
            else failed.push({ name, error: r.error || 'Could not be restored.' });
          }
          return { restored, failed };
        },
        resultOf: (r) => ({ message: `${r.restored.length} project${r.restored.length === 1 ? '' : 's'} restored` }),
      });
      const r = await job.done;
      return { ok: true, ...r };
    } catch (err) {
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err instanceof Error ? err.message : 'The backup could not be restored.' };
    } finally {
      up.done();
    }
  });
}
