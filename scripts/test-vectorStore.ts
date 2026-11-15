// pgvector, optional everywhere (0029_pgvector.sql, src/server/vectorStore.ts; docs/assistant/00-design.md phase C, PR 7a).
//
// Always: without a database, vectorStatus() says no_database and ensureVectorStore() makes nothing.
// With DATABASE_URL (a Postgres it may CREATE DATABASE and CREATE ROLE on), on scratch databases:
//   1. The migration ran, as the URL's role. Where the server offers pgvector and the role may create it: the extension,
//      the table as 7b builds on it (columns, primary key, HNSW over vector_cosine_ops, forced RLS), a 768-dim round
//      trip in which `ORDER BY embedding <=> $q` returns the nearer first (through the HNSW index too), a 3-dim vector
//      refused, and row-level security holding for an ordinary role. Where it does not offer it: no extension, no
//      table, status no_extension, and the ensure function creates nothing.
//   2. INSTALLED LATER: with the table and the extension dropped, status says not_created, and the ensure function
//      creates nothing and does not throw (NEGATIVE CONTROL); after CREATE EXTENSION the first status check makes the
//      table, with the same columns, index and policy as the migration's; four pods at once all succeed.
//      With the extension and no CREATE on the schema, status says no_table and nothing throws.
//   3. NO PRIVILEGE: a database owned by an ordinary role migrates cleanly as that role: CREATE EXTENSION fails inside
//      the migration's DO block, which skips it without aborting the transaction (0029 is recorded), and makes no table.
//
// ORDINATE_EXPECT_PGVECTOR=1 (CI's check job, on pgvector/pgvector) makes a missing pgvector FAIL instead of taking the
// plain-Postgres branch, so CI cannot lose the extension without a red check. A test-only variable: no server code
// reads it, so it is documented here, not in docs/server/configuration.md.
//
//   npm run build:ts && [DATABASE_URL=…] [ORDINATE_EXPECT_PGVECTOR=1] node scripts/test-vectorStore.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { randomBytes } from 'crypto';
import { Client, Pool } from 'pg';

const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const vs: typeof import('../src/server/vectorStore') = require('../src/server/vectorStore');

const EXPECT = process.env.ORDINATE_EXPECT_PGVECTOR === '1';
const DIMS = 768;
const P = '11111111-1111-4111-8111-111111111111';
const vec = (f: (i: number) => number, n = DIMS): string => `[${Array.from({ length: n }, (_, i) => f(i)).join(',')}]`;
const Q = vec((i) => (i < 384 ? 1 : 0));
const NEAR = vec((i) => (i < 384 ? 1 : i === 400 ? 0.2 : 0));
const FAR = vec((i) => (i >= 384 ? 1 : 0));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

async function one<T>(pool: Pool, sql: string): Promise<T> {
  return (await pool.query(sql)).rows[0] as T;
}
const hasTable = async (pool: Pool): Promise<boolean> =>
  (await one<{ t: boolean }>(pool, `SELECT to_regclass('assistant_search_vectors') IS NOT NULL AS t`)).t;
const hasExtension = async (pool: Pool): Promise<boolean> =>
  (await one<{ t: boolean }>(pool, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS t`)).t;
const recorded = async (pool: Pool): Promise<boolean> =>
  (await one<{ t: boolean }>(pool, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 29 AND name = '0029_pgvector.sql') AS t`)).t;

