// Self-check for the MongoDB connector (src/connectors/mongodb.ts). The real
// driver runs against a fake server on loopback (scripts/mongoFake.ts), so the
// options, the pinning and the cursor paging are the driver's own behaviour.
//
//   1. the query: a picked collection round-trips any name; JSON pipelines and
//      Extended JSON; $out/$merge refused anywhere, before a socket opens
//   2. cells: ObjectId, Date, int64 past 2^53, Decimal128, sub-documents
//   3. SSRF: loopback refused without SSRF_ALLOW (negative control: no socket);
//      the socket goes to the PINNED address; a member list a server advertises
//      is never followed; SRV targets outside the parent domain are refused
//   4. rows: the cap ($limit cap+1, truncated), getMore paging, fields seen late
//   5. the clock and the caller's abort close the client
//   6. listTables, describeTable, and a password canary through a refused sign-in
//
//   npm run build:ts && node scripts/test-connectorsMongo.js

export {}; // module scope — sibling test scripts share top-level names
import * as dns from 'dns';
import { BSON } from 'mongodb';
import { ok, finish } from './selfcheck';
import { startFakeMongo, type FakeMongo } from './mongoFake';

const mongo: typeof import('../src/connectors/mongodb') = require('../src/connectors/mongodb');
const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const registry: typeof import('../src/connectors') = require('../src/connectors');
type Ctx = import('../src/connectors/types').ConnectorContext;

let captured = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return orig(chunk, ...rest);
  };
}

const found = registry.getConnector('mongodb');
if (!found) throw new Error('mongodb is not registered');
const def: import('../src/connectors/types').ConnectorDef = found;
const ctxFor = (values: Record<string, unknown>, extra: Partial<Ctx> = {}): Ctx =>
  ({ values: { database: 'shop', tls: false, srv: false, ...values }, secrets: {}, rowLimit: 100, timeoutMs: 10_000, ...extra });
const isErr = (r: { ok: boolean }): r is { ok: false; error: string } => !r.ok;

// A name lookup answering for `.test` names, as a DNS server would. The driver's
// own sockets use the CALLBACK dns.lookup, which is left alone: a socket that
// reached a `.test` name without the pin would fail ENOTFOUND.
const realLookup = dns.promises.lookup;
(dns.promises as unknown as { lookup: unknown }).lookup = (host: string, o: unknown) =>
  host.endsWith('.test') ? Promise.resolve([{ address: '127.0.0.1', family: 4 }]) : (realLookup as (h: string, o: unknown) => Promise<unknown>)(host, o);

