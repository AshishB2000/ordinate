// MongoDB — MAIN PROCESS ONLY. The official `mongodb` driver, one client per operation.
//
// A collection is a table. A saved query is JSON naming a collection and an
// aggregation pipeline, read as relaxed Extended JSON so dates and ids can be
// written ({"$date": "2024-01-01T00:00:00Z"}, {"$oid": "…"}):
//
//   {"collection": "orders", "pipeline": [{"$match": {"status": "paid"}}]}
//
// READ-ONLY, ENFORCED HERE: this file calls listCollections, find, aggregate and
// estimatedDocumentCount and nothing else, and refuses a pipeline that names
// $out or $merge (the two stages that write) anywhere in it. A user with the
// `read` role is still the right credential.
//
// BOUNDED: every pipeline ends in {$limit: cap + 1}, maxTimeMS carries the clock
// to the server, rows stop at MAX_RESULT_BYTES, and on the clock or the caller's
// abort the client is closed, which destroys its sockets.
//
// SSRF: every socket goes to an address `checkHost` approved. The driver runs
// with `directConnection: true`, so it never follows the member list a server
// advertises in its `hello` reply (a server could name any internal address
// there), and with `lookup: pinnedLookup(pin)`, so DNS answering differently at
// connect time changes nothing. An SRV address (Atlas, mongodb+srv://) is
// resolved HERE: each target must sit under the SRV name's parent domain (the
// SRV spec's own rule), each is checked, and they are tried in priority order.
// A direct connection may land on a secondary, which reads fine for analytics.
//
// The form's field is `server`, not `host`, on purpose: connectionRun.guardHost
// resolves a `host` field before the call, and an Atlas SRV name has no A record
// to resolve. This file guards every target itself instead.

import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BSON, Decimal128, Long, MongoClient, ObjectId, type Db, type Document, type MongoClientOptions } from 'mongodb';
import { bool, budgetMs, num, rowCap, secret, str } from './httpShared';
import { checkHost, pinnedLookup, type PinnedHost } from './ssrf';
import { MAX_RESULT_BYTES, rowBytes, safeError } from './types';
import type { ConnectorColumn, ConnectorContext, ConnectorDef, ConnectorError, ConnectorRows, ConnectorSchema, ConnectorTables } from './types';

type Cell = string | number | boolean | null;
const err = (error: string): ConnectorError => ({ ok: false, error });

// ── the query ────────────────────────────────────────────────────────────────

const SHAPE = 'A MongoDB query is JSON: {"collection": "orders", "pipeline": [{"$match": {"status": "paid"}}]}';
// What connectionRun.buildTableSql makes of a picked collection: its quotedTable
// JSON-quotes a mongodb name, so any collection name round-trips.
const TABLE_SQL = /^select \* from ("(?:[^"\\]|\\.)*") limit \d+$/;

export type MongoQuery = { ok: true; collection: string; pipeline: Document[] };

function collectionOf(name: unknown, pipeline: Document[]): MongoQuery | ConnectorError {
  if (typeof name !== 'string' || !name.trim() || name.startsWith('system.') || name.includes('$') || name.includes('\0')) {
    return err(`Name a collection. ${SHAPE}`);
  }
  return { ok: true, collection: name, pipeline };
}

/** True when `v` names $out or $merge as a key anywhere inside it. */
function writes(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(writes);
  if (!v || typeof v !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false; // a Date, an ObjectId: a value, not a stage
  return Object.entries(v).some(([k, inner]) => k === '$out' || k === '$merge' || writes(inner));
}

/** A saved table or query → the collection and pipeline it reads. Exported for the self-check. */
export function parseQuery(text: string): MongoQuery | ConnectorError {
  const s = String(text ?? '').trim();
  const table = TABLE_SQL.exec(s);
  if (table) return collectionOf(JSON.parse(table[1]), []);
  if (!s.startsWith('{')) return err(SHAPE);
  let q: unknown;
  try {
    q = BSON.EJSON.parse(s, { relaxed: true });
  } catch (e) {
    return err(`The query is not valid JSON (${e instanceof Error ? e.message : String(e)}). ${SHAPE}`);
  }
  if (!q || typeof q !== 'object' || Array.isArray(q)) return err(SHAPE);
  const { collection, pipeline = [], ...rest } = q as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) return err(`Unknown key "${extra[0]}". ${SHAPE}`);
  if (!Array.isArray(pipeline) || pipeline.some((st) => !st || typeof st !== 'object' || Array.isArray(st))) {
    return err('"pipeline" is a list of stages, each an object such as {"$match": {…}}.');
  }
  if (writes(pipeline)) return err('Ordinate only reads: a pipeline may not use $out or $merge.');
  return collectionOf(collection, pipeline as Document[]);
}

