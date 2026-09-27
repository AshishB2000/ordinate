// ANALYSIS ENGINES, end to end in the real app — one launch, five sections.
//
//   1. drivers    — "Why did this change?" from a KPI's Compare, a line-chart
//                   point and an alert event; the waterfall, drill, tile, the
//                   Assistant's facts and Alert me
//   2. scenarios  — the fifth Dashboards tab: drivers, KPIs beside the
//                   baseline, the tornado, compare, a KPI card's chip
//   3. segments   — Find segments from the dataset ⋯: k-means, the profile,
//                   the PCA scatter, Save as column, the RFM preset
//   4. cohorts    — the cohort and event-funnel visuals from their shelves:
//                   the triangle, the retention curve, funnel rates, captions,
//                   thumbnails and export
//   5. filters    — typed filters: the box, ⌘K's @ mode, the dock's
//                   "filter this to …" with no model call
//
// Each section lives in its own scripts/ae*.ts module (this file would pass the
// 800-line cap otherwise) and asserts through the shared `ok`, so one verdict
// covers them all. They run IN ORDER against ONE app on the bundled sample
// project. Then one check ACROSS features: a typed filter is an ordinary
// selection, so the drivers panel explains the change inside it. Zero renderer
// console errors across the whole run is the last assertion.
//
//   npm run build && node scripts/smoke-engines.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, finishSmoke } from './smokeFixture';
import { sampleIds } from './wfStub';
import { driversSection } from './aeDrivers';
import { scenariosSection } from './aeScenarios';
import { segmentsSection } from './aeSegments';
import { cohortsSection } from './aeCohorts';
import { filtersSection } from './aeFilters';

// The sample runs Jan 2023 – Dec 2024; relative periods resolve inside it.
process.env.ORDINATE_TODAY = '2024-12-31';

// Hub globals, read by bare name inside page.evaluate (classic-script lexicals).
declare const dashCurrent: any;
declare let dashSel: any[];
declare function renderDashGrid(): void;
declare function effectiveFilters(): any[];

async function main(): Promise<void> {
  const s = await launchSmoke('engines');
  try {
    const ids = await sampleIds(s);
    ok('the bundled sample project is present', !!ids.projectId && !!ids.datasetId && !!ids.dashboardId, JSON.stringify(ids));
    if (!ids.projectId) return;

    await driversSection(s, ids);
    await scenariosSection(s, ids);
    await segmentsSection(s, ids);
    await cohortsSection(s, ids);
    await filtersSection(s, ids);

    // Across features: type "west" into the filter box, turn Compare on for
    // Revenue under December, and ask Why — the question arrives scoped to
    // the typed chip, so region is spent and the totals are West's alone.
    const { win } = s;
    await win.evaluate(async (dash: string) => {
      const w = window as any;
      w.selectSection('analyses');
      await w.openAnalysis(dash);
    }, ids.dashboardId);
    await win.waitForTimeout(3000);
    const box = await win.$('#ft-input');
    ok('engines: the filter box is on the sheet', !!box);
    if (box) {
      await box.click();
      await box.fill('west');
      await win.waitForTimeout(900);
      await box.press('Enter');
      await win.waitForTimeout(1500);
    }
    const typed = await win.evaluate(() => {
      const dec = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2024-12-01', to: '2024-12-31' } };
      dashCurrent.filters = [dec];
      for (const p of dashCurrent.pages || []) {
        for (const c of p.cards || []) {
          if (c.type === 'metric' && c.metric && c.metric.column === 'revenue') c.metric.compare = { mode: 'previous_period' };
        }
      }
      renderDashGrid();
      return { sel: dashSel.map((x: any) => [x.column, x.op, x.value ?? x.values]), filters: effectiveFilters() };
    });
    ok('engines: the typed chip is an ordinary selection step', typed.sel.some((x: any) => x[0] === 'region'), JSON.stringify(typed.sel));
    await win.waitForSelector('.dash-metric-why', { timeout: 15000 }).catch(() => null);
    const why = await win.$('.dash-metric-why');
    if (why) {
      await why.click();
      await win.waitForSelector('.drv-wf-row', { timeout: 15000 }).catch(() => null);
      const scoped = await win.evaluate(async (a: { pid: string; dsid: string; filters: any[] }) => {
        const dims = [...document.querySelectorAll('.drv-dim-name')].map((d) => (d.textContent || '').trim());
        const shown = (document.querySelector('.drv-periods .is-after .drv-period-v')?.textContent || '').trim();
        const r = await (window as any).hubDrivers.explain(a.pid, {
          datasetId: a.dsid, metric: { column: 'revenue', aggregation: 'sum' }, filters: a.filters, compare: { mode: 'previous_period' },
        });
        const west = await (window as any).hub.computeMetric(a.pid, a.dsid, 'revenue', 'sum', a.filters);
        return { dims, shown, total: r && r.ok ? r.totals.a : null, text: r && r.ok ? r.totals.aText : '', west: west && west.value };
      }, { pid: ids.projectId, dsid: ids.datasetId, filters: typed.filters });
      ok('engines: inside the typed "west", region is spent — one member explains nothing', scoped.dims.length > 0 && !scoped.dims.includes('region'),
        JSON.stringify(scoped.dims));
      ok('engines: the panel\'s December figure is West\'s, the same figure the KPI computes',
        typeof scoped.total === 'number' && scoped.total === scoped.west && scoped.shown !== '', JSON.stringify(scoped));
      await win.keyboard.press('Escape');
    } else {
      ok('engines: the Revenue KPI offers Why? under the typed filter', false);
    }

    ok('zero renderer console errors across the run', s.errors.length === 0, s.errors.slice(0, 5).join('\n'));
  } finally {
    await s.close();
  }
}

main()
  .then(() => finishSmoke('engines', failureCount()))
  .catch((e) => { console.error(e); process.exit(1); });
