// Connection metadata persistence — MAIN PROCESS ONLY.
// One JSON file per connection under
// userData/projects/<projectId>/connections/<connId>.json. Mirrors
// src/datasets.ts verbatim: the UUID id-validation guard, atomic JSON writes,
// and graceful skip of missing/corrupt files.
//
// SCHEMA v2 (2026-08). v1 hardcoded `kind: 'postgres' | 'url'` plus a fixed set
// of top-level pg fields, which meant every new data source edited this file, the
// IPC layer, the runner and the renderer. v2 stores a `connectorId` (validated
// against src/connectors) and a generic `values` bag keyed by the connector's own
// field keys. Migration is LAZY and ONE-WAY, exactly like datasets.ts v2→v3: a v1
// record is upgraded in memory on every read and rewritten as v2 the next time it
// is saved, so a user with saved connections loses nothing and a rollback still
// finds a readable file.
//
// SECURITY: this file stores ONLY non-secret metadata (name, connectorId, the
// non-secret field values, the saved table/query, status). Passwords, tokens and
// API keys live in config.json's connectionSecrets block (see src/config.ts) —
// NEVER here, so a connections/*.json stays safe to share. Any value whose field
// the connector marks `secret` is stripped on write AND on the way to a renderer,
// so a bad caller cannot smuggle one into the shareable file. BOTH projectId AND
// connId are validated as UUIDs before either is concatenated into a path, so a
// connection path can never escape userData/projects/<projectId>/connections.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import type { ConnectorDef } from './types';
import * as recordFs from '../app/recordFs';

/** v1's fixed union, kept ONLY so the migration can name what it reads. */
export type LegacyConnectionKind = 'postgres' | 'url';

/** Non-secret form values, keyed by ConnectorField.key. JSON scalars only. */
export type ConnectionValues = Record<string, string | number | boolean | null>;

/**
 * A query the user named and kept on this connection.
 *
 * The ID is what makes a rename non-destructive: a dataset imported from a
 * saved query stores `origin.queryId`, so renaming the query moves a label and
 * nothing else. It also stores the `sql` it was built from, so a dataset
 * refreshes to EXACTLY what built it even if the saved query is later edited or
 * deleted — see datasetOrigin's `connection` member.
 */
export interface SavedQuery {
  id: string; // generated UUID
  name: string;
  sql: string;
  updatedAt: string;
}

/** Enough named queries to be a library, few enough to stay a list. A
 *  connection file is loaded on every Connect visit and shipped to a renderer. */
const MAX_SAVED_QUERIES = 200;

export interface Connection {
  id: string; // generated UUID
  projectId: string;
  name: string;
  /** Which ConnectorDef runs this connection. Persisted — never rename one. */
  connectorId: string;
  /** Non-secret field values. Secrets live in config.connectionSecrets. */
  values: ConnectionValues;
  // the saved table or query the user picked (their own DB; run as-is but
  // bounded by the connector's rowLimit/timeout):
  table?: string;
  query?: string;
  /** Named queries kept on this connection. Newest-updated first. */
  queries: SavedQuery[];
  // status / telemetry:
  lastRefreshedAt: string | null;
  lastStatus: 'ok' | 'error' | 'untested';
  lastError?: string | null; // human-readable, NEVER contains a secret
  linkedDatasetId?: string | null; // set once a run result is saved as a dataset
  createdAt: string;
  updatedAt: string;
  schemaVersion: 2;
}

// The renderer-facing view. A Connection carries no secret, but the view is
// rebuilt key-by-key so a stray future field can never leak.
//
// The flat legacy fields are DERIVED, not stored: the desktop's connections.js
// still reads c.kind / c.host / c.url to label a row, and this file's job is not
// to break it. They are a read-only mirror of `values` — writing them changes
// nothing.
export interface PublicConnection {
  id: string;
  projectId: string;
  name: string;
  connectorId: string;
  values: ConnectionValues;
  table?: string;
  query?: string;
  queries: SavedQuery[];
  lastRefreshedAt: string | null;
  lastStatus: 'ok' | 'error' | 'untested';
  lastError?: string | null;
  linkedDatasetId?: string | null;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 2;
  // ── derived legacy mirror (display only) ──
  kind: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  url?: string;
}


function getProjectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
}

// Ids arrive from the renderer over IPC. Validate the SHAPE before either id ever
// reaches a filesystem path — an id like ".." or "../../foo" would otherwise
// escape the project's connections dir. Copied verbatim from datasets.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

// The registry is loaded LAZILY and behind a try/catch. This module is a pure
// metadata store — it must keep listing and reading records on a machine where a
// driver failed to load, so a registry failure degrades validation, never the
// store. (It also keeps `require('./connections')` from pulling four database
// drivers into a self-check that only touches disk.)
type Registry = typeof import('./index');
let registryCache: Registry | null | undefined;
function registry(): Registry | null {
  if (registryCache === undefined) {
    try {
      registryCache = require('./index') as Registry;
    } catch (err: unknown) {
      console.error('[connections] Connector registry unavailable:', err instanceof Error ? err.message : err);
      registryCache = null;
    }
  }
  return registryCache;
}

function connectorOf(connectorId: string): ConnectorDef | null {
  const reg = registry();
  return reg ? reg.getConnector(connectorId) : null;
}

/** True when the registry can run this id. Unknown ids are refused on WRITE
 *  (you cannot save what you cannot test) but tolerated on READ, so a record
 *  never disappears because a driver failed to load today. */
export function isKnownConnectorId(id: unknown): boolean {
  const reg = registry();
  if (!reg) return typeof id === 'string' && id.length > 0; // no registry → no opinion
  return reg.isKnownConnectorId(id);
}

// Field keys this connector routes to the secret store. Empty when the connector
// is unknown — in that case nothing is stripped, because nothing is known to be
// a secret and silently deleting a user's stored value would be worse.
function secretKeysOf(connectorId: string): ReadonlySet<string> {
  const def = connectorOf(connectorId);
  if (!def) return EMPTY_SET;
  return new Set((def.fields || []).filter((f) => f.secret === true).map((f) => f.key));
}
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

// A URL connection's metadata (incl. `url`) lives in the git-SHAREABLE
// connections/<id>.json. Inline credentials (https://user:pass@host) would leak
// a secret into that shared/exported file, so strip the userinfo before it is
// ever persisted. The intended auth path is the separate token field (kept in
// the gitignored secret store), which this does not touch.
function stripUrlUserinfo(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      return u.toString();
    }
    return url;
  } catch (_) {
    return url; // not a parseable URL — leave as-is (validated at run time)
  }
}

// Any value key that looks like a URL gets the same userinfo strip. Keyed on the
// key name rather than the connector so it also covers a v1 record read before
// its connector module is available.
function isUrlKey(key: string): boolean {
  return key === 'url' || key.toLowerCase().endsWith('url');
}

// Coerce an arbitrary bag into JSON scalars. Anything else (object, array,
// function, undefined) is dropped rather than persisted — a connection file must
// stay a flat, shareable, JSON-clonable record.
function sanitizeValues(
  input: unknown,
  secretKeys: ReadonlySet<string> = EMPTY_SET,
): ConnectionValues {
  const out: ConnectionValues = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  // ponytail: an IPC payload / disk JSON bag — every entry is type-checked below.
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key !== 'string' || !key) continue;
    if (secretKeys.has(key)) continue; // a secret NEVER enters the project file
    if (raw === null) { out[key] = null; continue; }
    if (typeof raw === 'boolean') { out[key] = raw; continue; }
    if (typeof raw === 'number') { if (Number.isFinite(raw)) out[key] = raw; continue; }
    if (typeof raw === 'string') { out[key] = isUrlKey(key) ? stripUrlUserinfo(raw) : raw; continue; }
    // everything else is dropped on purpose
  }
  return out;
}

