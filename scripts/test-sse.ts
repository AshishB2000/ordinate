// Self-check for server push (src/server/sse.ts) — REAL HTTP, server mode, no
// Electron. Three tabs hold event streams: A and B for one org-a user, C for
// org-b. A starts a real job over RPC (`quality:run`, a compute-worker job) and
// must receive its progress and completion, wire-decoded; B (another tab) and
// C (another org) must receive nothing. Then: hijack attempts on A's client id,
// cancel over the stream, backpressure (coalescing, never dropping a
// completion, closing instead of growing), heartbeat, and the registry back to 0.
//
//   npm run build:ts && node scripts/test-sse.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');
const { randomUUID }: typeof import('crypto') = require('crypto');
const Module: any = require('module'); // any: the loader hook has no public type

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');

type Identity = import('../src/server/context').Identity;
type Job = import('../src/app/jobs').Job;
type Snap = import('../src/app/jobs').JobsSnapshot;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sse-'));
const who = (org: string, user = 'u'): Identity => ({ user: { email: `${user}@${org}`, role: 'admin' }, org: { id: org } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ev { channel: string; data: unknown }
interface Tab {
  status: number;
  headers: import('http').IncomingHttpHeaders;
  events: Ev[];
  heartbeats: number;
  res: import('http').IncomingMessage;
  ended: Promise<void>;
  close(): void;
}

let port = 0;

/** Opens /api/events like a browser tab's EventSource, parsing frames as they arrive. */
function openTab(key: string, org: string | null, user = 'u', pause = false): Promise<Tab> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: `/api/events?client=${encodeURIComponent(key)}`,
      headers: org ? { 'x-test-org': org, 'x-test-user': user } : {},
    }, (res) => {
      let buf = '';
      let endedResolve!: () => void;
      const tab: Tab = {
        status: res.statusCode || 0, headers: res.headers, events: [], heartbeats: 0, res,
        ended: new Promise<void>((r) => (endedResolve = r)),
        close: () => req.destroy(),
      };
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block === ': hb') tab.heartbeats++;
          if (block.startsWith(':')) continue;
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          tab.events.push({ channel: ev ? ev[1] : 'message', data: data ? wire.decode(data[1]) : undefined });
        }
      });
      res.on('close', endedResolve);
      res.on('error', () => { /* a destroyed test socket */ });
      if (pause) res.pause();
      resolve(tab);
    });
    req.on('error', reject);
  });
}

async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

