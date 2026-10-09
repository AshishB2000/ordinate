// The Snowflake half of scripts/test-warehouseLive.ts: the real connector,
// through the real registry and dispatch, against a real account over the
// SQL API. Every request still goes through the real transport (snowflakeHttp's
// safeFetch, the SSRF guard on — the suite runs in server mode); the seam only
// WATCHES it, to see partitions, the cancel and the statement handle.
//
// Not a suite itself: test-warehouseLive.ts calls `runSnowflake` when the
// SNOWFLAKE_* variables are set.

import { errOf, ident, keep, leaksIn, ok, ORG, say, secret, until } from './warehouseLiveHarness';

const registry: typeof import('../src/connectors') = require('../src/connectors');
const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const snowflake: typeof import('../src/connectors/snowflake') = require('../src/connectors/snowflake');
const sfHttp: typeof import('../src/connectors/snowflakeHttp') = require('../src/connectors/snowflakeHttp');

type Ctx = import('../src/connectors/types').ConnectorContext;
type LiveParam = import('../src/connectors/types').LiveParam;

export interface SnowflakeConfig {
  account: string;
  user: string;
  warehouse: string;
  role: string;
  database?: string;
  schema?: string;
  /** A PEM private key (PKCS#8), or … */
  key?: string;
  passphrase?: string;
  /** … a programmatic access token. */
  pat?: string;
}

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  status: number; // -1 while in flight, 0 when it failed
  handle: string;
}

/** The same strings test-connectorsSnowflake binds against the fake (minus NUL, checked on its own below). */
const NASTY = ["'; drop table orders; --", "\\'", '’ or ‘1’=‘1', '${process.exit()}', '?', '$$ select 1 $$', 'line\nbreak', '﻿bom',
  '"quoted"', '/* c */', '\\', '', 'é😀', "x' or '1'='1"];

