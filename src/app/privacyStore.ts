// Privacy state on disk — MAIN PROCESS ONLY.
//
// Three small files under userData/projects/<pid>/privacy/:
//
//   salt.key     the project's masking key: 32 random bytes, hex. Created the
//                first time something needs it (a hash step, a masked export),
//                mode 0600, never overwritten. It NEVER leaves this folder: not
//                in a dataset record or its steps, not in an IPC reply, not in a
//                bundle (bundle.ts whitelists what travels and this is not on
//                it), not in a log line. Everything that needs it calls getSalt
//                here, in main. On a server with a key store (DATABASE_URL and
//                ORDINATE_MASTER_KEY) it is not a file: it is the encrypted secret
//                ('privacy.salt', project id), the same on every pod and every
//                fresh disk — a file an earlier version left seeds it.
//   policy.json  the Share policy — what exports, reports, publish and bundles
//                do with a sensitive column: 'mask' (default), 'drop' or
//                'include'. Sanitised on every read.
//   review.json  detection proposals waiting for the user, and the columns the
//                user said are NOT sensitive, per dataset. A proposal is never
//                applied here: accepting one writes the level through
//                catalog.setColumn, which is where sensitivity lives.
//
// Conventions from catalog.ts: UUID-check every id before it reaches a path,
// atomic temp-sibling-then-rename writes, a corrupt file reads as EMPTY, and
// every read-modify-write of one file is serialised per project.

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { projectDir, isValidId } from './recordKinds';
import * as catalog from './catalog';
import { detectSensitive } from '../data/sensitivity';
import type { SensitivityProposal, SensitiveKind } from '../data/sensitivity';
import type { ParsedColumn } from '../data/parse';
import type { Cell, TransformStep } from '../data/transforms';
import * as recordFs from './recordFs';
import { ctx, orgKey, serverDataDir } from '../server/context';
import type { MintingSecretStore } from '../server/secrets/store';

export type ShareAction = 'mask' | 'drop' | 'include';
export type SharePath = 'export' | 'report' | 'publish' | 'bundle';
export type SharePolicy = Record<SharePath, ShareAction>;

export const SHARE_PATHS: readonly SharePath[] = ['export', 'report', 'publish', 'bundle'];
const ACTIONS: ReadonlySet<string> = new Set(['mask', 'drop', 'include']);
export const DEFAULT_POLICY: SharePolicy = { export: 'mask', report: 'mask', publish: 'mask', bundle: 'mask' };

const MAX_COLUMN_NAME = 256;
const MAX_PROPOSALS = 500;
const MAX_DISMISSED = 2000;

function privacyDir(projectId: string): string {
  const dir = projectDir(projectId);
  return dir ? path.join(dir, 'privacy') : '';
}

async function writeAtomic(file: string, data: string, mode?: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, data, mode ? { encoding: 'utf8', mode } : 'utf8');
  await recordFs.rename(tmp, file);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await recordFs.readFile(file, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') console.error('[privacy] unreadable', path.basename(file), '— treating as empty');
    return null;
  }
}

// One promise chain per project FILE: overlapping read-modify-writes would drop one.
const chains = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(key, next);
  try {
    return await next;
  } finally {
    if (chains.get(key) === next) chains.delete(key);
  }
}

// ── The salt ─────────────────────────────────────────────────────────────────

const SALT_RE = /^[0-9a-f]{64}$/;
// Keyed by the salt's path, which carries the org: project ids repeat across orgs.
const saltCache = new Map<string, string>();

/** Where the salt lives. Exported for the tests that prove it stays there. */
export function saltPath(projectId: string): string {
  const dir = privacyDir(projectId);
  return dir ? path.join(dir, 'salt.key') : '';
}

/** A hash step needs the project's masking key and it cannot be read: the step refuses rather than pass values through. */
export class MaskKeyUnavailableError extends Error {
  constructor() {
    super('This project\'s masking key is not available, so its hash steps cannot run. Ask an admin to check the server\'s key store.');
    this.name = 'MaskKeyUnavailableError';
  }
}

