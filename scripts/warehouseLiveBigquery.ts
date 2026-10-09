// The BigQuery half of scripts/test-warehouseLive.ts: the real connector,
// through the real registry and dispatch, against a real project. Every request
// still goes through the real transport (http.ts's httpRequest, the SSRF guard
// on — the suite runs in server mode); the seam only WATCHES it: which scopes
// each token was asked for, pages, dry runs, the cancel.
//
// It also answers the plan's unverified read-only spike (docs/live-data/log.md,
// L1.3): which scopes Google actually granted the query token, whether
// jobs.query takes it, and whether a WRITE sent with it is refused by Google or
// only by Ordinate's dry-run gate. Those answers are recorded (`spike`), not
// asserted — either outcome is safe by design; the run says which one holds.
//
// Not a suite itself: test-warehouseLive.ts calls `runBigquery` when the
// BIGQUERY_* variables are set.

import { errOf, ident, keep, leaksIn, ok, say, secret, spike, until } from './warehouseLiveHarness';

const registry: typeof import('../src/connectors') = require('../src/connectors');
const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const bq: typeof import('../src/connectors/bigquery') = require('../src/connectors/bigquery');
const auth: typeof import('../src/connectors/bigqueryAuth') = require('../src/connectors/bigqueryAuth');
const shape: typeof import('../src/connectors/bigqueryShape') = require('../src/connectors/bigqueryShape');
const http: typeof import('../src/connectors/http') = require('../src/connectors/http');

type Ctx = import('../src/connectors/types').ConnectorContext;
type LiveParam = import('../src/connectors/types').LiveParam;

export interface BigqueryConfig {
  keyJson: string;
  project?: string;
  dataset?: string;
  location?: string;
  /** A dataset the account may WRITE, for the spike's permanent-table probe. Optional. */
  scratch?: string;
}

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
  status: number; // -1 in flight, 0 failed
  dry: boolean;
}

const PUBLIC_TABLE = 'bigquery-public-data.samples.shakespeare'; // static, readable by any account, in US
const NASTY = [`O'Brien`, `x' OR '1'='1`, 'back\\slash\\', '’curly’ “quotes”', '${process.env.HOME}', '`; DROP TABLE t; --', '@p999', '﻿bom',
  'é😀', 'line\nbreak', '', '/* c */', '?'];
// A write that needs no IAM grant at all — a temp table lives in the job's own anonymous dataset —
// so a refusal of it can only be the token's scopes (or Ordinate's gate).
const TEMP_WRITE = 'CREATE TEMP TABLE ordinate_scope_probe AS SELECT 1 AS x;\nSELECT x FROM ordinate_scope_probe';

