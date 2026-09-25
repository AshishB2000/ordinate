// ANALYSIS DEPTH, in the real app, on the bundled sample: date intelligence,
// parameters, SQL over datasets, data quality rules, and workspace formats.
//
// Every expected figure is computed HERE from the committed CSV, never written
// down and never read back from the app: a KPI that resolves correctly in a
// unit test and renders a different number on the page is exactly what this
// catches. Displayed figures are PARSED back ("2.7M" → 2.7e6) and compared
// within the display's own rounding, so the assertions hold whatever the
// workspace formats say, and a figure that is merely plausible still fails.
//
// The clock is pinned to 2024-12-31 (ORDINATE_TODAY), the last day of the
// sample's two years of orders, so "this fiscal year" (from July) is half
// elapsed — and a Compare against last year is the same half, to date.
//
//   npm run build:ts && node scripts/smoke-depth.js

export {};
import { ok, failureCount } from './selfcheck';
import { launchSmoke, REPO, finishSmoke } from './smokeFixture';

// Renderer globals read inside win.evaluate — classic-script consts, not window props.
declare const chartInstances: { get(el: unknown): any };

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const TODAY = '2024-12-31';
process.env.ORDINATE_TODAY = TODAY;

// ── The truth, folded out of the CSV ─────────────────────────────────────────

interface Row { date: string; region: string; revenue: number; profit: number; discount: number }

function sampleRows(): Row[] {
  const csv = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8');
  const lines = csv.trim().split('\n');
  const head = lines[0].split(',');
  const at = (n: string): number => head.indexOf(n);
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return {
      date: c[at('order_date')], region: c[at('region')],
      revenue: Number(c[at('revenue')]), profit: Number(c[at('profit')]), discount: Number(c[at('discount')]),
    };
  });
}
const ROWS = sampleRows();
const sumRevenue = (from: string, to: string): number =>
  ROWS.filter((r) => r.date >= from && r.date <= to).reduce((a, r) => a + r.revenue, 0);

/** "2.7M" / "$2.7M" / "€2,7 M" / "−41.2K" → a number, or NaN. */
function parseShown(text: string): number {
  const t = String(text).replace(/[\s  ]/g, '').replace(/[−–]/g, '-');
  const m = /(-?)[^\d-]*([\d.,]+)([KMB]?)/i.exec(t);
  if (!m) return NaN;
  let digits = m[2];
  // A decimal comma (de-DE, fr-FR) when the last separator is a comma followed by 1–2 digits.
  if (/,\d{1,2}$/.test(digits) && !/\.\d/.test(digits)) digits = digits.replace(/\./g, '').replace(',', '.');
  else digits = digits.replace(/,/g, '');
  const scale = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[m[3].toUpperCase() as '' | 'K' | 'M' | 'B'];
  return (m[1] ? -1 : 1) * Number(digits) * scale;
}
/** Whether `text` is `truth` at the precision it was printed with. */
function shows(text: string, truth: number): boolean {
  const v = parseShown(text);
  if (!Number.isFinite(v)) return false;
  const m = /([\d.,]+)([KMB]?)/i.exec(String(text).replace(/[\s  ]/g, ''));
  const decimals = m && /[.,](\d+)/.exec(m[1]) ? /[.,](\d+)/.exec(m[1])![1].length : 0;
  const scale = m ? ({ '': 1, K: 1e3, M: 1e6, B: 1e9 } as any)[m[2].toUpperCase()] : 1;
  return Math.abs(v - truth) <= 0.5 * Math.pow(10, -decimals) * scale + 1e-9;
}

