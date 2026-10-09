// The scheduler's tick, end to end (L0.3): incremental refreshes are QUEUED as
// jobs, most overdue first, at most MAX_RUNNING at a time, and the tick does
// not wait for them; full refreshes stay strictly serial and awaited; a dataset
// whose refresh is already running is skipped, not queued twice; and a run
// that outlasts its cadence comes back "Behind schedule".
//
// Real url connections and the real stores in a temp userData; only the
// network is faked — a fetch that answers each source's URL when the test
// RELEASES it, so the test decides when each refresh can finish and can count
// how many are in flight at once.
//
//   1. five due 5-minute incremental datasets: the tick returns at once with
//      every one queued; three run, two wait, in most-overdue order; never
//      more than three fetches at once; each reports as it lands, stamped;
//   2. a dataset already refreshing (a ↻ job) when it comes due: skipped,
//      nothing stamped, one job — the negative control is the same tick
//      without that ↻, which does queue it;
//   3. a run that outlasts 5 minutes: `lastAutoMs` > interval → the summary
//      says behindSchedule, computed on the server; one inside it does not;
//   4. two due FULL (non-incremental) refreshes: awaited by the tick, one at a
//      time, most overdue first.
//
//   npm run build:ts && node scripts/test-refreshQueue.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-refreshq-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const MIN = 60_000;
const urlFor = (table: string): string => `https://source.test/${table}.json`;
const tableOf = (url: string): string => url.slice('https://source.test/'.length, -'.json'.length);

// ── The gated network ───────────────────────────────────────────────────────
const docs = new Map<string, string>();
const waiting = new Map<string, Array<() => void>>(); // table → releases of fetches parked on it
const held = new Set<string>(); // tables whose fetches park until released
const started: string[] = []; // fetch start order, by table
let inFlight = 0;
let maxInFlight = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const t = tableOf(url);
  started.push(t);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (held.has(t)) await new Promise<void>((r) => waiting.set(t, [...(waiting.get(t) || []), r]));
    const body = docs.get(url);
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  } finally {
    inFlight--;
  }
}) as typeof fetch;
const release = (t: string): void => {
  held.delete(t);
  const list = waiting.get(t) || [];
  waiting.delete(t);
  for (const r of list) r();
};
const parked = (): string[] => [...waiting.keys()].sort();

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const sched: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');
const refreshJob: typeof import('../src/data/refreshJob') = require('../src/data/refreshJob');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