async function main(): Promise<void> {
  // ── 1. the query ────────────────────────────────────────────────────────────
  for (const name of ['orders', 'user-events', 'app.logs', 'we"ird\\name']) {
    const sql = connectionRun.buildTableSql('mongodb', name, 50);
    const q = sql ? mongo.parseQuery(sql) : null;
    ok(`a picked collection round-trips: ${name}`, !!q && q.ok && q.collection === name && q.pipeline.length === 0, sql);
  }
  ok('an empty collection name has no table SQL', connectionRun.buildTableSql('mongodb', '', 5) === null);

  const q = mongo.parseQuery('{"collection": "orders", "pipeline": [{"$match": {"at": {"$gte": {"$date": "2024-01-01T00:00:00Z"}}, "_id": {"$oid": "65a1b2c3d4e5f60718293a4b"}}}]}');
  const match = q.ok ? (q.pipeline[0].$match as Record<string, Record<string, unknown>>) : null;
  ok('Extended JSON: $date is a Date and $oid an ObjectId', !!match && match.at.$gte instanceof Date && match._id instanceof BSON.ObjectId);
  const refusals: [string, string][] = [
    ['{"collection": "o", "pipeline": [{"$out": "x"}]}', '$out'],
    ['{"collection": "o", "pipeline": [{"$merge": {"into": "x"}}]}', '$merge'],
    ['{"collection": "o", "pipeline": [{"$facet": {"a": [{"$out": "x"}]}}]}', '$out inside $facet'],
    ['{"collection": "o", "pipeline": [{"$lookup": {"from": "p", "pipeline": [{"$merge": "x"}], "as": "y"}}]}', '$merge inside $lookup'],
    ['{"collection": "o", "pipeline": {"$match": {}}}', 'a pipeline that is not a list'],
    ['{"collection": "o", "filter": {}}', 'an unknown key'],
    ['{"collection": "system.users"}', 'a system collection'],
    ['{"pipeline": []}', 'no collection'],
    ['{"collection": "o", ', 'not JSON'],
    ['select * from orders', 'SQL'],
    ['', 'nothing'],
  ];
  for (const [text, what] of refusals) ok(`refused: ${what}`, !mongo.parseQuery(text).ok);
  ok('the refusal names the read-only rule', /only reads/.test((mongo.parseQuery(refusals[0][0]) as { error: string }).error));

  // ── 2. cells ────────────────────────────────────────────────────────────────
  const oid = new BSON.ObjectId('65a1b2c3d4e5f60718293a4b');
  ok('ObjectId → its hex', mongo.cell(oid) === '65a1b2c3d4e5f60718293a4b');
  ok('Date → ISO', mongo.cell(new Date('2024-02-03T04:05:06.007Z')) === '2024-02-03T04:05:06.007Z');
  ok('int64 past 2^53 → exact text', mongo.cell(BSON.Long.fromString('9007199254740993')) === '9007199254740993');
  ok('Decimal128 → exact text', mongo.cell(BSON.Decimal128.fromString('0.10')) === '0.10');
  ok('a sub-document → Extended JSON', mongo.cell({ city: 'Pune', id: oid }) === '{"city":"Pune","id":{"$oid":"65a1b2c3d4e5f60718293a4b"}}');
  ok('null, undefined → null; NaN → text', mongo.cell(null) === null && mongo.cell(undefined) === null && mongo.cell(NaN) === 'NaN');
  ok('"007" stays a string', mongo.cell('007') === '007');

  // ── 3–6 against the fake server ─────────────────────────────────────────────
  const docs = Array.from({ length: 7 }, (_, i) => ({ _id: new BSON.ObjectId(), n: i, ...(i === 5 ? { late: 'yes' } : {}) }));
  const decoy: FakeMongo = await startFakeMongo({ collections: {} });
  const fake: FakeMongo = await startFakeMongo({
    collections: { orders: docs, 'user-events': [{ a: 1 }], 'system.views': [], slow: [], big: Array.from({ length: 1_500 }, (_, i) => ({ i })) },
    // A replica set member list naming another address: a direct connection must ignore it.
    hello: { setName: 'rs0', hosts: [`127.0.0.1:${decoy.port}`], primary: `127.0.0.1:${decoy.port}` },
    hang: (cmd) => cmd.aggregate === 'slow',
  });
  const at = { server: '127.0.0.1', port: fake.port };

  delete process.env.SSRF_ALLOW;
  const refused = await def.run(ctxFor(at), '{"collection": "orders"}');
  ok('SSRF: loopback is refused before a socket opens (negative control)', isErr(refused) && /internal address/.test(refused.error) && fake.accepted === 0, refused);
  process.env.SSRF_ALLOW = '127.0.0.1/32';

  const before = fake.seen.length;
  const wrote = await def.run(ctxFor(at), '{"collection": "orders", "pipeline": [{"$out": "copy"}]}');
  ok('$out is refused before a socket opens', isErr(wrote) && fake.seen.length === before && fake.accepted === 0);

  const listed = await def.listTables(ctxFor(at));
  ok('listTables: collections sorted, system.* left out', listed.ok && JSON.stringify(listed.tables) === JSON.stringify([{ name: 'big' }, { name: 'orders' }, { name: 'slow' }, { name: 'user-events' }]), listed);

  const all = await def.run(ctxFor(at), '{"collection": "orders", "pipeline": [{"$match": {}}]}');
  const agg = fake.seen.filter((c) => c.aggregate === 'orders').pop();
  const pipeline = (agg?.pipeline ?? []) as Record<string, unknown>[];
  ok('the pipeline is sent with {$limit: cap+1} last, and maxTimeMS', JSON.stringify(pipeline[pipeline.length - 1]) === '{"$limit":101}' && Number(agg?.maxTimeMS) === 10_000, agg);
  ok('rows: every document, columns in first-seen order', all.ok && all.rows.length === 7 && !all.truncated && all.columns.map((c) => c.name).join() === '_id,n,late', all.ok && all.columns);
  ok('a field first seen late pads the rows before it with null', all.ok && all.rows[0].length === 3 && all.rows[0][2] === null && all.rows[5][2] === 'yes');
  ok('column types are BSON type names', all.ok && all.columns[0].type === 'ObjectId' && all.columns[1].type === 'number');
  ok('a direct connection never follows an advertised member (the decoy saw no socket)', decoy.accepted === 0);

  const capped = await def.run(ctxFor(at, { rowLimit: 3 }), '{"collection": "orders"}');
  ok('the cap: 3 rows and truncated', capped.ok && capped.rows.length === 3 && capped.truncated);
  const paged = await def.run(ctxFor(at, { rowLimit: 1_200 }), '{"collection": "big"}');
  ok('getMore paging past the first 1,000-row batch, then the cap', paged.ok && paged.rows.length === 1_200 && paged.truncated && paged.rows[1_199][0] === 1_199 && fake.seen.some((c) => c.getMore !== undefined), paged.ok && paged.rows.length);
  const whole = await def.run(ctxFor(at, { rowLimit: 1_500 }), '{"collection": "big"}');
  ok('exactly at the cap: every row, not truncated', whole.ok && whole.rows.length === 1_500 && !whole.truncated);

  const viaTable = await connectionRun.runConnectionText('mongodb', ctxFor(at).values, {}, { table: 'user-events' }, { rowLimit: 10 });
  ok('through connectionRun: a picked collection with a dash reads', viaTable.ok && viaTable.header.join() === 'a' && viaTable.body[0][0] === '1', viaTable);

  // The pin: `mongo.test` resolves only through the stubbed lookup checkHost uses.
  const pinned = await def.run(ctxFor({ server: 'mongo.test', port: fake.port }), '{"collection": "orders"}');
  ok('the socket goes to the address checkHost pinned', pinned.ok && pinned.rows.length === 7, pinned);

  const t0 = Date.now();
  const slow = await def.run(ctxFor(at, { timeoutMs: 1_200 }), '{"collection": "slow"}');
  ok('the clock: a hung aggregate stops near its budget', isErr(slow) && /timed out after 2s/.test(slow.error) && Date.now() - t0 < 4_000, [slow, Date.now() - t0]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t1 = Date.now();
  const cancelled = await def.run(ctxFor(at, { signal: ac.signal }), '{"collection": "slow"}');
  ok('the caller hanging up cancels at once', isErr(cancelled) && cancelled.error === 'The query was cancelled' && Date.now() - t1 < 2_500, [cancelled, Date.now() - t1]);
  await new Promise((r) => setTimeout(r, 300));
  ok('every client is closed afterwards (no socket left open)', fake.open === 0, fake.open);

  const described = await def.describeTable!(ctxFor(at), 'orders');
  ok('describeTable: sampled fields and the count', described.ok && described.columns.map((c) => c.name).join() === '_id,n,late' && described.rowEstimate === 7, described);

  // ── SRV ─────────────────────────────────────────────────────────────────────
  type Srv = { name: string; port: number; priority: number; weight: number };
  let records: Srv[] = [];
  const proto = dns.promises.Resolver.prototype as unknown as { resolveSrv: (n: string) => Promise<Srv[]> };
  const realSrv = proto.resolveSrv;
  let asked = '';
  proto.resolveSrv = async (n: string) => {
    asked = n;
    return records;
  };
  records = [{ name: 'evil.elsewhere.test', port: fake.port, priority: 0, weight: 0 }];
  const outside = await def.run(ctxFor({ server: 'cluster0.ab1cd.test', srv: true }), '{"collection": "orders"}');
  ok('SRV: a target outside the parent domain is refused', isErr(outside) && /outside ab1cd\.test/.test(outside.error), outside);
  ok('SRV: the record asked for is _mongodb._tcp.<server>', asked === '_mongodb._tcp.cluster0.ab1cd.test');
  ok('SRV: a two-part name is refused', isErr(await def.run(ctxFor({ server: 'mongodb.test', srv: true }), '{"collection": "orders"}')));
  const dead = await startFakeMongo({ collections: {} });
  const deadPort = dead.port;
  await dead.close();
  records = [
    { name: 'b.ab1cd.test', port: fake.port, priority: 2, weight: 0 },
    { name: 'a.ab1cd.test', port: deadPort, priority: 1, weight: 0 },
  ];
  const srv = await def.run(ctxFor({ server: 'cluster0.ab1cd.test', srv: true }, { timeoutMs: 6_000 }), '{"collection": "orders"}');
  ok('SRV: priority order, and the next target when one is down', srv.ok && srv.rows.length === 7, JSON.stringify(srv));
  proto.resolveSrv = realSrv;

  // ── the password canary ─────────────────────────────────────────────────────
  const PASSWORD = `pw-${Math.random().toString(36).slice(2)}-canary`;
  const locked = await startFakeMongo({ collections: {}, refuseAuth: true });
  const denied = await def.run({ ...ctxFor({ server: '127.0.0.1', port: locked.port, user: 'reader' }), secrets: { password: PASSWORD } }, '{"collection": "x"}');
  ok('a refused sign-in is an error', isErr(denied), denied);
  ok('the password is in no error, command or log line', !JSON.stringify(denied).includes(PASSWORD) && !JSON.stringify(locked.seen).includes(PASSWORD) && !captured.includes(PASSWORD));

  await Promise.all([fake.close(), decoy.close(), locked.close()]);
}

main()
  .catch((e: unknown) => ok('the suite ran to the end', false, e))
  .finally(finish);
