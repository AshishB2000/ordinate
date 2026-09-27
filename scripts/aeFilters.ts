// Smoke SECTION: typed filters, end to end on the bundled sample.
//
// Not a smoke file of its own: `filtersSection(s, ids)` runs against an app a
// runner launched (scripts/smoke-engines.ts), on a FRESH userData whose
// first-launch sample ("Retail orders" / "Retail overview") is seeded. It
// drives what a user does:
//   1. types "west technology last quarter" into the filter bar's box — the
//      popover groups what it read by column — and presses Enter: the chips
//      become real selection steps, and the Revenue KPI shows main's own
//      figure for exactly those steps (and the CSV's, independently)
//   2. types a word the parser cannot read: it stays highlighted, unguessed
//   3. ⌘K `@west` offers the filter, and Enter applies it
//   4. the dock's "filter this to furniture" applies with ZERO model calls
//
// The clock is pinned in MAIN for the section (ORDINATE_TODAY, read on every
// resolve) to 2024-12-31, inside the sample's two years, and put back after.

import { ok } from './selfcheck';
import { REPO } from './smokeFixture';
import type { Smoke } from './smokeFixture';
import { installModelStub, stubState } from './wfStub';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
type Ids = { projectId: string; datasetId: string; dashboardId: string };

const TODAY = '2024-12-31';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// Hub globals, read by bare name inside page.evaluate (classic-script lexicals).
declare let dashSel: any[];
declare const dashCurrent: any;
declare function effectiveFilters(): any[];

/** sum(revenue) over the CSV rows matching region/category in [from, to] — computed HERE, not by the app. */
function csvRevenue(region: string, category: string, from: string, to: string): number {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  const at = (n: string): number => head.indexOf(n);
  let total = 0;
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const d = c[at('order_date')];
    if (c[at('region')] === region && c[at('category')] === category && d >= from && d <= to) total += Number(c[at('revenue')]);
  }
  return total;
}

async function revenueText(win: Win): Promise<string> {
  return win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue');
    return (card?.querySelector('.dash-metric-value')?.textContent || '').trim();
  });
}

async function selection(win: Win): Promise<string[]> {
  return win.evaluate(() => dashSel.map((s: any) => JSON.stringify([s.column, s.op, s.value ?? s.values ?? s.period])));
}

async function clearSelection(win: Win): Promise<void> {
  await win.evaluate(() => {
    dashSel = [];
    (window as any).renderDashSelStrip();
    (window as any).renderDashGrid();
  });
  await win.waitForTimeout(1500);
}

async function typeInBox(win: Win, text: string): Promise<void> {
  await win.click('#ft-input');
  await win.keyboard.press(MOD + '+A');
  await win.keyboard.press('Backspace');
  await win.keyboard.type(text, { delay: 15 });
  // The debounce (120 ms) and the round trip, then the popover has painted this text.
  await win.waitForFunction((t: string) => {
    const pop = document.getElementById('ft-pop');
    return !!pop && !pop.hidden && (document.getElementById('ft-input') as HTMLInputElement).value === t
      && document.querySelectorAll('#ft-mirror .ft-tok').length > 0;
  }, text, { timeout: 15_000 });
  await win.waitForTimeout(300);
}

