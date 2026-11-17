// BigQuery's ingestion-time partition filter on a REAL table: part of scripts/test-warehouseLive.ts (the
// real-account nightly), not a suite. A table that requires a filter on `_PARTITIONTIME` gets the required range as
// `lv_src._PARTITIONTIME >= @from AND lv_src._PARTITIONTIME < @to+1`, two TIMESTAMPs at UTC midnight, on the table's
// own scan (engine/live/liveDateRange, compileFilter `partitionTimeRange`). BigQuery's documentation shows the
// pseudo-column only unqualified and against literals, so this runs our shapes (docs/live-data/log.md, 2026-11-16):
//
//   fixture  `<scratch>.ordinate_partitiontime`, PARTITION BY _PARTITIONDATE, require_partition_filter, rewritten each
//            run (CREATE OR REPLACE: idempotent; it expires itself three days on) with rows on the range's first and
//            last days, on the day after it (this month) and, 1,000 of them, on the day before. The connector never
//            writes, so the harness mints its own `bigquery`-scope token for this one script.
//   facts    `readFacts` (sourceTable:read, one tables.get): `_PARTITIONTIME`, DAY, required, which is what makes the
//            target ask for the range. CONTROL: the same KPI without it is refused by BigQuery's own dry run, so
//            "it answered" means the filter counted.
//   doors    through the real executor and connector: a chart (`liveVizData`), a KPI (`liveMetric`), an answer whose
//            case fix reads the range, an empty answer whose latest-day probe does, and SQL on Live (`runLiveSql`,
//            its view CTE). Each answers, with the figures of the in-range rows folded here, and says the range.
//   bytes    each statement billed at most twice BigQuery's 10 MB minimum, and read fewer bytes than the table holds.
//   spike    the KPI's dry run with the pseudo-column unqualified, recorded only.
//
// It needs BIGQUERY_SCRATCH_DATASET, the dataset the test account may write; without it, one skip line.
// scripts/test-warehousePartitionTime.ts runs the whole case on every `npm test` against a stand-in BigQuery.

import { errOf, ident, keep, ok as harnessOk, say, secret, spike, summary, until } from './warehouseLiveHarness';
import type { BigqueryConfig } from './warehouseLiveBigquery';

const auth: typeof import('../src/connectors/bigqueryAuth') = require('../src/connectors/bigqueryAuth');
const bq: typeof import('../src/connectors/bigquery') = require('../src/connectors/bigquery');
const shape: typeof import('../src/connectors/bigqueryShape') = require('../src/connectors/bigqueryShape');
const http: typeof import('../src/connectors/http') = require('../src/connectors/http');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const dateRange: typeof import('../src/engine/live/liveDateRange') = require('../src/engine/live/liveDateRange');

type Ok = (label: string, cond: boolean, extra?: unknown) => void;
type Transport = import('../src/connectors/bigquery').Transport;

export const TABLE = 'ordinate_partitiontime';
/** BigQuery bills at least 10 MB per table a query reads; a CTE read twice may count twice. */
export const MAX_BILLED = 2 * 10 * 2 ** 20;
const COLUMNS: import('../src/data/parse').ParsedColumn[] = [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'day', type: 'date' }];
const PARTITION_ERROR = /without a filter that can be used for partition elimination/i;

/** `n` rows of one value, in the partition of its `day`. */
export interface Row { day: string; region: string; amount: number; n: number }

const shift = (iso: string, days: number): string => dateIntel.isoFromDays(dateIntel.daysFromIso(iso)! + days);

/** The required range's first and last days hold rows; the day after (this month) and the day before do too, outside it. */
export function fixtureRows(from: string, to: string): Row[] {
  return [
    { day: from, region: 'West', amount: 10, n: 1 },
    { day: to, region: 'West', amount: 5, n: 1 },
    { day: to, region: 'East', amount: 7, n: 1 },
    { day: shift(to, 1), region: 'West', amount: 100000, n: 1 },
    { day: shift(to, 1), region: 'WEST', amount: 3, n: 1 }, // a spelling only outside: a case fix that read it would pick it
    { day: shift(from, -1), region: 'North', amount: 1, n: 1000 }, // the bytes a pruned read skips
  ];
}

