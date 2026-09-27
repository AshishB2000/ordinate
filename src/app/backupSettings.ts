// The `backups` block of config.json — MAIN ONLY. Electron-free, so config.ts
// can import it without a cycle and a plain-node test can run it.
//
// `folder` is only ever set by main from a native folder picker (see
// src/ipc/backups.ts): a renderer that could name the folder could name any
// place on disk to write to. '' means the default, <userData>/backups.

import * as path from 'path';

export type BackupCadence = 'off' | 'daily' | 'weekly';

export interface BackupSettings {
  folder: string;
  cadence: BackupCadence;
  /** Scheduled backups kept per project. Safety copies are counted apart. */
  keep: number;
  lastRunAt?: string;
  lastError?: string;
}

export const CADENCES: readonly BackupCadence[] = ['off', 'daily', 'weekly'];
export const BACKUP_DEFAULTS: BackupSettings = { folder: '', cadence: 'daily', keep: 7 };

// ponytail: raw disk/IPC JSON — every field is checked before it is kept.
export function sanitizeBackups(raw: any): BackupSettings {
  const out: BackupSettings = { ...BACKUP_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.folder === 'string' && path.isAbsolute(raw.folder)) out.folder = raw.folder;
  if (CADENCES.includes(raw.cadence)) out.cadence = raw.cadence;
  const keep = Math.round(Number(raw.keep));
  if (Number.isFinite(keep)) out.keep = Math.min(100, Math.max(1, keep));
  if (typeof raw.lastRunAt === 'string' && Number.isFinite(Date.parse(raw.lastRunAt))) out.lastRunAt = raw.lastRunAt;
  if (typeof raw.lastError === 'string' && raw.lastError) out.lastError = raw.lastError.slice(0, 400);
  return out;
}
