// Settings (T2.14) — the SERVER forms of the desktop handlers that cannot load
// on a server, plus the org backup. MAIN (server) only: registered by
// src/server/app.ts registerHandlers(); the desktop's src/ipc/providers.ts and
// its backup schedule went with the desktop app at the T8.1 cutover.
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
import { MAX_ENTRIES, MAX_TOTAL_BYTES, RECORD_MAX_BYTES } from '../app/bundleRules';
import { notABackup } from '../app/bundleMessages';
import { openZip, ZipRefused, type ZipEntryInfo, type ZipPolicy, type ZipReader, type ZipSource } from '../app/zipReader';
import { ZipFileWriter } from '../app/zipWriter';
import type { JobContext } from '../app/jobs';
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
async function upload(token: unknown): Promise<Upload | null> {
  try {
    return await resolveUpload(token);
  } catch (err) {
    if (err instanceof FileTokenError) return null;
    throw err;
  }
}

/**
 * Every project → one zip in the org's temp(), written entry by entry: each
 * project's bundle is added STORED (it is deflated already) the moment it is
 * exported, so memory holds one project, never the org. backup.json goes last —
 * its counts are known only then; a reader finds it by name. The file is the
 * download route's to delete.
 */
export async function writeBackup(job: { progress(p: number, note?: string): void; checkCancelled(): void }) {
  const list = await projects.listProjects();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    appVersion: (require('../../package.json') as { version: string }).version,
    exportedAt: new Date().toISOString(),
    projects: [],
  };
  const file = path.join(appPaths.temp(), `backup-${randomUUID()}.zip`);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const zip = await ZipFileWriter.create(file);
  try {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const note = `${p.name} (${i + 1} of ${list.length})`;
      // ponytail: one project's bundle is built in memory (~3× its size) — the
      // export's ceiling; stream exportProject to a file if a project nears the pod's memory.
      const out = await bundle.exportProject(p.id, {
        onProgress: (f) => job.progress((i + f) / Math.max(1, list.length), note),
        checkCancelled: () => job.checkCancelled(),
      });
      if (!out) continue; // removed while the backup ran
      const name = `${folderName(p)}.ordinate`;
      await zip.add(name, out.bytes, { store: true });
      manifest.projects.push({ file: name, name: p.name, counts: out.manifest.counts });
    }
    await zip.add(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    await zip.close();
  } catch (err) {
    await zip.abort();
    throw err;
  }
  return { file, count: manifest.projects.length, at: manifest.exportedAt };
}

/** The reader's policy for a backup: backup.json and one bundle per project. The names are keys, never paths. */
const BACKUP_POLICY: ZipPolicy = {
  refuseName: (name) => (name === MANIFEST || /^[^/\\]+\.ordinate$/.test(name) ? null : notABackup()),
  capOf: (name) => (name === MANIFEST ? RECORD_MAX_BYTES : MAX_TOTAL_BYTES),
  maxEntries: MAX_ENTRIES,
  maxTotal: MAX_TOTAL_BYTES,
};

/**
 * Restore a backup file, INSIDE its job: checked as a whole first (its list and
 * its files must be the same set), then each project imported as a new one. One
 * handle on the upload for the whole run; a stored bundle is read in place, a
 * deflated one (a backup an earlier version wrote) is unpacked to temp first. One byte budget across every project.
 */
export async function restoreBackupFile(file: string, j: JobContext): Promise<{ restored: Array<{ id: string; name: string }>; failed: Array<{ name: string; error: string }> }> {
  const fh = await fs.promises.open(file, 'r');
  try {
    let outer: ZipReader;
    try {
      outer = await openZip({ fh, offset: 0, length: (await fh.stat()).size }, BACKUP_POLICY);
    } catch (err) {
      if (err instanceof ZipRefused) throw new Error(notABackup());
      throw err;
    }
    const head = outer.get(MANIFEST);
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(head ? (await outer.read(head, j.signal)).toString('utf8') : '') as BackupManifest;
    } catch (_) {
      throw new Error('That file is not an Ordinate backup (no readable backup.json).');
    }
    if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_VERSION || !Array.isArray(manifest.projects)) {
      throw new Error('That is not an Ordinate backup, or it is from a newer version.');
    }
    // The listed projects and the files present must be the same set: a file
    // the manifest does not name is how a crafted backup would smuggle one in,
    // and a listed file that is missing is a truncated backup.
    const files = outer.entries.map((e) => e.name).filter((n) => n !== MANIFEST);
    const listed = new Set(manifest.projects.map((p) => (p && typeof p.file === 'string' ? p.file : '')));
    const same = listed.size === manifest.projects.length && listed.size === files.length && files.every((n) => listed.has(n));
    if (!same) throw new Error('The backup does not match its own list of projects — it was refused as a whole.');

    const at = new Date(manifest.exportedAt);
    const when = Number.isFinite(at.getTime()) ? at : new Date();
    const budget = { left: MAX_TOTAL_BYTES };
    const restored: Array<{ id: string; name: string }> = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (let i = 0; i < manifest.projects.length; i++) {
      const p = manifest.projects[i];
      const name = restoredName(String(p.name || 'Project'), when);
      const e = outer.get(p.file) as ZipEntryInfo;
      let tmp: string | null = null;
      try {
        let source: ZipSource;
        if (e.method === 0) {
          await outer.verify(e, j.signal);
          source = outer.range(e);
        } else {
          tmp = path.join(appPaths.temp(), `restore-${randomUUID()}.ordinate`);
          await outer.extract(e, tmp, j.signal);
          source = { file: tmp };
        }
        const r = await bundle.importBundle(source, {
          name,
          budget,
          signal: j.signal,
          onProgress: (f, note) => j.progress((i + f) / manifest.projects.length, note),
          checkCancelled: () => j.checkCancelled(),
        });
        if (r.ok && r.project) restored.push({ id: r.project.id, name: r.project.name });
        else failed.push({ name, error: r.error || 'Could not be restored.' });
      } catch (err) {
        if (err instanceof ZipRefused) failed.push({ name, error: err.message });
        else throw err;
      } finally {
        if (tmp) await fs.promises.rm(tmp, { force: true });
      }
    }
    return { restored, failed };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

export function register(): void {
  // ── Assistant rules, auto-refresh, alert notifications (config, per org) ──
  ipcMain.handle('rules:set', (_e, { text }: { text: string }) => config.setGlobalRules(text));
  ipcMain.handle('autorefresh:set', (_e, on: boolean) => config.setAutoRefreshEnabled(on));
  ipcMain.handle('notifications:set', (_e, { fields }: { fields: { alerts?: boolean; alertExplain?: boolean } }) =>
    config.setNotifications(fields));

  // ── The workspace logo, uploaded ─────────────────────────────────────────
  ipcMain.handle('branding:setLogo', async (_e, { fileToken }: { fileToken: string }) => {
    const up = await upload(fileToken);
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
      return { ok: true, count: r.count, ...(await offerDownload(r.file, `Ordinate backup ${ctx().org.id} ${stamp}.zip`)) };
    } catch (err) {
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err instanceof Error ? err.message : 'The backup failed.' };
    }
  });

  // The RPC only resolves the upload and hands it to the job; the job reads it
  // (restoreBackupFile). The upload is deleted when the job is over, never before.
  ipcMain.handle('backups:restore', async (_e, { fileToken }: { fileToken: string; confirm: 'restore' }) => {
    const up = await upload(fileToken);
    if (!up) return EXPIRED;
    try {
      const job = jobs.submit({
        kind: 'restore',
        label: 'Restore a backup',
        run: (j) => restoreBackupFile(up.path, j),
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
