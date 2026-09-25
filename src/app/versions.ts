// Version history — every save of a record, kept. MAIN PROCESS ONLY.
//
// userData/projects/<projectId>/history/<type>/<recordId>/<iso>.json, one file
// per save, holding the record's CONTENT (recordDiff.contentOf) plus the
// app-written summary of what changed against the save before it.
//
// Rules this module keeps, and why:
//
//   · APPEND-ONLY. A restore is a new save of an old version, written through
//     the record's own store (src/ipc/versions.ts), then recorded here like any
//     other. Nothing ever edits or deletes a version except the cap below.
//   · CAPPED at 50 per record, oldest pruned — a dashboard autosaves on idle,
//     and an unbounded directory is a disk leak with a nice name.
//   · A save that changed nothing versioned is NOT a version (a favourite
//     toggle, a rename to the same name). Compared on canonical content.
//   · Written atomically (temp sibling, then rename), like every store here.
//   · Every id is UUID-checked and every file key shape-checked before either
//     reaches a path.
//
// <iso> is the save time with ':' and '.' turned into '-' — Windows refuses a
// colon in a filename, and the key still sorts in time order as a string.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { projectDir, isValidId } from './recordKinds';
import type { FileRecordType } from './recordKinds';
import { contentOf, sameContent, summarize } from '../analysis/recordDiff';

export const MAX_VERSIONS = 50;

const TYPES: ReadonlySet<string> = new Set(['dataset', 'visual', 'dashboard', 'metric', 'report']);
const KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d{1,3})?$/;

export interface VersionFile {
  savedAt: string;
  summary: string;
  /** Set on the save a Restore wrote: the savedAt of the version it brought back. */
  restoredFrom?: string;
  // ponytail: content of one of five record shapes; its own store re-sanitizes on restore
  record: Record<string, any>;
}

export interface VersionMeta {
  key: string;
  savedAt: string;
  summary: string;
  restoredFrom?: string;
  /** Dashboards only: the first sheet's tiles as {x,y,w,h,type} — enough to
   *  draw a thumbnail of the layout without shipping every card. */
  thumb?: Array<{ x: number; y: number; w: number; h: number; type: string }>;
}

export function isVersionType(t: unknown): t is FileRecordType {
  return typeof t === 'string' && TYPES.has(t);
}

function recordDir(projectId: string, type: string, recordId: string): string {
  const base = projectDir(projectId);
  if (!base || !isVersionType(type) || !isValidId(recordId)) return '';
  return path.join(base, 'history', type, recordId);
}

/** The whole history tree of one record — Trash's permanent delete removes it. */
export async function forget(projectId: string, type: string, recordId: string): Promise<void> {
  const dir = recordDir(projectId, type, recordId);
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
}

function keyFor(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

async function keys(dir: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && KEY_RE.test(n.slice(0, -5)))
    .map((n) => n.slice(0, -5))
    .sort();
}

async function readVersion(dir: string, key: string): Promise<VersionFile | null> {
  try {
    const data = JSON.parse(await fs.promises.readFile(path.join(dir, key + '.json'), 'utf8'));
    if (!data || typeof data !== 'object' || !data.record || typeof data.savedAt !== 'string') return null;
    return data as VersionFile;
  } catch (_) {
    return null;
  }
}

/**
 * Record a save. Returns the new version's meta, or null when nothing was
 * written (bad ids, or content identical to the newest version). Never throws:
 * a history write that fails must not fail the save it rides on.
 */
export function record(
  projectId: string,
  type: FileRecordType,
  // ponytail: any stored record; contentOf picks the versioned fields
  rec: any,
  opts: RecordOpts = {},
): Promise<VersionMeta | null> {
  const dir = recordDir(projectId, type, rec && rec.id);
  if (!dir) return Promise.resolve(null);
  // One record's saves are written one at a time: two overlapping autosaves
  // would otherwise both diff against the same "newest" and both prune.
  const run = (queues.get(dir) || Promise.resolve(null)).then(() => write(dir, type, rec, opts));
  queues.set(dir, run);
  void run.then(() => { if (queues.get(dir) === run) queues.delete(dir); });
  return run;
}

