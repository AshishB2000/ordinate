// ANALYSIS POWER, end to end in the real app — one launch, five sections.
//
//   1. analytics   — reference / target / trend / forecast overlays in the builder,
//                    a dragged line, an ⌥-click note, the caption and the facts
//   2. table calcs — "Calculate as" on a builder measure, a pivot value and a KPI card
//   3. prepare     — the new steps in the Prepare panel: previews, row counts, results
//   4. comments    — card-head threads, replies, resolve, the dashboard toggle,
//                    ⌘-click pins (drawn by section 1's plugin), Home, the report page
//   5. scorecards  — the fourth Dashboards tab: targets, statuses, the period picker,
//                    a metric's detail, the Assistant's facts, a report
//
// Each section lives in its own scripts/pw*.ts module (this file would pass the
// 800-line cap otherwise) and asserts through the shared `ok`, so one verdict
// covers them all. They run IN ORDER against ONE app on the bundled sample
// project, and later sections may rely on what earlier ones left behind. Zero
// renderer console errors across the whole run is the last assertion.
//
//   npm run build && node scripts/smoke-power.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, finishSmoke } from './smokeFixture';
import { sampleIds } from './wfStub';
import { analyticsSection } from './pwAnalytics';
import { tableCalcSection } from './pwTableCalc';
import { prepareSection } from './pwPrepare';
import { commentsSection } from './pwComments';
import { scorecardsSection } from './pwScorecards';

// The hub's chart registry (chartRender.ts), read by its bare name.
declare const chartInstances: WeakMap<Element, any>;

async function main(): Promise<void> {
  const s = await launchSmoke('power');
  try {
    const ids = await sampleIds(s);
    ok('the bundled sample project is present', !!ids.projectId && !!ids.datasetId && !!ids.dashboardId, JSON.stringify(ids));
    if (!ids.projectId) return;

    await analyticsSection(s, ids);
    await tableCalcSection(s, ids);
    await prepareSection(s, ids);
    await commentsSection(s, ids);
    // Across sections: a pinned comment (section 4) is DRAWN by the annotations
    // plugin (section 1). Pin one to the first bar of a card, then read the
    // card's live chart: the plugin is there and it was handed that pin.
    const pinned = await s.win.evaluate(async (a: { pid: string; dash: string }) => {
      const w = window as any;
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      w.selectSection('analyses');
      await w.openAnalysis(a.dash);
      await pause(3500);
      const find = () => {
        for (const el of document.querySelectorAll('#dash-grid .dash-card')) {
          const area = el.querySelector('.cv-viz-area') as HTMLElement | null;
          const chart = area ? chartInstances.get(area) : null;
          if (chart && chart.config.type === 'bar') return { card: (el as HTMLElement).dataset.cardId || '', chart };
        }
        return null;
      };
      const hit = find();
      if (!hit) return { plugin: false, pins: 0, label: '' };
      const label = String(hit.chart.data.labels[0]);
      await w.hubPower.addComment(a.pid, { kind: 'card', id: hit.card, point: { label } }, 'Pinned by the power smoke');
      await w.openAnalysis(a.dash);
      await pause(3500);
      const again = find();
      const plugin = again && (again.chart.config.plugins || []).find((p: any) => p && p.id === 'ordAnnotations');
      const pins = plugin && plugin.config ? plugin.config.pins : [];
      return { plugin: !!plugin, pins: pins.length, label, onAxis: pins.some((p: any) => again!.chart.data.labels.map(String).includes(p.label)) };
    }, { pid: ids.projectId, dash: ids.dashboardId });
    ok('comments × analytics: a pinned bar is drawn through the annotations plugin', pinned.plugin && pinned.pins >= 1 && !!(pinned as any).onAxis, JSON.stringify(pinned));
    await scorecardsSection(s, ids);

    ok('zero renderer console errors across the run', s.errors.length === 0, s.errors.slice(0, 5).join('\n'));
  } finally {
    await s.close();
  }
}

main()
  .then(() => finishSmoke('power', failureCount()))
  .catch((e) => { console.error(e); process.exit(1); });
