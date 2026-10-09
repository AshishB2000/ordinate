// Self-check for GET /metrics (T7.1, src/server/metrics.ts):
//
//   format       the whole exposition parses as Prometheus text 0.0.4 — HELP and
//                TYPE before every sample, valid names and label sets, label
//                values escaped, histograms cumulative with +Inf = _count, no
//                duplicate series — after real traffic through the app, a job,
//                residentTrace outcomes and a cache lookup; the validator itself
//                refuses six broken expositions (negative controls)
//   separation   real sockets: the app port answers /metrics 404 for every
//                Accept (never the SPA page, never a metric), the METRICS_PORT
//                listener answers /metrics 200 and 404s everything else
//   env          METRICS_PORT unset → no listener; equal to PORT or invalid → refused
//   labels       a channel without a contract is `unknown`, a route is its
//                pattern — a token in a URL never becomes a label
//
//   npm run build:ts && node scripts/test-promMetrics.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const metrics: typeof import('../src/server/metrics') = require('../src/server/metrics');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const staticMod: typeof import('../src/server/static') = require('../src/server/static');
const { fastify }: typeof import('fastify') = require('fastify');

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (-?(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|NaN|\+Inf|-Inf))$/;
const LABEL = /^([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\\n]|\\["\\n])*)"(,|$)/;

/** Problems with `text` as Prometheus text exposition 0.0.4; [] when valid. */
function validate(text: string): string[] {
  const problems: string[] = [];
  if (!text.endsWith('\n')) problems.push('does not end with a newline');
  const types = new Map<string, string>();
  const helped = new Set<string>();
  const seen = new Set<string>();
  const hist = new Map<string, { buckets: Array<[number, number]>; count?: number }>();
  for (const line of text.split('\n').slice(0, -1)) {
    if (line.startsWith('# HELP ')) {
      const name = line.split(' ')[2] ?? '';
      if (!NAME.test(name) || helped.has(name)) problems.push(`bad or repeated HELP: ${line}`);
      helped.add(name);
      continue;
    }
    if (line.startsWith('# TYPE ')) {
      const [, , name = '', type = ''] = line.split(' ');
      if (!NAME.test(name) || !['counter', 'gauge', 'histogram', 'summary', 'untyped'].includes(type) || types.has(name)) problems.push(`bad or repeated TYPE: ${line}`);
      types.set(name, type);
      continue;
    }
    const m = SAMPLE.exec(line);
    if (!m) {
      problems.push(`not a sample: ${line}`);
      continue;
    }
    const [, name, , body = '', value] = m;
    const fam = types.has(name) ? name : name.replace(/_(bucket|sum|count)$/, '');
    if (!types.has(fam)) problems.push(`sample before its TYPE: ${line}`);
    if (!helped.has(fam)) problems.push(`sample without HELP: ${line}`);
    if (types.get(fam) === 'counter' && !fam.endsWith('_total')) problems.push(`counter not named _total: ${fam}`);
    const lbl: Record<string, string> = {};
    let rest = body;
    while (rest) {
      const l = LABEL.exec(rest);
      if (!l) {
        problems.push(`bad label set: ${line}`);
        break;
      }
      if (l[1] in lbl) problems.push(`repeated label ${l[1]}: ${line}`);
      lbl[l[1]] = l[2];
      rest = rest.slice(l[0].length);
    }
    const key = `${name}{${Object.keys(lbl).sort().map((k) => `${k}=${lbl[k]}`).join(',')}}`;
    if (seen.has(key)) problems.push(`duplicate series: ${line}`);
    seen.add(key);
    if (types.get(fam) === 'histogram') {
      const { le, ...others } = lbl;
      const id = `${fam}{${JSON.stringify(others)}}`;
      const h = hist.get(id) ?? { buckets: [] };
      hist.set(id, h);
      if (name.endsWith('_bucket')) h.buckets.push([le === '+Inf' ? Infinity : Number(le), Number(value)]);
      if (name.endsWith('_count')) h.count = Number(value);
    }
  }
  for (const [id, h] of hist) {
    const inf = h.buckets.find(([le]) => le === Infinity);
    if (!inf) problems.push(`histogram without +Inf: ${id}`);
    else if (inf[1] !== h.count) problems.push(`histogram +Inf ${inf[1]} ≠ _count ${h.count}: ${id}`);
    for (let i = 1; i < h.buckets.length; i++) {
      if (h.buckets[i][0] <= h.buckets[i - 1][0] || h.buckets[i][1] < h.buckets[i - 1][1]) problems.push(`histogram not cumulative: ${id}`);
    }
  }
  return problems;
}

const value = (text: string, series: string): number | null => {
  const line = text.split('\n').find((l) => l.startsWith(series + ' '));
  return line === undefined ? null : Number(line.slice(series.length + 1));
};

(async () => {
  // ── The validator catches what it must (negative controls) ────────────────
  const good = '# HELP x_total X.\n# TYPE x_total counter\nx_total{a="1"} 2\n';
  ok('validator: a minimal exposition is valid', validate(good).length === 0, validate(good).join('; '));
  const broken: Record<string, string> = {
    'no TYPE': '# HELP x_total X.\nx_total 1\n',
    'unescaped quote in a label': '# HELP x_total X.\n# TYPE x_total counter\nx_total{a="say "hi""} 1\n',
    'duplicate series': good + 'x_total{a="1"} 3\n',
    'histogram +Inf ≠ count': '# HELP h H.\n# TYPE h histogram\nh_bucket{le="1"} 1\nh_bucket{le="+Inf"} 2\nh_sum 1\nh_count 3\n',
    'histogram not cumulative': '# HELP h H.\n# TYPE h histogram\nh_bucket{le="1"} 2\nh_bucket{le="2"} 1\nh_bucket{le="+Inf"} 2\nh_sum 1\nh_count 2\n',
    'no trailing newline': good.trimEnd(),
  };
  for (const [what, text] of Object.entries(broken)) ok(`validator refuses: ${what}`, validate(text).length > 0);
  ok('esc: backslash, quote and newline are escaped', metrics.esc('a\\b"c\nd') === 'a\\\\b\\"c\\nd');

  // ── env ───────────────────────────────────────────────────────────────────
  ok('env: METRICS_PORT unset → no metrics listener', envMod.parseEnv({ AUTH_MODE: 'dev' }).metricsPort === null);
  ok('env: METRICS_PORT=9464 → 9464', envMod.parseEnv({ AUTH_MODE: 'dev', METRICS_PORT: '9464' }).metricsPort === 9464);
  for (const bad of [{ PORT: '8080', METRICS_PORT: '8080' }, { METRICS_PORT: '8080' }, { METRICS_PORT: 'abc' }, { METRICS_PORT: '0' }, { METRICS_PORT: '70000' }]) {
    let refused = '';
    try {
      envMod.parseEnv(bad);
    } catch (err) {
      refused = err instanceof envMod.EnvError ? err.message : '';
    }
    ok(`env: refuses ${JSON.stringify(bad)}`, refused.startsWith('METRICS_PORT'), refused);
  }

  // ── Real traffic through the app ─────────────────────────────────────────
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-metrics-'));
  context.enterServerMode(DATA);
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    h['x-test'] ? { user: { email: 'm@test', role: 'admin' }, org: { id: 'metrics' } } : null);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const mserver = await metrics.startMetricsServer(0, '127.0.0.1');
  const appBase = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  const mBase = `http://127.0.0.1:${(mserver.address() as import('net').AddressInfo).port}`;
  const TOKEN = 'secret-looking-file-token-'.padEnd(43, 'z');

  try {
    for (let i = 0; i < 3; i++) await fetch(`${appBase}/healthz`);
    await fetch(`${appBase}/api/files/${TOKEN}`, { headers: { 'x-test': '1' } });
    const rpc = (channel: string) => fetch(`${appBase}/api/rpc/${channel}`, { method: 'POST', body: '{"args":[]}', headers: withCsrf({ 'content-type': 'application/json', 'x-test': '1' }) });
    await rpc('no:such-channel');
    await rpc('projects:list');
    trace.record('metricsTest:op', 'resident');
    trace.record('metricsTest:op', 'skipped');
    trace.recordCache('metricsTest:op', 'hit');
    await jobs.submit({ kind: 'compute', label: 'metrics test', run: async () => 1 }).done;

    // ── Separation ──────────────────────────────────────────────────────────
    for (const accept of ['*/*', 'text/html', 'text/plain;version=0.0.4']) {
      const res = await fetch(`${appBase}/metrics`, { headers: { accept, 'x-test': '1' } });
      const body = await res.text();
      ok(`app port: GET /metrics (Accept ${accept}) → 404, no metric, no SPA page`, res.status === 404 && !body.includes('ordinate_') && !body.includes('<html'), `${res.status} ${body.slice(0, 80)}`);
    }
    // The SPA fallback answers any unknown HTML navigation with index.html — /metrics must not be one.
    const spaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-metrics-spa-'));
    fs.writeFileSync(path.join(spaRoot, 'index.html'), '<html>app</html>');
    const spa = fastify();
    metrics.registerRequestMetrics(spa);
    staticMod.registerStatic(spa, spaRoot);
    const spaPage = await spa.inject({ url: '/metrics', headers: { accept: 'text/html' } });
    const spaOther = await spa.inject({ url: '/data', headers: { accept: 'text/html' } });
    ok('app port with the web app built: /metrics → 404 while other routes get the SPA page',
      spaPage.statusCode === 404 && spaOther.statusCode === 200 && spaOther.body.includes('<html>'), `${spaPage.statusCode} ${spaOther.statusCode}`);
    await spa.close();
    fs.rmSync(spaRoot, { recursive: true, force: true });
    ok('app port: signed out, /metrics is still 404 (no sign-in redirect)', (await fetch(`${appBase}/metrics`, { headers: { accept: 'text/html' }, redirect: 'manual' })).status === 404);
    const res = await fetch(`${mBase}/metrics`);
    const text = await res.text();
    ok('metrics port: GET /metrics → 200 text/plain; version=0.0.4', res.status === 200 && res.headers.get('content-type') === 'text/plain; version=0.0.4; charset=utf-8', `${res.status} ${res.headers.get('content-type')}`);
    for (const [method, p] of [['GET', '/'], ['GET', '/healthz'], ['GET', '/api/rpc/projects:list'], ['POST', '/metrics'], ['GET', '/metrics/x']]) {
      ok(`metrics port: ${method} ${p} → 404`, (await fetch(`${mBase}${p}`, { method })).status === 404);
    }

    // ── Format and content ──────────────────────────────────────────────────
    const problems = validate(text);
    ok(`format: the exposition is valid Prometheus text (${text.split('\n').length} lines)`, problems.length === 0, problems.slice(0, 5).join('; '));
    ok('rpc: an uncontracted channel is counted as `unknown`', value(text, 'ordinate_rpc_requests_total{channel="unknown",code="404"}') === 1, text.match(/^ordinate_rpc_requests_total.*$/gm)?.join(' | '));
    ok('rpc: a contracted channel is counted under its name',
      (text.match(/^ordinate_rpc_requests_total\{channel="projects:list",code="\d+"\} 1$/m) ?? []).length === 1);
    ok('rpc: latency histogram per channel', value(text, 'ordinate_rpc_request_duration_seconds_count{channel="projects:list"}') === 1);
    ok('http: /healthz counted 3 times with latency', value(text, 'ordinate_http_requests_total{method="GET",route="/healthz",code="200"}') === 3
      && value(text, 'ordinate_http_request_duration_seconds_count{method="GET",route="/healthz"}') === 3);
    ok('http: a file token is never a label (route pattern instead)', !text.includes(TOKEN) && text.includes('route="/api/files/:token"'));
    // 4 on this app + 1 on the SPA app above: the counters are per process.
    ok('http: the app port\'s own /metrics 404s are counted, the scrape port is not', value(text, 'ordinate_http_requests_total{method="GET",route="/metrics",code="404"}') === 5);
    ok('jobs: queue gauges by state', value(text, 'ordinate_jobs{state="queued"}') === 0 && value(text, 'ordinate_jobs{state="running"}') === 0);
    ok('jobs: a finished job is counted by kind and state', value(text, 'ordinate_jobs_finished_total{kind="compute",state="done"}') === 1);
    ok('compute pool: queue depth and worker gauges', value(text, 'ordinate_compute_pool_queue_depth') === 0
      && value(text, 'ordinate_compute_pool_workers{state="busy"}') === 0 && value(text, 'ordinate_compute_pool_workers{state="idle"}') !== null);
    ok('resident: resident/skipped/failed per call site',
      value(text, 'ordinate_resident_calls_total{op="metricsTest:op",outcome="resident"}') === 1
      && value(text, 'ordinate_resident_calls_total{op="metricsTest:op",outcome="skipped"}') === 1
      && value(text, 'ordinate_resident_calls_total{op="metricsTest:op",outcome="failed"}') === 0);
    ok('resident: cache sites count hit and miss', value(text, 'ordinate_resident_calls_total{op="cache:metricsTest:op",outcome="hit"}') === 1
      && value(text, 'ordinate_resident_calls_total{op="cache:metricsTest:op",outcome="miss"}') === 0);
    ok('scheduled jobs: the family is declared (no runs without Postgres)', text.includes('# TYPE ordinate_scheduled_job_runs_total counter'));
  } finally {
    mserver.close();
    await app.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