async function main(): Promise<void> {
  const s = await launchSmoke('depth');
  const { app, win, shotDir } = s;
  const shot = (name: string) => win.screenshot({ path: path.join(shotDir, 'depth-' + name + '.png') });
  const wait = (ms: number) => win.waitForTimeout(ms);

  // ════════════════════════════════════════════════════════════════════════
  // 1. DATE INTELLIGENCE
  // ════════════════════════════════════════════════════════════════════════
  // Fiscal year from July — through Settings → General → Formats, as a user would.
  await win.evaluate(() => (window as any).showSettingsPanel('general'));
  await wait(800);
  await win.selectOption('#stp-fmt-week', '1');
  await win.selectOption('#stp-fmt-fiscal', '7');
  await wait(800);
  const calendar = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/app/config.js').get().formats;
  });
  ok('Settings → Formats saves a July fiscal year and a Monday week', calendar.fiscalYearStart === 7 && calendar.weekStart === 1,
    JSON.stringify(calendar));
  await shot('1-settings-fiscal');
  await win.evaluate(() => (window as any).hideSettingsPanel());
  await wait(400);

  const fy = { from: '2024-07-01', to: '2025-06-30' };
  // To date: today is inside this fiscal year, so last year stops at the same date.
  const fyPrev = { from: '2023-07-01', to: '2023-12-31' };
  const fyRevenue = sumRevenue(fy.from, fy.to);
  const fyPrevRevenue = sumRevenue(fyPrev.from, fyPrev.to);

  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await wait(2500);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list > *')].find((r) => /Retail overview/.test(r.textContent || ''));
    if (row) ((row.querySelector('button, a') as HTMLElement) || (row as HTMLElement)).click();
  });
  await wait(7000);

  // + Control → Date range → order_date → "This fiscal year" as its default.
  await win.click('#dash-add-control');
  await wait(1200);
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .dc-kind-tile[data-kind="date_range"]') as HTMLElement).click();
  });
  await wait(900);
  const dialog = await win.evaluate(() => {
    const cols = [...document.querySelectorAll('.dash-control-modal select')].map((s) => (s as HTMLSelectElement).value);
    const pill = [...document.querySelectorAll('.dash-control-modal .pp-pill')]
      .find((b) => (b.textContent || '').trim() === 'This fiscal year') as HTMLElement | undefined;
    pill?.click();
    return { cols, pill: !!pill };
  });
  ok('the date control dialog offers "This fiscal year" (fiscal year from July)', dialog.pill, JSON.stringify(dialog));
  ok('…with order_date picked first, because it is the date column', dialog.cols.includes('order_date'), JSON.stringify(dialog.cols));
  await wait(900);
  const resolvedLine = await win.evaluate(() => (document.querySelector('.dash-control-modal .pp-resolved')?.textContent || '').trim());
  ok('…and says which dates that is today', /This fiscal year/.test(resolvedLine) && /2024/.test(resolvedLine) && /2025/.test(resolvedLine), resolvedLine);
  await shot('1-control-dialog');
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .ws-modal-actions .btn-primary') as HTMLElement).click();
  });
  await wait(4500);

  const kpi = (label: string) => win.evaluate((want: string) => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === want);
    return {
      value: (card?.querySelector('.dash-metric-value')?.textContent || '').trim(),
      delta: (card?.querySelector('.dash-metric-delta')?.textContent || '').trim(),
      deltaClass: card?.querySelector('.dash-metric-delta')?.className || '',
      deltaVal: (card?.querySelector('.dash-metric-delta-val')?.textContent || '').trim(),
      pct: (card?.querySelector('.dash-metric-delta-pct')?.textContent || '').trim(),
      vs: (card?.querySelector('.dash-metric-vs')?.textContent || '').trim(),
      fits: !!card && [...card.querySelectorAll('.dash-metric-value, .dash-metric-delta, .dash-metric-vs')].every((el) => {
        const b = (card.querySelector('.dash-card-body') as HTMLElement).getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      }),
    };
  }, label);

  const chip = await win.evaluate(() => (document.querySelector('.dash-filter-bar .dash-ctrl-period')?.textContent || '').trim());
  ok('the filter bar carries the control, named by its preset', chip === 'This fiscal year', chip);
  const rev = await kpi('Revenue');
  ok(`the Revenue KPI is the sum over this fiscal year (${fyRevenue.toFixed(2)})`, shows(rev.value, fyRevenue),
    JSON.stringify({ shown: rev.value, truth: fyRevenue }));

  // KPI Compare — same period last year, set in the card's Properties.
  await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue');
    (card?.querySelector('.an-card-props') as HTMLElement | null)?.click();
  });
  await wait(600);
  const setCompare = await win.evaluate(() => {
    const host = document.getElementById('an-kpi-props') as HTMLElement | null;
    if (!host || host.hidden || host.getClientRects().length === 0) return false; // must be SEEN, not just present
    const sel = [...host.querySelectorAll('select')]
      .find((s) => [...(s as HTMLSelectElement).options].some((o) => o.value === 'previous_year')) as HTMLSelectElement | undefined;
    if (!sel) return false;
    sel.value = 'previous_year';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  ok('selecting the KPI card shows Compare → Same period last year in Properties', setCompare);
  await wait(4000);
  const cmp = await kpi('Revenue');
  const delta = fyRevenue - fyPrevRevenue;
  ok(`…and the delta equals this fiscal year minus last (${delta.toFixed(2)})`, shows(cmp.deltaVal, Math.abs(delta)),
    JSON.stringify({ shown: cmp.deltaVal, truth: delta }));
  ok('…as a percent too', shows(cmp.pct.replace(/[()%+]/g, ''), (delta / fyPrevRevenue) * 100), JSON.stringify(cmp));
  ok('…coloured by direction (revenue up is good)', cmp.deltaClass.includes(delta > 0 ? 'is-good' : 'is-bad'), cmp.deltaClass);
  ok('…against a named comparison', cmp.vs === 'vs same period last year', cmp.vs);
  ok('…and the figure, the delta and its comparison all fit inside the card', cmp.fits);
  await shot('1-kpi-compare');

  // Period overlay on the line chart — Build → Analytics.
  await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue by month');
    (card?.querySelector('.an-card-props') as HTMLElement | null)?.click();
  });
  await wait(900);
  await win.evaluate(() => {
    (document.querySelector('#an-tabs .an-tab[data-tab="an-tabp-build"]') as HTMLElement | null)?.click();
  });
  await wait(600);
  const overlayOn = await win.evaluate(() => {
    const sel = document.querySelector('#an-tabp-build .js-enc-overlay') as HTMLSelectElement | null;
    const row = document.querySelector('#an-tabp-build .js-enc-analytics-row') as HTMLElement | null;
    if (!sel || !row || row.hidden) return false;
    sel.value = 'previous_year';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  ok('a line chart on a date category offers Analytics → Overlay: vs previous year', overlayOn);
  await wait(5000);
  const overlay = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue by month');
    const area = card?.querySelector('.dash-viz-area') as HTMLElement | null;
    const chart = area ? chartInstances.get(area) : null;
    const cap = card?.querySelector('.viz-overlay-caption') as HTMLElement | null;
    const body = card?.querySelector('.dash-card-body') as HTMLElement | null;
    return {
      captionVisible: !!cap && !!body && cap.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1,
      caption: (card?.querySelector('.viz-overlay-caption')?.textContent || '').trim(),
      datasets: chart ? chart.data.datasets.length : 0,
      dashed: chart ? chart.data.datasets.some((d: any) => Array.isArray(d.borderDash) && d.borderDash.length) : false,
    };
  });
  // Month by month over the fiscal year so far vs the same months a year earlier.
  let cur = 0, prior = 0;
  for (const m of ['07', '08', '09', '10', '11', '12']) {
    const c = sumRevenue(`2024-${m}-01`, `2024-${m}-31`);
    const p = sumRevenue(`2023-${m}-01`, `2023-${m}-31`);
    if (c && p) { cur += c; prior += p; }
  }
  const pct = Math.round(Math.abs(((cur - prior) / prior) * 100));
  const word = cur > prior ? 'up' : 'down';
  ok('the prior year draws as a second, dashed series', overlay.datasets === 2 && overlay.dashed, JSON.stringify(overlay));
  ok('…and its caption sits inside the tile, not below it', overlay.captionVisible, JSON.stringify(overlay));
  ok(`…captioned "Revenue is ${word} ${pct}% vs the same months last year"`,
    overlay.caption === `Revenue is ${word} ${pct}% vs the same months last year`, overlay.caption);
  await shot('1-overlay');

  // ════════════════════════════════════════════════════════════════════════
  // 2. PARAMETERS
  // ════════════════════════════════════════════════════════════════════════
  // Back to every date, so the figures below depend on the parameter alone.
  await win.click('#dash-fb-clear');
  await wait(2500);

  /** Fill a field of the OPEN modal by its label text. */
  const setField = (label: string, value: string) => win.evaluate(([l, v]) => {
    const f = [...document.querySelectorAll('.ws-modal-overlay .dm-field, .ws-modal-overlay .me-field')]
      .find((x) => (x.querySelector('.dm-field-label, .me-field-label')?.textContent || '').trim() === l);
    const input = f?.querySelector('input, textarea, select') as HTMLInputElement | null;
    if (!input) return false;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [label, value] as [string, string]);
  const modalPrimary = () => win.evaluate(() => {
    const boxes = [...document.querySelectorAll('.ws-modal-overlay .ws-modal')];
    const btn = boxes[boxes.length - 1]?.querySelector('.ws-modal-actions .btn-primary') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });

  await win.click('#dash-add-control');
  await wait(1000);
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .dc-kind-tile[data-kind="parameter"]') as HTMLElement).click();
  });
  await wait(900);
  const pdOpen = await win.evaluate(() => !!document.querySelector('.pd-modal'));
  ok('+ Control → Parameter opens the parameter dialog', pdOpen);
  const filled = [
    await setField('Name', 'threshold'),
    await setField('Default', '1000'),
    await setField('Minimum', '0'),
    await setField('Maximum', '5000'),
    await setField('Step', '100'),
    await setField('Label', 'Threshold'),
  ];
  const refs = await win.evaluate(() => (document.querySelector('.pd-modal .pd-refs')?.textContent || '').trim());
  ok('…which shows how to reference it', /\[\[threshold\]\]/.test(refs) && /\{\{threshold\}\}/.test(refs), refs);
  await shot('2-param-dialog');
  ok('…and takes a name, a default, bounds and a step', filled.every(Boolean) && (await modalPrimary()), JSON.stringify(filled));
  await wait(2500);

  const slider = await win.evaluate(() => {
    const chip = document.querySelector('.dash-filter-bar .dash-fb-chip--param');
    const r = chip?.querySelector('input[type=range]') as HTMLInputElement | null;
    return { chip: !!chip, min: r?.min, max: r?.max, step: r?.step, value: r?.value,
      out: (chip?.querySelector('.dash-param-out')?.textContent || '').trim() };
  });
  ok('a bounded number parameter is a SLIDER in the filter bar', slider.chip && slider.min === '0' && slider.max === '5000'
    && slider.step === '100' && slider.value === '1000', JSON.stringify(slider));

  // revenue > [[threshold]], as a dashboard filter, through the filter dialog.
  await win.evaluate(() => {
    const btn = document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-filter"]') as HTMLElement | null;
    if (btn && !btn.classList.contains('is-on')) btn.click();
  });
  await wait(400);
  await win.click('#dash-add-filter');
  await wait(900);
  await modalPrimary(); // the only dataset
  await wait(900);
  await win.evaluate(() => {
    const open = [...document.querySelectorAll('.ws-modal-overlay')].filter((o) => (o as HTMLElement).getClientRects().length > 0);
    const sel = open[open.length - 1]?.querySelector('select') as HTMLSelectElement | null;
    if (sel) { sel.value = 'revenue'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await modalPrimary();
  await wait(1200);
  await win.evaluate(() => {
    const tab = [...document.querySelectorAll('.fd-modal .fd-tab')].find((t) => (t.textContent || '').trim() === 'Condition') as HTMLElement | undefined;
    tab?.click();
  });
  await wait(300);
  const usedParam = await win.evaluate(() => {
    const sel = document.querySelector('.fd-modal .fd-body select') as HTMLSelectElement | null;
    if (sel) { sel.value = '>'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    const chip = [...document.querySelectorAll('.fd-modal .fd-param-chip')].find((c) => /threshold/.test(c.textContent || '')) as HTMLElement | undefined;
    chip?.click();
    return !!chip;
  });
  ok('the filter dialog offers the parameter as a value', usedParam);
  await wait(300);
  const valueShown = await win.evaluate(() => (document.querySelector('.fd-modal .fd-param-val') as HTMLInputElement | null)?.value || '');
  ok('…as [[threshold]]', valueShown === '[[threshold]]', valueShown);
  await modalPrimary();
  await wait(3500);

  const chipText = await win.evaluate(() => [...document.querySelectorAll('#dash-filter-chips .dash-filter-chip-txt')].map((c) => (c.textContent || '').trim()));
  const n1000 = (1000).toLocaleString();
  ok('the filter chip names the parameter and its value', chipText.some((t) => t.includes('threshold (' + n1000 + ')')), JSON.stringify(chipText));

  // {{threshold}} in a tile title, through the card's Properties.
  await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue by category');
    (card?.querySelector('.an-card-props') as HTMLElement | null)?.click();
  });
  await wait(900);
  await win.evaluate(() => {
    (document.querySelector('#an-tabs .an-tab[data-tab="an-tabp-format"]') as HTMLElement | null)?.click();
  });
  await wait(300);
  await win.evaluate(() => {
    const input = document.querySelector('#an-props .an-prop-input') as HTMLInputElement | null; // Title
    if (input) { input.value = 'Orders over {{threshold}} by category'; input.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await wait(3500);
  const over = (t: number) => ROWS.filter((r) => r.revenue > t).reduce((a, r) => a + r.revenue, 0);
  const titles = () => win.evaluate(() => [...document.querySelectorAll('#dash-grid .dash-card-title')].map((t) => (t.textContent || '').trim()));
  const t1 = await titles();
  ok(`the tile title reads the parameter: "Orders over ${n1000} by category"`, t1.includes(`Orders over ${n1000} by category`), JSON.stringify(t1));
  const k1 = await kpi('Revenue');
  ok('the Revenue KPI is the sum of orders over 1,000', shows(k1.value, over(1000)), JSON.stringify({ shown: k1.value, truth: over(1000) }));
  await shot('2-param-1000');

  // Move the slider: both the title and the figure follow it.
  await win.evaluate(() => {
    const r = document.querySelector('.dash-filter-bar .dash-fb-chip--param input[type=range]') as HTMLInputElement | null;
    if (r) { r.value = '2500'; r.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await wait(3500);
  const n2500 = (2500).toLocaleString();
  const t2 = await titles();
  ok(`moving the slider to 2,500 updates the title`, t2.includes(`Orders over ${n2500} by category`), JSON.stringify(t2));
  const k2 = await kpi('Revenue');
  ok('…and the KPI, to the sum of orders over 2,500', shows(k2.value, over(2500)), JSON.stringify({ shown: k2.value, truth: over(2500) }));
  const chip2 = await win.evaluate(() => [...document.querySelectorAll('#dash-filter-chips .dash-filter-chip-txt')].map((c) => (c.textContent || '').trim()));
  ok('…and the filter chip', chip2.some((t) => t.includes('threshold (' + n2500 + ')')), JSON.stringify(chip2));
  const saved = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const projects = req('./src/app/projects.js');
    const p = (await projects.listProjects())[0];
    const a = (await analysis.listAnalyses(p.id)).find((x: any) => x.name === 'Retail overview');
    const full = await analysis.getAnalysis(p.id, a.id);
    return full.parameters;
  });
  ok('the slider is VIEW state: the saved default is still 1,000', Array.isArray(saved) && saved.length === 1 && saved[0].value === 1000,
    JSON.stringify(saved));
  await shot('2-param-2500');

  // ════════════════════════════════════════════════════════════════════════
  // 3. SQL OVER DATASETS
  // ════════════════════════════════════════════════════════════════════════
  // Out of the dashboard (focus mode hides the nav), onto Data → Query.
  await win.evaluate(() => {
    const back = [...document.querySelectorAll('.dash-editor-head button')].find((b) => /Back/.test(b.textContent || '')) as HTMLElement | undefined;
    back?.click();
  });
  await wait(1500);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await wait(1500);
  await win.click('#ds-tab-query');
  await wait(3000);
  const tree = await win.evaluate(() => (document.getElementById('qt-tree')?.textContent || '').replace(/\s+/g, ' '));
  ok('the Query tab lists the dataset under its name and its slug alias', /Retail orders/.test(tree) && /retail_orders/.test(tree), tree.slice(0, 200));
  await shot('3-query-empty');

  const QUERY = 'select region, sum(revenue) r from retail_orders group by 1 order by 2 desc';
  await win.evaluate((q: string) => {
    const ta = document.getElementById('qt-sql') as HTMLTextAreaElement;
    ta.value = q;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, QUERY);
  await win.click('#qt-run');
  await wait(4000);
  const grid = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#qt-grid tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()));
    return { rows, status: (document.getElementById('qt-status')?.textContent || '').trim(),
      error: !(document.getElementById('qt-error') as HTMLElement | null)?.hidden };
  });
  // The APP's aggregate for the same question — the resident query every chart uses.
  const appAgg = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const rq = req('./src/engine/residentQuery.js');
    const p = (await projects.listProjects())[0];
    const ds = (await datasets.listDatasets(p.id)).find((d: any) => d.name === 'Retail orders');
    const src = await datasets.residentSource(p.id, ds.id);
    const out = rq.aggregateResident(src, 'region', [{ column: 'revenue', aggregation: 'sum' }]);
    const pairs = out.labels.map((l: any, i: number) => [String(l), out.series[0].values[i]]);
    pairs.sort((a: any, b: any) => b[1] - a[1]);
    return { top: pairs[0], id: ds.id };
  });
  const first = grid.rows.find((r) => r.length >= 2) || [];
  ok('Run previews the result', !grid.error && grid.rows.length >= 4, JSON.stringify(grid).slice(0, 300));
  ok(`the first row is the app's own aggregate: ${appAgg.top[0]} = ${Number(appAgg.top[1]).toFixed(2)}`,
    first[0] === appAgg.top[0] && Math.abs(parseShown(first[1]) - appAgg.top[1]) < 0.01, JSON.stringify(first));
  await shot('3-query-result');

  // A text column summed is a LOUD error in the editor, never a number.
  await win.evaluate(() => {
    const ta = document.getElementById('qt-sql') as HTMLTextAreaElement;
    ta.value = 'select sum(state) from retail_orders';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await win.click('#qt-run');
  await wait(2500);
  const loud = await win.evaluate(() => ({
    shown: !(document.getElementById('qt-error') as HTMLElement).hidden,
    msg: (document.getElementById('qt-error-msg')?.textContent || '').trim(),
  }));
  ok('sum() over a text column is an error in the editor', loud.shown && /sum/i.test(loud.msg), JSON.stringify(loud));
  await shot('3-query-error');

  // Save the aggregate as a dataset — the ordinary composer path.
  await win.evaluate((q: string) => {
    const ta = document.getElementById('qt-sql') as HTMLTextAreaElement;
    ta.value = q;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, QUERY);
  await win.click('#qt-run');
  await wait(3000);
  await win.click('#qt-save');
  await wait(3500);
  await win.fill('#dc-name', 'Revenue by region (SQL)');
  await win.click('#dc-save', { timeout: 8000 });
  await wait(4500);
  const sqlSaved = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const p = (await projects.listProjects())[0];
    const list = await datasets.listDatasets(p.id);
    const row = list.find((d: any) => d.name === 'Revenue by region (SQL)');
    if (!row) return null;
    const meta = await datasets.getDatasetMeta(p.id, row.id);
    return { id: row.id, origin: meta.origin, rows: meta.rowCount, sourceKind: meta.sourceKind };
  });
  ok('Save as dataset stores a SQL origin', !!sqlSaved && sqlSaved.origin && sqlSaved.origin.kind === 'sql' && sqlSaved.origin.sql === QUERY,
    JSON.stringify(sqlSaved));
  ok('…whose dependency list names Retail orders', !!sqlSaved && Array.isArray(sqlSaved.origin.deps) && sqlSaved.origin.deps[0] === appAgg.id,
    JSON.stringify(sqlSaved && sqlSaved.origin));
  const lineage = await win.evaluate(() => (document.getElementById('ds-lineage')?.textContent || '').replace(/\s+/g, ' ').trim());
  ok('the new dataset\'s page shows its lineage: reads from Retail orders', /Retail orders/.test(lineage), lineage);
  await shot('3-lineage');

  // ════════════════════════════════════════════════════════════════════════
  // 4. DATA QUALITY RULES
  // ════════════════════════════════════════════════════════════════════════
  await win.evaluate((id: string) => { void (window as any).openSavedDataset(id); }, appAgg.id);
  await wait(3500);
  await win.click('#ds-tab-quality');
  await wait(2500);
  const emptyRules = await win.evaluate(() => ({
    add: !!document.querySelector('#dq-rules .btn-primary'),
    suggest: document.querySelectorAll('#dq-rules .dq-chip').length,
  }));
  ok('the Quality tab has a Rules section with an Add rule button', emptyRules.add, JSON.stringify(emptyRules));
  ok('…and, before any rule exists, suggestions drawn from the profile', emptyRules.suggest > 0, JSON.stringify(emptyRules));
  await shot('4-rules-empty');

  /** Add rule → a kind → a column → optional bounds → Save. */
  const addRule = async (kind: string, column: string, bounds?: { min?: string; max?: string }): Promise<boolean> => {
    await win.evaluate(() => {
      const btn = [...document.querySelectorAll('#dq-rules .btn-primary')].find((b) => /Add rule/.test(b.textContent || '')) as HTMLElement | undefined;
      btn?.click();
    });
    await wait(1200);
    await win.evaluate((k: string) => { (document.querySelector(`.dq-modal .dq-kind[data-kind="${k}"]`) as HTMLElement | null)?.click(); }, kind);
    await wait(500);
    await win.evaluate((c: string) => {
      const sel = document.querySelector('.dq-modal select') as HTMLSelectElement | null;
      if (sel) { sel.value = c; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }, column);
    await wait(700);
    if (bounds) {
      if (bounds.min !== undefined) await setField('Minimum', bounds.min);
      if (bounds.max !== undefined) await setField('Maximum', bounds.max);
    }
    await wait(1200);
    const saved = await modalPrimary();
    await wait(3000);
    return saved;
  };
  const ruleRows = () => win.evaluate(() => [...document.querySelectorAll('#dq-rules .dq-row:not(.dq-row-head)')].map((r) => ({
    cls: r.className, words: (r.querySelector('.dq-words')?.textContent || '').trim(),
  })));

  ok('add not_null(order_date)', await addRule('not_null', 'order_date'));
  ok('add range(discount, 0, 1)', await addRule('range', 'discount', { min: '0', max: '1' }));
  const both = await ruleRows();
  ok('both rules are listed, and both PASS on the sample', both.length === 2 && both.every((r) => /is-pass/.test(r.cls)), JSON.stringify(both));
  await shot('4-rules-pass');

  // Edit the range to fail: every discount above 0.1 breaks it.
  const overTenth = ROWS.filter((r) => r.discount > 0.1).length;
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('#dq-rules .dq-row')].find((r) => /discount/.test(r.textContent || ''));
    (row?.querySelector('.dq-more') as HTMLElement | null)?.click();
  });
  await wait(500);
  await win.evaluate(() => {
    const item = [...document.querySelectorAll('.dq-menu .chart-menu-item')].find((b) => /Edit rule/.test(b.textContent || '')) as HTMLElement | undefined;
    item?.click();
  });
  await wait(1200);
  await setField('Maximum', '0.1');
  await wait(1500);
  const preview = await win.evaluate(() => (document.querySelector('.dq-modal .dq-preview')?.textContent || '').trim());
  ok(`the editor previews the failure before saving (${overTenth} rows)`, preview.includes(overTenth.toLocaleString()), preview);
  await modalPrimary();
  await wait(3500);
  const after = await ruleRows();
  const failing = after.find((r) => /discount/.test(r.words));
  ok('the edited rule now FAILS', !!failing && /is-fail/.test(failing.cls), JSON.stringify(after));
  const count = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#dq-rules .dq-row')].find((r) => /discount/.test(r.textContent || ''));
    return (row?.textContent || '').replace(/\s+/g, ' ');
  });
  ok(`…on exactly ${overTenth} rows`, count.includes(overTenth.toLocaleString() + ' rows'), count);
  await shot('4-rules-fail');

  // The red dot: the dataset row…
  await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
  await wait(1500);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.click('#ds-tab-datasets');
  await wait(2500);
  const rowDot = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#ds-saved .ds-saved-item, #ds-saved [data-dataset-id], #ds-saved > *')]
      .find((r) => /Retail orders/.test(r.textContent || '') && !/Revenue by region/.test(r.textContent || ''));
    const dot = row?.querySelector('.dq-dot') as HTMLElement | null;
    return { dot: !!dot, title: dot?.title || dot?.getAttribute('aria-label') || '' };
  });
  ok('the dataset row carries a red quality dot', rowDot.dot, JSON.stringify(rowDot));
  await shot('4-row-dot');

  // …and the header of the dashboard built on it.
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await wait(2500);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list > *')].find((r) => /Retail overview/.test(r.textContent || ''));
    if (row) ((row.querySelector('button, a') as HTMLElement) || (row as HTMLElement)).click();
  });
  await wait(6000);
  const header = await win.evaluate(() => ({
    text: (document.getElementById('dash-fresh')?.parentElement?.textContent || '').replace(/\s+/g, ' ').trim(),
    flag: !!document.querySelector('.dq-dash-flag .dq-dot'),
  }));
  ok('the dashboard header says "Data quality: 1 rule failing" with a red dot', header.flag && /Data quality: 1 rule failing/.test(header.text),
    JSON.stringify(header));
  await shot('4-dash-flag');

  // ════════════════════════════════════════════════════════════════════════
  // 5. WORKSPACE FORMATS AND BRANDING
  // ════════════════════════════════════════════════════════════════════════
  // Every order in scope: the threshold slider to 0, the date control to All dates.
  await win.evaluate(() => {
    const r = document.querySelector('.dash-filter-bar .dash-fb-chip--param input[type=range]') as HTMLInputElement | null;
    if (r) { r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await wait(2500);
  await win.click('.dash-ctrl-period');
  await wait(500);
  await win.click('.pp-pop .pp-clear');
  await wait(3500);
  const total = over(0);
  const millions = String(Math.round(total / 1e5) / 10) + 'M'; // the metric's compact format: "5.2M", "5M"
  const usd = await kpi('Revenue');
  ok(`with every order in scope the Revenue KPI reads $${millions}`, usd.value === '$' + millions && shows(usd.value, total),
    JSON.stringify({ shown: usd.value, truth: total }));

  // What a primary button and a chart bar are painted in, right now.
  const paint = () => win.evaluate(() => {
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    document.body.appendChild(b);
    const button = getComputedStyle(b).backgroundColor;
    b.remove();
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => /by category/.test(c.querySelector('.dash-card-title')?.textContent || ''));
    const area = card?.querySelector('.dash-viz-area') as HTMLElement | null;
    const chart = area ? chartInstances.get(area) : null;
    let bar: number[] = [];
    if (chart) {
      const el = chart.getDatasetMeta(0).data[0];
      const r = chart.currentDevicePixelRatio || window.devicePixelRatio || 1;
      const px = chart.ctx.getImageData(Math.round(el.x * r), Math.round(((el.y + el.base) / 2) * r), 1, 1).data;
      bar = [px[0], px[1], px[2]];
    }
    return { button, bar };
  });
  /** Hue in degrees of "rgb(r, g, b)" or [r, g, b]. */
  const hue = (c: string | number[]): number => {
    const [r, g, b] = (Array.isArray(c) ? c : (c.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number)).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return NaN;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const unbranded = await paint();

  // Settings → General → Formats: currency EUR.
  await win.evaluate(() => (window as any).showSettingsPanel('general'));
  await wait(800);
  await win.selectOption('#stp-fmt-currency', 'EUR');
  await wait(1200);
  const fmtPreview = await win.evaluate(() => (document.getElementById('stp-fmt-preview')?.textContent || '').replace(/\s+/g, ' '));
  ok('the Formats preview is in euros', /€/.test(fmtPreview), fmtPreview);
  await shot('5-settings-formats');

  // Settings → Appearance → Branding: the second swatch.
  await win.evaluate(() => (window as any).selectSettingsCat('appearance'));
  await wait(500);
  await win.click('#stp-brand-swatches .sf-swatch:nth-child(2)');
  await wait(1500);
  const branding = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/app/config.js').get().branding;
  });
  ok('the second swatch saves violet as the workspace accent', branding.accent === '#7c3aed', JSON.stringify(branding));
  await shot('5-settings-branding');
  await win.evaluate(() => (window as any).hideSettingsPanel());
  await wait(3000);

  const eur = await kpi('Revenue');
  ok(`…and the Revenue KPI now reads €${millions}`, eur.value === '€' + millions, JSON.stringify(eur));
  const branded = await paint();
  const VIOLET = [245, 290];
  const isViolet = (h: number) => h >= VIOLET[0] && h <= VIOLET[1];
  ok('the primary button takes the new accent', !isViolet(hue(unbranded.button)) && isViolet(hue(branded.button)),
    JSON.stringify({ before: unbranded.button, after: branded.button }));
  ok('…and so does a chart bar', unbranded.bar.length === 3 && !isViolet(hue(unbranded.bar)) && isViolet(hue(branded.bar)),
    JSON.stringify({ before: unbranded.bar, after: branded.bar }));
  await shot('5-branded');

  // ── The end: nothing on the page threw. ─────────────────────────────────
  ok('zero renderer console errors', s.errors.length === 0, s.errors.join('\n'));
  await s.close();
  finishSmoke('depth', failureCount());
}

main().catch((err) => {
  console.error('FAIL smoke-depth crashed:', err);
  process.exit(1);
});
