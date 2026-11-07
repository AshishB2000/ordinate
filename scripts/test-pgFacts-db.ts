// A table's facts (src/connectors/pgFacts.ts) against a REAL PostgreSQL, through the door
// (src/connectors/tableFactsRun.ts): comments, types, the primary key in its own order, a partition
// key, indexes, size and the estimate; a hostile name that reads nothing and drops nothing; a
// password stored in a comment that never comes back. Only PostgreSQL itself: Redshift and the pgwire
// engines have not been asked (their statements stay UNVERIFIED, see test-connectorsPostgres).
//
// Skips without DATABASE_URL; with one it works in a scratch database it creates and drops.
//
//   npm run build:ts && DATABASE_URL=postgres://… node scripts/test-pgFacts-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { Client }: typeof import('pg') = require('pg');
const { readTableFacts }: typeof import('../src/connectors/tableFactsRun') = require('../src/connectors/tableFactsRun');

const PASSWORD = 'pw-canary-pgfacts-5d2e';

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip pgFacts-db: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return finish();
  }
  const dbName = `ordinate_pgfacts_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const client = new Client({ connectionString: scratch.toString() });
  await client.connect();
  try {
    await client.query(`
      create table public.orders (line_id bigint, order_date date not null, amount numeric(12,2), primary key (line_id, order_date)) partition by range (order_date);
      create table public.orders_2026 partition of public.orders for values from ('2026-01-01') to ('2027-01-01');
      comment on table public.orders is 'Orders';
      comment on column public.orders.amount is 'Discount in USD, after tax';
      create table public.plain_t (id int primary key, note text not null, region text);
      create index plain_t_note on public.plain_t (note, region);
      insert into public.plain_t select i, 'n' || i, 'r' from generate_series(1, 3) i;
      analyze public.plain_t;
      comment on table public.plain_t is 'pw=${PASSWORD}';
      create table reordered (a int, b int, primary key (b, a));`);
    const values = { host: scratch.hostname, port: Number(scratch.port || 5432), database: dbName, user: decodeURIComponent(scratch.username) };
    const secrets = { password: PASSWORD }; // the server asks for none under trust auth; it is here to be redacted
    const read = async (table: string) => readTableFacts('postgres', values, secrets, table);
    const got = async (table: string) => { const r = await read(table); return r && r.ok ? r.facts : null; };

    const f = await got('public.orders');
    ok('real pg: comments, key, partition', f?.comment === 'Orders' && f.columns.find((c) => c.name === 'amount')?.comment === 'Discount in USD, after tax'
      && JSON.stringify(f.primaryKey) === '{"columns":["line_id","order_date"],"enforced":true}' && JSON.stringify(f.partition) === '{"columns":["order_date"],"method":"RANGE"}', JSON.stringify(f));
    ok('real pg: types as the catalog prints them, nullability, the key flag', JSON.stringify(f?.columns.map((c) => [c.name, c.type, c.nullable, !!c.key])) ===
      '[["line_id","bigint",false,true],["order_date","date",false,true],["amount","numeric(12,2)",true,false]]', JSON.stringify(f?.columns));
    ok('real pg: the size of the table and its partition', typeof f?.bytes === 'number' && f.bytes > 0, JSON.stringify(f?.bytes));
    ok('real pg: the primary key index, unique, with its access method', JSON.stringify(f?.indexes?.map((i) => [i.name, i.columns, i.unique, i.kind])) === '[["orders_pkey",["line_id","order_date"],true,"btree"]]', JSON.stringify(f?.indexes));

    const p = await got('plain_t');
    ok('real pg: an unqualified name, the analysed estimate, a composite index in its own order, no partition', p?.rowEstimate === 3 && !('partition' in p) && JSON.stringify(p.indexes?.map((i) => [i.name, i.columns, i.unique])) ===
      '[["plain_t_note",["note","region"],false],["plain_t_pkey",["id"],true]]' && p.columns.length === 3, JSON.stringify(p));
    ok('real pg: a key listed in a different order than the columns keeps the key\'s order', JSON.stringify((await got('reordered'))?.primaryKey) === '{"columns":["b","a"],"enforced":true}');
    ok('real pg: a password stored in a comment is redacted', p?.comment === 'pw=***' && !JSON.stringify(await read('public.plain_t')).includes(PASSWORD));

    const missing = await read('public.nope');
    ok('real pg: a table that is not there is an error', missing?.ok === false && missing.error === 'No such table: nope', JSON.stringify(missing));
    ok('real pg: a system table is not a source table', (await read('pg_catalog.pg_class'))?.ok === false);
    const hostile = [await read('public.orders"; drop table public.orders; --'), await read('public.x"; drop table orders; --')];
    ok('real pg: a hostile name reads nothing and drops nothing', hostile.every((r) => r?.ok === false) && (await client.query("select to_regclass('public.orders') is not null as t")).rows[0].t === true);
  } finally {
    await client.end().catch(() => undefined);
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