/** What Google said to a request: accepted, or who refused it and why. */
function googleSaid(status: number, json: unknown): string {
  if (status >= 200 && status < 300) return 'accepted (the job was created)';
  const e = shape.prop(json, 'error');
  const msg = String(shape.prop(e, 'message') ?? '').slice(0, 200);
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const reasons = [...list(shape.prop(e, 'errors')), ...list(shape.prop(e, 'details'))].map((x) => String(shape.prop(x, 'reason') ?? '')).filter(Boolean);
  if (status === 403 && (/insufficient authentication scopes/i.test(msg) || reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT'))) return 'refused by Google: insufficient authentication scopes';
  if (status === 403 && reasons.includes('accessDenied')) return `refused by Google: IAM (accessDenied) — ${msg}`;
  return `refused by Google: HTTP ${status} ${reasons.join(',')} — ${msg}`;
}

/** Who refused a write the connector was asked to run. */
function whoRefused(r: { ok: boolean; error?: string }): string {
  if (r.ok) return 'NOT refused';
  const e = String(r.error ?? '');
  const gate = /^Refused: only SELECT statements .* this is (.*)\.$/.exec(e);
  if (gate) return `Ordinate's dry-run gate (${gate[1]})`;
  return /insufficient authentication scopes/i.test(e) ? 'Google: insufficient authentication scopes' : `Google, at the dry run — ${e.slice(0, 200)}`;
}

export async function runBigquery(cfg: BigqueryConfig, nonce: string): Promise<void> {
  const def = registry.getConnector('bigquery');
  ok('bigquery: registered, read-only, with a live capability that estimates', !!def && def.readOnly === true && def.live?.dialect === 'bigquery' && typeof def.live.estimate === 'function');
  secret('BigQuery key file', cfg.keyJson);
  const key = auth.parseKey(cfg.keyJson);
  ok('bigquery: the key file is a service-account key this server accepts', !('ok' in key), 'ok' in key ? key.error : '');
  if (!def?.live?.estimate || 'ok' in key) return;
  secret('BigQuery private key', (JSON.parse(cfg.keyJson) as { private_key?: string }).private_key);
  secret('BigQuery private key id', key.privateKeyId);
  const project = cfg.project || key.projectId || '';
  for (const [l, v] of [['bigquery project', project], ['bigquery dataset', cfg.dataset], ['bigquery scratch dataset', cfg.scratch], ['service account', key.clientEmail]] as const) ident(l, v);

  const values: Record<string, unknown> = {};
  if (cfg.project) values.project = cfg.project;
  if (cfg.dataset) values.dataset = cfg.dataset;
  if (cfg.location) values.location = cfg.location;
  const anywhere: Record<string, unknown> = { ...values };
  delete anywhere.location; // the public table lives in US; an unset location lets BigQuery follow the data
  const secrets = { token: cfg.keyJson };
  const ctxOf = (extra: Partial<Ctx> = {}, v = values): Ctx => ({ ...connectionRun.buildContext(v, secrets, { rowLimit: 1000 }), ...extra });
  const live = def.live;
  const estimate = def.live.estimate;

  // Watch the real transport.
  const calls: Call[] = [];
  const scopeOf = new Map<string, string>(); // access token → the scopes it was asked for
  const replyScope = new Map<string, string>(); // asked scopes → `scope` in Google's reply, when it sends one
  bq.setTransport(async (o) => {
    const c: Call = { url: o.url, method: o.method, headers: { ...(o.headers ?? {}) }, body: o.body ?? '', status: -1, dry: false };
    calls.push(c);
    let asked = '';
    if (o.url.hostname === auth.TOKEN_HOST && o.url.pathname === '/token') {
      const assertion = new URLSearchParams(c.body).get('assertion') ?? '';
      secret('BigQuery signed assertion', assertion);
      try {
        asked = String((JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8')) as { scope?: unknown }).scope ?? '');
      } catch {
        /* not a JWT: the exchange fails on its own */
      }
    }
    try {
      c.dry = (JSON.parse(c.body) as { dryRun?: unknown }).dryRun === true;
    } catch {
      /* a GET */
    }
    try {
      const r = await http.httpRequest(o);
      c.status = r.status;
      if (asked && r.status === 200) {
        const j = JSON.parse(r.body) as { access_token?: unknown; scope?: unknown };
        if (typeof j.access_token === 'string') {
          secret('BigQuery access token', j.access_token);
          scopeOf.set(j.access_token, asked);
          if (typeof j.scope === 'string') replyScope.set(asked, j.scope);
        }
      }
      return r;
    } catch (e) {
      c.status = 0;
      throw e;
    }
  });
  const bearer = (c: Call): string => (c.headers.authorization ?? '').replace(/^Bearer /, '');
  const READ = auth.READ_SCOPES.join(' ');
  const executed = (from: number): Call[] => calls.slice(from).filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/queries') && !c.dry);
  /** One raw request through the connector's own guarded door, for the spike and jobs.get. */
  const api = async (method: 'GET' | 'POST', url: URL, token: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> => {
    const r = await bq.send({ url, method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), timeoutMs: 30_000, maxBytes: 1 << 20 });
    let json: unknown;
    try {
      json = JSON.parse(r.body) as unknown;
    } catch {
      json = undefined;
    }
    return { status: r.status, json };
  };
  const loc = cfg.location ? { location: cfg.location } : {};

  try {
    // ── Test connection, the catalog ──────────────────────────────────────
    let t = Date.now();
    const tested = keep(await connectionRun.testConnection('bigquery', values, secrets));
    ok(`bigquery: test connection mints a token and lists (${Date.now() - t} ms)`, tested.ok, errOf(tested));
    const listed = keep(await connectionRun.listTables('bigquery', values, secrets));
    ok('bigquery: listTables answers, every name a dataset.table the dispatch can quote', listed.ok && listed.tables.every((x) => connectionRun.buildTableSql('bigquery', `${x.schema}.${x.name}`, 1) !== null), errOf(listed));
    if (listed.ok) say(`bigquery: ${listed.tables.length} tables listed`);
    const desc = keep(await connectionRun.describeTable('bigquery', values, secrets, PUBLIC_TABLE));
    ok('bigquery: describeTable (tables.get) on a public table: its four columns, their types, a row estimate',
      !!desc && desc.ok && desc.columns.map((c) => `${c.name}:${c.type}`).join() === 'word:STRING,word_count:INTEGER,corpus:STRING,corpus_date:INTEGER' && (desc.rowEstimate ?? 0) > 0,
      desc && desc.ok ? JSON.stringify(desc.columns) : errOf(desc));

    // ── The token's scopes (the spike, part 1) ────────────────────────────
    const readToken = [...scopeOf].find(([, s]) => s === READ)?.[0];
    ok('bigquery: the query token was asked for exactly the two read-only scopes', !!readToken, JSON.stringify([...scopeOf.values()]));
    if (readToken) {
      const info = async (how: 'header' | 'form') => bq.send(how === 'header'
        ? { url: new URL('https://oauth2.googleapis.com/tokeninfo'), method: 'POST', headers: { authorization: `Bearer ${readToken}` }, timeoutMs: 15_000, maxBytes: 65_536 }
        : { url: new URL('https://oauth2.googleapis.com/tokeninfo'), method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ access_token: readToken }).toString(), timeoutMs: 15_000, maxBytes: 65_536 });
      let r = await info('header');
      if (r.status !== 200) r = await info('form');
      let granted: string[] = [];
      try {
        granted = String((JSON.parse(r.body) as { scope?: unknown }).scope ?? '').split(/\s+/).filter(Boolean);
      } catch {
        /* reported below */
      }
      spike('scopes asked for (query token)', READ);
      spike('scopes granted (tokeninfo)', granted.length ? granted.join(' ') : `unknown — tokeninfo answered HTTP ${r.status}`);
      spike('scopes in the token reply', replyScope.get(READ) ?? 'not sent');
      ok('bigquery: the query token carries no scope beyond the read-only two (tokeninfo)', granted.length > 0 && granted.every((s) => auth.READ_SCOPES.includes(s)), `${r.status} ${granted.join(' ')}`);
    }

    // ── The row cap, pages ────────────────────────────────────────────────
    const fifty = 'select i from unnest(generate_array(1, 50)) as i';
    const capped = keep(await connectionRun.runConnection('bigquery', values, secrets, { query: fifty }, { rowLimit: 7 }));
    ok('bigquery: 50 rows at a cap of 7 — 7 rows, reported truncated', capped.ok && capped.result.rows.length === 7 && capped.truncated
      && capped.result.warnings.some((w) => /truncated at 7 rows/.test(w)), errOf(capped));
    const exact = keep(await connectionRun.runConnection('bigquery', values, secrets, { query: fifty }, { rowLimit: 50 }));
    ok('bigquery: 50 rows at a cap of 50 — all of them, NOT truncated (the cap + 1 wrapper; negative control)', exact.ok && exact.result.rows.length === 50 && !exact.truncated, errOf(exact));
    const before = calls.length;
    t = Date.now();
    const big = await connectionRun.runConnection('bigquery', values, secrets,
      { query: "select i, format('%032d', i) as s from unnest(generate_array(1, 150000)) as i" }, { rowLimit: 120_000 });
    const pages = calls.slice(before).filter((c) => c.method === 'GET' && c.url.searchParams.has('pageToken'));
    keep(big.ok ? { ok: true, rows: big.result.rows.length } : big);
    ok(`bigquery: 120,000 of 150,000 rows, ${pages.length} further pages followed by pageToken, reported truncated (${Date.now() - t} ms)`,
      big.ok && big.result.rows.length === 120_000 && big.truncated && pages.length > 0 && pages.every((p) => p.status === 200), errOf(big));
    if (big.ok) ok('bigquery: …no page read twice or skipped (120,000 distinct ids)', new Set(big.result.rows.map((r) => r[0])).size === 120_000);

    // ── Types, through the dispatch (an extract) ──────────────────────────
    const typesSql = [
      "select 42 as n_int, numeric '1234.5' as n_dec, 0.5 + 0.25 as n_real, 1234567890123456789 as big_id, '007' as code, date '2024-03-01' as d,",
      "  datetime '2024-03-01 12:34:56.789' as dt, timestamp '2024-03-01 12:34:56.789+05:30' as ts, json '{\"a\":1,\"b\":[true,null]}' as j,",
      "  [1, 2, 3] as arr, struct(1 as x, 'y' as y) as rec, true as flag, '﻿bom' as bom",
    ].join('\n');
    const typed = keep(await connectionRun.runConnection('bigquery', values, secrets, { query: typesSql }, { rowLimit: 10 }));
    ok('bigquery: the type query runs', typed.ok && typed.result.rows.length === 1, errOf(typed));
    if (typed.ok && typed.result.rows.length === 1) {
      const types = typed.result.columns.map((c) => c.type).join();
      const row = typed.result.rows[0];
      ok('bigquery types: number ×3, a 19-digit INT64 id and "007" text, DATE / DATETIME / TIMESTAMP dates, JSON / REPEATED / RECORD / BOOL / U+FEFF text',
        types === 'number,number,number,text,text,date,date,date,text,text,text,text,text', types);
      ok('bigquery values: 42, 1234.5, 0.75, every digit of the id, "007"',
        Object.is(row[0], 42) && Object.is(row[1], 1234.5) && Object.is(row[2], 0.75) && row[3] === '1234567890123456789' && row[4] === '007', JSON.stringify(row.slice(0, 5)));
      ok('bigquery values: DATE and DATETIME as sent; TIMESTAMP (epoch seconds on the wire) as UTC ISO to the millisecond',
        row[5] === '2024-03-01' && String(row[6]).startsWith('2024-03-01T12:34:56.789') && row[7] === '2024-03-01T07:04:56.789Z', JSON.stringify(row.slice(5, 8)));
      let j: unknown;
      try { j = JSON.parse(String(row[8])); } catch { j = undefined; }
      ok('bigquery values: JSON, REPEATED and RECORD as JSON text, BOOL as text, a leading U+FEFF kept',
        JSON.stringify(j) === '{"a":1,"b":[true,null]}' && row[9] === '[1,2,3]' && row[10] === '{"x":1,"y":"y"}' && row[11] === 'true' && row[12] === '﻿bom', JSON.stringify(row.slice(8)));
    }

    // ── runBound: adversarial literals, an injection control, typed parameters ─
    const text = (v: string, i: number): LiveParam => ({ name: `p${i}`, type: 'text', value: v });
    const nasty = keep(await live.runBound(ctxOf({ costTag: 'live' }), 'select ' + NASTY.map((_, i) => `@p${i} as v${i}`).join(', '), NASTY.map(text)));
    ok(`bigquery runBound: ${NASTY.length} adversarial literals as named parameters, each returned byte for byte (Object.is)`,
      nasty.ok && nasty.rows.length === 1 && NASTY.every((v, i) => Object.is(nasty.rows[0][i], v)), nasty.ok ? JSON.stringify(nasty.rows[0]) : errOf(nasty));
    const inj = "select count(*) as n from unnest(['North', 'South']) as region where region = @p0";
    const hostile = keep(await live.runBound(ctxOf({ costTag: 'live' }), inj, [text(`x' OR '1'='1`, 0)]));
    const plain = keep(await live.runBound(ctxOf({ costTag: 'live' }), inj, [text('North', 0)]));
    ok('bigquery runBound: an injection-shaped literal matches no row of two; the plain value matches one (negative control)',
      hostile.ok && hostile.rows[0]?.[0] === '0' && plain.ok && plain.rows[0]?.[0] === '1', JSON.stringify([hostile, plain]));
    const binds = keep(await live.runBound(ctxOf({ costTag: 'live' }), 'select @n as n, @r as r, @b as b, @d as d, @t as t, @z as z', [
      { name: 'n', type: 'number', value: 42 }, { name: 'r', type: 'number', value: 2.5 }, { name: 'b', type: 'boolean', value: true },
      { name: 'd', type: 'date', value: '2024-03-01' }, { name: 't', type: 'timestamp', value: '2024-03-01T12:34:56.789Z' }, { name: 'z', type: 'text', value: null },
    ]));
    ok('bigquery runBound: INT64, FLOAT64, BOOL, DATE, TIMESTAMP and a typed NULL come back as bound',
      binds.ok && binds.rows[0]?.[0] === '42' && binds.rows[0][1] === '2.5' && binds.rows[0][2] === true && binds.rows[0][3] === '2024-03-01'
      && binds.rows[0][4] === '2024-03-01T12:34:56.789Z' && binds.rows[0][5] === null, binds.ok ? JSON.stringify(binds.rows[0]) : errOf(binds));
    const nul = keep(await live.runBound(ctxOf({ costTag: 'live' }), 'select @p0 as v', [text('a\u0000b', 0)]));
    ok('bigquery runBound: a NUL inside a literal comes back exact, or the query is refused — never another value', nul.ok ? nul.rows[0]?.[0] === 'a\u0000b' : true);
    say(`bigquery: a literal holding NUL was ${nul.ok ? 'returned exact' : 'refused by BigQuery'}`);
    ok('bigquery runBound: compiled SQL is not dry-run (no extra round trip on a chart)', calls.filter((c) => c.dry && /@p0 as v0/.test(c.body)).length === 0);

    // ── The estimate ──────────────────────────────────────────────────────
    const priced = keep(await connectionRun.estimateSql('bigquery', anywhere, secrets, `select word, word_count from \`${PUBLIC_TABLE}\``));
    ok('bigquery: the estimate prices a SELECT before it runs — bytes > 0, a server-formatted label, free (a dry run only)',
      !!priced && priced.ok && priced.bytes > 0 && /^~[\d.]+ (B|KB|MB|GB)$/.test(priced.label) && calls.at(-1)?.dry === true, priced && priced.ok ? JSON.stringify(priced) : errOf(priced));
    const pricedBound = keep(await estimate(ctxOf({}, anywhere), `select word from \`${PUBLIC_TABLE}\` where word_count > @p0`, [{ name: 'p0', type: 'number', value: 10 }]));
    ok('bigquery: live.estimate prices a statement with named parameters', pricedBound.ok && pricedBound.bytes > 0, errOf(pricedBound));

    // ── Read-only: the dry-run gate, and the spike's write probes ─────────
    let from = calls.length;
    const assertStmt = keep(await estimate(ctxOf(), "ASSERT 1 = 1 AS 'ordinate gate probe'", []));
    const viaEstimate = keep(await estimate(ctxOf(), TEMP_WRITE, []));
    const viaRun = keep(await connectionRun.runConnection('bigquery', values, secrets, { query: TEMP_WRITE }));
    ok('bigquery gate: an ASSERT and a writing script are refused, through estimate and through run, and no job is created',
      !assertStmt.ok && !viaEstimate.ok && !viaRun.ok && executed(from).length === 0, JSON.stringify([errOf(assertStmt), errOf(viaEstimate), errOf(viaRun)]));
    ok('bigquery gate: on the real service the dry run names a statementType that is not SELECT, and the gate refuses on it',
      [assertStmt, viaEstimate].some((r) => whoRefused(r).startsWith("Ordinate's dry-run gate")), JSON.stringify([whoRefused(assertStmt), whoRefused(viaEstimate)]));
    spike('ASSERT through Ordinate\'s estimate', whoRefused(assertStmt));
    spike('a write (temp-table script) through Ordinate\'s estimate', whoRefused(viaEstimate));
    spike('a write (temp-table script) through Ordinate\'s run (inside the row-cap wrapper)', whoRefused(viaRun));

    if (readToken) {
      const q = shape.queriesUrl(project);
      const sel = await api('POST', q, readToken, { query: 'SELECT 1 AS one', useLegacySql: false, timeoutMs: 20_000, ...loc });
      spike('jobs.query SELECT 1 with the read-only token', googleSaid(sel.status, sel.json));
      ok('bigquery: jobs.query accepts the read-only token for a SELECT', sel.status === 200, googleSaid(sel.status, sel.json));
      const write = await api('POST', q, readToken, {
        query: TEMP_WRITE, useLegacySql: false, timeoutMs: 20_000, maximumBytesBilled: String(10 * 2 ** 20), labels: { ordinate: 'scope-probe' }, ...loc,
      });
      const temp = googleSaid(write.status, write.json);
      spike('a write needing no IAM grant (temp-table script) sent straight to jobs.query with the read-only token', temp);
      if (cfg.scratch && shape.validDataset(cfg.scratch)) {
        const table = `\`${project}.${cfg.scratch}.ordinate_scope_probe_${nonce}\``;
        const ctas = await api('POST', q, readToken, { query: `CREATE TABLE ${table} AS SELECT 1 AS x`, useLegacySql: false, timeoutMs: 20_000, ...loc });
        spike('CREATE TABLE … AS SELECT 1 into the scratch dataset with the read-only token', googleSaid(ctas.status, ctas.json));
        if (ctas.status === 200) {
          const drop = await api('POST', q, readToken, { query: `DROP TABLE IF EXISTS ${table}`, useLegacySql: false, timeoutMs: 20_000, ...loc });
          spike('…the probe table dropped again', drop.status === 200 ? 'yes' : `NO — drop ordinate_scope_probe_${nonce} by hand (${googleSaid(drop.status, drop.json)})`);
        }
      } else {
        spike('CREATE TABLE … AS SELECT 1 into a writable dataset', 'not run: BIGQUERY_SCRATCH_DATASET is unset');
      }
      spike('verdict', sel.status !== 200
        ? 'Google refuses the read-only scopes for jobs.query: every BigQuery query fails (log, L1.3: decide with the owner)'
        : temp.includes('insufficient authentication scopes')
          ? 'Google enforces read-only under these scopes; the dry-run gate is defence in depth'
          : temp.startsWith('accepted')
            ? 'Google does NOT refuse a write under these scopes; read-only rests on the dry-run gate and the IAM roles'
            : `inconclusive: ${temp}`);
    } else {
      spike('scopes granted (tokeninfo)', `none — no read-only token was issued: ${errOf(tested) || 'the exchange was never seen'}`);
    }

    // ── Cancel on abort, confirmed by BigQuery ────────────────────────────
    const ac = new AbortController();
    from = calls.length;
    t = Date.now();
    // Long on the wall clock, light on CPU (an on-demand job that burns much CPU over few bytes is
    // stopped for its billing tier): each iteration of a recursive CTE is a stage of its own, in turn.
    const heavy = 'with recursive r as (select 1 as n union all select n + 1 from r where n < 450) select max(n) as n from r';
    const pending = def.run(ctxOf({ timeoutMs: 120_000, signal: ac.signal }), heavy);
    setTimeout(() => ac.abort(), 4_000);
    const aborted = keep(await pending);
    const answered = Date.now() - t;
    ok(`bigquery: an aborted query answers at once, as cancelled (${answered} ms after submit, abort at 4 s)`, !aborted.ok && /cancelled/i.test(errOf(aborted)) && answered < 8_000, errOf(aborted));
    const isCancel = (c: Call): boolean => c.method === 'POST' && /\/jobs\/[^/]+\/cancel$/.test(c.url.pathname);
    const sent = await until(() => calls.slice(from).some((c) => isCancel(c) && c.status === 200), 40_000);
    const cancel = calls.slice(from).find(isCancel);
    ok(`bigquery: jobs.cancel sent when the job id landed, and accepted (${Date.now() - t} ms after submit)`, sent && !!cancel,
      JSON.stringify(calls.slice(from).map((c) => [c.method, c.url.pathname.replace(/\/projects\/[^/]+/, '/projects/<p>').replace(/\/(queries|jobs)\/[^/]+/, '/$1/<job>'), c.status])));
    if (cancel && readToken) {
      ok('bigquery: …with the cancel-only token (the bigquery scope), never the read token', scopeOf.get(bearer(cancel)) === auth.CANCEL_SCOPES.join(' '));
      const job = new URL(cancel.url.href.replace(/\/cancel(\?|$)/, '$1'));
      let state = '';
      let error: unknown;
      await until(async () => {
        const r = await api('GET', job, readToken);
        state = String(shape.prop(shape.prop(r.json, 'status'), 'state') ?? `HTTP ${r.status}`);
        error = shape.prop(shape.prop(r.json, 'status'), 'errorResult');
        return state === 'DONE';
      }, 60_000, 1_000);
      ok('bigquery: …and BigQuery reports the job stopped by the cancel (jobs.get: DONE, reason "stopped")',
        state === 'DONE' && (shape.prop(error, 'reason') === 'stopped' || /cancel/i.test(String(shape.prop(error, 'message') ?? ''))), `${state} ${JSON.stringify(error)}`);
    }

    // ── An error from the warehouse (for the canary) ─────────────────────
    const broken = keep(await connectionRun.runConnection('bigquery', values, secrets, { query: `select * from ordinate_no_such_dataset_${nonce}.t` }));
    ok('bigquery: a statement BigQuery refuses comes back as an error sentence', !broken.ok && errOf(broken).length > 0);

    // ── What went over the wire ──────────────────────────────────────────
    const ours = calls.filter((c) => c.url.pathname !== '/tokeninfo'); // the spike's own tokeninfo call carries a token by design
    ok(`bigquery: no request of ${ours.length} carried the key; access tokens only ever in the Authorization header`,
      ours.length > 10 && ours.every((c) => leaksIn(`${c.url.href}\n${JSON.stringify({ ...c.headers, authorization: '' })}`).length === 0
        && leaksIn(c.body).every((l) => l === 'BigQuery signed assertion')));
    ok('bigquery: every request went to the two declared Google hosts, over https', calls.every((c) => c.url.protocol === 'https:' && bq.HOSTS.includes(c.url.hostname)));
  } finally {
    bq.setTransport(null);
  }
}