export async function runSnowflake(cfg: SnowflakeConfig, nonce: string): Promise<void> {
  const def = registry.getConnector('snowflake');
  ok('snowflake: registered, read-only, with a live capability in the snowflake dialect', !!def && def.readOnly === true && def.live?.dialect === 'snowflake');
  if (!def?.live) return;
  ident('snowflake account', cfg.account, true);
  ident('snowflake user', cfg.user, true);
  for (const [l, v] of [['warehouse', cfg.warehouse], ['role', cfg.role], ['database', cfg.database], ['schema', cfg.schema]] as const) ident(`snowflake ${l}`, v);
  secret('Snowflake private key', cfg.key);
  secret('Snowflake key passphrase', cfg.passphrase);
  secret('Snowflake PAT', cfg.pat);

  const values: Record<string, unknown> = { account: cfg.account, user: cfg.user, auth: cfg.key ? 'keypair' : 'pat', warehouse: cfg.warehouse, role: cfg.role };
  if (cfg.database) values.database = cfg.database;
  if (cfg.schema) values.schema = cfg.schema;
  const secrets: Record<string, string> = cfg.key ? { token: cfg.key, ...(cfg.passphrase ? { password: cfg.passphrase } : {}) } : { token: cfg.pat ?? '' };
  const ctxOf = (extra: Partial<Ctx> = {}): Ctx => ({ ...connectionRun.buildContext(values, secrets, { rowLimit: 1000 }), ...extra });
  const live = def.live;

  // Watch the real transport: what was asked, what came back, which handle.
  const seen: Seen[] = [];
  snowflake.setTransport(async (req) => {
    const s: Seen = { method: req.method, url: req.url, headers: req.headers, body: req.body ?? '', status: -1, handle: '' };
    seen.push(s);
    secret('Snowflake bearer (JWT or PAT)', (req.headers.authorization ?? '').replace(/^Bearer /, ''));
    try {
      const res = await sfHttp.snowflakeFetch(req);
      s.status = res.status;
      try {
        s.handle = String((JSON.parse(res.body) as { statementHandle?: unknown }).statementHandle ?? '');
      } catch {
        /* a partition, or not JSON */
      }
      return res;
    } catch (e) {
      s.status = 0;
      throw e;
    }
  });

  try {
    // ── Test connection, the catalog ──────────────────────────────────────
    let t = Date.now();
    const tested = keep(await connectionRun.testConnection('snowflake', values, secrets));
    ok(`snowflake: test connection signs in and lists (${Date.now() - t} ms)`, tested.ok, errOf(tested));
    const admin = snowflake.adminRole(cfg.role);
    ok(`snowflake: the admin-role warning is given exactly when the role is one (${admin ? 'it is' : 'it is not'})`,
      tested.ok && (admin ? tested.warnings?.length === 1 : !tested.warnings?.length), tested.ok ? tested.warnings : '');

    const listed = keep(await connectionRun.listTables('snowflake', values, secrets));
    ok('snowflake: listTables names at least one table (the account under test needs one — docs/server/live-data.md)', listed.ok && listed.tables.length > 0, errOf(listed));
    if (listed.ok && listed.tables.length > 0) {
      say(`snowflake: ${listed.tables.length} tables listed`);
      const want = (cfg.schema ?? '').toUpperCase();
      const pick = listed.tables.find((x) => want && (x.schema ?? '').toUpperCase().split('.').pop() === want) ?? listed.tables[0];
      const name = pick.schema ? `${pick.schema}.${pick.name}` : pick.name;
      ident('snowflake table', pick.name);
      const desc = keep(await connectionRun.describeTable('snowflake', values, secrets, name));
      ok('snowflake: describeTable gives a listed table\'s columns, each named and typed', !!desc && desc.ok && desc.columns.length > 0 && desc.columns.every((c) => c.name && c.type), errOf(desc));
    }

    // ── The row cap, partitions ───────────────────────────────────────────
    const fifty = 'select seq4() as i from table(generator(rowcount => 50))';
    const capped = keep(await connectionRun.runConnection('snowflake', values, secrets, { query: fifty }, { rowLimit: 7 }));
    ok('snowflake: 50 rows at a cap of 7 — 7 rows, reported truncated', capped.ok && capped.result.rows.length === 7 && capped.truncated
      && capped.result.warnings.some((w) => /truncated at 7 rows/.test(w)), errOf(capped));
    const exact = keep(await connectionRun.runConnection('snowflake', values, secrets, { query: fifty }, { rowLimit: 50 }));
    ok('snowflake: 50 rows at a cap of 50 — all of them, NOT truncated (the cap + 1 wrapper; negative control)', exact.ok && exact.result.rows.length === 50 && !exact.truncated, errOf(exact));

    const before = seen.length;
    t = Date.now();
    // ~160 bytes a row, ~48 MB for the 300,000 read: several partitions, inside the 100 MB ceiling.
    const big = await connectionRun.runConnection('snowflake', values, secrets,
      { query: 'select seq4() as i, uuid_string() as u, randstr(100, random()) as pad from table(generator(rowcount => 400000))' }, { rowLimit: 300_000 });
    const parts = seen.slice(before).filter((s) => s.method === 'GET' && s.url.searchParams.has('partition'));
    keep(big.ok ? { ok: true, rows: big.result.rows.length } : big);
    ok(`snowflake: 300,000 of 400,000 rows, read across ${parts.length} further partitions (gzip), reported truncated (${Date.now() - t} ms)`,
      big.ok && big.result.rows.length === 300_000 && big.truncated && parts.length > 0 && parts.every((p) => p.status === 200), errOf(big));
    if (big.ok) ok('snowflake: …no partition read twice or skipped (300,000 distinct ids)', new Set(big.result.rows.map((r) => r[0])).size === 300_000);

    // ── Types, through the dispatch (an extract) ──────────────────────────
    const typesSql = [
      "select 42 as n_int, 1234.5::number(12,2) as n_dec, (0.1::float + 0.2::float) as n_real, 12345678901234567890::number(38,0) as big_id,",
      "  '007' as code, '2024-03-01'::date as d, '2024-03-01 12:34:56.789'::timestamp_ntz as ts_ntz,",
      `  '2024-03-01 12:34:56.789 +05:30'::timestamp_tz as ts_tz, parse_json('{"a":1,"b":[true,null]}') as j, true as flag, '﻿bom' as bom`,
    ].join('\n');
    const typed = keep(await connectionRun.runConnection('snowflake', values, secrets, { query: typesSql }, { rowLimit: 10 }));
    ok('snowflake: the type query runs', typed.ok && typed.result.rows.length === 1, errOf(typed));
    if (typed.ok && typed.result.rows.length === 1) {
      const types = typed.result.columns.map((c) => c.type).join();
      const row = typed.result.rows[0];
      ok('snowflake types: number ×3, an id past 15 digits and "007" text, DATE / NTZ / TZ dates, JSON, boolean and U+FEFF text',
        types === 'number,number,number,text,text,date,date,date,text,text,text', types);
      ok('snowflake values: 42, 1234.5, 0.3 (a REAL printed at 15 digits for an extract), every digit of the id, "007"',
        Object.is(row[0], 42) && Object.is(row[1], 1234.5) && Object.is(row[2], 0.3) && row[3] === '12345678901234567890' && row[4] === '007', JSON.stringify(row.slice(0, 5)));
      ok('snowflake values: DATE as sent; TIMESTAMP_NTZ and TIMESTAMP_TZ as UTC ISO to the millisecond',
        row[5] === '2024-03-01' && row[6] === '2024-03-01T12:34:56.789Z' && row[7] === '2024-03-01T07:04:56.789Z', JSON.stringify(row.slice(5, 8)));
      ok('snowflake values: VARIANT as compact JSON text, a boolean as text, a leading U+FEFF kept',
        row[8] === '{"a":1,"b":[true,null]}' && row[9] === 'true' && row[10] === '﻿bom', JSON.stringify(row.slice(8)));
    }
    const session = keep(await live.runBound(ctxOf({ costTag: 'live' }), "select to_char(current_timestamp(), 'TZH:TZM') as tz, dayofweek('2024-03-03'::date) as sunday", []));
    ok('snowflake: the session runs in UTC with WEEK_START = 1 (Sunday is day 7), as the live compiler assumes',
      session.ok && session.rows[0]?.[0] === '+00:00' && String(session.rows[0]?.[1]) === '7', session.ok ? JSON.stringify(session.rows) : errOf(session));

    // ── runBound: adversarial literals, an injection control, typed binds ─
    const text = (v: string, i: number): LiveParam => ({ name: `p${i}`, type: 'text', value: v });
    const nasty = keep(await live.runBound(ctxOf({ costTag: 'live' }), 'select ' + NASTY.map((_, i) => `? as v${i}`).join(', '), NASTY.map(text)));
    ok(`snowflake runBound: ${NASTY.length} adversarial literals bound, each returned byte for byte (Object.is)`,
      nasty.ok && nasty.rows.length === 1 && NASTY.every((v, i) => Object.is(nasty.rows[0][i], v)), nasty.ok ? JSON.stringify(nasty.rows[0]) : errOf(nasty));
    const inj = "select count(*) as n from (select 'North' as region union all select 'South') where region = ?";
    const hostile = keep(await live.runBound(ctxOf({ costTag: 'live' }), inj, [text("x' or '1'='1", 0)]));
    const plain = keep(await live.runBound(ctxOf({ costTag: 'live' }), inj, [text('North', 0)]));
    ok('snowflake runBound: an injection-shaped literal matches no row of two; the plain value matches one (negative control)',
      hostile.ok && String(hostile.rows[0]?.[0]) === '0' && plain.ok && String(plain.rows[0]?.[0]) === '1', JSON.stringify([hostile, plain]));
    const binds = keep(await live.runBound(ctxOf({ costTag: 'live' }), 'select ? as n, ? as r, ? as b, ? as d, ? as t, ? as z', [
      { name: 'n', type: 'number', value: 42 }, { name: 'r', type: 'number', value: 2.5 }, { name: 'b', type: 'boolean', value: true },
      { name: 'd', type: 'date', value: '2024-03-01' }, { name: 't', type: 'timestamp', value: '2024-03-01T12:34:56.789Z' }, { name: 'z', type: 'text', value: null },
    ]));
    ok('snowflake runBound: FIXED, REAL, BOOLEAN, DATE, TIMESTAMP_NTZ and a NULL come back as bound',
      binds.ok && String(binds.rows[0]?.[0]) === '42' && Object.is(binds.rows[0][1], 2.5) && binds.rows[0][2] === true && binds.rows[0][3] === '2024-03-01'
      && binds.rows[0][4] === '2024-03-01T12:34:56.789Z' && binds.rows[0][5] === null, binds.ok ? JSON.stringify(binds.rows[0]) : errOf(binds));
    const nul = keep(await live.runBound(ctxOf({ costTag: 'live' }), 'select ? as v', [text('a\u0000b', 0)]));
    ok('snowflake runBound: a NUL inside a literal comes back exact, or the statement is refused — never another value',
      nul.ok ? nul.rows[0]?.[0] === 'a\u0000b' : true, nul.ok ? JSON.stringify(nul.rows) : '');
    say(`snowflake: a literal holding NUL was ${nul.ok ? 'returned exact' : 'refused by Snowflake'}`);

    // QUERY_TAG, read back from the warehouse's own history (needs a database for INFORMATION_SCHEMA).
    if (cfg.database) {
      const tagged = keep(await live.runBound(ctxOf({ costTag: 'live' }), `select '${nonce}' as nonce`, []));
      let tag: unknown;
      const found = tagged.ok && (await until(async () => {
        const h = keep(await connectionRun.runConnection('snowflake', values, secrets, {
          query: `select query_tag from table(information_schema.query_history(result_limit => 1000)) where query_text like '%${nonce}%' and query_text not ilike '%query_history%'`,
        }, { rowLimit: 5 }));
        tag = h.ok ? h.result.rows[0]?.[0] : undefined;
        return tag !== undefined;
      }, 20_000, 2_000));
      ok('snowflake: QUERY_TAG reads ordinate:<org>:live in the warehouse\'s own query history', found && tag === `ordinate:${ORG}:live`, String(tag));
    } else {
      say('snowflake: QUERY_TAG not read back (SNOWFLAKE_DATABASE is unset, so there is no INFORMATION_SCHEMA to ask)');
    }

    // ── Cancel on abort, confirmed by Snowflake ───────────────────────────
    const ac = new AbortController();
    const from = seen.length;
    t = Date.now();
    const pending = def.run(ctxOf({ timeoutMs: 120_000, signal: ac.signal }), 'select system$wait(100) as w');
    setTimeout(() => ac.abort(), 3_000);
    const aborted = keep(await pending);
    const answered = Date.now() - t;
    ok(`snowflake: an aborted query answers at once, as cancelled (${answered} ms after submit, abort at 3 s)`, !aborted.ok && /cancelled/i.test(errOf(aborted)) && answered < 6_000, errOf(aborted));
    // A sync submit is parked by Snowflake for up to ~45 s before its 202 names the handle; the cancel follows it.
    const cancelled = await until(() => seen.slice(from).some((s) => s.url.pathname.endsWith('/cancel') && s.status === 200), 80_000);
    const submit = seen.slice(from).find((s) => s.method === 'POST' && s.handle);
    ok(`snowflake: POST …/cancel sent for the statement and accepted (${Date.now() - t} ms after submit)`, cancelled && !!submit,
      JSON.stringify(seen.slice(from).map((s) => [s.method, s.url.pathname.replace(/[0-9a-f-]{20,}/g, '<handle>'), s.status])));
    if (submit) {
      let status = 0;
      let body = '';
      await until(async () => {
        const r = await sfHttp.snowflakeFetch({ url: new URL(`/api/v2/statements/${encodeURIComponent(submit.handle)}`, submit.url), method: 'GET', headers: submit.headers, timeoutMs: 15_000, maxBytes: 1 << 20 });
        status = r.status;
        body = r.body;
        return r.status !== 202;
      }, 30_000, 1_000);
      ok('snowflake: …and Snowflake reports the statement cancelled (HTTP 422, 000604)', status === 422 && /000604|cancel/i.test(body), `${status} ${body.slice(0, 200)}`);
    }

    // ── An error from the warehouse (for the canary) ─────────────────────
    const missing = keep(await connectionRun.runConnection('snowflake', values, secrets, { query: `select * from ordinate_no_such_table_${nonce}` }));
    ok('snowflake: a statement Snowflake refuses comes back as an error sentence', !missing.ok && errOf(missing).length > 0);

    // ── What went over the wire ──────────────────────────────────────────
    ok(`snowflake: no request of ${seen.length} carried the key, its passphrase or the bearer outside the Authorization header`,
      seen.length > 10 && seen.every((s) => !leaks(`${s.url.href}\n${s.body}\n${JSON.stringify({ ...s.headers, authorization: '' })}`)));
    ok('snowflake: every request went to the account\'s own snowflakecomputing.com host, over https',
      seen.every((s) => s.url.protocol === 'https:' && s.url.hostname.endsWith('.snowflakecomputing.com')));
  } finally {
    snowflake.setTransport(null);
  }
}

const leaks = (hay: string): boolean => leaksIn(hay).length > 0;