/**
 * Whitelist an untrusted `queries` array — from disk OR an IPC payload.
 *
 * Same discipline as sanitizeValues above: keep what is recognised, drop the
 * rest, never repair. An entry without a UUID id is dropped rather than given
 * one, because a generated id here would silently orphan the dataset origins
 * that point at the real one. SQL is length-capped: this file is loaded on
 * every Connect visit and a megabyte of pasted text in it is a slow panel.
 */
const MAX_QUERY_SQL = 20_000;

function sanitizeQueries(raw: unknown): SavedQuery[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedQuery[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const q = entry as Record<string, unknown>;
    const id = typeof q.id === 'string' ? q.id : '';
    if (!isValidId(id) || seen.has(id)) continue;
    const sql = typeof q.sql === 'string' ? q.sql.slice(0, MAX_QUERY_SQL) : '';
    if (!sql.trim()) continue; // a saved query with no SQL is not a query
    seen.add(id);
    out.push({
      id,
      name: typeof q.name === 'string' && q.name.trim() ? q.name.trim().slice(0, 200) : 'Untitled query',
      sql,
      updatedAt: typeof q.updatedAt === 'string' ? q.updatedAt : new Date().toISOString(),
    });
    if (out.length >= MAX_SAVED_QUERIES) break;
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

function connectionsDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'connections');
}

function connectionFilePath(projectId: string, id: string): string {
  return path.join(connectionsDir(projectId), id + '.json');
}

const STATUSES: ReadonlySet<string> = new Set(['ok', 'error', 'untested']);

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied from
// datasets.ts so a crash mid-write never leaves a half-written connection file.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file); // atomic on same fs
}

// ── v1 → v2 migration ────────────────────────────────────────────────────────
//
// v1 record:
//   { id, projectId, name, kind: 'postgres'|'url',
//     host, port, database, user, ssl, table, query, url,
//     lastRefreshedAt, lastStatus, lastError, linkedDatasetId,
//     createdAt, updatedAt, schemaVersion: 1 }
//
// Everything above survives: `kind` becomes `connectorId` through the map below
// (the two v1 kinds are the ids of the two connectors that replaced them), the
// six source fields become `values`, and table/query/status/telemetry are
// already v2-shaped. Nothing is dropped and nothing is renamed on disk until the
// record is next written.

const LEGACY_KIND_TO_CONNECTOR: Readonly<Record<string, string>> = {
  postgres: 'postgres',
  url: 'url',
};

/** The v1 top-level keys that became `values` entries. */
const LEGACY_VALUE_KEYS: readonly string[] = ['host', 'port', 'database', 'user', 'ssl', 'url'];

function isLegacyRecord(data: Record<string, unknown>): boolean {
  return typeof data.connectorId !== 'string' || !data.connectorId;
}

// Lift a v1 record's flat source fields into a v2 `values` bag.
function migrateLegacyValues(data: Record<string, unknown>): ConnectionValues {
  const values: ConnectionValues = {};
  for (const key of LEGACY_VALUE_KEYS) {
    const raw = data[key];
    if (typeof raw === 'string') values[key] = isUrlKey(key) ? stripUrlUserinfo(raw) : raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) values[key] = raw;
    else if (typeof raw === 'boolean') values[key] = raw;
  }
  return values;
}

function migrateLegacyConnectorId(data: Record<string, unknown>): string {
  const kind = typeof data.kind === 'string' ? data.kind : '';
  return LEGACY_KIND_TO_CONNECTOR[kind] || kind || 'url';
}

// Basic shape validation for a parsed connection.json (skips corrupt files).
// Accepts BOTH schemas: a v2 record identifies its connector, a v1 record its
// kind. Deliberately does NOT consult the registry — an unknown connector is a
// record we can still list, name and delete.
function isValidConnection(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'string' || !d.id) return false;
  if (typeof d.connectorId === 'string' && d.connectorId) return true;
  return typeof d.kind === 'string' && d.kind.length > 0;
}