export async function filtersSection(s: Smoke, ids: Ids): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;
  const prevToday = await s.app.evaluate((_app: unknown, today: string) => {
    const prev = process.env.ORDINATE_TODAY ?? null;
    process.env.ORDINATE_TODAY = today;
    return prev;
  }, TODAY);
  try {
    await win.evaluate(async (a: Ids) => {
      const w = window as any;
      await w.adoptProject(a.projectId);
      w.selectSection('analyses');
      await w.openAnalysis(a.dashboardId);
    }, ids);
    await win.waitForTimeout(4000);
    await win.mouse.click(5, 300); // any click ends the sample's first-open coach-mark tour
    await win.waitForTimeout(500);

    // ── the box ──────────────────────────────────────────────────────────────
    const box = await win.evaluate(() => {
      const input = document.getElementById('ft-input') as HTMLInputElement | null;
      const bar = input?.closest('#dash-control-bar') as HTMLElement | null;
      return {
        placeholder: input?.placeholder || '',
        role: input?.getAttribute('role') || '',
        label: input?.getAttribute('aria-label') || '',
        controls: input?.getAttribute('aria-controls') || '',
        first: !!bar && !bar.hidden && bar.firstElementChild === input?.closest('.ft-box'),
        tabbablesInPopover: document.querySelectorAll('#ft-pop button, #ft-pop input, #ft-pop a[href], #ft-pop [tabindex]').length,
      };
    });
    ok('filters: the box sits at the start of the filter bar, a named combobox with the example placeholder',
      box.first && box.role === 'combobox' && !!box.label && box.controls === 'ft-list'
      && box.placeholder === 'Filter… e.g. west technology last quarter' && box.tabbablesInPopover === 0, JSON.stringify(box));

    const before = await revenueText(win);
    await win.click('#ft-input');
    await win.waitForSelector('#ft-list [role="option"]', { timeout: 10_000 });
    if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'filters-empty.png') });
    const empty = await win.evaluate(() => [...document.querySelectorAll('#ft-list .ft-opt-label')].map((e) => (e.textContent || '').trim()));
    ok('filters: focused and empty, the popover offers examples from this dashboard\'s own values',
      empty.length >= 3 && empty.includes('last quarter'), JSON.stringify(empty));

    // ── 1. type, read the grouped suggestions, Enter ───────────────────────────
    await typeInBox(win, 'west technology last quarter');
    const pop = await win.evaluate(() => {
      const input = document.getElementById('ft-input') as HTMLInputElement;
      const active = input.getAttribute('aria-activedescendant') || '';
      return {
        groups: [...document.querySelectorAll('#ft-list .ft-group')].map((g) => ({
          head: (g.querySelector('.ft-group-h')?.textContent || '').trim(),
          role: g.getAttribute('role'),
          chosen: [...g.querySelectorAll('.ft-opt.is-chosen .ft-opt-label')].map((e) => (e.textContent || '').trim()),
          tags: [...g.querySelectorAll('.ft-tag')].map((e) => (e.textContent || '').trim()),
        })),
        unknown: document.querySelectorAll('#ft-mirror .ft-tok--unknown').length,
        expanded: input.getAttribute('aria-expanded'),
        activeOk: !!active && document.getElementById(active)?.getAttribute('aria-selected') === 'true',
        foot: (document.querySelector('#ft-foot .ft-keys')?.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    });
    // The sample has two date columns — order_date and the "Month" field — so
    // the date is offered on both, applied to the first.
    ok('filters: suggestions are grouped by column — region, category, order_date, and Month as the alternative',
      JSON.stringify(pop.groups.map((g) => g.head)) === '["region","category","order_date","Month"]' && pop.groups.every((g) => g.role === 'group'), JSON.stringify(pop.groups));
    ok('filters: each group shows what it read, tagged by how; the alternative is offered, not applied',
      JSON.stringify(pop.groups.map((g) => g.chosen[0] || '')) === '["West","Technology","Last quarter",""]'
      && pop.groups[0].tags[0] === 'exact' && pop.groups[2].tags[0] === 'date' && pop.groups[3].tags[0] === 'date', JSON.stringify(pop.groups));
    ok('filters: nothing is unknown, the combobox is expanded and its active option is announced',
      pop.unknown === 0 && pop.expanded === 'true' && pop.activeOk && /apply 3 filters/.test(pop.foot), JSON.stringify(pop));
    if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'filters-popover.png') });

    await win.keyboard.press('Enter');
    await win.waitForFunction(() => dashSel.length === 3, undefined, { timeout: 10_000 });
    await win.waitForTimeout(3500);
    const applied = await win.evaluate(() => ({
      sel: dashSel.map((x: any) => ({ ...x })),
      inEffective: dashSel.every((x: any) => effectiveFilters().includes(x)),
      strip: [...document.querySelectorAll('#dash-sel-strip .dash-sel-chip-txt')].map((e) => (e.textContent || '').trim()),
      input: (document.getElementById('ft-input') as HTMLInputElement).value,
      open: !(document.getElementById('ft-pop') as HTMLElement).hidden,
      metricId: ((dashCurrent.pages || []).flatMap((p: any) => p.cards || [])
        .find((c: any) => c.type === 'metric' && c.metric && c.metric.label === 'Revenue') || { metric: {} }).metric.metricId || '',
    }));
    ok('filters: Enter made the chips ordinary selection steps — region, category, a relative period',
      JSON.stringify(applied.sel) === JSON.stringify([
        { type: 'filter', column: 'region', op: '=', value: 'West' },
        { type: 'filter', column: 'category', op: '=', value: 'Technology' },
        { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'last_quarter' } },
      ]) && applied.inEffective, JSON.stringify(applied.sel));
    ok('filters: they show as removable chips in the selection strip, and the box is cleared',
      JSON.stringify(applied.strip) === '["region = West","category = Technology","order_date: Last quarter"]'
      && applied.input === '' && !applied.open, JSON.stringify(applied));

    if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'filters-applied.png') });
    const after = await revenueText(win);
    const main = await s.app.evaluate(async (_app: unknown, a: { pid: string; metricId: string; filters: any[] }) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const r = await req('./src/ipc/metrics.js').resolveMetric(a.pid, a.metricId, { filters: a.filters });
      return r ? { value: r.value, display: r.display } : null;
    }, { pid: ids.projectId, metricId: applied.metricId, filters: applied.sel });
    const want = csvRevenue('West', 'Technology', '2024-07-01', '2024-09-30'); // last quarter on 2024-12-31
    ok('filters: the Revenue KPI changed to main\'s own figure for exactly those steps',
      !!main && after === main.display && after !== before && after !== '…', JSON.stringify({ before, after, main }));
    ok('filters: …which is the CSV\'s West · Technology · Jul–Sep 2024 revenue', !!main && Math.abs((main.value as number) - want) < 1e-6,
      JSON.stringify({ main: main && main.value, want }));

    // ── 2. an unknown word stays highlighted ─────────────────────────────────
    await typeInBox(win, 'west blorp');
    const unk = await win.evaluate(() => ({
      mirror: [...document.querySelectorAll('#ft-mirror .ft-tok--unknown')].map((e) => e.textContent),
      listed: [...document.querySelectorAll('#ft-foot .ft-unknown-w')].map((e) => e.textContent),
      chosen: [...document.querySelectorAll('#ft-list .ft-opt.is-chosen .ft-opt-label')].map((e) => (e.textContent || '').trim()),
    }));
    ok('filters: an unknown word stays highlighted in the box and is listed, not guessed',
      JSON.stringify(unk.mirror) === '["blorp"]' && JSON.stringify(unk.listed) === '["blorp"]' && JSON.stringify(unk.chosen) === '["West"]', JSON.stringify(unk));
    if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'filters-unknown.png') });
    await win.keyboard.press('Escape');
    const closed = await win.evaluate(() => (document.getElementById('ft-input') as HTMLInputElement).getAttribute('aria-expanded'));
    ok('filters: Escape closes the popover', closed === 'false', String(closed));
    await win.keyboard.press(MOD + '+A');
    await win.keyboard.press('Backspace');

    // ── 3. ⌘K `@west` ────────────────────────────────────────────────────────
    await clearSelection(win);
    await win.mouse.click(5, 300);
    await win.keyboard.press(MOD + '+K');
    await win.waitForSelector('#cp-input', { state: 'visible', timeout: 10_000 });
    await win.fill('#cp-input', '@west');
    await win.waitForFunction(() => [...document.querySelectorAll('#cp-results .cp-row-title')].some((e) => (e.textContent || '').trim() === 'region = West'),
      undefined, { timeout: 10_000 });
    const cp = await win.evaluate(() => ({
      group: (document.querySelector('#cp-results .cp-group')?.textContent || '').trim(),
      first: (document.querySelector('#cp-results .cp-row.is-sel .cp-row-title')?.textContent || '').trim(),
    }));
    ok('filters: ⌘K "@west" offers the filter on the open dashboard', cp.group === 'Filter Retail overview' && cp.first === 'region = West', JSON.stringify(cp));
    await win.keyboard.press('Enter');
    await win.waitForTimeout(1500);
    const viaPalette = await selection(win);
    ok('filters: …and Enter applies it', JSON.stringify(viaPalette) === JSON.stringify([JSON.stringify(['region', '=', 'West'])]), JSON.stringify(viaPalette));

    // ── 4. the dock, with no model ───────────────────────────────────────────
    await clearSelection(win);
    const stub = await installModelStub(s); // resets the stub's record: asked = [], net = 0
    ok('filters: the model stub is installed and the Assistant is ready', stub.ready);
    await win.evaluate(async () => {
      const w = window as any;
      w.dkSetOpen(true);
      await w.dkRefresh();
      const input = document.getElementById('dk-input') as HTMLTextAreaElement;
      input.value = 'filter this to furniture';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await win.focus('#dk-input');
    await win.keyboard.press('Enter');
    await win.waitForFunction(() => [...document.querySelectorAll('#dk-messages .xp-msg-assistant .xp-bubble')]
      .some((b) => /Filtered/.test(b.textContent || '')), undefined, { timeout: 15_000 });
    await win.waitForTimeout(1500);
    const dock = await win.evaluate(() => {
      const bubbles = [...document.querySelectorAll('#dk-messages .xp-msg-assistant')];
      const last = bubbles[bubbles.length - 1];
      return {
        text: (last?.querySelector('.xp-bubble')?.textContent || '').trim(),
        prov: (last?.querySelector('.xp-provenance')?.textContent || '').trim(),
        sel: dashSel.map((x: any) => JSON.stringify([x.column, x.op, x.value])),
      };
    });
    const st = await stubState(s);
    ok('filters: the dock\'s "filter this to furniture" applied category = Furniture',
      JSON.stringify(dock.sel) === JSON.stringify([JSON.stringify(['category', '=', 'Furniture'])]), JSON.stringify(dock));
    ok('filters: …answered by an app-written bubble naming the chip', /category = Furniture/.test(dock.text) && /no model/.test(dock.prov), JSON.stringify(dock));
    ok('filters: …with ZERO model calls and no network', st.asked.length === 0 && st.net === 0, JSON.stringify({ asked: st.asked.length, net: st.net }));
    await win.evaluate(() => { (window as any).dkSetOpen(false); });
    await clearSelection(win);

    const errors = s.errors.slice(errorsBefore);
    ok('filters: no renderer console errors in this section', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
  } finally {
    await s.app.evaluate((_app: unknown, prev: string | null) => {
      if (prev === null) delete process.env.ORDINATE_TODAY;
      else process.env.ORDINATE_TODAY = prev;
    }, prevToday);
  }
}
