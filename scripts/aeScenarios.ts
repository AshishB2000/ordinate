// Smoke SECTION: what-if scenarios, end to end on the bundled sample.
//
// Not a smoke file of its own: `scenariosSection(s, ids)` runs against an app a
// smoke runner launched on a FRESH userData whose first-launch sample is
// seeded. It drives what a user does: the Scenarios tab's empty state → New
// scenario → a percent driver and a filtered driver from the Add-driver form →
// the result tiles against main's own computation (and the CSV) → the tornado →
// the dock's context and the Assistant's facts → a second scenario from a
// suggestion → Compare → a dashboard KPI card bound to the scenario, with its
// chip — and then unbound again, so later sections see the sample as shipped.
//
// The expected Revenue is computed HERE from assets/samples/retail-orders.csv,
// never read back from the app under test.

import { ok } from './selfcheck';
import { REPO, domDriver } from './smokeFixture';
import type { Smoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
type Ids = { projectId: string; datasetId: string; dashboardId: string };

// Hub globals, read by bare name inside page.evaluate (classic-script lexicals).
declare const snCurrent: { id: string; name: string; baseMetricIds: string[] } | null;
declare function dkContextRef(): { kind: string; id: string };
declare function effectiveFilters(): any[];
declare function dashParamPayload(): any[];

/** Σ of a column over the CSV rows a predicate keeps. */
function csvSum(column: string, keep: (row: Record<string, string>) => boolean = () => true): number {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  let total = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    head.forEach((h, i) => { row[h] = cells[i]; });
    if (keep(row)) total += Number(row[column]);
  }
  return total;
}

const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-6;
const pause = (win: Win, ms: number): Promise<void> => win.waitForTimeout(ms);

/** Set a <select>/<input> inside the open Add-driver form and fire its event (the form re-renders on change). */
async function setField(win: Win, selector: string, value: string, event = 'change'): Promise<boolean> {
  const done = await win.evaluate((a: { selector: string; value: string; event: string }) => {
    const el = document.querySelector('.sn-add-form ' + a.selector) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return false;
    if (el instanceof HTMLSelectElement) {
      const opt = [...el.options].find((o) => o.value === a.value || o.value.endsWith('|' + a.value));
      if (!opt) return false;
      el.value = opt.value;
    } else el.value = a.value;
    el.dispatchEvent(new Event(a.event, { bubbles: true }));
    return true;
  }, { selector, value, event });
  await pause(win, 250);
  return done;
}

async function addDriver(win: Win, column: string, value: string, filter?: { column: string; value: string }): Promise<boolean> {
  await win.evaluate(() => (document.getElementById('sn-add-open') as HTMLElement | null)?.click());
  await pause(win, 250);
  let ok1 = await setField(win, 'select[aria-label="Column the driver moves"]', column);
  if (filter) {
    ok1 = ok1 && await setField(win, 'select[aria-label="Only rows where this column"]', filter.column);
    await pause(win, 1200); // the value list is read from main
    ok1 = ok1 && await setField(win, 'select[aria-label="has this value"]', filter.value);
  }
  ok1 = ok1 && await setField(win, '#sn-add-value', value, 'input');
  const clicked = await win.evaluate(() => {
    const b = document.getElementById('sn-add-confirm') as HTMLElement | null;
    b?.click();
    return !!b;
  });
  await pause(win, 300);
  return ok1 && clicked;
}

async function ensureMetric(win: Win, name: string): Promise<void> {
  const has = await win.evaluate((n: string) => [...document.querySelectorAll('#sn-metric-chips .sn-mchip-name')].some((e) => e.textContent === n), name);
  if (has) return;
  await win.evaluate(() => (document.getElementById('sn-add-metric') as HTMLElement).click());
  await pause(win, 300);
  await win.evaluate((n: string) => ([...document.querySelectorAll('.chart-menu .chart-menu-item')]
    .find((b) => (b.textContent || '').trim() === n) as HTMLElement | undefined)?.click(), name);
  await pause(win, 1200);
}

