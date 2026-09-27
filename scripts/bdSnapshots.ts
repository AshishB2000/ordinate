// Build-depth smoke SECTION: data snapshots, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-build.ts calls snapshotsSection(s, fx) on its
// one launch and fixture.
//
//   The seeded "Refreshable" dataset (a real CSV with a file origin) → its
//   Snapshots tab says only scheduled/connected datasets keep them → Auto-refresh
//   Daily from the header → the designed empty state → Refresh, change the CSV,
//   Refresh → two snapshots listed with row counts → Compare, matched by city:
//   1 added / 1 removed / 1 changed, the changed cell 20 → 25 → a dashboard
//   over it: "As of" the newest snapshot draws the OLD total, Latest the new →
//   Restore that snapshot (confirmed in the app's dialog) → the old rows are
//   back and one more snapshot is kept. Leaves the dataset list on screen and
//   every picker on Latest.
//
// The refresh scheduler is stopped for the section (and started again after):
// a Daily schedule with no last run is due on its next tick, and a refresh of
// its own mid-section would add a snapshot the counts below do not expect.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// A page-level `const` (chartRender.ts), read by bare name inside evaluate — not on window.
declare const chartInstances: any;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
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

export async function snapshotsSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const pid = fx.projectId;
  const id = fx.fileDatasetId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const snapshots = req('./src/data/snapshots.js');
    const sched = req('./src/app/refreshScheduler.js');
    if (a.fn === 'count') return (await snapshots.list(a.pid, a.id)).length;
    if (a.fn === 'rows') return (await datasets.getDataset(a.pid, a.id)).rows;
    if (a.fn === 'schedule') return (await datasets.getDatasetMeta(a.pid, a.id)).autoRefresh || null;
    if (a.fn === 'stop') { sched.stop(); return true; }
    if (a.fn === 'start') { sched.start(); return true; }
    return null;
  }, { fn, pid, id, ...arg }) as Promise<T>;

  await main('stop');
  try {
    // ── The tab, before the dataset is eligible ─────────────────────────────
    await openProject(win, pid);
    await win.evaluate(() => { (window as any).selectSection('datasets'); });
    await win.waitForTimeout(800);
    await win.evaluate((d: string) => (window as any).openSavedDataset(d), id);
    await until(win, () => win.evaluate(() => !document.getElementById('ds-explorer')?.hidden), 10_000);
    ok('snapshots: the dataset page has a Snapshots tab', await click(win, '#ds-tab-snapshots'));
    await until(win, async () => (await text(win, '#snap-body')).length > 0, 10_000);
    ok('snapshots: a file dataset with no schedule says only scheduled or connected datasets keep them',
      /Only datasets with a schedule or a connection keep snapshots/.test(await text(win, '#snap-body .snap-notice')),
      await text(win, '#snap-body'));

    // ── Eligible: Auto-refresh → Daily, from the header ───────────────────
    ok('snapshots: the header offers Auto-refresh', await choose(win, '#ds-explorer-auto select', 'daily'));
    ok('snapshots: main holds the Daily schedule', await until(win, async () => {
      const a: any = await main('schedule');
      return !!a && a.every === 'daily';
    }, 10_000));
    await until(win, async () => /Snapshots start with the next refresh/.test(await text(win, '#snap-body')), 10_000);
    ok('snapshots: the designed empty state names the next refresh and the retention',
      /Snapshots start with the next refresh/.test(await text(win, '#snap-body .snap-empty'))
        && (await win.evaluate(() => (document.getElementById('snap-keep') as HTMLSelectElement | null)?.value)) === '10',
      await text(win, '#snap-body'));
    await shot('snapshots-empty.png');

    // ── Two refreshes, the file changed in between ─────────────────────────
    ok('snapshots: Refresh is on the header', await click(win, '#ds-explorer-refresh'));
    ok('snapshots: the first refresh keeps the imported table', await until(win, async () => (await main<number>('count')) === 1));
    fs.writeFileSync(fx.csvPath, 'city,visits\nBergen,25\nTromso,7\nAlta,1\n', 'utf8');
    await until(win, () => win.evaluate(() => !(document.getElementById('ds-explorer-refresh') as HTMLButtonElement).disabled), 10_000);
    await win.waitForTimeout(50);
    ok('snapshots: Refresh again', await click(win, '#ds-explorer-refresh'));
    ok('snapshots: the second refresh keeps the first one\'s table', await until(win, async () => (await main<number>('count')) === 2));
    await until(win, () => win.evaluate(() => !(document.getElementById('ds-explorer-refresh') as HTMLButtonElement).disabled), 10_000);

    await click(win, '#ds-tab-snapshots');
    await until(win, () => win.evaluate(() => document.querySelectorAll('#snap-body .snap-row[data-stamp]').length === 2), 10_000);
    const listed: string[] = await win.evaluate(() =>
      [...document.querySelectorAll('#snap-body .snap-row')].map((r) => (r.children[1]?.textContent || '').trim()));
    ok('snapshots: the list shows now and two snapshots with their row counts',
      JSON.stringify(listed) === JSON.stringify(['3 rows', '2 rows', '2 rows']), JSON.stringify(listed));
    await shot('snapshots-list.png');

    // ── Compare the newest with now, matched by city ───────────────────────
    ok('snapshots: Compare opens on the newest snapshot', await click(win, '#snap-body .snap-row[data-stamp] .js-snap-compare'));
    await until(win, async () => (await text(win, '#snap-diff-out .snap-sum')).length > 0, 15_000);
    ok('snapshots: keyed by the whole row first (3 added, 2 removed)',
      /3 added/.test(await text(win, '#snap-diff-out .snap-sum')) && /2 removed/.test(await text(win, '#snap-diff-out .snap-sum')),
      await text(win, '#snap-diff-out .snap-sum'));
    ok('snapshots: city is offered as the key', await choose(win, '#snap-diff-key', 'city'));
    await until(win, async () => /changed/.test(await text(win, '#snap-diff-out .snap-sum')), 15_000);
    const chips = {
      added: await text(win, '#snap-diff-out .snap-chip-added b'),
      removed: await text(win, '#snap-diff-out .snap-chip-removed b'),
      changed: await text(win, '#snap-diff-out .snap-chip-changed b'),
    };
    ok('snapshots: by city — 2 added, 1 removed, 1 changed', chips.added === '2' && chips.removed === '1' && chips.changed === '1', JSON.stringify(chips));
    const cell = await win.evaluate(() => {
      const tr = document.querySelector('#snap-diff-out .snap-changed tbody tr');
      return tr ? [...tr.children].map((c) => (c.textContent || '').trim()) : [];
    });
    ok('snapshots: the changed cell is Bergen · visits · 20 → 25', JSON.stringify(cell) === JSON.stringify(['Bergen', 'visits', '20', '25']), JSON.stringify(cell));
    await shot('snapshots-diff.png');

    // ── As of, on a dashboard over the dataset ─────────────────────────────
    await seedAnalysis(app, pid, {
      name: 'Snapshots board',
      sheets: [{ name: 'Sheet 1', cards: [
        { type: 'metric', metric: { datasetId: id, column: 'visits', aggregation: 'sum', label: 'Visits' }, layout: { x: 0, y: 0, w: 3, h: 2 } },
      ] }],
    });
    await win.evaluate(() => { (window as any).selectSection('analyses'); });
    await win.waitForTimeout(1200);
    ok('snapshots: the dashboard opens', await openSeededAnalysis(win, 'Snapshots board'));
    const figure = (): Promise<string> => text(win, '#dash-grid .dash-card .dash-metric-value');
    await until(win, async () => (await figure()) === '33', 15_000);
    ok('snapshots: Latest shows the current total (33)', (await figure()) === '33', await figure());
    ok('snapshots: the header grows an "As of" picker with the snapshot times', await until(win, () => win.evaluate(() => {
      const w = document.getElementById('dash-asof-wrap');
      const sel = document.getElementById('dash-asof') as HTMLSelectElement | null;
      return !!w && !w.hidden && !!sel && sel.options.length === 3 && sel.value === '';
    }), 15_000), await win.evaluate(() => {
      const w = document.getElementById('dash-asof-wrap');
      const sel = document.getElementById('dash-asof') as HTMLSelectElement | null;
      return JSON.stringify({ inDom: !!w && document.contains(w), hidden: w && w.hidden, n: sel && sel.options.length, v: sel && sel.value });
    }));
    const newest: string = await win.evaluate(() => {
      const o = (document.getElementById('dash-asof') as HTMLSelectElement | null)?.options[1];
      return o ? o.value : '';
    });
    ok('snapshots: pick the newest snapshot', await choose(win, '#dash-asof', newest));
    await until(win, async () => (await figure()) === '30', 15_000);
    ok('snapshots: As of the snapshot, the figure is the old total (30)', (await figure()) === '30', await figure());
    await shot('snapshots-asof.png');
    ok('snapshots: back to Latest', await choose(win, '#dash-asof', ''));
    await until(win, async () => (await figure()) === '33', 15_000);
    ok('snapshots: Latest draws the current total again (33)', (await figure()) === '33', await figure());

    // ── Restore the newest snapshot, through the app's confirm ────────────
    await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
    await win.waitForTimeout(600);
    await win.evaluate(() => { (window as any).selectSection('datasets'); });
    await win.waitForTimeout(600);
    await win.evaluate((d: string) => (window as any).openSavedDataset(d), id);
    await win.waitForTimeout(600);
    await click(win, '#ds-tab-snapshots');
    await until(win, () => win.evaluate(() => document.querySelectorAll('#snap-body .snap-row[data-stamp]').length === 2), 10_000);
    ok('snapshots: Restore… is on the snapshot row', await click(win, '#snap-body .snap-row[data-stamp] .js-snap-restore'));
    await until(win, () => win.evaluate(() => [...document.querySelectorAll('.ws-modal-overlay')].some((o) => (o as HTMLElement).getClientRects().length > 0)), 5000);
    ok('snapshots: the confirm says what it will do', /Restore this snapshot\?/.test(await text(win, '.sy-modal .ws-modal-title')), await text(win, '.sy-modal'));
    await shot('snapshots-restore-confirm.png');
    await click(win, '.sy-modal .ws-modal-actions .btn-primary');
    ok('snapshots: the restore keeps the replaced table as one more snapshot', await until(win, async () => (await main<number>('count')) === 3));
    const rows: any[] = await main('rows');
    ok('snapshots: the dataset has the old rows back', JSON.stringify(rows) === JSON.stringify([['Oslo', 10], ['Bergen', 20]]), JSON.stringify(rows));
    await until(win, () => win.evaluate(() => document.querySelectorAll('#snap-body .snap-row[data-stamp]').length === 3), 10_000);
    const after: string[] = await win.evaluate(() =>
      [...document.querySelectorAll('#snap-body .snap-row')].map((r) => (r.children[1]?.textContent || '').trim()));
    ok('snapshots: the tab lists three snapshots, now 2 rows again', JSON.stringify(after) === JSON.stringify(['2 rows', '3 rows', '2 rows', '2 rows']), JSON.stringify(after));

    // ── A metric's value across the snapshots (the metric editor) ─────────
    const metric: any = await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      return req('./src/analysis/metrics.js').saveMetric(a.pid, {
        name: 'Total visits', datasetId: a.id, definition: { column: 'visits', aggregation: 'sum' },
      });
    }, { pid, id });
    ok('snapshots: a metric over the dataset', !!metric && !!metric.id);
    await win.evaluate((m: any) => { void (window as any).openMetricEditor(m); }, metric);
    await until(win, () => win.evaluate(() => !!document.querySelector('.me-modal .snap-mh-chart canvas')), 15_000);
    const series: any = await win.evaluate(() => {
      const area = document.querySelector('.me-modal .snap-mh-chart');
      const chart: any = area ? chartInstances.get(area) : null;
      return chart ? { labels: chart.data.labels, values: chart.data.datasets[0].data } : null;
    });
    ok('snapshots: the metric editor plots it across snapshots — 30, 30, 33, then now 30',
      !!series && JSON.stringify(series.values) === JSON.stringify([30, 30, 33, 30]) && series.labels[3] === 'Now', JSON.stringify(series));
    await win.evaluate(() => { document.querySelector('.me-modal .snap-mh')?.scrollIntoView({ block: 'center' }); });
    await shot('snapshots-metric-history.png');
    await win.keyboard.press('Escape');
    await until(win, () => win.evaluate(() => !document.querySelector('.me-modal')), 5000);

    // Neutral: the dataset list, every picker on Latest.
    await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
    await win.waitForTimeout(400);
    ok('snapshots: every "As of" picker is on Latest', await win.evaluate(() =>
      ['dash-asof', 'viz-asof'].every((i) => !(document.getElementById(i) as HTMLSelectElement | null)?.value)));
  } finally {
    await main('start');
  }
  const errs = s.errors.slice(errors0);
  ok('snapshots: no renderer console error in the section', errs.length === 0, errs.join('\n'));
}
