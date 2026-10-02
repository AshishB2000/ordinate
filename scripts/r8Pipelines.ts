// Round 8 smoke SECTION: the Pipelines tab, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round8.ts calls pipelinesSection(s, fx) on
// its one launch and fixture.
//
//   A project with nothing that runs → the designed empty state (six stages
//   waiting). The fixture project, plus a quality rule and an alert on
//   'Refreshable' and a 'Broken feed' whose file is gone → Data → Pipelines:
//   six stage columns, the file sources, the datasets, the quality gate and the
//   alert as cards, every edge drawn → a dataset's own schedule set from the
//   page lands in its EXISTING autoRefresh field → the pipeline cron, typed,
//   previewed and saved, then paused → Run from 'Refreshable': it refreshes
//   (2 rows), its checks pass, its alert is checked, and each run is in the
//   history with its log → Run from 'Broken feed' with one retry: failed after
//   two attempts, its checks BLOCKED, and a "Pipeline" alert event raised.
//   Everything it created is removed; the Datasets tab is left showing.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level `let`s (pipelinesPage.ts), read by bare name inside evaluate — not on window.
declare let pqView: any;
declare let pqRunning: boolean;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
  }
  return false;
}

const text = (win: Win, sel: string): Promise<string> =>
  win.evaluate((q: string) => (document.querySelector(q)?.textContent || '').trim(), sel);

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

const choose = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string }) => {
    const el = document.querySelector(a.q) as HTMLSelectElement | null;
    if (!el || ![...el.options].some((o) => o.value === a.v)) return false;
    el.value = a.v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { q: sel, v: value });

const card = (id: string): string => `#pq-wrap .pq-node[data-node-id="${id}"]`;
declare let pqSel: string | null;
/** Select a step's card — a click on the selected one would deselect it. */
const pick = async (win: Win, id: string): Promise<boolean> =>
  (await win.evaluate((x: string) => pqSel === x, id)) || click(win, card(id));
const loaded = (win: Win): Promise<boolean> => win.evaluate(() => !!pqView && !pqRunning);