// Coerce a parsed object into a well-formed Connection, migrating v1 on the way.
// String fields are copied only when they are strings — never trusts disk JSON.
function normalize(data: Record<string, unknown>, projectId: string): Connection {
  const createdAt = typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString();
  const legacy = isLegacyRecord(data);
  const connectorId = legacy
    ? migrateLegacyConnectorId(data)
    : String(data.connectorId);
  // A legacy record's `values` come from its flat fields; a v2 record's from its
  // own bag. Secret keys are stripped in both directions — a value that somehow
  // reached disk must not reach a caller as if it were metadata we endorse.
  const secretKeys = secretKeysOf(connectorId);
  const values = legacy
    ? sanitizeValues(migrateLegacyValues(data), secretKeys)
    : sanitizeValues(data.values, secretKeys);
  const status = STATUSES.has(String(data.lastStatus)) ? String(data.lastStatus) : 'untested';

  const c: Connection = {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled connection',
    connectorId,
    values,
    lastRefreshedAt: typeof data.lastRefreshedAt === 'string' ? data.lastRefreshedAt : null,
    lastStatus: status as Connection['lastStatus'],
    lastError: typeof data.lastError === 'string' ? data.lastError : null,
    linkedDatasetId: typeof data.linkedDatasetId === 'string' ? data.linkedDatasetId : null,
    createdAt,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : createdAt,
    schemaVersion: 2,
    // A v1 record (and every v2 record written before the workbench) simply has
    // none, which reads back as an empty library rather than a broken record.
    queries: sanitizeQueries(data.queries),
  };
  if (typeof data.table === 'string') c.table = data.table;
  if (typeof data.query === 'string') c.query = data.query;
  return c;
}

// Whitelisted copy of a connection for the renderer. There is no secret in a
// Connection, but we rebuild it field-by-field rather than pass the object
// through, so nothing unexpected ever rides along — plus one belt-and-braces
// pass that drops any `values` key the connector marks `secret`.
export function publicConnection(c: Connection): PublicConnection {
  const values = sanitizeValues(c.values, secretKeysOf(c.connectorId));
  const out: PublicConnection = {
    id: c.id,
    projectId: c.projectId,
    name: c.name,
    connectorId: c.connectorId,
    values,
    table: c.table,
    query: c.query,
    lastRefreshedAt: c.lastRefreshedAt,
    lastStatus: c.lastStatus,
    lastError: c.lastError ?? null,
    linkedDatasetId: c.linkedDatasetId ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    schemaVersion: 2,
    // Rebuilt, like everything else here: a saved query is user text and holds
    // no secret, but it travels through the same whitelist as the rest.
    queries: sanitizeQueries(c.queries),
    // derived display mirror — see PublicConnection
    kind: c.connectorId,
  };
  if (typeof values.host === 'string') out.host = values.host;
  if (typeof values.port === 'number') out.port = values.port;
  if (typeof values.database === 'string') out.database = values.database;
  if (typeof values.user === 'string') out.user = values.user;
  if (typeof values.ssl === 'boolean') out.ssl = values.ssl;
  if (typeof values.url === 'string') out.url = values.url;
  return out;
}

// ── Change notifications ─────────────────────────────────────────────────────
// Every write — create, update, delete — is announced, so something that
// mirrors a connection's settings follows the record instead of polling it. A listener that
// throws is skipped; it can never fail the write that already happened.
type ChangeListener = (projectId: string, id: string, conn: Connection | null) => void;
const changeListeners = new Set<ChangeListener>();

/** Hear about every connection write. `conn` is null for a delete. */
export function onConnectionChange(fn: ChangeListener): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function emitChange(projectId: string, id: string, conn: Connection | null): void {
  for (const fn of changeListeners) {
    try { fn(projectId, id, conn); } catch (_) { /* a listener must not fail a write */ }
  }
}

// No-op stub kept for symmetry with datasets.init()/projects.init(). The
// per-project connections/ dir is created lazily on first saveConnection.
export async function init(): Promise<void> {
  // Intentionally empty — per-project connections/ dirs are created on demand.
}