// The server's encrypted store (app.ts), when it has one: the salt is a secret
// there, not a file on this pod's disk. Null: the file, below.
let saltStore: MintingSecretStore | null = null;

export function useMaskSaltStore(store: MintingSecretStore | null): void {
  saltStore = store;
  saltCache.clear();
}

const storeOn = (): MintingSecretStore | null => (serverDataDir() !== null ? saltStore : null);
const saltChain = (projectId: string): string => orgKey(saltPath(projectId));

/** Store `salt` unless one is stored; the stored one. Inside the project's salt chain. */
async function seedLocked(store: MintingSecretStore, projectId: string, salt: string): Promise<string | null> {
  const got = await store.putIfAbsent(ctx().org.id, 'privacy.salt', projectId, salt);
  if (!SALT_RE.test(got)) return null;
  saltCache.set(saltPath(projectId), got);
  return got;
}

/** The store's salt; on none, this pod's legacy file seeds it, or one is minted. null on any failure — never a new key then. */
async function storedSalt(store: MintingSecretStore, projectId: string): Promise<string | null> {
  try {
    const have = await store.get(ctx().org.id, 'privacy.salt', projectId);
    if (have !== null) {
      if (!SALT_RE.test(have)) return null;
      saltCache.set(saltPath(projectId), have);
      return have;
    }
    let legacy: string | null = null;
    try {
      legacy = (await fs.promises.readFile(saltPath(projectId), 'utf8')).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (legacy !== null && !SALT_RE.test(legacy)) {
      // As below: a damaged key is not replaced — every token hashed under it would change meaning.
      console.error('[privacy] the masking key file is damaged; hash steps refuse until it is removed. Project', projectId);
      return null;
    }
    if (legacy === null && !(await recordFs.exists(projectDir(projectId)))) return null;
    return await seedLocked(store, projectId, legacy ?? randomBytes(32).toString('hex'));
  } catch (_) {
    console.error('[privacy] the masking key could not be read from the key store. Project', projectId);
    return null;
  }
}

/**
 * The project's masking key, created on first use. null for an invalid id or a
 * project that does not exist — a key is never minted for a folder nobody owns.
 */
export async function getSalt(projectId: string): Promise<string | null> {
  if (!isValidId(projectId)) return null;
  const hit = saltCache.get(saltPath(projectId));
  if (hit) return hit;
  return serial(saltChain(projectId), async () => {
    const again = saltCache.get(saltPath(projectId));
    if (again) return again;
    const store = storeOn();
    if (store) return storedSalt(store, projectId);
    const file = saltPath(projectId);
    try {
      const s = (await recordFs.readFile(file, 'utf8')).trim();
      if (SALT_RE.test(s)) {
        saltCache.set(saltPath(projectId), s);
        return s;
      }
      // A damaged key is NOT silently replaced: every token hashed under it
      // would change meaning. The hash step refuses instead.
      console.error('[privacy] the masking key is damaged; hash steps will refuse until it is removed');
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    try {
      await recordFs.access(projectDir(projectId));
    } catch (_) {
      return null;
    }
    const salt = randomBytes(32).toString('hex');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + randomUUID() + '.tmp';
    await recordFs.writeFile(tmp, salt, { encoding: 'utf8', mode: 0o600 });
    try {
      // link, not rename: it refuses to replace a key that appeared meanwhile.
      await fs.promises.link(tmp, file);
    } catch (_) {
      await recordFs.rm(tmp, { force: true });
      saltCache.delete(saltPath(projectId));
      const s = (await recordFs.readFile(file, 'utf8').catch(() => '')).trim();
      if (!SALT_RE.test(s)) return null;
      saltCache.set(saltPath(projectId), s);
      return s;
    }
    await recordFs.rm(tmp, { force: true });
    saltCache.set(saltPath(projectId), salt);
    return salt;
  });
}

/** import-desktop: a desktop project's key becomes the stored one, unless one is stored already. The stored one, or null. */
export async function seedSalt(projectId: string, salt: string): Promise<string | null> {
  const store = storeOn();
  if (!store || !isValidId(projectId) || !SALT_RE.test(salt)) return null;
  return serial(saltChain(projectId), () => seedLocked(store, projectId, salt));
}

/** A deleted project's key goes with it. (On disk it went with the folder.) */
export async function dropSalt(projectId: string): Promise<void> {
  if (!isValidId(projectId)) return;
  const store = storeOn();
  await serial(saltChain(projectId), async () => {
    saltCache.delete(saltPath(projectId));
    if (store) await store.delete(ctx().org.id, 'privacy.salt', projectId);
  });
}

/** The salt when `steps` hash something; undefined otherwise, so no key is minted for nothing. Throws when it is needed and unavailable. */
export async function saltForSteps(projectId: string, steps: TransformStep[] | undefined): Promise<string | undefined> {
  if (!Array.isArray(steps) || !steps.some((s) => s && s.type === 'mask_hash')) return undefined;
  const salt = await getSalt(projectId);
  if (!salt) throw new MaskKeyUnavailableError();
  return salt;
}

// ── The share policy ─────────────────────────────────────────────────────────

export function sanitizePolicy(raw: unknown): SharePolicy {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_POLICY };
  for (const p of SHARE_PATHS) if (typeof o[p] === 'string' && ACTIONS.has(o[p] as string)) out[p] = o[p] as ShareAction;
  return out;
}

export function isSharePath(v: unknown): v is SharePath {
  return typeof v === 'string' && (SHARE_PATHS as readonly string[]).includes(v);
}

function policyPath(projectId: string): string {
  const dir = privacyDir(projectId);
  return dir ? path.join(dir, 'policy.json') : '';
}

export async function getPolicy(projectId: string): Promise<SharePolicy> {
  if (!isValidId(projectId)) return { ...DEFAULT_POLICY };
  return sanitizePolicy(await readJson(policyPath(projectId)));
}

/** Merge the paths present in `patch`. Returns the stored policy, or null for a bad id. */
export async function setPolicy(projectId: string, patch: unknown): Promise<SharePolicy | null> {
  if (!isValidId(projectId)) return null;
  try { await recordFs.access(projectDir(projectId)); } catch (_) { return null; }
  return serial('policy:' + projectId, async () => {
    const cur = await getPolicy(projectId);
    const next = sanitizePolicy({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) });
    await writeAtomic(policyPath(projectId), JSON.stringify(next, null, 2));
    return next;
  });
}