async function main(): Promise<void> {
  await projects.init();
  const pid = (await projects.createProject('Queue')).id;
  const ids = new Map<string, string>(); // table → dataset id
  const names = new Map<string, string>(); // dataset id → table
  async function table(name: string, incremental: boolean): Promise<string> {
    docs.set(urlFor(name), JSON.stringify([{ id: 1, updated: 100 }, { id: 2, updated: 101 }]));
    const conn = await connections.saveConnection(pid, { name, connectorId: 'url', values: { url: urlFor(name) } });
    const ds = await datasets.saveDataset(pid, {
      name, sourceKind: 'json', columns: [{ name: 'id', type: 'number' }, { name: 'updated', type: 'number' }],
      rows: [[1, 100]], origin: { kind: 'connection', connId: conn!.id },
    } as never);
    if (incremental) {
      await datasets.writeIncremental(pid, ds!.id, () => ({ enabled: true, cursorColumn: 'updated', keyColumn: 'id', lookback: 0, highWater: null, runsSinceFull: 0, log: [] }));
    }
    ids.set(name, ds!.id);
    names.set(ds!.id, name);
    return ds!.id;
  }
  const schedule = async (name: string, every: 'hourly' | '5min', lastAutoAt?: string) => {
    const r = await datasets.setAutoRefresh(pid, ids.get(name)!, { every, ...(lastAutoAt ? { lastAutoAt } : {}) });
    ok(`fixture: ${name} scheduled ${every}`, !!r);
  };
  const auto = async (name: string) => (await datasets.getDatasetMeta(pid, ids.get(name)!))?.autoRefresh;
  const reported: import('../src/app/refreshScheduler').AutoRefreshOutcome[] = [];
  sched.onRefreshed((o) => reported.push(o));
  const label = (j: { label: string }) => j.label.replace('Scheduled refresh · ', 'S:').replace('Refresh ', 'R:');

  // ── 1. Five due, queued at once, most overdue first ───────────────────────
  for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) await table(t, true);
  const NOW = Date.now();
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  // Past due by: c never ran (∞), b 25 min, d 5 min, e 2 min, a 1 min; f is not due.
  await schedule('a', '5min', at(6 * MIN));
  await schedule('b', '5min', at(30 * MIN));
  await schedule('c', '5min');
  await schedule('d', '5min', at(10 * MIN));
  await schedule('e', '5min', at(7 * MIN));
  await schedule('f', '5min', at(1 * MIN));
  for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) held.add(t);

  const t0 = performance.now();
  const out1 = await sched.tickNow(NOW);
  const tickMs = performance.now() - t0;
  ok('1. the tick returns while its incremental refreshes are still running (not awaited)',
    jobs.snapshot().active.length === 5 && reported.length === 0, `${tickMs.toFixed(0)} ms`);
  ok('1. …and reports no serial outcomes (nothing full was due)', out1.length === 0);
  console.log(`     tick with 5 incremental refreshes due: returned in ${tickMs.toFixed(0)} ms, all 5 still queued or running`);
  const act = jobs.snapshot().active;
  ok('1. all five due are queued as jobs, one per dataset, in most-overdue order: c, b, d, e, a',
    act.map(label).join() === 'S:c,S:b,S:d,S:e,S:a', act.map(label).join());
  ok('1. MAX_RUNNING (3) run, the rest wait in that order', act.map((j) => j.state).join() === 'running,running,running,queued,queued',
    act.map((j) => j.state).join());
  ok('1. the dataset not yet due (f) is not queued', !act.some((j) => label(j) === 'S:f'));
  await until(() => parked().length === 3);
  ok('1. the three running fetches are the three most overdue', parked().join() === 'b,c,d', parked().join());
  for (const t of ['c', 'b', 'd', 'e', 'a']) {
    ok(`1. ${t} is stamped at the tick's time before its run`, (await auto(t))?.lastAutoAt === new Date(NOW).toISOString());
  }
  ok('1. f is not stamped', (await auto('f'))?.lastAutoAt === at(1 * MIN));
  release('c');
  await until(() => parked().includes('e'));
  ok('1. a slot freed → the next in line (e) starts, not a', parked().join() === 'b,d,e', parked().join());
  for (const t of ['b', 'd', 'e', 'a']) release(t);
  ok('1. each lands and reports through onRefreshed, ok', await until(() => reported.length === 5) && reported.every((o) => o.ok),
    JSON.stringify(reported));
  ok('1. never more than three fetches in flight at once', maxInFlight === 3, maxInFlight);
  await until(() => jobs.snapshot().active.length === 0);
  const ms = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(async (t) => (await auto(t))?.lastAutoMs));
  ok('1. each run\'s length was recorded, under its 5-minute cadence', ms.every((v) => typeof v === 'number' && v >= 0 && v < 5 * MIN), JSON.stringify(ms));
  const list1 = await datasets.listDatasets(pid);
  ok('1. so none is behind schedule', list1.every((d) => !d.behindSchedule));
  ok('1. the summary says incremental refresh is on', list1.filter((d) => d.incrementalOn).length === 6);

  // ── 2. Already refreshing when it comes due: skipped, not stamped ─────────
  const NOW2 = NOW + 6 * MIN; // a..e (stamped NOW) and f are all due again
  held.add('a');
  const manual = refreshJob.refreshAsJob(pid, ids.get('a')!);
  await until(() => parked().includes('a'));
  reported.length = 0;
  maxInFlight = 0;
  for (const t of ['b', 'c', 'd', 'e', 'f']) held.add(t);
  await sched.tickNow(NOW2);
  const act2 = jobs.snapshot().active;
  ok('2. a, already refreshing (a ↻ job), is not queued a second time', act2.filter((j) => j.datasetId === ids.get('a')).length === 1
    && label(act2.find((j) => j.datasetId === ids.get('a'))!) === 'R:a', act2.map(label).join());
  ok('2. …and not stamped, so the next tick asks again', (await auto('a'))?.lastAutoAt === new Date(NOW).toISOString());
  ok('2. the others due are queued (f now too)', ['b', 'c', 'd', 'e', 'f'].every((t) => act2.some((j) => label(j) === `S:${t}`)), act2.map(label).join());
  ok('2. refreshRunning names the ↻ job', (await refreshJob.refreshRunning(pid, ids.get('a')!))?.jobId === act2.find((j) => j.datasetId === ids.get('a'))?.id);
  const s2 = await refreshJob.startRefresh(pid, ids.get('a')!);
  ok('2. startRefresh coalesces onto it: already_running, its job id, nothing queued',
    s2.status === 'already_running' && s2.jobId === act2.find((j) => j.datasetId === ids.get('a'))?.id
      && jobs.snapshot().active.filter((j) => j.datasetId === ids.get('a')).length === 1, JSON.stringify(s2));
  for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) release(t);
  ok('2. the ↻ itself finishes ok', (await manual).ok);
  await until(() => reported.length === 5 && jobs.snapshot().active.length === 0);
  // Negative control: with nothing running, the same dataset IS queued by a tick.
  reported.length = 0;
  held.add('a');
  await sched.tickNow(NOW2);
  ok('2. control: a tick with a not running queues it (stamped)', jobs.snapshot().active.some((j) => label(j) === 'S:a')
    && (await auto('a'))?.lastAutoAt === new Date(NOW2).toISOString(), jobs.snapshot().active.map(label).join());
  const s2b = await refreshJob.startRefresh(pid, ids.get('b')!);
  ok('2. control: startRefresh on an idle dataset queues one', s2b.status === 'queued' && typeof s2b.jobId === 'string');
  release('a');
  ok('2. control: …and it runs', s2b.status === 'queued' && (await s2b.done).ok);
  await until(() => jobs.snapshot().active.length === 0);

  // ── 3. Behind schedule ────────────────────────────────────────────────────
  await table('g', true);
  await schedule('g', '5min');
  // The tick's `now` is when the run was QUEUED: ten minutes before it lands.
  reported.length = 0;
  await sched.tickNow(Date.now() - 10 * MIN);
  await until(() => reported.length === 1 && jobs.snapshot().active.length === 0);
  const g = await auto('g');
  ok('3. a run that landed 10 min after it was queued recorded that length', typeof g?.lastAutoMs === 'number' && g.lastAutoMs >= 10 * MIN, JSON.stringify(g));
  const list3 = await datasets.listDatasets(pid);
  ok('3. the summary says behindSchedule (5-minute cadence)', list3.find((d) => d.id === ids.get('g'))?.behindSchedule === true);
  ok('3. the on-time ones still do not', list3.filter((d) => d.behindSchedule).length === 1);

  // ── 4. Full refreshes: serial, awaited, most overdue first ────────────────
  // §3's `g` was stamped ten minutes back on a 5-minute cadence, so it is due
  // again at this tick; its incremental job would fetch beside h1 whenever the
  // machine is loaded and read as an overlap. Off its schedule, §4 sees only
  // the full refreshes it is about.
  await datasets.setAutoRefresh(pid, ids.get('g')!, { every: null });
  await table('h1', false);
  await table('h2', false);
  await schedule('h2', 'hourly', new Date(Date.now() - 3 * 60 * MIN).toISOString()); // 2 h past due
  await schedule('h1', 'hourly'); // never: first
  held.add('h1');
  held.add('h2');
  maxInFlight = 0;
  started.length = 0;
  let settled = false;
  const tick4 = sched.tickNow().then((o) => { settled = true; return o; });
  await until(() => parked().length > 0);
  await sleep(150);
  ok('4. the tick waits for a full refresh (not queued and left)', !settled && parked().join() === 'h1', parked().join());
  release('h1');
  await until(() => parked().includes('h2'));
  ok('4. …then the next, one at a time (h1 before h2)', !settled && started.filter((t) => t.startsWith('h')).join() === 'h1,h2', started.join());
  release('h2');
  const out4 = await tick4;
  ok('4. the tick returns their outcomes, in order', out4.map((o) => names.get(o.datasetId)).join() === 'h1,h2' && out4.every((o) => o.ok),
    JSON.stringify(out4));
  ok('4. a full refresh never overlapped another', maxInFlight === 1, maxInFlight);
  ok('4. not incremental: the summary says so', !(await datasets.listDatasets(pid)).find((d) => d.id === ids.get('h1'))?.incrementalOn);
}

main()
  .catch((err) => ok('threw', false, err && err.stack))
  .finally(() => {
    for (const t of waiting.keys()) release(t); // deleting the current key mid-iteration is safe for a Map
    globalThis.fetch = realFetch;
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    finish();
  });