// ── documents → rows ─────────────────────────────────────────────────────────

/** One BSON value as a cell. Exported for the self-check. */
export function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof ObjectId) return v.toHexString();
  // An int64 past 2^53 and a Decimal128 as their exact text, never a rounded double.
  if (v instanceof Long || v instanceof Decimal128) return v.toString();
  return BSON.EJSON.stringify(v, { relaxed: true }); // a sub-document, an array, binary…
}

function bsonType(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (typeof v === 'object') return String((v as { _bsontype?: unknown })._bsontype ?? 'object');
  return typeof v;
}

/** Documents → positional rows. Columns are every top-level field, in the order first seen. */
async function readDocs(docs: AsyncIterable<Document>, cap: number): Promise<ConnectorRows> {
  const index = new Map<string, number>();
  const types: string[] = [];
  const rows: Cell[][] = [];
  let bytes = 0;
  let truncated = false;
  for await (const doc of docs) {
    if (rows.length >= cap || bytes > MAX_RESULT_BYTES) {
      truncated = true;
      break; // ends the cursor
    }
    const row: Cell[] = new Array<Cell>(index.size).fill(null);
    for (const [k, v] of Object.entries(doc)) {
      let i = index.get(k);
      if (i === undefined) {
        i = index.size;
        index.set(k, i);
        types.push(bsonType(v));
      } else if (types[i] === 'null') {
        types[i] = bsonType(v);
      }
      row[i] = cell(v);
    }
    rows.push(row);
    bytes += rowBytes(row);
  }
  for (const r of rows) while (r.length < index.size) r.push(null); // rows read before a later field appeared
  const columns: ConnectorColumn[] = [...index.keys()].map((name, i) => ({ name, type: types[i] }));
  return { ok: true, columns, rows, truncated };
}

// ── where to connect ─────────────────────────────────────────────────────────

interface Target { port: number; pin: PinnedHost }

const DNS_TIMEOUT_MS = 5_000;

function portOf(v: number): number {
  return Number.isInteger(v) && v > 0 && v < 65_536 ? v : 27_017;
}

/** Every server this connection may use, each checked and pinned. Throws a user-facing error. */
export async function targets(ctx: ConnectorContext): Promise<Target[]> {
  const server = str(ctx, 'server').trim().toLowerCase().replace(/\.$/, '');
  if (!server) throw new Error('Enter the server address');
  if (!bool(ctx, 'srv')) return [{ port: portOf(num(ctx, 'port', 27_017)), pin: await checkHost(server) }];
  if (isIP(server) || server.split('.').length < 3) {
    throw new Error('An SRV address has at least three parts, such as cluster0.ab1cd.mongodb.net');
  }
  const parent = server.slice(server.indexOf('.'));
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  let records;
  try {
    records = await resolver.resolveSrv(`_mongodb._tcp.${server}`);
  } catch {
    throw new Error(`No SRV record for ${server}. Untick "SRV address" for a single server.`);
  }
  records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  const out: Target[] = [];
  for (const r of records) {
    const name = r.name.toLowerCase().replace(/\.$/, '');
    if (!name.endsWith(parent)) throw new Error(`Refused: the SRV record names ${name}, which is outside ${parent.slice(1)}.`);
    out.push({ port: portOf(r.port), pin: await checkHost(name) });
  }
  if (!out.length) throw new Error(`No SRV record for ${server}.`);
  return out;
}

function clientFor(t: Target, ctx: ConnectorContext, budget: number, targetCount: number): MongoClient {
  const user = str(ctx, 'user').trim();
  // Selection retries a refused connection until this runs out, so each SRV
  // target gets a share: a member that is down must leave time for the next.
  const wait = Math.max(1, Math.floor(Math.min(15_000, budget / targetCount)));
  const options: MongoClientOptions = {
    directConnection: true,
    lookup: pinnedLookup(t.pin),
    // Unset (a record saved before the field existed) means on; certificates are always verified.
    tls: ctx.values.tls === undefined || bool(ctx, 'tls'),
    appName: 'Ordinate',
    serverSelectionTimeoutMS: wait,
    connectTimeoutMS: wait,
    socketTimeoutMS: budget + 5_000,
    maxPoolSize: 2,
    ...(user ? { auth: { username: user, password: secret(ctx, 'password') }, authSource: str(ctx, 'authSource').trim() || 'admin' } : {}),
  };
  const host = isIP(t.pin.host) === 6 ? `[${t.pin.host}]` : t.pin.host;
  return new MongoClient(`mongodb://${host}:${t.port}/`, options);
}