// ── Review: pending proposals and dismissals ─────────────────────────────────

export interface DatasetReview {
  pending: SensitivityProposal[];
  /** Columns the user said are not sensitive — never proposed again. */
  dismissed: string[];
}

type ReviewFile = Record<string, DatasetReview>;

const KINDS: ReadonlySet<string> = new Set(['email', 'phone', 'national_id', 'card_number', 'iban', 'ip_address',
  'street_address', 'person_name', 'birth_date', 'salary']);

function colName(v: unknown): string | null {
  return typeof v === 'string' && v && v.length <= MAX_COLUMN_NAME ? v : null;
}

function sanitizeReview(raw: unknown): ReviewFile {
  const out: ReviewFile = Object.create(null) as ReviewFile;
  const ds = raw && typeof raw === 'object' ? ((raw as Record<string, unknown>).datasets as Record<string, unknown>) : null;
  if (!ds || typeof ds !== 'object') return out;
  for (const id of Object.keys(ds)) {
    if (!isValidId(id)) continue;
    const r = (ds[id] && typeof ds[id] === 'object' ? ds[id] : {}) as Record<string, unknown>;
    const pending: SensitivityProposal[] = [];
    for (const p of Array.isArray(r.pending) ? r.pending.slice(0, MAX_PROPOSALS) : []) {
      const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      const column = colName(o.column);
      if (!column || !KINDS.has(String(o.kind)) || (o.level !== 'personal' && o.level !== 'financial')) continue;
      pending.push({ column, kind: o.kind as SensitiveKind, level: o.level, reason: String(o.reason || '').slice(0, 300) });
    }
    const dismissed = (Array.isArray(r.dismissed) ? r.dismissed : []).map(colName).filter((c): c is string => !!c).slice(0, MAX_DISMISSED);
    out[id] = { pending, dismissed };
  }
  return out;
}