/** The table as the catalog sees it: columns, primary key, other indexes' method and operator class, RLS, policies. */
async function shape(pool: Pool): Promise<string[]> {
  const cols = await pool.query<{ s: string }>(
    `SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
            || coalesce(' collate ' || nullif(co.collname, 'default'), '') AS s
       FROM pg_attribute a LEFT JOIN pg_collation co ON co.oid = a.attcollation
      WHERE a.attrelid = 'assistant_search_vectors'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
  const idx = await pool.query<{ s: string }>(
    `SELECT CASE WHEN i.indisprimary THEN 'pk ' || (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(att, n)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.att)
                 ELSE c.relname || ' ' || am.amname || ' ' || opc.opcname END AS s
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
       JOIN pg_opclass opc ON opc.oid = i.indclass[0]
      WHERE i.indrelid = 'assistant_search_vectors'::regclass ORDER BY i.indisprimary DESC, c.relname`);
  const rls = await pool.query<{ s: string }>(
    `SELECT 'rls ' || relrowsecurity || ' forced ' || relforcerowsecurity AS s FROM pg_class WHERE oid = 'assistant_search_vectors'::regclass
     UNION ALL
     SELECT 'policy ' || policyname || ' ' || qual || ' / ' || with_check FROM pg_policies WHERE tablename = 'assistant_search_vectors'`);
  return [...cols.rows, ...idx.rows, ...rls.rows].map((r) => r.s);
}

const EXPECTED_SHAPE = [
  'org_id text not null',
  'project_id uuid not null',
  'item text not null collate C',
  'model text not null',
  'text_hash text not null',
  'embedding vector(768) not null',
  'updated_at timestamp with time zone not null',
  'pk org_id,project_id,item,model',
  'assistant_search_vectors_embedding hnsw vector_cosine_ops',
  'rls true forced true',
];

async function roundTrip(rolePool: Pool): Promise<string[]> {
  inOrg.useOrgDb(rolePool);
  try {
    await inOrg.inOrg(async (c) => {
      for (const [item, v] of [['metric:far', FAR], ['metric:near', NEAR]] as const) {
        await c.query(`INSERT INTO assistant_search_vectors (org_id, project_id, item, model, text_hash, embedding) VALUES ('acme', $1, $2, 'm768', 'h', $3::vector)`, [P, item, v]);
      }
    }, 'acme');
    const order = (c: import('pg').PoolClient) => c.query<{ item: string }>(
      `SELECT item FROM assistant_search_vectors WHERE org_id = 'acme' AND project_id = $1 AND model = 'm768' ORDER BY embedding <=> $2::vector LIMIT 2`, [P, Q]);
    const seq = await inOrg.inOrg(async (c) => (await order(c)).rows.map((r) => r.item), 'acme');
    ok('round trip: ORDER BY embedding <=> q returns the nearer first', same(seq, ['metric:near', 'metric:far']), JSON.stringify(seq));
    const short = await inOrg.inOrg((c) => c.query(`INSERT INTO assistant_search_vectors (org_id, project_id, item, model, text_hash, embedding) VALUES ('acme', $1, 'metric:short', 'm768', 'h', $2::vector)`, [P, vec(() => 1, 3)]).then(() => 'inserted', (e: Error) => e.message), 'acme');
    ok('a 3-dimension vector is refused (768 fixed)', /768/.test(short), short);
    const other = await inOrg.inOrg(async (c) => (await c.query(`SELECT count(*)::int AS n FROM assistant_search_vectors`)).rows[0].n as number, 'other');
    ok('RLS: another org reads none of them', other === 0, other);
    const forged = await inOrg.inOrg((c) => c.query(`INSERT INTO assistant_search_vectors (org_id, project_id, item, model, text_hash, embedding) VALUES ('other', $1, 'metric:x', 'm768', 'h', $2::vector)`, [P, NEAR]).then(() => 'inserted', (e: Error) => e.message), 'acme');
    ok('RLS: a row for another org is refused', /row-level security/.test(forged), forged);
    return seq;
  } finally {
    inOrg.useOrgDb(null);
  }
}

async function vectorLeg(admin: Pool, rolePool: Pool, role: string): Promise<void> {
  const built = await shape(admin);
  ok('the table is as 7b builds on it', same(built.slice(0, EXPECTED_SHAPE.length), EXPECTED_SHAPE), built.join(' | '));
  ok('one org policy, as 0027', built.some((s) => s.startsWith("policy assistant_search_vectors_org (org_id = current_setting('ordinate.org'::text, true))")), built.join(' | '));
  inOrg.useOrgDb(admin);
  ok('status: available, with the table', same(await vs.vectorStatus(0), { available: true, table: true }));
  inOrg.useOrgDb(null);

  await admin.query(`GRANT SELECT, INSERT ON assistant_search_vectors TO ${role}`);
  const seq = await roundTrip(rolePool);
  // The index as the superuser: with no RLS predicate, the planner has no primary key to prefer at two rows.
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL enable_seqscan = off');
    const sql = `SELECT item FROM assistant_search_vectors ORDER BY embedding <=> '${Q}'::vector LIMIT 2`;
    const plan = (await c.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    const rows = (await c.query<{ item: string }>(sql)).rows.map((r) => r.item);
    await c.query('COMMIT');
    ok('round trip: the HNSW index serves the ORDER BY', /Index Scan using assistant_search_vectors_embedding/.test(plan), plan.slice(0, 300));
    ok('round trip: through the index, the same order', same(rows, seq), JSON.stringify(rows));
  } finally {
    c.release();
  }

  // ── installed later ──
  inOrg.useOrgDb(admin);
  await admin.query('DROP TABLE assistant_search_vectors');
  ok('cache: a fresh status is kept for its TTL', same(await vs.vectorStatus(), { available: true, table: true }));
  inOrg.useOrgDb(rolePool);
  ok('no CREATE on the schema: status says no_table, nothing throws', same(await vs.vectorStatus(0), { available: true, table: false, reason: 'no_table' }));
  ok('no CREATE on the schema: no table', !(await hasTable(admin)));
  inOrg.useOrgDb(admin);
  await admin.query('DROP EXTENSION vector');
  ok('extension dropped: status says not_created', same(await vs.vectorStatus(0), { available: false, table: false, reason: 'not_created' }));
  const made = await vs.ensureVectorStore(admin).then((r) => r, (e: Error) => e.message);
  ok('NEGATIVE CONTROL: ensure without the extension returns false and does not throw', made === false, made);
  ok('NEGATIVE CONTROL: ensure without the extension creates no table', !(await hasTable(admin)));
  ok('the app never creates the extension', !(await hasExtension(admin)));

  await admin.query('CREATE EXTENSION vector');
  ok('extension created later: the first status check makes the table', same(await vs.vectorStatus(0), { available: true, table: true }));
  const again = await shape(admin);
  ok('the later table is the migration\'s, column for column, index and policy', same(again, built), again.join(' | '));
  await admin.query('DROP TABLE assistant_search_vectors');
  const pods = await Promise.all([1, 2, 3, 4].map(() => vs.ensureVectorStore(admin).then((r) => r, (e: Error) => e.message)));
  ok('four pods ensuring at once: each succeeds', pods.every((r) => r === true), JSON.stringify(pods));
  ok('ensure is idempotent', (await vs.ensureVectorStore(admin)) === true && same(await shape(admin), built));
  inOrg.useOrgDb(null);
}

(async () => {
  inOrg.useOrgDb(null);
  ok('no database: status says no_database', same(await vs.vectorStatus(), { available: false, table: false, reason: 'no_database' }));
  ok('no database: ensure makes nothing', (await vs.ensureVectorStore()) === false);

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    ok('ORDINATE_EXPECT_PGVECTOR=1 needs DATABASE_URL', !EXPECT);
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const tag = `${process.pid}_${Date.now()}`;
  const role = `ordinate_vec_${tag}`;
  const pw = randomBytes(12).toString('hex');
  const names = { a: `ordinate_vec_a_${tag}`, b: `ordinate_vec_b_${tag}` };
  const urlOf = (db: string, asRole = false): string => {
    const u = new URL(adminUrl);
    u.pathname = '/' + db;
    if (asRole) {
      u.username = role;
      u.password = pw;
    }
    return u.toString();
  };
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const pools: Pool[] = [];
  const pool = (url: string): Pool => {
    const p = new Pool({ connectionString: url, max: 4 });
    p.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
    pools.push(p);
    return p;
  };
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await admin.query(`CREATE DATABASE ${names.a}`);
    await admin.query(`CREATE DATABASE ${names.b} OWNER ${role}`);

    // ── 1. the migration, as the URL's role ──
    const a = pool(urlOf(names.a));
    const r = await mig.migrate(a);
    ok('the migration applied 0029_pgvector.sql', r.applied.includes('0029_pgvector.sql'), r.applied.join());
    ok('0029 is recorded', await recorded(a));
    const offered = (await one<{ t: boolean }>(a, `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS t`)).t;
    const created = await hasExtension(a);
    console.log(`     pgvector: ${offered ? 'offered' : 'not offered'} by this Postgres, ${created ? 'created' : 'not created'} by the migration${EXPECT ? ' (ORDINATE_EXPECT_PGVECTOR=1)' : ''}`);
    if (EXPECT) {
      ok('ORDINATE_EXPECT_PGVECTOR=1: this Postgres offers pgvector', offered);
      ok('ORDINATE_EXPECT_PGVECTOR=1: the migration created the extension', created);
      ok('ORDINATE_EXPECT_PGVECTOR=1: and the table', await hasTable(a));
    }
    inOrg.useOrgDb(a);
    if (created) {
      ok('extension created: the table exists', await hasTable(a));
      await vectorLeg(a, pool(urlOf(names.a, true)), role);
    } else {
      ok('no extension: no table', !(await hasTable(a)));
      ok(`no extension: status says ${offered ? 'not_created' : 'no_extension'}`, same(await vs.vectorStatus(0), { available: false, table: false, reason: offered ? 'not_created' : 'no_extension' }));
      const made = await vs.ensureVectorStore(a).then((x) => x, (e: Error) => e.message);
      ok('NEGATIVE CONTROL: ensure on a plain Postgres returns false and does not throw', made === false, made);
      ok('NEGATIVE CONTROL: ensure on a plain Postgres creates no table', !(await hasTable(a)));
    }
    inOrg.useOrgDb(null);

    // ── 3. no privilege: an ordinary role migrates its own database ──
    const b = pool(urlOf(names.b, true));
    const rb = await mig.migrate(b).then((x) => x.applied, (e: Error) => e.message);
    ok('an ordinary role migrates cleanly (CREATE EXTENSION skipped, not fatal)', Array.isArray(rb) && rb.includes('0029_pgvector.sql'), String(rb));
    ok('no privilege: 0029 is recorded, so the DO block did not abort the transaction', await recorded(b));
    ok('no privilege: no extension, no table', !(await hasExtension(b)) && !(await hasTable(b)));
    inOrg.useOrgDb(b);
    ok(`no privilege: status says ${offered ? 'not_created' : 'no_extension'}`, same(await vs.vectorStatus(0), { available: false, table: false, reason: offered ? 'not_created' : 'no_extension' }));
    inOrg.useOrgDb(null);
  } finally {
    inOrg.useOrgDb(null);
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP DATABASE IF EXISTS ${names.a} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${names.b} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
})()
  .catch((e) => ok('vector store suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => finish());