/**
 * Connect to the first target that answers, run `work` on the database, close.
 * The clock and the caller's abort close the client, which fails `work` at once.
 */
async function withDb<T>(ctx: ConnectorContext, work: (db: Db, budget: number) => Promise<T>): Promise<T | ConnectorError> {
  const database = str(ctx, 'database').trim();
  if (!database) return err('Enter the database to read');
  const budget = budgetMs(ctx);
  const clock = AbortSignal.timeout(budget);
  const stop = ctx.signal ? AbortSignal.any([ctx.signal, clock]) : clock;
  const stopped = (): ConnectorError => err(ctx.signal?.aborted ? 'The query was cancelled' : `Query timed out after ${Math.ceil(budget / 1000)}s`);
  let list: Target[];
  try {
    list = await targets(ctx);
  } catch (e) {
    return err(safeError(e, ctx.secrets));
  }
  let last: unknown = new Error('No server answered');
  for (const t of list) {
    if (stop.aborted) return stopped();
    const client = clientFor(t, ctx, budget, list.length);
    const close = (): void => void client.close().catch(() => undefined);
    stop.addEventListener('abort', close, { once: true });
    try {
      try {
        await client.connect();
      } catch (e) {
        last = e;
        continue; // the next SRV target
      }
      return await work(client.db(database), budget);
    } catch (e) {
      return stop.aborted ? stopped() : err(safeError(e, ctx.secrets));
    } finally {
      stop.removeEventListener('abort', close);
      await client.close().catch(() => undefined);
    }
  }
  return stop.aborted ? stopped() : err(safeError(last, ctx.secrets));
}

// ── the operations ───────────────────────────────────────────────────────────

async function run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const q = parseQuery(sql);
  if (!q.ok) return q;
  const cap = rowCap(ctx);
  return withDb(ctx, (db, budget) =>
    readDocs(db.collection(q.collection).aggregate([...q.pipeline, { $limit: cap + 1 }], { maxTimeMS: budget, batchSize: Math.min(cap + 1, 1_000) }), cap));
}

async function listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  return withDb(ctx, async (db) => {
    const found = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
    const names = found.map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
    return { ok: true as const, tables: names.map((name) => ({ name })) };
  });
}

/** Documents a schema expand reads to name a collection's fields. */
const DESCRIBE_DOCS = 100;

async function describeTable(ctx: ConnectorContext, table: string): Promise<ConnectorSchema | ConnectorError> {
  const c = collectionOf(String(table ?? ''), []);
  if (!c.ok) return c;
  return withDb(ctx, async (db, budget) => {
    const coll = db.collection(c.collection);
    const sample = await readDocs(coll.find({}, { limit: DESCRIBE_DOCS, maxTimeMS: budget }), DESCRIBE_DOCS);
    const estimate = await coll.estimatedDocumentCount({ maxTimeMS: budget });
    return { ok: true as const, columns: sample.columns, rowEstimate: estimate };
  });
}

// ── the definition ───────────────────────────────────────────────────────────

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'mongodb',
    label: 'MongoDB',
    family: 'mongodb',
    category: 'Databases',
    readOnly: true,
    blurb: 'Collections are tables. A query is an aggregation pipeline in JSON; $out and $merge are refused.',
    fields: [
      {
        key: 'server', label: 'Server', type: 'text', required: true, placeholder: 'cluster0.ab1cd.mongodb.net',
        help: 'The host name only. In mongodb+srv://user:pw@cluster0.ab1cd.mongodb.net/ it is cluster0.ab1cd.mongodb.net.',
      },
      {
        key: 'srv', label: 'SRV address (mongodb+srv://)', type: 'checkbox', default: true,
        help: 'On for Atlas and any address given as mongodb+srv://. Off for a single server given as mongodb://.',
      },
      { key: 'port', label: 'Port', type: 'number', default: 27017, help: 'Not used for an SRV address: its DNS record names the ports.' },
      { key: 'database', label: 'Database', type: 'text', required: true, placeholder: 'sales' },
      { key: 'user', label: 'User', type: 'text', help: 'A user with the read role. Leave empty for a server without sign-in.' },
      { key: 'password', label: 'Password', type: 'password', secret: true },
      { key: 'authSource', label: 'Authentication database', type: 'text', default: 'admin', help: 'Where the user is defined. Atlas users are in admin.' },
      { key: 'tls', label: 'Use TLS', type: 'checkbox', default: true, help: 'Atlas requires it. Certificates are always verified.' },
    ],
    listTables,
    run,
    describeTable,
  },
];