const queues = new Map<string, Promise<VersionMeta | null>>();

export interface RecordOpts {
  restoredFrom?: string;
  now?: Date;
  /**
   * The record as it stood BEFORE this save. Used once: a record that has no
   * history yet (anything made before this feature, or by the sample seeder,
   * which writes through the stores directly) gets its pre-edit state kept as
   * the first version, so its first edit is undoable and is summarised as the
   * edit it was rather than as "First saved version".
   */
  // ponytail: any stored record, like `rec`
  before?: any;
}

async function write(
  dir: string,
  type: FileRecordType,
  // ponytail: see record()
  rec: any,
  opts: RecordOpts,
): Promise<VersionMeta | null> {
  try {
    let existing = await keys(dir);
    if (!existing.length && opts.before && !sameContent(type, opts.before, rec)) {
      const at = Date.parse(opts.before.updatedAt);
      const base = Number.isFinite(at) && at < (opts.now || new Date()).getTime() ? new Date(at) : new Date((opts.now || new Date()).getTime() - 1);
      await write(dir, type, opts.before, { now: base });
      existing = await keys(dir);
    }
    const newest = existing.length ? await readVersion(dir, existing[existing.length - 1]) : null;
    if (newest && sameContent(type, newest.record, rec)) return null;

    const savedAt = (opts.now || new Date()).toISOString();
    let key = keyFor(savedAt);
    // Two saves in one millisecond (a restore right after a save, a test) keep both.
    for (let n = 1; existing.includes(key); n++) key = keyFor(savedAt) + '-' + n;
    const content = contentOf(type, rec);
    // The summary is the diff alone; `restoredFrom` says it was a restore, and
    // the panel words that in the reader's own clock.
    const summary = summarize(type, newest ? newest.record : null, content);
    const file: VersionFile = { savedAt, summary, record: content };
    if (opts.restoredFrom) file.restoredFrom = opts.restoredFrom;

    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, key + '.json');
    const tmp = target + '.' + randomUUID() + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(file), 'utf8');
    await fs.promises.rename(tmp, target);

    // Oldest first, so the prune is a slice off the front.
    const all = [...existing, key].sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) {
      await fs.promises.rm(path.join(dir, old + '.json'), { force: true });
    }
    return toMeta(type, key, file);
  } catch (err: any) {
    console.error('[versions] could not record a version:', err && err.message);
    return null;
  }
}

function toMeta(type: string, key: string, f: VersionFile): VersionMeta {
  const meta: VersionMeta = { key, savedAt: f.savedAt, summary: f.summary };
  if (f.restoredFrom) meta.restoredFrom = f.restoredFrom;
  if (type === 'dashboard') {
    const first = Array.isArray(f.record.sheets) ? f.record.sheets[0] : null;
    const cards = first && Array.isArray(first.cards) ? first.cards : [];
    meta.thumb = cards.map((c: any) => ({
      x: Number(c.layout && c.layout.x) || 0,
      y: Number(c.layout && c.layout.y) || 0,
      w: Number(c.layout && c.layout.w) || 1,
      h: Number(c.layout && c.layout.h) || 1,
      type: String(c.type || ''),
    }));
  }
  return meta;
}

/** Every version of one record, NEWEST first. */
export async function list(projectId: string, type: string, recordId: string): Promise<VersionMeta[]> {
  const dir = recordDir(projectId, type, recordId);
  if (!dir) return [];
  const out: VersionMeta[] = [];
  for (const key of (await keys(dir)).reverse()) {
    const f = await readVersion(dir, key);
    if (f) out.push(toMeta(type, key, f));
  }
  return out;
}

/** One version in full, or null. */
export async function get(projectId: string, type: string, recordId: string, key: string): Promise<VersionFile | null> {
  const dir = recordDir(projectId, type, recordId);
  if (!dir || typeof key !== 'string' || !KEY_RE.test(key)) return null;
  return readVersion(dir, key);
}