export async function pipelinesSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const fileId = fx.fileDatasetId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(250);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const quality = req('./src/analysis/qualityRun.js');
    const alertStore = req('./src/analysis/alertStore.js');
    const store = req('./src/app/pipelineStore.js');
    const fs = req('fs');
    const nodePath = req('path');
    const userData = req('electron').app.getPath('userData');
    if (a.fn === 'seed') {
      const missing = nodePath.join(userData, 'gone-feed.csv');
      fs.writeFileSync(missing, 'city,visits\nOslo,1\n', 'utf8');
      const broken = await datasets.saveDataset(a.pid, {
        name: 'Broken feed', sourceKind: 'csv',
        columns: [{ name: 'city', type: 'text' }, { name: 'visits', type: 'number' }],
        rows: [['Oslo', 1]], origin: { kind: 'file', path: missing },
      });
      fs.unlinkSync(missing); // the source disappears: every refresh of it fails
      const q1 = await quality.saveRule(a.pid, a.fileId, { kind: 'not_null', column: 'city', severity: 'fail', args: {} });
      const q2 = await quality.saveRule(a.pid, broken.id, { kind: 'not_null', column: 'city', severity: 'fail', args: {} });
      const al = await alertStore.saveRule(a.pid, {
        name: 'Visits spike', datasetId: a.fileId, metric: { column: 'visits', aggregation: 'sum' },
        compare: 'threshold', threshold: { op: '>', value: 1e9 }, enabled: true,
      });
      return { brokenId: broken.id, q1: q1.ok && q1.rule.id, q2: q2.ok && q2.rule.id, alertId: al && al.id, missing };
    }
    if (a.fn === 'auto') return ((await datasets.getDatasetMeta(a.pid, a.id)) || {}).autoRefresh || null;
    if (a.fn === 'state') return store.load(a.pid);
    if (a.fn === 'setPolicy') return store.update(a.pid, (st: any) => { st.policy = { retries: 1, backoffMs: 1000 }; });
    if (a.fn === 'events') return (await alertStore.load(a.pid)).events.filter((e: any) => e.ruleName === 'Pipeline');
    if (a.fn === 'cleanup') {
      await datasets.setAutoRefresh(a.pid, a.fileId, { every: null });
      if (a.q1) await quality.deleteRule(a.pid, a.fileId, a.q1);
      if (a.alertId) await alertStore.deleteRule(a.pid, a.alertId);
      if (a.brokenId) await datasets.deleteDataset(a.pid, a.brokenId);
      // The raised events: out of the inbox file, so a later section's bell counts start clean.
      const f = nodePath.join(userData, 'projects', a.pid, 'alerts.json');
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        raw.events = (raw.events || []).filter((e: any) => e.ruleName !== 'Pipeline');
        fs.writeFileSync(f, JSON.stringify(raw, null, 2));
      } catch (_) { /* no alerts file */ }
      try { fs.unlinkSync(nodePath.join(userData, 'projects', a.pid, 'pipelines.json')); } catch (_) { /* never written */ }
      return true;
    }
    return null;
  }, { fn, pid, fileId, ...arg }) as Promise<T>;

  const openTab = async (projectId: string): Promise<void> => {
    await openProject(win, projectId);
    await win.evaluate(() => { (window as any).selectSection('datasets'); });
    await win.waitForTimeout(500);
    await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
    await win.waitForTimeout(300);
    await click(win, '#ds-tab-pipelines');
  };

  // ── Empty: a project where nothing runs ──────────────────────────────────
  await openTab(fx.bareProjectId);
  ok('pipelines: the Data page has a Pipelines tab, and it opens',
    await until(win, () => win.evaluate(() => !document.getElementById('pq-wrap')!.hidden && !!document.querySelector('#pq-wrap .pq-head'))));
  ok('pipelines: a project with nothing that runs shows the designed empty state',
    await until(win, async () => (await text(win, '#pq-wrap .pq-empty .ws-empty-h')) === 'Nothing runs on its own yet'), await text(win, '#pq-wrap'));
  ok('pipelines: …over the six stages, waiting', await win.evaluate(() =>
    [...document.querySelectorAll('#pq-wrap .pq-cols--ghost .pq-col-h')].map((h) => h.textContent).join('|')
      === 'Sources|Datasets|Derived datasets|Quality checks|Alerts|Reports & publish'));
  ok('pipelines: the empty state offers a way in', (await text(win, '#pq-wrap .pq-empty .btn-primary')) === 'Connect data');
  ok('pipelines: the page sentence follows the tab', /one pipeline/.test(await text(win, '#ds-sub')));
  await shot('pipelines-empty.png');

  // ── The fixture project's pipeline ───────────────────────────────────────
  const seed: any = await main('seed');
  ok('pipelines: seeded a quality rule, an alert and a broken feed', !!seed.brokenId && !!seed.q1 && !!seed.q2 && !!seed.alertId, JSON.stringify(seed));
  await openTab(pid);
  ok('pipelines: the graph renders', await until(win, () => win.evaluate(() => !!pqView && pqView.ok && !!document.querySelector('#pq-graph .pq-node'))));
  ok('pipelines: six stage columns, in order', await win.evaluate(() =>
    [...document.querySelectorAll('#pq-graph .pq-col-h > span:first-child')].map((h) => h.textContent).join('|')
      === 'Sources|Datasets|Derived datasets|Quality checks|Alerts|Reports & publish'));
  const srcId = 'source:file:' + fx.csvPath;
  const ids = ['dataset:' + fileId, 'quality:' + fileId, 'alert:' + seed.alertId, 'dataset:' + seed.brokenId, 'quality:' + seed.brokenId];
  const present: boolean[] = await win.evaluate((list: string[]) => list.map((id) => !!document.querySelector(`#pq-wrap .pq-node[data-node-id="${CSS.escape(id)}"]`)), [srcId, ...ids]);
  ok('pipelines: the file source, both datasets, both quality gates and the alert are cards', present.every(Boolean), JSON.stringify(present));
  ok('pipelines: a dataset that nothing runs or reads (Sales, pasted) is not in it',
    !(await win.evaluate((id: string) => !!document.querySelector(`#pq-wrap .pq-node[data-node-id="dataset:${id}"]`), fx.datasetId)));
  ok('pipelines: cards sit in their stage columns', await win.evaluate((a: { f: string; al: string }) => {
    const col = (id: string): number => [...document.querySelectorAll('#pq-graph .pq-col')].findIndex((c) => !!c.querySelector(`[data-node-id="${id}"]`));
    return col('dataset:' + a.f) === 1 && col('quality:' + a.f) === 3 && col('alert:' + a.al) === 4;
  }, { f: fileId, al: seed.alertId }));
  ok('pipelines: the alert hangs off the quality gate, and every edge is drawn', await win.evaluate((a: { f: string; al: string }) => {
    const edges = pqView.edges as Array<{ from: string; to: string }>;
    const gated = edges.some((e) => e.from === 'quality:' + a.f && e.to === 'alert:' + a.al);
    return gated && document.querySelectorAll('#pq-graph svg.pq-edges path.pq-edge').length === edges.length && edges.length >= 5;
  }, { f: fileId, al: seed.alertId }));
  ok('pipelines: each card shows schedule, last run and next run', await win.evaluate((id: string) =>
    document.querySelectorAll(`.pq-node[data-node-id="dataset:${id}"] .pq-meta`).length === 3, fileId));
  ok('pipelines: the head names the step count', /\d+ steps in \d+ stages/.test(await text(win, '#pq-wrap .pq-stats')), await text(win, '#pq-wrap .pq-stats'));

  // ── A node's own schedule, written to its own record ─────────────────────
  ok('pipelines: selecting a card opens its panel', await pick(win, 'dataset:' + fileId)
    && await until(win, async () => (await text(win, '#pq-detail .pq-detail-name')) === 'Refreshable'));
  ok('pipelines: a dataset step offers its refresh schedule', await choose(win, '#pq-node-every', 'daily'));
  ok('pipelines: …which lands in the dataset\'s existing autoRefresh field',
    await until(win, async () => ((await main<any>('auto', { id: fileId })) || {}).every === 'daily'));
  ok('pipelines: the card now says Daily', await until(win, async () => /Daily/.test(await text(win, card('dataset:' + fileId) + ' .pq-meta'))));

  // ── The pipeline's own cron ──────────────────────────────────────────────
  ok('pipelines: Set a schedule opens the editor', await click(win, '#pq-wrap .pq-sched-acts .btn') && await until(win, () => win.evaluate(() => !!document.getElementById('pq-cron-input'))));
  await win.fill('#pq-cron-input', '30 7 * * 1-5');
  ok('pipelines: the editor previews what it means and when it next runs',
    await until(win, async () => /^Weekdays at 07:30 · times in .+ · next: .+, .+, .+/.test(await text(win, '#pq-wrap .pq-cron-preview'))), await text(win, '#pq-wrap .pq-cron-preview'));
  await win.fill('#pq-cron-input', '0 6 * *');
  ok('pipelines: a broken expression is explained and cannot be saved',
    await until(win, () => win.evaluate(() => (document.getElementById('pq-cron-save') as HTMLButtonElement).disabled)));
  await win.fill('#pq-cron-input', '0 6 * * *');
  await until(win, () => win.evaluate(() => !(document.getElementById('pq-cron-save') as HTMLButtonElement).disabled));
  await click(win, '#pq-cron-save');
  ok('pipelines: the saved schedule heads the page', await until(win, async () => (await text(win, '#pq-wrap .pq-sched-main')) === 'Every day at 06:00'));
  const st1: any = await main('state');
  ok('pipelines: …stored in the project\'s pipeline file, in a real zone', !!st1.schedule && st1.schedule.cron === '0 6 * * *' && !!st1.schedule.tz && !st1.schedule.paused, JSON.stringify(st1.schedule));
  await click(win, '#pq-wrap .pq-sched-acts .btn:nth-child(2)');
  ok('pipelines: Pause pauses it', await until(win, async () => /paused/.test(await text(win, '#pq-wrap .pq-sched-main'))) && (await main<any>('state')).schedule.paused === true);
  await shot('pipelines-graph.png');

  // ── Run from here: the good path ─────────────────────────────────────────
  await pick(win, 'dataset:' + fileId);
  await until(win, async () => (await text(win, '#pq-detail .pq-detail-name')) === 'Refreshable');
  ok('pipelines: Run from here', await click(win, '#pq-run-node'));
  ok('pipelines: the run finishes', await until(win, () => win.evaluate(() => !pqRunning && !!pqView && pqView.ok
    && pqView.nodes.some((n: any) => n.id.startsWith('quality:') && n.runs.length)), 60_000));
  await until(win, () => loaded(win));
  const good: any = await win.evaluate((a: { f: string; al: string }) => {
    const get = (id: string): any => pqView.nodes.find((n: any) => n.id === id);
    const d = get('dataset:' + a.f);
    const q = get('quality:' + a.f);
    const al = get('alert:' + a.al);
    return { d: d && d.runs[0], q: q && q.runs[0], al: al && al.runs[0], all: pqView.nodes.map((n: any) => [n.id, n.runs.length]) };
  }, { f: fileId, al: seed.alertId });
  ok('pipelines: the dataset refreshed — ok, 2 rows before and after', !!good.d && good.d.status === 'ok' && good.d.rows === 2 && good.d.rowsBefore === 2, JSON.stringify(good));
  ok('pipelines: then its checks ran and passed', !!good.q && good.q.status === 'ok' && /1 of 1 rules passed/.test(good.q.note || ''), JSON.stringify(good.q));
  ok('pipelines: then its alert was checked', !!good.al && good.al.status === 'ok' && /did not fire/.test(good.al.note || ''), JSON.stringify(good.al));
  ok('pipelines: one run id across the three', !!good.d && good.d.runId === good.q.runId && good.q.runId === good.al.runId);
  ok('pipelines: the card says OK with a duration', await until(win, async () => /OK/.test(await text(win, card('dataset:' + fileId) + ' .pq-pill'))
    && / s$/.test((await text(win, card('dataset:' + fileId) + ' .pq-meta:nth-child(2)')))));
  await pick(win, 'dataset:' + fileId);
  ok('pipelines: the history lists the run', await until(win, () => win.evaluate(() => document.querySelectorAll('#pq-runs .pq-run:not(.pq-run--head)').length >= 1)));
  await click(win, '#pq-runs .pq-run:not(.pq-run--head)');
  ok('pipelines: a run opens its log inline — row counts', await until(win, async () => /2 rows before, 2 after/.test(await text(win, '#pq-runs .pq-log:not([hidden])'))), await text(win, '#pq-runs'));

  // ── Run from here: a failure stops what follows, and raises an alert ─────
  await main('setPolicy');
  await win.evaluate(() => (window as any).pqLoad());
  await until(win, async () => (await win.evaluate(() => (document.getElementById('pq-retries') as HTMLSelectElement | null)?.value)) === '1');
  ok('pipelines: the retry policy shows (retry once, after 1 s)', await win.evaluate(() =>
    (document.getElementById('pq-retries') as HTMLSelectElement).value === '1' && (document.getElementById('pq-backoff') as HTMLSelectElement).value === '1000'));
  await pick(win, 'dataset:' + seed.brokenId);
  await until(win, async () => (await text(win, '#pq-detail .pq-detail-name')) === 'Broken feed');
  await click(win, '#pq-run-node');
  ok('pipelines: the broken run finishes', await until(win, () => win.evaluate((id: string) => !pqRunning && !!pqView && pqView.ok
    && (pqView.nodes.find((n: any) => n.id === 'quality:' + id) || { runs: [] }).runs.length > 0, seed.brokenId), 60_000));
  const bad: any = await win.evaluate((id: string) => {
    const get = (x: string): any => pqView.nodes.find((n: any) => n.id === x);
    return { d: get('dataset:' + id).runs[0], q: get('quality:' + id).runs[0] };
  }, seed.brokenId);
  ok('pipelines: the feed failed after two attempts (one retry)', bad.d.status === 'failed' && bad.d.attempts === 2 && bad.d.errors.length === 1, JSON.stringify(bad.d));
  ok('pipelines: its checks were BLOCKED, naming the failure', bad.q.status === 'blocked' && /"Broken feed" failed/.test(bad.q.errors[0] || ''), JSON.stringify(bad.q));
  ok('pipelines: the cards say Failed and Blocked, and the edge between them is marked', await until(win, () => win.evaluate((id: string) =>
    !!document.querySelector(`.pq-node.is-failed[data-node-id="dataset:${id}"]`)
    && !!document.querySelector(`.pq-node.is-blocked[data-node-id="quality:${id}"]`)
    && !!document.querySelector(`path.pq-edge.is-blocked[data-to="quality:${id}"]`), seed.brokenId)));
  const events: any[] = await main('events');
  ok('pipelines: the failure raised an alert event in the inbox', events.length === 1 && /Pipeline: "Broken feed" failed/.test(events[0].message)
    && /1 step after it was stopped/.test(events[0].message) && events[0].datasetId === seed.brokenId, JSON.stringify(events));
  await shot('pipelines-failed.png');

  // ── Clean up ─────────────────────────────────────────────────────────────
  await main('cleanup', { q1: seed.q1, alertId: seed.alertId, brokenId: seed.brokenId });
  await click(win, '#ds-tab-datasets');
  ok('pipelines: back on the Datasets tab', await win.evaluate(() => document.getElementById('pq-wrap')!.hidden === true));
}