// Return a project's connections, newest-updated first. Skips corrupt/missing
// files quietly (ENOENT silent; real damage logged). v1 records are migrated in
// memory here — reading never rewrites a file.
export async function listConnections(projectId: string): Promise<Connection[]> {
  if (!isValidId(projectId)) return [];
  const dir = connectionsDir(projectId);
  let dirents;
  try {
    dirents = await recordFs.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return []; // no connections dir yet
  }

  const out: Connection[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await recordFs.readFile(connectionFilePath(projectId, id), 'utf8');
      const data = JSON.parse(raw);
      if (!isValidConnection(data)) continue;
      out.push(normalize(data, projectId));
    } catch (err: any) { // ponytail: fs errors carry .code, JSON errors don't
      if (err.code !== 'ENOENT') {
        console.error('[connections] Skipping corrupt or unreadable connection:', id, err.message);
      }
    }
  }

  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

// Load a single connection. Returns null if either id is invalid, or the file is
// missing/corrupt. Migrates v1 → v2 in memory.
export async function getConnection(projectId: string, id: string): Promise<Connection | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await recordFs.readFile(connectionFilePath(projectId, id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidConnection(data)) return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

// The editable, non-secret fields a caller supplies to create a connection.
export interface ConnectionInput {
  name: string;
  connectorId: string;
  values?: Record<string, unknown>;
  table?: string;
  query?: string;
  lastStatus?: Connection['lastStatus'];
  lastRefreshedAt?: string | null;
  lastError?: string | null;
}

// Create a new connection file. Id is generated (never derived from the name).
// The project's connections/ dir is created lazily. Returns the created
// connection, or null if the projectId is invalid, its parent project does not
// exist, or the connectorId is not one the registry can run. The SECRET is NOT
// handled here — the IPC layer stores it separately via
// config.setConnectionSecret(connId, ...).
export async function saveConnection(
  projectId: string,
  input: ConnectionInput,
): Promise<Connection | null> {
  if (!isValidId(projectId)) return null;
  const connectorId = typeof input.connectorId === 'string' ? input.connectorId.trim() : '';
  // Refuse to persist a record nothing can open. Reads stay permissive; writes
  // do not, because an unknown id here is a bug in the caller, not old data.
  if (!connectorId || !isKnownConnectorId(connectorId)) return null;
  // Don't orphan a connection under a bogus-but-UUID-shaped project id.
  const parent = await projects.getProject(projectId);
  if (!parent) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  const c: Connection = {
    id,
    projectId,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled connection',
    connectorId,
    values: sanitizeValues(input.values, secretKeysOf(connectorId)),
    lastRefreshedAt: input.lastRefreshedAt ?? null,
    lastStatus: STATUSES.has(input.lastStatus as string) ? (input.lastStatus as Connection['lastStatus']) : 'untested',
    lastError: input.lastError ?? null,
    linkedDatasetId: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
    queries: [],
  };
  if (typeof input.table === 'string') c.table = input.table;
  if (typeof input.query === 'string') c.query = input.query;

  await fs.promises.mkdir(connectionsDir(projectId), { recursive: true });
  await writeJsonAtomic(connectionFilePath(projectId, id), c);
  emitChange(projectId, id, c);
  return c;
}

// Fields that may be patched onto an existing connection (status/telemetry +
// editable metadata). id/projectId/createdAt/schemaVersion are never patchable.
export type ConnectionPatch = Partial<Omit<Connection, 'id' | 'projectId' | 'createdAt' | 'schemaVersion' | 'values'>> & {
  /** MERGED onto the stored values (not replaced), so a patch can set one field. */
  values?: Record<string, unknown>;
};

// Merge a patch onto an existing connection (lastRefreshedAt / lastStatus /
// linkedDatasetId / edited metadata). Bumps updatedAt, and rewrites the record as
// v2 — this is where a lazily-migrated v1 file finally lands on disk. Returns
// null if either id is invalid or the connection does not exist.
export async function updateConnection(
  projectId: string,
  id: string,
  patch: ConnectionPatch,
): Promise<Connection | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getConnection(projectId, id);
  if (!existing) return null;

  const next: Connection = { ...existing };
  // Only copy known fields, type-checked, so an IPC payload can't inject junk.
  if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
  if (typeof patch.connectorId === 'string' && isKnownConnectorId(patch.connectorId)) {
    next.connectorId = patch.connectorId;
  }
  if (patch.values !== undefined) {
    next.values = sanitizeValues(
      { ...existing.values, ...sanitizeValues(patch.values) },
      secretKeysOf(next.connectorId),
    );
  } else {
    next.values = sanitizeValues(existing.values, secretKeysOf(next.connectorId));
  }
  if (typeof patch.table === 'string') next.table = patch.table;
  if (typeof patch.query === 'string') next.query = patch.query;
  if (patch.queries !== undefined) next.queries = sanitizeQueries(patch.queries);
  else next.queries = sanitizeQueries(next.queries);
  if (patch.lastRefreshedAt !== undefined) next.lastRefreshedAt = patch.lastRefreshedAt;
  if (patch.lastStatus !== undefined && STATUSES.has(patch.lastStatus)) next.lastStatus = patch.lastStatus;
  if (patch.lastError !== undefined) next.lastError = patch.lastError;
  if (patch.linkedDatasetId !== undefined) next.linkedDatasetId = patch.linkedDatasetId;
  next.updatedAt = new Date().toISOString();

  await fs.promises.mkdir(connectionsDir(projectId), { recursive: true });
  await writeJsonAtomic(connectionFilePath(projectId, id), next);
  emitChange(projectId, id, next);
  return next;
}