/** The script that (re)writes the fixture: our own ISO days, words and integers, checked, never a caller's value. */
export function fixtureScript(table: string, rows: readonly Row[], expiresAt: string): string {
  const q = `\`${table}\``;
  const bad = rows.find((r) => dateIntel.daysFromIso(r.day) === null || !/^[A-Za-z]+$/.test(r.region) || !Number.isSafeInteger(r.amount) || !Number.isSafeInteger(r.n));
  if (bad || !/^[\w.-]+$/.test(table) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expiresAt)) throw new Error('the fixture holds only our own literals');
  const selects = rows.map((r) => `SELECT TIMESTAMP '${r.day}' AS pt, '${r.region}' AS region, CAST(${r.amount} AS FLOAT64) AS amount, DATE '${r.day}' AS day FROM UNNEST(GENERATE_ARRAY(1, ${r.n}))`);
  return [
    `CREATE OR REPLACE TABLE ${q} (region STRING, amount FLOAT64, day DATE) PARTITION BY _PARTITIONDATE`,
    `OPTIONS (require_partition_filter = TRUE, partition_expiration_days = 3650, expiration_timestamp = TIMESTAMP '${expiresAt}');`,
    `INSERT INTO ${q} (_PARTITIONTIME, region, amount, day) SELECT pt, region, amount, day FROM (${selects.join('\nUNION ALL ')});`,
  ].join('\n');
}

/** What the in-range rows hold: each door's figure, folded here. */
export function expected(rows: readonly Row[], from: string, to: string): { byRegion: Map<string, number>; total: number; lastDay: string } {
  const inside = rows.filter((r) => r.day >= from && r.day <= to);
  const byRegion = new Map<string, number>();
  for (const r of inside) byRegion.set(r.region, (byRegion.get(r.region) ?? 0) + r.amount * r.n);
  return { byRegion, total: [...byRegion.values()].reduce((a, b) => a + b, 0), lastDay: inside.map((r) => r.day).sort().at(-1) ?? '' };
}

interface Seen { sql: string; dry: boolean; status: number; json: unknown }

/** A query reply's first row's first cell, as BigQuery sent it. */
function firstCell(json: unknown): unknown {
  const rows = shape.prop(json, 'rows');
  const f = Array.isArray(rows) ? shape.prop(rows[0], 'f') : undefined;
  return Array.isArray(f) ? shape.prop(f[0], 'v') : undefined;
}

