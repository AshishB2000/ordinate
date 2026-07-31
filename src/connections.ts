// Connection metadata persistence — MAIN PROCESS ONLY.
// One JSON file per connection under
// userData/projects/<projectId>/connections/<connId>.json. Mirrors
// src/datasets.ts verbatim: the UUID id-validation guard, atomic JSON writes,
// and graceful skip of missing/corrupt files.
//
// SECURITY: this file stores ONLY non-secret metadata (name, kind, host/port/
// db/user, url, table/query, status). The pg password / URL auth token live in
// config.json's connectionSecrets block (see src/config.ts) — NEVER here, so a
// connections/*.json is safe to share. BOTH projectId AND connId are validated
// as UUIDs before either is concatenated into a path, so a connection path can
// never escape userData/projects/<projectId>/connections.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as projects from './projects';

export type ConnectionKind = 'postgres' | 'url';

export interface Connection {
  id: string; // generated UUID
  projectId: string;
  name: string;
  kind: ConnectionKind;
  // postgres (non-secret only — password lives in config.connectionSecrets):
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  // the saved table or query the user picked (their own DB; run as-is but
  // LIMIT-wrapped by the runner):
  table?: string;
  query?: string;
  // url source (https only; token, if any, lives in config.connectionSecrets):
  url?: string;
  // status / telemetry:
  lastRefreshedAt: string | null;
  lastStatus: 'ok' | 'error' | 'untested';
  lastError?: string | null; // human-readable, NEVER contains a secret
  linkedDatasetId?: string | null; // set once a run result is saved as a dataset
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

// The renderer-facing view. Connection carries no secret, but define an explicit
// whitelist so a stray future field can never leak — and to signal intent.
export type PublicConnection = Connection;

// Whitelisted copy of a connection for the renderer. There is no secret in a
// Connection, but we rebuild it field-by-field rather than pass the object
// through, so nothing unexpected ever rides along.
export function publicConnection(c: Connection): PublicConnection {
  return {
    id: c.id,
    projectId: c.projectId,
    name: c.name,
    kind: c.kind,
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    ssl: c.ssl,
    table: c.table,
    query: c.query,
    url: c.url,
    lastRefreshedAt: c.lastRefreshedAt,
    lastStatus: c.lastStatus,
    lastError: c.lastError ?? null,
    linkedDatasetId: c.linkedDatasetId ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    schemaVersion: 1,
  };
}

let projectsBase: string | null = null;

function getProjectsBase(): string {
  if (!projectsBase) projectsBase = path.join(app.getPath('userData'), 'projects');
  return projectsBase;
}

// Ids arrive from the renderer over IPC. Validate the SHAPE before either id ever
// reaches a filesystem path — an id like ".." or "../../foo" would otherwise
// escape the project's connections dir. Copied verbatim from datasets.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

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

function connectionsDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'connections');
}

function connectionFilePath(projectId: string, id: string): string {
  return path.join(connectionsDir(projectId), id + '.json');
}

const KINDS: ReadonlySet<string> = new Set<ConnectionKind>(['postgres', 'url']);
const STATUSES: ReadonlySet<string> = new Set(['ok', 'error', 'untested']);

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied from
// datasets.ts so a crash mid-write never leaves a half-written connection file.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file); // atomic on same fs
}

// Basic shape validation for a parsed connection.json (skips corrupt files).
function isValidConnection(data: any): boolean {
  return (
    Boolean(data) &&
    typeof data.id === 'string' &&
    data.id.length > 0 &&
    KINDS.has(data.kind)
  );
}

// Coerce a parsed object into a well-formed Connection (fills sane defaults).
// String fields are copied only when they are strings — never trusts disk JSON.
function normalize(data: any, projectId: string): Connection {
  const createdAt = data.createdAt || new Date().toISOString();
  const kind: ConnectionKind = KINDS.has(data.kind) ? data.kind : 'url';
  const status = STATUSES.has(data.lastStatus) ? data.lastStatus : 'untested';
  const c: Connection = {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled connection',
    kind,
    lastRefreshedAt: typeof data.lastRefreshedAt === 'string' ? data.lastRefreshedAt : null,
    lastStatus: status as Connection['lastStatus'],
    lastError: typeof data.lastError === 'string' ? data.lastError : null,
    linkedDatasetId: typeof data.linkedDatasetId === 'string' ? data.linkedDatasetId : null,
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 1,
  };
  if (typeof data.host === 'string') c.host = data.host;
  if (typeof data.port === 'number') c.port = data.port;
  if (typeof data.database === 'string') c.database = data.database;
  if (typeof data.user === 'string') c.user = data.user;
  if (typeof data.ssl === 'boolean') c.ssl = data.ssl;
  if (typeof data.table === 'string') c.table = data.table;
  if (typeof data.query === 'string') c.query = data.query;
  if (typeof data.url === 'string') c.url = stripUrlUserinfo(data.url);
  return c;
}

