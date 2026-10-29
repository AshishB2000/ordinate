// Self-check for the request context (src/server/context.ts) and per-org paths
// (src/app/paths.ts) — the Home handlers run in SERVER MODE.
//
// The suite checks the local (no-switch) defaults first, then switches the
// process into server mode and drives the REAL Home handlers
// over HTTP for two orgs — CONCURRENTLY, with each request parked until the
// other has entered its own context, so AsyncLocalStorage isolation is what is
// actually exercised, not request order.
//
//   npm run build:ts && node scripts/test-server-context.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-ctx-'));
const as = (org: string): import('../src/server/context').Identity => ({ user: { email: `${org}@test`, role: 'admin' }, org: { id: org } });

function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

(async () => {
  // ── Desktop (no switch set) ───────────────────────────────────────────────
  ok('desktop: ctx() is the fixed desktop context', context.ctx().org.id === 'desktop' && context.ctx().requestId === 'desktop');
  const wc = { id: 7, send() {}, isDestroyed: () => false, once: () => undefined };
  ok('desktop: senderOf(e) is e.sender, untouched', context.senderOf({ sender: wc }) === wc);
  delete process.env.ORDINATE_LOCAL_DIR;
  ok('local: with no ORDINATE_LOCAL_DIR a path is an error, never a guess', throws(() => appPaths.userData()));
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-ctx-local-'));
  process.env.ORDINATE_LOCAL_DIR = localDir;
  ok('local: every kind is ORDINATE_LOCAL_DIR', [appPaths.userData(), appPaths.downloads(), appPaths.temp(), appPaths.documents()].every((p) => p === localDir));
  delete process.env.ORDINATE_LOCAL_DIR;
  fs.rmSync(localDir, { recursive: true, force: true });

  // ── Dev auth / prod refusal ───────────────────────────────────────────────
  const dev = context.identityFor(envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_ENV: 'dev' }))({});
  ok('dev auth: dev@local, org default, admin', dev?.user.email === 'dev@local' && dev.org.id === 'default' && dev.user.role === 'admin', JSON.stringify(dev));
  let prodErr: unknown = null;
  try { context.identityFor(envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_ENV: 'prod', DATA_DIR: DATA })); } catch (err) { prodErr = err; }
  ok('prod with no auth configured: EnvError (main.ts prints it as one line and exits)', prodErr instanceof envMod.EnvError, prodErr);

  // ── Server mode ───────────────────────────────────────────────────────────
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  ok('server: the Home handlers registered', ['projects:list', 'dataset:list', 'recent:list'].every((c) => rpc.handlers.has(c)));
  ok('server: ctx() outside a request throws', throws(() => context.ctx()));
  ok('server: a path outside a request throws, never falls back', throws(() => appPaths.userData()));

  const kinds = ['userData', 'downloads', 'temp', 'documents'] as const;
  const got = context.runInContext(as('acme'), 'r1', () => kinds.map((k) => appPaths[k]()));
  ok('server: every kind resolves under DATA_DIR/orgs/<org>/<kind>', got.every((p, i) => p === path.join(DATA, 'orgs', 'acme', kinds[i])), got.join(' '));
  ok('server: …and the directory exists', got.every((p) => fs.statSync(p).isDirectory()));
  for (const bad of ['..', '../acme', 'a/b', 'A', '', '.hidden', 'x'.repeat(64)]) {
    ok(`server: org id ${JSON.stringify(bad)} never reaches a path`, throws(() => context.runInContext(as(bad), 'r', () => appPaths.userData())));
  }
  ok('server: senderOf(e) is ctx().client, not e.sender', context.runInContext(as('acme'), 'r', () => {
    const c = context.senderOf({ sender: wc });
    c.send('x', 1); // the T0.5 stub: a no-op that must not throw
    return c !== wc && c === context.ctx().client;
  }));

  // ── NV-1: formats, calendar and language are the CALLER's org's ──────────
  // They used to be process-wide copies of whichever org last loaded its
  // config, so one org's Formats moved another org's periods and currency.
  const config: typeof import('../src/app/config') = require('../src/app/config');
  const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
  const retail: typeof import('../src/analysis/retailCalendar') = require('../src/analysis/retailCalendar');
  const format: typeof import('../src/app/format') = require('../src/app/format');
  const i18n: typeof import('../src/app/i18n') = require('../src/app/i18n');
  process.env.ORDINATE_TODAY = '2026-10-28';
  const inOrg = <T>(org: string, fn: () => T): T => context.runInContext(as(org), 'nv1', fn);
  const ambient = () => JSON.stringify({
    fy: dateIntel.getCalendar().fiscalYearStart, year: dateIntel.resolvePeriodNow({ preset: 'this_year' }),
    wc: retail.activeWeekCal()?.type ?? null, currency: format.getFormatPrefs().currency, lang: i18n.currentLanguage(),
  });
  const betaBefore = inOrg('beta', () => { config.get(); return ambient(); });
  inOrg('acme', () => config.save({ formats: { ...config.get().formats, calendarType: '445', fiscalYearStart: 7, currency: 'EUR' }, language: 'de' }));
  inOrg('acme', () => config.get()); // what prefs:get does on every page load
  const acmeNow = JSON.parse(inOrg('acme', ambient));
  ok('NV-1: acme reads its own saved formats, calendar and language',
    acmeNow.fy === 7 && acmeNow.wc === '445' && acmeNow.currency === 'EUR' && acmeNow.lang === 'de', JSON.stringify(acmeNow));
  // No config.get() here: a figure path (vizDataFor, a period filter) never calls it.
  ok('NV-1: beta still computes with its own defaults after acme loaded and saved', inOrg('beta', ambient) === betaBefore
    && JSON.parse(betaBefore).currency === 'USD' && JSON.parse(betaBefore).year?.from === '2026-01-01', `${betaBefore} vs ${inOrg('beta', ambient)}`);
  fs.mkdirSync(path.join(DATA, 'orgs', 'gamma', 'userData'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'orgs', 'gamma', 'userData', 'config.json'), JSON.stringify({ formats: { currency: 'GBP', fiscalYearStart: 4 } }));
  const gamma = JSON.parse(inOrg('gamma', ambient));
  ok('NV-1: an org read before this process loaded its config gets its own settings', gamma.currency === 'GBP' && gamma.fy === 4, JSON.stringify(gamma));
  ok('NV-1 control: outside a request a set stays process-wide (the desktop slot)', (() => {
    format.setFormatPrefs({ currency: 'JPY' });
    return format.getFormatPrefs().currency === 'JPY' && JSON.parse(inOrg('acme', ambient)).currency === 'EUR';
  })());
  delete process.env.ORDINATE_TODAY;

  // ── Over HTTP, dev auth: everything lands in orgs/default ─────────────────
  const devApp = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }));
  const dl = await devApp.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: withCsrf({ 'content-type': 'application/json' }), payload: '{"args":[]}' });
  ok('dev: projects:list is 200 with a wire-encoded list', dl.statusCode === 200 && Array.isArray(wire.decode(dl.body)), dl.body);
  ok('dev: it ran as org default', fs.existsSync(path.join(DATA, 'orgs', 'default', 'userData')));
  const hz = await devApp.inject({ method: 'GET', url: '/healthz' });
  ok('probes run outside any request context', hz.statusCode === 200);
  await devApp.close();

  // ── Two orgs, concurrently ────────────────────────────────────────────────
  // The org comes from a test header through the same `identify` seam real
  // auth will use (T3.2). No header → 401.
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    typeof h['x-test-org'] === 'string' ? as(h['x-test-org']) : null);
  const ORGS = ['org-a', 'org-b'];
  const arrived = new Map(ORGS.map((o) => {
    let resolve!: () => void;
    return [o, { promise: new Promise<void>((r) => (resolve = r)), resolve: () => resolve() }];
  }));
  // A route that parks until BOTH requests are inside their contexts, then
  // reads its paths again: if the store leaked, `after` is the other org's.
  app.post('/api/test/paths', async () => {
    const org = context.ctx().org.id;
    const before = appPaths.userData();
    arrived.get(org)!.resolve();
    await Promise.all([...arrived.values()].map((d) => d.promise));
    await new Promise((r) => setImmediate(r));
    return { org, before, after: appPaths.userData(), ctxOrg: context.ctx().org.id };
  });
  const call = (org: string | null, url: string, body = '{}') => app.inject({
    method: 'POST', url, payload: body,
    headers: withCsrf({ 'content-type': 'application/json', ...(org ? { 'x-test-org': org } : {}) }),
  });

  const [ra, rb] = await Promise.all(ORGS.map((o) => call(o, '/api/test/paths')));
  const [ja, jb] = [ra.json(), rb.json()];
  for (const j of [ja, jb]) {
    const want = path.join(DATA, 'orgs', j.org, 'userData');
    ok(`concurrent ${j.org}: userData() before and after the interleave is its own`, j.before === want && j.after === want && j.ctxOrg === j.org, JSON.stringify(j));
  }
  ok('concurrent: the two orgs resolved DIFFERENT userData() paths', ja.after !== jb.after && ja.org !== jb.org, `${ja.after} ${jb.after}`);
  ok('no identity → 401', (await call(null, '/api/rpc/projects:list', '{"args":[]}')).statusCode === 401);

  // Real handlers: org-a gets a project with a dataset; org-b must never see it.
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const DS = 'Orders (org-a only)';
  const pid = await context.runInContext(as('org-a'), 'seed', async () => {
    const p = await projects.createProject('Org A project');
    await datasets.saveDataset(p.id, {
      name: DS, sourceKind: 'csv',
      columns: [{ name: 'zip', type: 'text' }, { name: 'amount', type: 'number' }],
      rows: [['007', 1.5], ['010', NaN]],
    });
    return p.id;
  });
  const direct = (org: string, ch: string, ...args: unknown[]): Promise<string> =>
    context.runInContext(as(org), 'direct', async () => wire.encode(await rpc.handlers.get(ch)!({}, ...args)));
  const rpcBody = (payload?: unknown) => wire.encode({ args: payload === undefined ? [] : [payload] });
  const [pa, pb, da, db, recA] = await Promise.all([
    call('org-a', '/api/rpc/projects:list', rpcBody()),
    call('org-b', '/api/rpc/projects:list', rpcBody()),
    call('org-a', '/api/rpc/dataset:list', rpcBody({ projectId: pid })),
    call('org-b', '/api/rpc/dataset:list', rpcBody({ projectId: pid })),
    call('org-a', '/api/rpc/recent:list', rpcBody({ limit: 6 })),
  ]);
  ok('org-a projects:list: 200, lists its project', pa.statusCode === 200 && (wire.decode(pa.body) as { id: string }[]).some((p) => p.id === pid), pa.body);
  ok('org-a projects:list ≡ the handler called directly in org-a', pa.body === await direct('org-a', 'projects:list'));
  ok('org-b projects:list: 200 and does NOT see org-a\'s project', pb.statusCode === 200 && !pb.body.includes(pid), pb.body);
  ok('org-a dataset:list: its dataset', da.statusCode === 200 && (wire.decode(da.body) as { name: string }[]).some((d) => d.name === DS), da.body);
  ok('org-a dataset:list ≡ direct', da.body === await direct('org-a', 'dataset:list', { projectId: pid }));
  // T3.3: the project is not in org-b, so authorization refuses before the handler (it used to answer an empty list).
  ok('org-b dataset:list for org-a\'s project id: 403, nothing listed', db.statusCode === 403 && !db.body.includes(DS), db.body);
  ok('org-a recent:list: 200 and ≡ direct', recA.statusCode === 200 && recA.body === await direct('org-a', 'recent:list', { limit: 6 }), recA.body);
  ok('the project is on disk under orgs/org-a only',
    fs.existsSync(path.join(DATA, 'orgs', 'org-a', 'userData', 'projects', pid))
      && !fs.existsSync(path.join(DATA, 'orgs', 'org-b', 'userData', 'projects', pid)));

  // ── NV-2: a search is cancelled by its own caller's next one, never another member's ──
  const { runSearch } = require('../src/data/dataSearchRun') as typeof import('../src/data/dataSearchRun');
  const member = (org: string, email: string): import('../src/server/context').Identity => ({ user: { email, role: 'viewer' }, org: { id: org } });
  const search = (who: import('../src/server/context').Identity, term: string, projectId = pid) =>
    context.runInContext(who, 'nv2', () => runSearch({ projectId, term }));
  const alice = member('org-a', 'alice@a.test');
  ok('NV-2 control: a lone search finds the value', (await search(alice, '007')).ok === true);
  for (const [label, other] of [['another member of the org', member('org-a', 'bob@a.test')], ['a member of another org', member('org-b', 'bob@b.test')]] as const) {
    const mine = search(alice, '007'); // parked at its first await
    await search(other, '  ', ''); // returns at once, after taking its number
    const r = await mine;
    ok(`NV-2: ${label} searching does not cancel alice's search in flight`, r.ok === true && !r.cancelled && r.hits.length > 0, JSON.stringify(r));
  }
  const first = search(alice, '007');
  await search(alice, '  ');
  ok('NV-2 control: alice\'s own next search still cancels her older one', (await first).cancelled === true);

  await app.close();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