/**
 * Create or update one saved query, and return the whole updated list.
 *
 * `id` absent → a new query with a generated UUID. `id` present but unknown →
 * null, NOT a silent insert: the caller thought it was editing something, and
 * inventing a second query under a different id is how a rename turns into a
 * duplicate. Returns null for an invalid id or a missing connection.
 */
export async function saveQuery(
  projectId: string,
  connId: string,
  input: { id?: string; name?: string; sql?: string },
): Promise<SavedQuery[] | null> {
  const existing = await getConnection(projectId, connId);
  if (!existing) return null;
  const sql = typeof input.sql === 'string' ? input.sql.slice(0, MAX_QUERY_SQL) : '';
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '';
  const now = new Date().toISOString();
  const list = existing.queries.slice();

  if (input.id) {
    const at = list.findIndex((q) => q.id === input.id);
    if (at < 0) return null;
    // A rename sends no SQL and an edit sends no name; keep whichever the
    // caller did not send, so neither operation quietly clears the other.
    list[at] = {
      id: list[at].id,
      name: name || list[at].name,
      sql: sql.trim() ? sql : list[at].sql,
      updatedAt: now,
    };
  } else {
    if (!sql.trim()) return null;
    if (list.length >= MAX_SAVED_QUERIES) return null;
    list.unshift({ id: randomUUID(), name: name || 'Untitled query', sql, updatedAt: now });
  }

  const saved = await updateConnection(projectId, connId, { queries: list });
  return saved ? saved.queries : null;
}

/** Remove one saved query. Returns the remaining list, or null if the
 *  connection is gone. A dataset built from it keeps refreshing: its origin
 *  carries the SQL, not just the id. */
export async function deleteQuery(
  projectId: string,
  connId: string,
  queryId: string,
): Promise<SavedQuery[] | null> {
  const existing = await getConnection(projectId, connId);
  if (!existing) return null;
  const list = existing.queries.filter((q) => q.id !== queryId);
  const saved = await updateConnection(projectId, connId, { queries: list });
  return saved ? saved.queries : null;
}

// Delete a connection file. Returns true on success (force → missing is
// success). The caller (IPC layer) is responsible for also dropping the secret
// via config.deleteConnectionSecret(id).
export async function deleteConnection(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await recordFs.rm(connectionFilePath(projectId, id), { force: true });
    emitChange(projectId, id, null);
    return true;
  } catch (_) {
    return false;
  }
}
