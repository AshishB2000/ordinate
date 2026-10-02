// Smoke SECTION: scorecards, end to end on the bundled sample.
//
// Not a smoke file of its own: `scorecardsSection(s, ids)` runs against an app
// scripts/smoke-power.ts launched, on a FRESH userData whose first-launch sample
// is seeded. It makes two metrics through main's own store, then drives what a
// user does: the Scorecards tab's empty state → New scorecard (seeded with the
// project's metrics) → targets, owners and groups in the editor → the page for
// the latest month → the period picker → a quarterly cadence → a row's detail
// (a line with target and forecast overlays, the breakdown, Alert me) → the
// Assistant's facts and the dock's context → Create report.
//
// The FIGURES it checks — revenue and profit for December and November 2024 —
// are computed HERE from assets/samples/retail-orders.csv, never read back from
// the app it is testing.

import { ok } from './selfcheck';
import { REPO, domDriver } from './smokeFixture';
import type { Smoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
type Ids = { projectId: string; datasetId: string; dashboardId: string };

// Hub globals, read by bare name inside page.evaluate (classic-script lexicals).
declare const scCurrent: { id: string; name: string } | null;
declare function dkContextRef(): { kind: string; id: string };
declare function buildReportPages(ctx: any): Promise<any[]>;
declare function reportAnalysisFor(projectId: string, report: any): Promise<any>;
declare function reportBytes(pages: any[], report: any): Promise<{ base64: string; ext: string }>;

/** sum(column) over the rows whose order_date starts with `prefix` (YYYY-MM or a list of them). */
function sumFor(column: string, prefixes: string[]): number {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  const di = head.indexOf('order_date');
  const ci = head.indexOf(column);
  let total = 0;
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (prefixes.some((p) => c[di].startsWith(p))) total += Number(c[ci]);
  }
  return total;
}

const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-6;

async function rows(win: Win): Promise<Array<{ id: string; status: string; name: string; value: string }>> {
  return win.evaluate(() => [...document.querySelectorAll('#sc-table .sc-row:not(.sc-row--head)')].map((r) => ({
    id: (r as HTMLElement).dataset.metricId || '',
    status: (r as HTMLElement).dataset.status || '',
    name: (r.querySelector('.sc-metric-name')?.textContent || '').trim(),
    value: (r.querySelector('.sc-cell--value')?.textContent || '').trim(),
  })));
}