function reviewPath(projectId: string): string {
  const dir = privacyDir(projectId);
  return dir ? path.join(dir, 'review.json') : '';
}

async function loadReview(projectId: string): Promise<ReviewFile> {
  return sanitizeReview(await readJson(reviewPath(projectId)));
}

async function mutateReview<T>(projectId: string, fn: (file: ReviewFile) => T): Promise<T> {
  return serial('review:' + projectId, async () => {
    const file = await loadReview(projectId);
    const result = fn(file);
    await writeAtomic(reviewPath(projectId), JSON.stringify({ schemaVersion: 1, datasets: file }, null, 2));
    return result;
  });
}

/** Every dataset's review in one read (Settings → Privacy). */
export async function allReviews(projectId: string): Promise<Record<string, DatasetReview>> {
  if (!isValidId(projectId)) return {};
  return loadReview(projectId);
}

export async function getReview(projectId: string, datasetId: string): Promise<DatasetReview> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return { pending: [], dismissed: [] };
  const file = await loadReview(projectId);
  return file[datasetId] || { pending: [], dismissed: [] };
}

/**
 * Detect over a freshly imported or refreshed table and store what is NEW as
 * pending: a column already marked personal/financial in the catalog, or
 * dismissed by the user, is never proposed again. The stored list is REPLACED,
 * so a column that no longer looks sensitive (or no longer exists) drops off.
 * Never throws — a detection failure must not fail an import or a refresh.
 */
export async function scanDataset(
  projectId: string,
  ds: { id: string; columns: ParsedColumn[]; rows: Cell[][] } | null | undefined,
): Promise<SensitivityProposal[]> {
  try {
    if (!ds || !isValidId(projectId) || !isValidId(ds.id)) return [];
    const found = detectSensitive(ds.columns, ds.rows);
    // Nothing found and nothing on file: no write, so an ordinary import never
    // creates a privacy/ folder it does not need.
    if (!found.length && !(ds.id in (await loadReview(projectId)))) return [];
    const docs = await catalog.getColumns(projectId, ds.id);
    const decided = (c: string): boolean =>
      Object.prototype.hasOwnProperty.call(docs, c) && docs[c].sensitivity !== 'none';
    return await mutateReview(projectId, (file) => {
      const cur = file[ds.id] || { pending: [], dismissed: [] };
      const pending = found.filter((p) => !decided(p.column) && !cur.dismissed.includes(p.column));
      if (!pending.length && !cur.dismissed.length) delete file[ds.id];
      else file[ds.id] = { pending, dismissed: cur.dismissed };
      return pending;
    });
  } catch (err) {
    console.error('[privacy] sensitivity scan failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * The user's answer for one column. 'personal'/'financial' writes the level
 * through the catalog; 'none' remembers the dismissal. Either way the column
 * leaves the pending list.
 */
export async function decide(projectId: string, datasetId: string, column: string, level: unknown): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(datasetId) || !colName(column)) return false;
  if (level !== 'personal' && level !== 'financial' && level !== 'none') return false;
  if (level !== 'none') {
    const doc = await catalog.setColumn(projectId, datasetId, column, { sensitivity: level });
    if (!doc) return false;
  }
  await mutateReview(projectId, (file) => {
    const cur = file[datasetId] || { pending: [], dismissed: [] };
    const pending = cur.pending.filter((p) => p.column !== column);
    const dismissed = cur.dismissed.filter((c) => c !== column);
    if (level === 'none') dismissed.push(column);
    if (!pending.length && !dismissed.length) delete file[datasetId];
    else file[datasetId] = { pending, dismissed };
  });
  return true;
}