function rpc(org: string, channel: string, payload: unknown, clientKey?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = wire.encode({ args: [payload] });
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/api/rpc/${channel}`,
      headers: {
        'content-type': 'application/json', 'x-test-org': org, 'x-test-user': 'u',
        ...(clientKey ? { 'x-ordinate-client': clientKey } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: res.statusCode === 200 ? wire.decode(text) : text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const jobEvents = (t: Tab, id: string): Ev[] => t.events.filter((e) => {
  if (e.channel === 'jobs:finished') return (e.data as Job).id === id;
  if (e.channel !== 'jobs:changed') return false;
  const s = e.data as Snap;
  return [...s.active, ...s.recent].some((j) => j.id === id);
});
const findJob = (e: Ev, id: string): Job | undefined => {
  const s = e.data as Snap;
  return [...s.active, ...s.recent].find((j) => j.id === id);
};

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  sse.setHeartbeatMsForTest(40);
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    typeof h['x-test-org'] === 'string' ? who(h['x-test-org'], typeof h['x-test-user'] === 'string' ? h['x-test-user'] : 'u') : null);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as import('net').AddressInfo).port;

  // org-a: a project, a dataset and one passing rule, so quality:run does real work.
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const qr: typeof import('../src/analysis/qualityRun') = require('../src/analysis/qualityRun');
  const { pid, dsid } = await context.runInContext(who('org-a'), 'seed', async () => {
    const p = await projects.createProject('SSE project');
    const ds = await datasets.saveDataset(p.id, {
      name: 'Orders', sourceKind: 'csv',
      columns: [{ name: 'zip', type: 'text' }, { name: 'amount', type: 'number' }],
      rows: [['007', 1.5], ['010', 2]],
    });
    if (!ds) throw new Error('dataset not saved');
    const r = await qr.saveRule(p.id, ds.id, { kind: 'not_null', column: 'zip', args: {}, severity: 'fail' });
    if (!r.ok) throw new Error(r.error);
    return { pid: p.id, dsid: ds.id };
  });

  // ── Opening a stream ──────────────────────────────────────────────────────
  ok('no client id → 400', (await openTab('', 'org-a')).status === 400);
  ok('a malformed client id → 400', (await openTab('../x', 'org-a')).status === 400);
  ok('no identity → 401', (await openTab(randomUUID(), null)).status === 401);
  ok('nothing was registered by the refused opens', sse.streamCount() === 0, sse.streamCount());

  const [kA, kB, kC] = [randomUUID(), randomUUID(), randomUUID()];
  const A = await openTab(kA, 'org-a');
  const B = await openTab(kB, 'org-a');
  const C = await openTab(kC, 'org-b');
  ok('three tabs: 200 each', [A, B, C].every((t) => t.status === 200));
  ok('event-stream, no-cache, no proxy buffering, keep-alive',
    String(A.headers['content-type']).startsWith('text/event-stream')
      && String(A.headers['cache-control']).includes('no-cache')
      && A.headers['x-accel-buffering'] === 'no' && A.headers.connection === 'keep-alive', JSON.stringify(A.headers));
  ok('registry holds three streams', await until(() => sse.streamCount() === 3), sse.streamCount());

  // ── Hijack: A's id is bound to org-a / u ──────────────────────────────────
  ok('another org opening A\'s client id → 403', (await openTab(kA, 'org-b')).status === 403);
  ok('another user of the same org opening it → 403', (await openTab(kA, 'org-a', 'mallory')).status === 403);
  ok('…and A\'s stream is still the one registered', sse.streamCount() === 3 && sse.clientFor(kA, who('org-a')) !== null);
  ok('clientFor only answers A\'s owner', sse.clientFor(kA, who('org-b')) === null && sse.clientFor(kA, who('org-a', 'mallory')) === null);

  // ── A job over RPC: progress and completion reach A only ──────────────────
  const t0 = Date.now();
  const run = await rpc('org-a', 'quality:run', { projectId: pid, datasetId: dsid }, kA);
  const reply = run.body as { ok: boolean; latest?: { results: { failing: number }[] } };
  ok('quality:run over RPC: 200, ok, the stored run', run.status === 200 && reply.ok === true && reply.latest?.results[0]?.failing === 0, JSON.stringify(run.body));
  ok('A got jobs:finished', await until(() => A.events.some((e) => e.channel === 'jobs:finished')), JSON.stringify(A.events));
  const fin = A.events.find((e) => e.channel === 'jobs:finished')!.data as Job;
  const id = fin.id;
  ok('the completion is the quality job, done, wire-decoded to a Job', fin.kind === 'quality' && fin.state === 'done' && fin.projectId === pid && fin.datasetId === dsid && fin.progress === 1, JSON.stringify(fin));
  const changed = A.events.filter((e) => e.channel === 'jobs:changed').map((e) => findJob(e, id)).filter((j): j is Job => !!j);
  ok('A saw it running', changed.some((j) => j.state === 'running'), JSON.stringify(changed));
  ok('A saw its progress (0.1, "1 rule(s)")', changed.some((j) => j.state === 'running' && j.progress === 0.1 && j.note === '1 rule(s)'), JSON.stringify(changed));
  ok('A saw it done in the list', changed.some((j) => j.state === 'done' && j.progress === 1), JSON.stringify(changed));
  ok('every event A got is about its own job', A.events.every((e) => jobEvents(A, id).includes(e)), JSON.stringify(A.events));
  ok('the job is tagged with A\'s client, nobody else\'s', fin.client === sse.clientFor(kA, who('org-a'))!.id);
  console.log(`     (quality:run round trip with ${A.events.length} events: ${Date.now() - t0} ms)`);
  await sleep(120);
  ok('B (another tab, same user) received no events', B.events.length === 0, JSON.stringify(B.events));
  ok('C (another org) received no events', C.events.length === 0, JSON.stringify(C.events));

  // org-b names A's client id on its RPC: the binding refuses, the job still runs.
  // T3.3: org-a's project id is refused in org-b before any handler, so org-b
  // names a project of its OWN (which has no such dataset).
  const seenA = A.events.length;
  const pidB = await context.runInContext(who('org-b'), 'seed', async () => (await projects.createProject('B project')).id);
  ok('org-b naming org-a\'s project: 403', (await rpc('org-b', 'quality:run', { projectId: pid, datasetId: dsid }, kA)).status === 403);
  const steal = await rpc('org-b', 'quality:run', { projectId: pidB, datasetId: dsid }, kA);
  ok('org-b\'s RPC naming A\'s client id: still served (its own org: no such dataset)', steal.status === 200 && (steal.body as { ok: boolean }).ok === false, JSON.stringify(steal.body));
  await sleep(120);
  ok('…and none of org-b\'s job events reached A', A.events.length === seenA, JSON.stringify(A.events.slice(seenA)));
  ok('…nor C (the job had no client)', C.events.length === 0);

  // ── Cancel reaches the stream ─────────────────────────────────────────────
  const clientA = sse.clientFor(kA, who('org-a'))!;
  const long = context.runInContext(who('org-a'), 'cancel', () => jobs.submit({
    kind: 'compute', label: 'long', run: (jc) => new Promise((_res, rej) => jc.signal.addEventListener('abort', () => rej(new jobs.JobCancelled()))),
  }), clientA);
  await until(() => jobs.get(long.id)?.state === 'running');
  jobs.cancel(long.id);
  ok('cancel: A got jobs:finished, cancelled', await until(() => A.events.some((e) => e.channel === 'jobs:finished' && (e.data as Job).id === long.id && (e.data as Job).state === 'cancelled')));
  ok('cancel: A\'s list shows it cancelled', A.events.some((e) => e.channel === 'jobs:changed' && findJob(e, long.id)?.state === 'cancelled'));
  ok('cancel: B and C still empty', B.events.length === 0 && C.events.length === 0);

  // ── Heartbeat (40 ms here, 20 s in production) ────────────────────────────
  ok('heartbeat: every open stream gets comment frames', await until(() => [A, B, C].every((t) => t.heartbeats >= 2)), [A, B, C].map((t) => t.heartbeats).join(','));

  // ── Backpressure ──────────────────────────────────────────────────────────
  // D never reads: one 16 MB frame fills the socket for good. Three snapshots
  // then queue behind it — the newest must replace the older — and the
  // completion must survive. Resumed, D gets: big, newest snapshot, completion.
  const kD = randomUUID();
  const D = await openTab(kD, 'org-a', 'u', true);
  const dc = sse.clientFor(kD, who('org-a'))!;
  dc.send('jobs:changed', { active: [], recent: [], big: 'x'.repeat(16 * 2 ** 20) });
  dc.send('jobs:changed', { active: [], recent: [], n: 1 });
  dc.send('jobs:finished', { id: 'done-1' });
  dc.send('jobs:changed', { active: [], recent: [], n: 2 });
  D.res.resume();
  ok('backpressure: the queue drains once the tab reads', await until(() => D.events.length >= 3, 10_000), D.events.length);
  await sleep(50);
  const seq = D.events.map((e) => (e.channel === 'jobs:finished' ? 'fin' : (e.data as { n?: number }).n ?? 'big'));
  ok('backpressure: stale progress coalesced, the completion kept, order big → fin → newest', JSON.stringify(seq) === '["big","fin",2]', JSON.stringify(seq));

  // E never reads, and its queue fills with completions: closed, not grown.
  const kE = randomUUID();
  const E = await openTab(kE, 'org-a', 'u', true);
  const ec = sse.clientFor(kE, who('org-a'))!;
  let destroyedFired = false;
  ec.once('destroyed', () => (destroyedFired = true));
  ec.send('jobs:changed', { big: 'x'.repeat(16 * 2 ** 20) });
  for (let i = 0; i < sse.MAX_QUEUED; i++) ec.send('jobs:finished', { id: i });
  ok('backpressure: MAX_QUEUED completions queued, stream still open', !ec.isDestroyed());
  ec.send('jobs:finished', { id: 'one too many' });
  ok('backpressure: one more → the stream is closed, not grown', ec.isDestroyed() && destroyedFired && sse.clientFor(kE, who('org-a')) === null);
  E.close();

  // ── Same user reopening an id replaces the stream ─────────────────────────
  const A2 = await openTab(kA, 'org-a');
  ok('reopen by the same user: 200, the old stream is ended', A2.status === 200 && (await Promise.race([A.ended.then(() => true), sleep(2000).then(() => false)])));
  ok('reopen: a new numeric id (a job tagged with the old one cannot reach it)', sse.clientFor(kA, who('org-a'))!.id !== clientA.id && clientA.isDestroyed());

  // ── Closing frees the registry ────────────────────────────────────────────
  for (const t of [A2, B, C, D]) t.close();
  ok('every tab closed → registry back to 0', await until(() => sse.streamCount() === 0), sse.streamCount());

  // app.close() must not hang on an open stream.
  const F = await openTab(randomUUID(), 'org-a');
  ok('one more stream open before shutdown', F.status === 200 && sse.streamCount() === 1);
  const closed = await Promise.race([app.close().then(() => true), sleep(5000).then(() => false)]);
  ok('app.close() ends open streams instead of hanging', closed && sse.streamCount() === 0);
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