// No-op stub kept for symmetry with datasets.init()/projects.init(). The
// per-project connections/ dir is created lazily on first saveConnection.
export async function init(): Promise<void> {
  // Intentionally empty — per-project connections/ dirs are created on demand.
}

// Return a project's connections, newest-updated first. Skips corrupt/missing
// files quietly (ENOENT silent; real damage logged).
export async function listConnections(projectId: string): Promise<Connection[]> {
  if (!isValidId(projectId)) return [];
  const dir = connectionsDir(projectId);
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return []; // no connections dir yet
  }

  const out: Connection[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await fs.promises.readFile(connectionFilePath(projectId, id), 'utf8');
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
// missing/corrupt.
export async function getConnection(projectId: string, id: string): Promise<Connection | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await fs.promises.readFile(connectionFilePath(projectId, id), 'utf8');
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
  kind: ConnectionKind;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  table?: string;
  query?: string;
  url?: string;
  lastStatus?: Connection['lastStatus'];
  lastRefreshedAt?: string | null;
  lastError?: string | null;
}

// Create a new connection file. Id is generated (never derived from the name).
// The project's connections/ dir is created lazily. Returns the created
// connection, or null if the projectId is invalid or its parent project does
// not exist. The SECRET is NOT handled here — the IPC layer stores it separately
// via config.setConnectionSecret(connId, ...).
export async function saveConnection(
  projectId: string,
  input: ConnectionInput,
): Promise<Connection | null> {
  if (!isValidId(projectId)) return null;
  // Don't orphan a connection under a bogus-but-UUID-shaped project id.
  const parent = await projects.getProject(projectId);
  if (!parent) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  const kind: ConnectionKind = KINDS.has(input.kind) ? input.kind : 'url';
  const c: Connection = {
    id,
    projectId,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled connection',
    kind,
    lastRefreshedAt: input.lastRefreshedAt ?? null,
    lastStatus: STATUSES.has(input.lastStatus as string) ? (input.lastStatus as Connection['lastStatus']) : 'untested',
    lastError: input.lastError ?? null,
    linkedDatasetId: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
  if (typeof input.host === 'string') c.host = input.host;
  if (typeof input.port === 'number') c.port = input.port;
  if (typeof input.database === 'string') c.database = input.database;
  if (typeof input.user === 'string') c.user = input.user;
  if (typeof input.ssl === 'boolean') c.ssl = input.ssl;
  if (typeof input.table === 'string') c.table = input.table;
  if (typeof input.query === 'string') c.query = input.query;
  if (typeof input.url === 'string') c.url = stripUrlUserinfo(input.url);

  await fs.promises.mkdir(connectionsDir(projectId), { recursive: true });
  await writeJsonAtomic(connectionFilePath(projectId, id), c);
  return c;
}

// Fields that may be patched onto an existing connection (status/telemetry +
// editable metadata). id/projectId/createdAt/schemaVersion are never patchable.
export type ConnectionPatch = Partial<Omit<Connection, 'id' | 'projectId' | 'createdAt' | 'schemaVersion'>>;

// Merge a patch onto an existing connection (lastRefreshedAt / lastStatus /
// linkedDatasetId / edited metadata). Bumps updatedAt. Returns null if either id
// is invalid or the connection does not exist.
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
  if (patch.kind !== undefined && KINDS.has(patch.kind)) next.kind = patch.kind;
  if (typeof patch.host === 'string') next.host = patch.host;
  if (typeof patch.port === 'number') next.port = patch.port;
  if (typeof patch.database === 'string') next.database = patch.database;
  if (typeof patch.user === 'string') next.user = patch.user;
  if (typeof patch.ssl === 'boolean') next.ssl = patch.ssl;
  if (typeof patch.table === 'string') next.table = patch.table;
  if (typeof patch.query === 'string') next.query = patch.query;
  if (typeof patch.url === 'string') next.url = stripUrlUserinfo(patch.url);
  if (patch.lastRefreshedAt !== undefined) next.lastRefreshedAt = patch.lastRefreshedAt;
  if (patch.lastStatus !== undefined && STATUSES.has(patch.lastStatus)) next.lastStatus = patch.lastStatus;
  if (patch.lastError !== undefined) next.lastError = patch.lastError;
  if (patch.linkedDatasetId !== undefined) next.linkedDatasetId = patch.linkedDatasetId;
  next.updatedAt = new Date().toISOString();

  await fs.promises.mkdir(connectionsDir(projectId), { recursive: true });
  await writeJsonAtomic(connectionFilePath(projectId, id), next);
  return next;
}

// Delete a connection file. Returns true on success (force → missing is
// success). The caller (IPC layer) is responsible for also dropping the secret
// via config.deleteConnectionSecret(id).
export async function deleteConnection(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await fs.promises.rm(connectionFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