export async function scorecardsSection(s: Smoke, ids: Ids): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;
  const decRev = sumFor('revenue', ['2024-12']);
  const novRev = sumFor('revenue', ['2024-11']);
  const decProfit = sumFor('profit', ['2024-12']);
  const q4Rev = sumFor('revenue', ['2024-10', '2024-11', '2024-12']);
  ok('scorecards: the sample has December and November 2024 revenue', decRev > 0 && novRev > 0);

  // Two metrics of our own, through main's store (their ids are what rows name).
  const made = await s.app.evaluate(async (_a: unknown, arg: { pid: string; dsid: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const metrics = req('./src/analysis/metrics.js');
    const a = await metrics.saveMetric(arg.pid, { name: 'Smoke revenue', datasetId: arg.dsid, definition: { column: 'revenue', aggregation: 'sum' }, direction: 'up_good' });
    const b = await metrics.saveMetric(arg.pid, { name: 'Smoke profit', datasetId: arg.dsid, definition: { column: 'profit', aggregation: 'sum' }, direction: 'up_good' });
    return { rev: a ? a.id : '', profit: b ? b.id : '' };
  }, { pid: ids.projectId, dsid: ids.datasetId });
  ok('scorecards: two metrics saved', !!made.rev && !!made.profit);

  const { clickExact, fillPrompt } = domDriver(win);
  await clickExact('Dashboards');
  await win.waitForTimeout(900);
  await win.evaluate(() => (document.getElementById('rp-tab-scorecards') as HTMLElement | null)?.click());
  await win.waitForTimeout(700);
  const empty = await win.evaluate(() => {
    const e = document.getElementById('sc-empty') as HTMLElement | null;
    const tab = document.getElementById('rp-tab-scorecards');
    return { shown: !!e && !e.hidden, selected: tab?.getAttribute('aria-selected') === 'true', text: e?.textContent || '' };
  });
  ok('scorecards: the fourth tab shows its empty state', empty.shown && empty.selected && /No scorecards yet/.test(empty.text), JSON.stringify(empty));

  await win.evaluate(() => (document.getElementById('sc-empty-new') as HTMLElement | null)?.click());
  await win.waitForTimeout(500);
  ok('scorecards: New asks for a name', await fillPrompt('Smoke scorecard'));
  await win.waitForTimeout(3000);
  const editorOpen = await win.evaluate(() => !!document.querySelector('.ws-modal.sc-editor'));
  ok('scorecards: a seeded scorecard opens straight on its targets', editorOpen);

  // Keep our two rows; give revenue a target it misses (at risk) and profit one it beats.
  const revTarget = Math.round(decRev / 0.95); // ≈ 95% attainment → at risk
  const profitTarget = Math.round(decProfit / 2); // 200% → on track
  const edited = await win.evaluate(async (arg: { rev: string; profit: string; revTarget: number; profitTarget: number }) => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const box = document.querySelector('.ws-modal.sc-editor') as HTMLElement;
    const rowFor = (name: string) => [...box.querySelectorAll('.sc-ed-row:not(.sc-ed-row--head)')]
      .find((r) => (r.querySelector('.sc-ed-metric-name')?.textContent || '') === name) as HTMLElement | undefined;
    // Drop every other seeded row, so the page holds exactly the two we reason about.
    for (let guard = 0; guard < 20; guard++) {
      const other = [...box.querySelectorAll('.sc-ed-row:not(.sc-ed-row--head)')]
        .find((r) => !/^Smoke (revenue|profit)$/.test(r.querySelector('.sc-ed-metric-name')?.textContent || '')) as HTMLElement | undefined;
      if (!other) break;
      (other.querySelector('.sc-ed-acts button:last-child') as HTMLElement).click();
      await pause(100);
    }
    const set = async (name: string, target: number, owner: string, group: string) => {
      const row = rowFor(name);
      if (!row) return false;
      const mode = row.querySelector('.sc-ed-mode') as HTMLSelectElement;
      mode.value = 'number';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      await pause(150);
      const again = rowFor(name) as HTMLElement;
      const inputs = [...again.querySelectorAll('input.sc-ed-input')] as HTMLInputElement[];
      const fill = (i: HTMLInputElement, v: string) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
      fill(inputs[0], String(target));
      fill(inputs[1], owner);
      fill(inputs[2], group);
      return true;
    };
    const a = await set('Smoke revenue', arg.revTarget, 'Ana', 'Sales');
    const b = await set('Smoke profit', arg.profitTarget, 'Bo', 'Sales');
    const count = box.querySelectorAll('.sc-ed-row:not(.sc-ed-row--head)').length;
    ([...box.querySelectorAll('.ws-modal-actions .btn-primary')].pop() as HTMLElement).click();
    return { a, b, count };
  }, { ...made, revTarget, profitTarget });
  ok('scorecards: targets, owners and groups set in the editor', edited.a && edited.b && edited.count === 2, JSON.stringify(edited));
  await win.waitForTimeout(3500);

  const head = await win.evaluate(() => ({
    page: !(document.getElementById('sc-page') as HTMLElement).hidden,
    label: document.getElementById('sc-period-label')?.textContent || '',
    group: (document.querySelector('#sc-table .sc-group-roll')?.textContent || '').trim(),
  }));
  ok('scorecards: the page opens on the latest month of data', head.page && head.label === 'Dec 2024', JSON.stringify(head));
  ok('scorecards: the group rolls up one of two on track', head.group === '1 of 2 on track', head.group);
  if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'scorecard-page.png') });
  const r1 = await rows(win);
  const rev = r1.find((r) => r.id === made.rev);
  const prof = r1.find((r) => r.id === made.profit);
  ok('scorecards: revenue is at risk, profit on track', !!rev && rev.status === 'warn' && !!prof && prof.status === 'good', JSON.stringify(r1));

  const res = await win.evaluate(async (pid: string) => (window as any).hubPower.scorecardCompute(pid, scCurrent ? scCurrent.id : '', 0), ids.projectId);
  const rr = (res.rows || []).find((r: any) => r.metricId === made.rev) || {};
  ok('scorecards: December revenue is the CSV\'s own sum', near(rr.value, decRev), `${rr.value} vs ${decRev}`);
  ok('scorecards: the change is on November', near(rr.previous, novRev) && near(rr.delta, decRev - novRev));
  ok('scorecards: a twelve-period sparkline ends on December', Array.isArray(rr.spark) && rr.spark.length === 12 && near(rr.spark[11], decRev));

  await win.evaluate(() => (document.getElementById('sc-period-prev') as HTMLElement).click());
  await win.waitForTimeout(3000);
  const nov = await win.evaluate(async (pid: string) => ({
    label: document.getElementById('sc-period-label')?.textContent || '',
    res: await (window as any).hubPower.scorecardCompute(pid, scCurrent ? scCurrent.id : '', 1),
  }), ids.projectId);
  const nr = (nov.res.rows || []).find((r: any) => r.metricId === made.rev) || {};
  ok('scorecards: the period picker steps back to November, recomputed', nov.label === 'Nov 2024' && near(nr.value, novRev), nov.label);

  await win.evaluate(() => {
    const sel = document.getElementById('sc-period-select') as HTMLSelectElement;
    sel.value = 'quarter';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.waitForTimeout(3500);
  const q = await win.evaluate(async (pid: string) => ({
    label: document.getElementById('sc-period-label')?.textContent || '',
    res: await (window as any).hubPower.scorecardCompute(pid, scCurrent ? scCurrent.id : '', 0),
  }), ids.projectId);
  const qr = (q.res.rows || []).find((r: any) => r.metricId === made.rev) || {};
  ok('scorecards: a quarterly cadence reads Q4 2024 = Oct + Nov + Dec', q.label === 'Q4 2024' && near(qr.value, q4Rev), `${q.label} ${qr.value} vs ${q4Rev}`);

  // A row's detail: the line with its target and forecast, the breakdown, Alert me.
  await win.evaluate((id: string) => (document.querySelector(`#sc-table .sc-row[data-metric-id="${id}"]`) as HTMLElement | null)?.click(), made.rev);
  // Poll, not a fixed sleep: the detail's two charts wait on main's figures,
  // which take longer on a loaded runner.
  await win.waitForFunction(() => document.querySelectorAll('#sc-detail canvas').length >= 2, null, { timeout: 20_000 }).catch(() => null);
  const det = await win.evaluate(() => {
    const aside = document.getElementById('sc-detail') as HTMLElement;
    const canvases = [...aside.querySelectorAll('canvas')];
    return {
      open: !aside.hidden,
      canvases: canvases.length,
      alert: [...aside.querySelectorAll('button')].some((b) => /Alert me/.test(b.textContent || '')),
      note: (aside.querySelector('.sc-detail-note')?.textContent || ''),
      sub: [...aside.querySelectorAll('.sc-detail-sub')].map((x) => x.textContent || ''),
    };
  });
  ok('scorecards: the detail opens with a line and a breakdown', det.open && det.canvases === 2, JSON.stringify(det));
  if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'scorecard-detail.png') });
  ok('scorecards: the detail forecasts, and offers Alert me', /^Forecast /.test(det.note) && det.alert, JSON.stringify(det));
  ok('scorecards: the breakdown is by the dataset\'s top dimension', det.sub.some((t) => / by region$/.test(t)), JSON.stringify(det.sub));
  const plugin = await win.evaluate(async (arg: { pid: string; mid: string }) => {
    const d = await (window as any).hubPower.scorecardDetail(arg.pid, scCurrent ? scCurrent.id : '', arg.mid, 0);
    return (d.series.analytics || []).map((o: any) => o.kind);
  }, { pid: ids.projectId, mid: made.rev });
  ok('scorecards: the detail line carries target and forecast overlays', plugin.includes('target') && plugin.includes('forecast'), JSON.stringify(plugin));

  // The Assistant: the open scorecard is the dock's context, and its facts say what is off track.
  const ctx = await win.evaluate(() => dkContextRef());
  ok('scorecards: the dock is based on the open scorecard', ctx.kind === 'scorecard' && !!ctx.id, JSON.stringify(ctx));
  const facts = await s.app.evaluate(async (_a: unknown, arg: { pid: string; id: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const f = await req('./src/ipc/copilot.js').buildFacts(arg.pid, { kind: 'scorecard', id: arg.id });
    return f.text as string;
  }, { pid: ids.projectId, id: ctx.id });
  ok('scorecards: the Assistant\'s facts list the scorecard\'s statuses', /Scorecard: "Smoke scorecard"/.test(facts) && /Off track: /.test(facts) && /At risk: /.test(facts), facts.slice(0, 400));

  // Publish-to-folder is installed (feat/platform-depth): the menu offers it,
  // and the dialog opens with this scorecard ticked and sized as a page.
  await win.evaluate(() => (document.getElementById('sc-more') as HTMLElement).click());
  await win.waitForTimeout(400);
  const menu = await win.evaluate(() => [...document.querySelectorAll('.chart-menu .chart-menu-item')].map((b) => (b.textContent || '').trim()));
  ok('scorecards: the ⋯ menu offers a report and, with the publisher present, Publish', menu.includes('Create report…') && menu.includes('Publish…'), JSON.stringify(menu));
  await win.evaluate(() => ([...document.querySelectorAll('.chart-menu .chart-menu-item')]
    .find((b) => (b.textContent || '').trim() === 'Publish…') as HTMLElement | undefined)?.click());
  await win.waitForTimeout(3500);
  const pub = await win.evaluate((id: string) => {
    const cb = document.querySelector(`.pd-pick input[data-id="${id}"]`) as HTMLInputElement | null;
    const pages = [...document.querySelectorAll('.pd-page')].map((li) => (li.textContent || '').trim());
    return { ticked: !!cb && cb.checked, pages };
  }, ctx.id);
  ok('scorecards: Publish opens with the scorecard ticked, sized as a scorecard page',
    pub.ticked && pub.pages.some((t) => /Smoke scorecard/.test(t) && /Scorecard/.test(t)), JSON.stringify(pub));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);

  await win.evaluate(() => (document.getElementById('sc-more') as HTMLElement).click());
  await win.waitForTimeout(400);
  await win.evaluate(() => ([...document.querySelectorAll('.chart-menu .chart-menu-item')]
    .find((b) => (b.textContent || '').trim() === 'Create report…') as HTMLElement | undefined)?.click());
  await win.waitForTimeout(3000);
  const rep = await win.evaluate(async (pid: string) => {
    const w = window as any;
    const builder = !(document.getElementById('rp-builder') as HTMLElement).hidden;
    const list = await w.hub.reportsList(pid);
    const r = list.find((x: any) => x.name === 'Smoke scorecard report');
    const report = r ? await w.hub.reportsGet(pid, r.id) : null;
    if (!report) return { builder, pages: [] as string[], rows: 0, bytes: 0 };
    const pages = await buildReportPages({ projectId: pid, analysis: await reportAnalysisFor(pid, report), filters: [], report });
    const sc = pages.find((p: any) => p.kind === 'scorecard');
    const bytes = await reportBytes(pages, report);
    return { builder, pages: pages.map((p: any) => p.kind), rows: sc && sc.grid ? sc.grid.body.length : 0, bytes: bytes.base64.length };
  }, ids.projectId);
  ok('scorecards: Create report opens a report whose scorecard page is a native table, and it prints',
    rep.builder && rep.pages.includes('scorecard') && rep.rows === 2 && rep.bytes > 1000, JSON.stringify(rep));

  ok('scorecards: no renderer console errors in this section', s.errors.length === errorsBefore, s.errors.slice(errorsBefore).join('\n'));
}