/** The case, on `cfg`'s project. `inner`: what the watch sends through (the network; the suite's stand-in). */
export async function runPartitionTime(cfg: BigqueryConfig, inner: Transport = http.httpRequest, ok: Ok = harnessOk): Promise<void> {
  if (!cfg.scratch) {
    console.log('skip BigQuery partition-time case: BIGQUERY_SCRATCH_DATASET is not set (docs/server/live-data.md, "Testing against a real account")');
    summary('- BigQuery partition time: skipped — BIGQUERY_SCRATCH_DATASET is not set');
    return;
  }
  if (!shape.validDataset(cfg.scratch)) return ok('partition time: BIGQUERY_SCRATCH_DATASET is a dataset name (set but unusable fails, never skips)', false);
  const key = auth.parseKey(cfg.keyJson);
  if ('ok' in key) return ok('partition time: the key file is one this server accepts', false, key.error);
  secret('BigQuery key file', cfg.keyJson);
  const project = cfg.project || key.projectId || '';
  ident('bigquery project', project);
  ident('bigquery scratch dataset', cfg.scratch);
  const table = `${project}.${cfg.scratch}.${TABLE}`;
  const { values, secrets } = (require('./warehouseLiveBigquery') as typeof import('./warehouseLiveBigquery')).bigqueryConnection(cfg);
  const range = dateRange.requiredRange({ requiredTime: true }, []);
  const time = range.ok ? range.filters[0] : null;
  if (!range.ok || time?.kind !== 'range' || !time.from || !time.to) return ok('partition time: the required range resolves', false, JSON.stringify(range));
  const { from, to } = time;
  const sentence = range.notes[0];
  const rows = fixtureRows(from, to);
  const want = expected(rows, from, to);

  // The watch: every token for the canary, every statement and its reply.
  const seen: Seen[] = [];
  const sqlOfJob = new Map<string, string>();
  bq.setTransport(async (o) => {
    if (o.url.hostname === auth.TOKEN_HOST) secret('BigQuery signed assertion', new URLSearchParams(o.body ?? '').get('assertion'));
    const r = await inner(o);
    let body: unknown;
    let json: unknown;
    try { body = JSON.parse(o.body ?? ''); } catch { body = undefined; }
    try { json = JSON.parse(r.body); } catch { json = undefined; }
    if (o.url.hostname === auth.TOKEN_HOST) secret('BigQuery access token', String(shape.prop(json, 'access_token') ?? ''));
    const job = String(shape.prop(shape.prop(json, 'jobReference'), 'jobId') ?? '');
    if (o.method === 'POST' && o.url.pathname.endsWith('/queries')) {
      const sql = String(shape.prop(body, 'query') ?? '');
      if (job) sqlOfJob.set(job, sql);
      seen.push({ sql, dry: shape.prop(body, 'dryRun') === true, status: r.status, json });
    } else if (o.method === 'GET' && /\/queries\/[^/]+$/.test(o.url.pathname)) {
      seen.push({ sql: sqlOfJob.get(decodeURIComponent(o.url.pathname.split('/').at(-1) ?? '')) ?? '', dry: false, status: r.status, json });
    }
    return r;
  });
  const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
  const vault = new Map<string, string>();
  configSecrets.useSecretStore({
    get: async (org, kind, ref) => vault.get(`${org}\u0000${kind}\u0000${ref}`) ?? null,
    put: async (org, kind, ref, value) => { vault.set(`${org}\u0000${kind}\u0000${ref}`, value); },
    delete: async (org, kind, ref) => vault.delete(`${org}\u0000${kind}\u0000${ref}`),
  });
  try {
    // ── The fixture, with a token that may write ─────────────────────────
    const write = await writeToken(key);
    if (!write.ok) return ok('partition time: a token that may write the fixture', false, keep(write).error);
    const written = await runScript(write.token, project, fixtureScript(table, rows, new Date(Date.now() + 3 * 86_400_000).toISOString()), cfg.location);
    ok(`partition time: the fixture rewritten (${rows.reduce((a, r) => a + r.n, 0)} rows in four partitions)`, written === '', written);
    if (written) return;

    // ── The records, and the table's facts as an editor's "Read from warehouse" stores them ─
    const projects: typeof import('../src/app/projects') = require('../src/app/projects');
    const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
    const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
    const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
    const { readFacts }: typeof import('../src/ipc/sourceTableRead') = require('../src/ipc/sourceTableRead');
    const { storeSecrets }: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
    const { liveTarget }: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
    await projects.init();
    const P = (await projects.createProject('Partition time')).id;
    const conn = await connections.saveConnection(P, { name: 'BigQuery nightly', connectorId: 'bigquery', values });
    if (!conn) return ok('partition time: the connection is saved', false);
    await storeSecrets(conn.id, secrets);
    const live = await liveRecord.saveLiveRecord(P, { name: 'Partition time', columns: COLUMNS, origin: { kind: 'connection', connId: conn.id, table } });
    const doc = await store.createSourceDoc(P, conn.id, table, {});
    if (!live || !doc.ok) return ok('partition time: the Live dataset and its source doc are saved', false);
    const read = keep(await readFacts(P, conn.id, doc.docId));
    const part = read.ok ? read.doc.facts?.partition : undefined;
    ok('partition time: tables.get says `_PARTITIONTIME`, DAY, a filter required', JSON.stringify(part) === '{"columns":["_PARTITIONTIME"],"method":"DAY","required":true}', read.ok ? JSON.stringify(part) : read.error);
    const found = await liveTarget(P, live.id);
    if (!found.ok || found.target.requiredTime !== true) return ok('partition time: …so the target asks for the range', false, JSON.stringify(found.ok ? found.target.requiredTime : found));
    const t = found.target;
    const whole = read.ok ? read.doc.facts?.bytes ?? 0 : 0;

    // ── CONTROL: BigQuery refuses the KPI without the range; the spike's two spellings of it ─
    const compile: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
    const def = (require('../src/connectors') as typeof import('../src/connectors')).getConnector('bigquery')!;
    const kpi: import('../src/engine/live/liveSpec').LiveIR = { kind: 'metric', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], order: 'natural', weekCal: null };
    const ctx = { values, secrets, rowLimit: 10, timeoutMs: 60_000 };
    const bare = compile.compileMetric(kpi, t.env);
    const refused = bare.ok ? keep(await def.live!.estimate!(ctx, bare.query.sql, bare.query.params)) : bare;
    ok('partition time CONTROL: the KPI without the range is refused by BigQuery\'s dry run ("…without a filter that can be used for partition elimination")', !refused.ok && PARTITION_ERROR.test(errOf(refused)), errOf(refused));
    const ranged = dateRange.withRequiredRange(kpi, t);
    const q = ranged.ok ? compile.compileMetric(ranged.ir, ranged.env) : ranged;
    if (q.ok) {
      for (const [form, sql] of [['alias-qualified (sent)', q.query.sql], ['unqualified', q.query.sql.split('lv_src._PARTITIONTIME').join('_PARTITIONTIME')]] as const) {
        const e = keep(await def.live!.estimate!(ctx, sql, q.query.params));
        spike(`_PARTITIONTIME ${form}, a KPI's dry run`, e.ok ? `accepted (${e.bytes} bytes)` : `refused — ${e.error}`);
      }
    }

    // ── The doors ────────────────────────────────────────────────────────
    const lq: typeof import('../src/engine/live/liveQuery') = require('../src/engine/live/liveQuery');
    const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
    const liveSql: typeof import('../src/engine/live/liveSql') = require('../src/engine/live/liveSql');
    const start = seen.length;
    const figures = (labels: readonly (string | number)[], values: readonly (number | null)[]): string => JSON.stringify(labels.map((l, i) => [l, values[i]]).sort());
    const byRegion = JSON.stringify([...want.byRegion].sort());

    const viz = keep(await lq.liveVizData(P, live.id, { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, []));
    ok('partition time, a chart: answers with the in-range sums by region, and says the range',
      viz.ok && figures(viz.data.labels, viz.data.series[0]?.values ?? []) === byRegion && !!viz.notes?.includes(sentence), viz.ok ? figures(viz.data.labels, viz.data.series[0]?.values ?? []) : viz.error);
    const metric = keep(await lq.liveMetric(P, live.id, { column: 'amount', aggregation: 'sum' }, []));
    ok(`partition time, a KPI: answers ${want.total}, the in-range sum, and says the range`, metric.ok && Object.is(metric.value, want.total) && !!metric.notes?.includes(sentence), JSON.stringify(metric));
    const spec = (filters: import('../src/ai/answerSpec').AnswerFilter[]) => ({ datasetId: live.id, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' as const }], filters, chartType: 'bar', title: 'Partition time' });
    const fix = await answers.computeCard(P, spec([{ column: 'region', op: '=', value: 'west' }]));
    const west = 'card' in fix ? fix.card.data.series[0]?.values[fix.card.data.labels.indexOf('West')] : undefined;
    ok(`partition time, the case fix: "west" read as "West" inside the range (never "WEST", outside it), so the card says ${want.byRegion.get('West')}`,
      Object.is(west, want.byRegion.get('West')) && seen.slice(start).some((s) => / AS o_v FROM /.test(s.sql) && s.status === 200), JSON.stringify('card' in fix ? fix.card.data : fix));
    const empty = await answers.computeCard(P, spec([{ column: 'day', period: 'this_month' }]));
    const probe = seen.slice(start).filter((s) => / AS o_l0 FROM /.test(s.sql) && s.status === 200 && shape.prop(s.json, 'jobComplete') === true);
    const day = Number(firstCell(probe[0]?.json) ?? NaN);
    ok(`partition time, the latest-day probe of an empty answer (this month): held to the range, it finds ${want.lastDay}, and the card says the range`,
      'card' in empty && empty.card.notes.includes(sentence) && day === dateIntel.daysFromIso(want.lastDay), JSON.stringify(['card' in empty ? empty.card.notes : empty, day]));
    const sql = keep(await liveSql.runLiveSql(P, 'SELECT region, sum(amount) AS total FROM t GROUP BY region', [{ id: live.id, names: ['t'] }]));
    ok('partition time, SQL on Live: its view CTE answers with the in-range sums by region, and says the range',
      sql.ok && JSON.stringify(sql.rows.map((r) => [r[0], r[1]]).sort()) === byRegion && !!sql.notes?.includes(sentence), sql.ok ? JSON.stringify(sql.rows) : sql.error);

    // ── Every statement the doors sent ───────────────────────────────────
    const sent = seen.slice(start);
    const run = sent.filter((s) => !s.dry && shape.prop(s.json, 'jobComplete') === true);
    say(`partition time: ${sent.length} requests, ${run.length} statements run, billed ${run.map((s) => shape.billedBytesOf(s.json) ?? 0).join(', ')} bytes; the table holds ${whole}`);
    ok(`partition time: every statement the doors sent ranged on the pseudo-column, and none refused for a missing partition filter (${sent.length})`,
      sent.length >= 8 && sent.every((s) => s.sql.includes('lv_src._PARTITIONTIME >= ') && s.status === 200 && !PARTITION_ERROR.test(JSON.stringify(s.json))), JSON.stringify(sent.map((s) => [s.status, s.dry, s.sql.slice(0, 120)])));
    ok(`partition time: each statement billed at most ${MAX_BILLED} bytes and read fewer than the whole table's ${whole} (the day before is never read)`,
      whole > 0 && run.length >= 7 && run.every((s) => (shape.billedBytesOf(s.json) ?? Infinity) <= MAX_BILLED && Number(shape.prop(s.json, 'totalBytesProcessed') ?? Infinity) < whole), JSON.stringify(run.map((s) => [shape.prop(s.json, 'totalBytesBilled'), shape.prop(s.json, 'totalBytesProcessed')])));
    summary(`- BigQuery partition time: ${run.length} statements on an ingestion-time table that requires a filter, billed ${run.reduce((a, s) => a + (shape.billedBytesOf(s.json) ?? 0), 0)} bytes`);
  } finally {
    bq.setTransport(null);
    configSecrets.useSecretStore(null);
  }
}

/** A token of the `bigquery` scope, for a fixture script only (the connector's own token is read-only). */
export function writeToken(key: import('../src/connectors/bigqueryAuth').ServiceAccountKey): ReturnType<typeof auth.accessToken> {
  return auth.accessToken(key, auth.CANCEL_SCOPES, async (assertion) => {
    const req = auth.tokenRequest(assertion);
    const res = await bq.send({ url: req.url, method: 'POST', headers: req.headers, body: req.body, timeoutMs: 15_000, maxBytes: 65_536 });
    return auth.readTokenReply(res.status, res.body);
  });
}

/** One script through jobs.query, waited for: '' when it finished, else what Google said. */
export async function runScript(token: string, billing: string, script: string, location?: string): Promise<string> {
  const api = async (method: 'GET' | 'POST', url: URL, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> => {
    const r = await bq.send({ url, method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), timeoutMs: 30_000, maxBytes: 1 << 20 });
    let json: unknown;
    try { json = JSON.parse(r.body); } catch { json = undefined; }
    return { status: r.status, json };
  };
  const said = (r: { status: number; json: unknown }): string => `HTTP ${r.status}: ${String(shape.prop(shape.prop(r.json, 'error'), 'message') ?? '').slice(0, 300)}`;
  let r = await api('POST', shape.queriesUrl(billing), { query: script, useLegacySql: false, timeoutMs: 20_000, labels: { ordinate: 'nightly-fixture' }, ...(location ? { location } : {}) });
  if (r.status !== 200) return said(r);
  const job = shape.jobOf(r.json, location);
  if (!job) return 'BigQuery did not say which job runs the fixture script';
  const done = await until(async () => {
    if (r.status !== 200 || shape.prop(r.json, 'jobComplete') === true) return true;
    r = await api('GET', shape.resultsUrl(job, { timeoutMs: 10_000, maxResults: 0 }));
    return r.status !== 200 || shape.prop(r.json, 'jobComplete') === true;
  }, 180_000, 1_000);
  return r.status !== 200 ? said(r) : done ? '' : 'the fixture script did not finish in 3 minutes';
}