export async function scenariosSection(s: Smoke, ids: Ids): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;
  const R = csvSum('revenue');
  const RW = csvSum('revenue', (r) => r.region === 'West');
  const P = csvSum('profit');
  const want = (R - RW) * 1.05 + RW * 1.05 * 0.97;
  ok('scenarios: the sample has West revenue to move', R > 0 && RW > 0 && RW < R);

  const metricIds: Record<string, string> = await s.app.evaluate(async (_a: unknown, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const out: Record<string, string> = {};
    for (const m of await req('./src/analysis/metrics.js').listMetrics(pid)) out[m.name] = m.id;
    return out;
  }, ids.projectId);
  ok('scenarios: the sample\'s Revenue and Margin % metrics exist', !!metricIds['Revenue'] && !!metricIds['Margin %'], JSON.stringify(metricIds));

  // ── the tab and its empty state ────────────────────────────────────────────
  const { clickExact, fillPrompt } = domDriver(win);
  await clickExact('Dashboards');
  await pause(win, 900);
  await win.evaluate(() => (document.getElementById('rp-tab-scenarios') as HTMLElement | null)?.click());
  await pause(win, 700);
  const empty = await win.evaluate(() => {
    const e = document.getElementById('sn-empty') as HTMLElement | null;
    const tab = document.getElementById('rp-tab-scenarios');
    return { shown: !!e && !e.hidden, selected: tab?.getAttribute('aria-selected') === 'true', text: e?.textContent || '', examples: e ? e.querySelectorAll('.sn-chip').length : 0 };
  });
  ok('scenarios: the fifth tab shows its empty state, with example drivers', empty.shown && empty.selected && /No scenarios yet/.test(empty.text) && empty.examples === 3, JSON.stringify(empty));
  if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'scenarios-empty.png') });

  // ── a scenario, from the UI ────────────────────────────────────────────────
  await win.evaluate(() => (document.getElementById('sn-empty-new') as HTMLElement | null)?.click());
  await pause(win, 500);
  ok('scenarios: New asks for a name', await fillPrompt('Smoke what-if'));
  await pause(win, 2500);
  const opened = await win.evaluate(() => ({
    page: !(document.getElementById('sn-page') as HTMLElement).hidden,
    tiles: document.querySelectorAll('#sn-kpis .sn-kpi').length,
    chips: document.querySelectorAll('#sn-metric-chips .sn-mchip').length,
    ideas: document.querySelectorAll('#sn-drivers .sn-idea').length,
  }));
  ok('scenarios: the new scenario opens on its metrics, with driver suggestions', opened.page && opened.tiles > 0 && opened.chips === opened.tiles && opened.ideas > 0, JSON.stringify(opened));
  await ensureMetric(win, 'Revenue');
  await ensureMetric(win, 'Margin %');

  ok('scenarios: a percent driver is added from the form', await addDriver(win, 'revenue', '5'));
  ok('scenarios: a filtered driver is added from the form', await addDriver(win, 'revenue', '-3', { column: 'region', value: 'West' }));
  await pause(win, 2500);
  const sid = await win.evaluate(() => (snCurrent ? snCurrent.id : ''));
  const rows = await win.evaluate(() => [...document.querySelectorAll('#sn-drivers .sn-drv')].map((r) => ({
    label: (r.querySelector('.sn-drv-label')?.textContent || '').trim(),
    slider: !!r.querySelector('input[type="range"]'),
  })));
  ok('scenarios: the drivers read in words, each with a slider', rows.length === 2 && rows[0].label === 'revenue +5%' && rows[1].label === 'revenue in West −3%'
    && rows.every((r) => r.slider), JSON.stringify(rows));
  if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'scenario-page.png') });

  // ── the figures: the page against main, main against the CSV ───────────────
  const main = await s.app.evaluate(async (_a: unknown, arg: { pid: string; sid: string; rev: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const rec = await req('./src/analysis/scenarios.js').getScenario(arg.pid, arg.sid);
    const res = rec ? await req('./src/analysis/scenarioResolve.js').computeScenario(arg.pid, rec) : null;
    const base = await req('./src/ipc/metrics.js').resolveMetric(arg.pid, arg.rev);
    return { res, base: base ? base.value : null, drivers: rec ? rec.drivers.map((d: any) => d.name) : [] };
  }, { pid: ids.projectId, sid, rev: metricIds['Revenue'] });
  ok('scenarios: the drivers were saved, named by main', JSON.stringify(main.drivers) === '["revenue +5%","revenue in West −3%"]', JSON.stringify(main.drivers));
  const mRev = main.res ? main.res.metrics.find((m: any) => m.metricId === metricIds['Revenue']) : null;
  const mMargin = main.res ? main.res.metrics.find((m: any) => m.metricId === metricIds['Margin %']) : null;
  ok('scenarios: the baseline is the CSV\'s revenue, and main\'s resolveMetric', !!mRev && near(mRev.baseline, R) && Object.is(mRev.baseline, main.base), JSON.stringify(mRev));
  ok('scenarios: Revenue under the drivers is the CSV arithmetic', !!mRev && near(mRev.value, want), `${mRev && mRev.value} vs ${want}`);
  ok('scenarios: Margin % recomputes over the moved revenue', !!mMargin && near(mMargin.value, P / want), `${mMargin && mMargin.value} vs ${P / want}`);
  const tiles = await win.evaluate(() => [...document.querySelectorAll('#sn-kpis .sn-kpi')].map((t) => ({
    id: (t as HTMLElement).dataset.metricId || '',
    value: (t.querySelector('.sn-kpi-value')?.textContent || '').trim(),
    base: (t.querySelector('.sn-kpi-base')?.textContent || '').trim(),
    delta: (t.querySelector('.sn-kpi-delta')?.textContent || '').trim(),
  })));
  const same = !!main.res && main.res.metrics.every((m: any) => {
    const t = tiles.find((x) => x.id === m.metricId);
    return !!t && t.value === m.display && t.base === 'Baseline ' + m.baselineDisplay && (m.delta === 0 ? t.delta === 'No change' : t.delta.startsWith(m.deltaDisplay));
  });
  ok('scenarios: every tile shows main\'s value, baseline and change', same, JSON.stringify({ tiles, main: main.res && main.res.metrics }));
  const revTile = tiles.find((t) => t.id === metricIds['Revenue']);
  ok('scenarios: the Revenue delta is up — +5% everywhere outweighs −3% in the West', !!revTile && /^\+/.test(revTile.delta) && want > R, JSON.stringify(revTile));

  // ── the tornado ────────────────────────────────────────────────────────────
  await win.evaluate((rev: string) => (document.querySelector(`#sn-kpis .sn-kpi[data-metric-id="${rev}"]`) as HTMLElement | null)?.click(), metricIds['Revenue']);
  await pause(win, 2000);
  const tor = await win.evaluate(() => [...document.querySelectorAll('#sn-tornado-body .sn-tor-row:not(.sn-tor-row--head)')].map((r) => ({
    label: (r.querySelector('.sn-tor-label')?.textContent || '').trim(),
    bars: [...r.querySelectorAll('.sn-tor-bar')].map((b) => parseFloat((b as HTMLElement).style.width) || 0),
  })));
  ok('scenarios: the tornado draws one row per driver, widest swing first', tor.length === 2 && tor[0].label === 'revenue +5%' && tor[1].label === 'revenue in West −3%', JSON.stringify(tor));
  ok('scenarios: each row has a bar each way, the Revenue one symmetric', tor.every((r) => r.bars.length === 2 && r.bars.every((w) => w > 0))
    && Math.abs(tor[0].bars[0] - tor[0].bars[1]) < 0.01 && tor[0].bars[0] > tor[1].bars[0], JSON.stringify(tor));

  // ── the Assistant ──────────────────────────────────────────────────────────
  const ctx = await win.evaluate(() => dkContextRef());
  ok('scenarios: the dock is based on the open scenario', ctx.kind === 'scenario' && ctx.id === sid, JSON.stringify(ctx));
  const facts = await s.app.evaluate(async (_a: unknown, arg: { pid: string; id: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return (await req('./src/ipc/copilot.js').buildFacts(arg.pid, { kind: 'scenario', id: arg.id })).text as string;
  }, { pid: ids.projectId, id: sid });
  ok('scenarios: the Assistant\'s facts carry the drivers and the sensitivity', /Scenario: "Smoke what-if"/.test(facts) && /revenue in West −3%/.test(facts) && /Sensitivity of "/.test(facts), facts.slice(0, 400));

  // ── a second scenario, then Compare ────────────────────────────────────────
  await win.evaluate(() => (document.getElementById('sn-back') as HTMLElement).click());
  await pause(win, 1200);
  await win.evaluate(() => (document.getElementById('sn-new-btn') as HTMLElement | null)?.click());
  await pause(win, 500);
  ok('scenarios: a second scenario is named', await fillPrompt('Smoke volume'));
  await pause(win, 2500);
  await win.evaluate(() => (document.querySelector('#sn-drivers .sn-idea') as HTMLElement | null)?.click());
  await pause(win, 1500);
  await win.evaluate(() => (document.getElementById('sn-back') as HTMLElement).click());
  await pause(win, 1200);
  const cards = await win.evaluate(() => [...document.querySelectorAll('#sn-grid .sn-card .sn-card-title')].map((t) => t.textContent || ''));
  ok('scenarios: the tab lists both scenarios as cards', cards.length === 2 && cards.includes('Smoke what-if') && cards.includes('Smoke volume'), JSON.stringify(cards));
  if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'scenarios-list.png') });
  await win.evaluate(() => (document.getElementById('sn-compare-btn') as HTMLElement | null)?.click());
  await pause(win, 3500);
  const cmp = await win.evaluate((rev: string) => {
    const view = document.getElementById('sn-compare') as HTMLElement;
    const heads = [...document.querySelectorAll('#sn-cmp-body .sn-cmp-row--head .sn-cmp-colhead')].map((h) => (h.querySelector('.sn-cmp-colname')?.textContent || '').trim());
    const row = [...document.querySelectorAll('#sn-cmp-body .sn-cmp-row:not(.sn-cmp-row--head)')]
      .find((r) => (r.querySelector('.sn-cmp-metric')?.textContent || '').trim() === 'Revenue');
    const cells = row ? [...row.querySelectorAll('.sn-cmp-val')].map((c) => (c.querySelector('.sn-cmp-num')?.textContent || c.textContent || '').trim()) : [];
    return { shown: !view.hidden, heads, cells, picked: document.querySelectorAll('#sn-cmp-pick [aria-pressed="true"]').length, rev };
  }, metricIds['Revenue']);
  const col = cmp.heads.indexOf('Smoke what-if');
  ok('scenarios: Compare shows the baseline and both scenarios as columns', cmp.shown && cmp.picked === 2 && cmp.heads.length === 3 && cmp.heads[0] === 'Baseline' && col > 0 && cmp.heads.includes('Smoke volume'), JSON.stringify(cmp));
  ok('scenarios: Compare\'s cells are the page\'s own figures', !!mRev && cmp.cells[0] === mRev.baselineDisplay && cmp.cells[col] === mRev.display, JSON.stringify({ cmp, mRev }));
  if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'scenario-compare.png') });

  // ── a dashboard KPI card, bound to the scenario ────────────────────────────
  await win.evaluate(async (dash: string) => { const w = window as any; w.selectSection('analyses'); await w.openAnalysis(dash); }, ids.dashboardId);
  await pause(win, 6000);
  const pick = async (value: string): Promise<boolean> => {
    await win.evaluate(() => {
      const card = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
        .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue');
      (card?.querySelector('.an-card-props') as HTMLElement | null)?.click();
    });
    await pause(win, 1500);
    const done = await win.evaluate((v: string) => {
      const sel = document.querySelector('#an-kpi-props select[aria-label="Show this metric under a scenario"]') as HTMLSelectElement | null;
      if (!sel || ![...sel.options].some((o) => o.value === v)) return false;
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, value);
    await pause(win, 4000);
    return done;
  };
  ok('scenarios: the Revenue card\'s Properties offer the scenario beside Compare', await pick(sid));
  const card = await win.evaluate(async (a: { pid: string; sid: string; rev: string }) => {
    const el = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue');
    const r = await (window as any).hubScenarios.card(a.pid, a.sid, a.rev, effectiveFilters(), dashParamPayload());
    return {
      chip: (el?.querySelector('.dash-metric-scn')?.textContent || '').trim(),
      value: (el?.querySelector('.dash-metric-value')?.textContent || '').trim(),
      base: el?.querySelector('.dash-metric-delta')?.getAttribute('title') || '',
      fits: (() => { const b = el?.querySelector('.dash-card-body') as HTMLElement | null; return !!b && b.scrollHeight <= b.clientHeight + 1; })(),
      main: r && r.ok ? r.display : null,
      mainBase: r && r.ok ? r.baselineDisplay : null,
    };
  }, { pid: ids.projectId, sid, rev: metricIds['Revenue'] });
  ok('scenarios: the KPI card shows the scenario chip', card.chip === 'Scenario: Smoke what-if', JSON.stringify(card));
  ok('scenarios: the card\'s figure is main\'s scenario value under the dashboard\'s filters', !!card.main && card.value === card.main && card.base === 'Baseline ' + card.mainBase, JSON.stringify(card));
  ok('scenarios: figure, change and chip fit the card without clipping', card.fits, JSON.stringify(card));
  if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'scenario-kpi-card.png') });
  const stored = await win.evaluate(async (a: { pid: string; id: string }) => {
    const an = await (window as any).hub.getAnalysis(a.pid, a.id);
    const cards = ((an && (an.sheets || an.pages)) || []).flatMap((p: any) => p.cards || []);
    const c = cards.find((x: any) => x.type === 'metric' && x.metric && x.metric.scenarioId);
    return c ? c.metric.scenarioId : '';
  }, { pid: ids.projectId, id: ids.dashboardId });
  ok('scenarios: the dashboard stored the scenario on the card', stored === sid, stored);

  ok('scenarios: back to the baseline, the chip goes', await pick(''));
  const after = await win.evaluate(() => {
    const el = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue');
    return !!el && !el.querySelector('.dash-metric-scn');
  });
  ok('scenarios: …and the card is the plain metric again', after);

  ok('scenarios: no renderer console errors in this section', s.errors.length === errorsBefore, s.errors.slice(errorsBefore).join('\n'));
}
