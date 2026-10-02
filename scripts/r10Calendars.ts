// Round 10 smoke SECTION: retail and fiscal calendars, driven through the REAL
// app. Not a standalone smoke — scripts/smoke-round10.ts calls
// calendarsSection(s, fx) on its one launch.
//
//   Seeds "Retail weeks" (Dec 2023 – Mar 2024, across NRF fiscal 2023's 53rd
//   week) and a line visual by week → Settings → General → Formats → Calendar:
//   pick Retail 4-5-4, flip the year-end rule and back, the gregorian rows hide,
//   the preview reads main's own "Today is FY.. P.. W.." and the year's length
//   → the builder's chart labels its axis FY23 P12 W5 …, exactly main's reply
//   → "This month" is named "This period" and resolves to main's 4-5-4 period
//   (Sunday to Saturday) → the original calendar is put back through the same
//   control and the stored formats match the originals exactly. Deletes the
//   visual and dataset it made; leaves the Visuals page on screen.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Hub globals, read by bare name inside evaluate — not on window.
declare const chartInstances: { get(el: unknown): any };
declare const openSavedVisual: (id: string) => Promise<void>;
declare const selectSection: (s: string) => void;
declare const closeVisualBuilder: () => void;
declare const showSettingsPanel: (cat?: string) => Promise<void>;
declare const hideSettingsPanel: () => void;
declare const periodLabel: (spec: unknown) => string;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
  }
  return false;
}

const text = (win: Win, sel: string): Promise<string> =>
  win.evaluate((q: string) => (document.querySelector(q)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

const shown = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    return !!el && el.getClientRects().length > 0;
  }, sel);

export async function calendarsSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  // ponytail: main-side reads/writes through the same module instances main.js registered — any, as in r8Events.ts
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const config = req('./src/app/config.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const di = req('./src/analysis/dateIntel.js');
    const rc = req('./src/analysis/retailCalendar.js');
    if (a.fn === 'formats') return config.get().formats;
    if (a.fn === 'seed') {
      const rows: any[][] = [];
      const start = Date.UTC(2023, 11, 3);
      for (let d = 0; d < 112; d++) rows.push([new Date(start + d * 86400000).toISOString().slice(0, 10), 10 + (d % 7)]);
      const ds = await datasets.saveDataset(a.pid, { name: 'Retail weeks', sourceKind: 'csv',
        columns: [{ name: 'day', type: 'date' }, { name: 'sales', type: 'number' }], rows });
      const v = await visuals.saveVisual(a.pid, { datasetId: ds.id, name: 'Sales by retail week', chartType: 'line',
        encoding: { category: 'day', grain: 'week', values: [{ column: 'sales', aggregation: 'sum' }] } });
      return { dsId: ds.id, vId: v.id };
    }
    if (a.fn === 'today') {
      // Main's own answer under the workspace calendar, for the preview and the preset.
      const today = di.todayIso();
      const wc = rc.activeWeekCal();
      const day = di.daysFromIso(today);
      return {
        today,
        label: wc ? rc.weekLabel(rc.bucketStartOf(day, 'week', wc), 'week', wc) : '',
        weeks: wc ? rc.weekPos(day, wc).weeks : null,
        period: di.resolvePeriod({ preset: 'this_month' }, today, di.getCalendar()),
      };
    }
    if (a.fn === 'cleanup') {
      await visuals.deleteVisual(a.pid, a.vId);
      await datasets.deleteDataset(a.pid, a.dsId);
      return true;
    }
    return null;
  }, { fn, pid, ...arg }) as Promise<T>;

  const original: any = await main('formats');
  const { dsId, vId } = await main<{ dsId: string; vId: string }>('seed');
  const enc = { category: 'day', grain: 'week', values: [{ column: 'sales', aggregation: 'sum' }] };

  try {
    await openProject(win, pid);

    // ── Settings → General → Formats → Calendar ─────────────────────────────
    await win.evaluate(() => showSettingsPanel('general'));
    ok('calendars: Settings → Formats has a Calendar control', await until(win, () => shown(win, '#stp-cal-type'), 5000));
    ok('calendars: Gregorian shows the week-start and fiscal-month rows, no year-end rule',
      await shown(win, '#stp-fmt-week') && await shown(win, '#stp-fmt-fiscal') && !(await shown(win, '#stp-cal-yearend-row')));
    await win.selectOption('#stp-cal-type', '454');
    ok('calendars: picking Retail 4-5-4 saves it', await until(win, async () => (await main<any>('formats')).calendarType === '454'));
    ok('calendars: a retail calendar asks for its year end and hides the gregorian rows',
      await until(win, async () => await shown(win, '#stp-cal-yearend-row') && !(await shown(win, '#stp-fmt-week')) && !(await shown(win, '#stp-fmt-fiscal'))));
    await click(win, '#stp-cal-yearend .stp-seg-opt[data-value="last"]');
    ok('calendars: "Last Saturday of January" saves', await until(win, async () => (await main<any>('formats')).yearEnd === 'last'));
    await click(win, '#stp-cal-yearend .stp-seg-opt[data-value="nearest"]');
    ok('calendars: back to "Saturday nearest Jan 31"', await until(win, async () => (await main<any>('formats')).yearEnd === 'nearest'));
    ok('calendars: the year-end control shows the stored rule', await until(win, () => win.evaluate(() =>
      document.querySelector('#stp-cal-yearend .stp-seg-opt.active')?.getAttribute('data-value') === 'nearest')));

    const today: any = await main('today');
    ok('calendars: main labels today in the retail shape', /^FY\d{2} P\d{2} W\d$/.test(today.label), JSON.stringify(today));
    ok('calendars: the preview reads main\'s label and the year\'s length',
      await until(win, async () => {
        const t = await text(win, '#stp-cal-preview');
        return t.includes('Today is' + today.label) && t.includes(`${today.weeks}-week year`) && /Fiscal year/.test(t);
      }), await text(win, '#stp-cal-preview'));
    await win.evaluate(() => document.getElementById('stp-cal-preview')?.scrollIntoView({ block: 'end' }));
    await shot('calendars-settings.png');
    await win.evaluate(() => hideSettingsPanel());
    await win.waitForTimeout(400);

    // ── A date axis labels in the calendar ──────────────────────────────────
    const reply: any = await win.evaluate((a: any) => (window as any).hub.computeVisualData(a.pid, a.dsId, a.enc, []), { pid, dsId, enc });
    const want: string[] = (reply && reply.data && reply.data.labels) || [];
    ok('calendars: main buckets the weeks as FY.. P.. W..', want.length > 0 && want.every((l) => /^FY\d{2} P\d{2} W\d$/.test(l)), JSON.stringify(want.slice(0, 6)));
    ok('calendars: the 53rd week of fiscal 2023 is FY23 P12 W5', want.includes('FY23 P12 W5') && want.includes('FY24 P01 W1'), JSON.stringify(want));
    await win.evaluate(() => selectSection('visuals'));
    await win.waitForTimeout(600);
    await win.evaluate((id: string) => openSavedVisual(id), vId);
    const drawnLabels = (): Promise<string[]> => win.evaluate(() => {
      const c = chartInstances.get(document.getElementById('viz-area'));
      return c && c.data && Array.isArray(c.data.labels) ? c.data.labels.map(String) : [];
    });
    ok('calendars: the builder chart draws exactly main\'s labels',
      await until(win, async () => JSON.stringify(await drawnLabels()) === JSON.stringify(want), 20_000), JSON.stringify((await drawnLabels()).slice(0, 6)));
    ok('calendars: the grain control calls a month a Period', await win.evaluate(() =>
      (document.querySelector('.js-enc-grain option[value="month"]')?.textContent || '') === 'Period'));
    await shot('calendars-chart.png');
    await win.keyboard.press('Escape');
    await win.evaluate(() => { if (typeof closeVisualBuilder === 'function') closeVisualBuilder(); });
    await win.waitForTimeout(400);

    // ── A relative preset resolves to retail boundaries ─────────────────────
    const resolved: any = await win.evaluate(() => (window as any).hub.resolvePeriod({ preset: 'this_month' }));
    const mainPeriod = today.period;
    ok('calendars: "This month" is named "This period", in main and in the picker',
      resolved && resolved.label === 'This period' && await win.evaluate(() => periodLabel({ preset: 'this_month' })) === 'This period', JSON.stringify(resolved));
    ok('calendars: and resolves to main\'s 4-5-4 period', resolved && mainPeriod && resolved.from === mainPeriod.from && resolved.to === mainPeriod.to,
      JSON.stringify({ resolved, mainPeriod }));
    const dow = (iso: string): number => new Date(iso + 'T00:00:00Z').getUTCDay();
    ok('calendars: a retail period runs Sunday to Saturday, in whole weeks', !!resolved && dow(resolved.from) === 0 && dow(resolved.to) === 6
      && [28, 35].includes((Date.parse(resolved.to) - Date.parse(resolved.from)) / 86400000 + 1), JSON.stringify(resolved));
  } finally {
    // ── Restore: the original calendar, through the same control ────────────
    await win.evaluate(() => showSettingsPanel('general')).catch(() => undefined);
    await win.waitForTimeout(500);
    await win.selectOption('#stp-cal-type', String(original.calendarType || 'gregorian')).catch(() => undefined);
    await win.evaluate((f: any) => (window as any).hub.setFormats(f), original);
    ok('calendars: the original formats are back exactly', await until(win, async () => JSON.stringify(await main('formats')) === JSON.stringify(original)),
      JSON.stringify(await main('formats')));
    ok('calendars: the gregorian rows are back on screen', await until(win, () => shown(win, '#stp-fmt-week'), 5000));
    await win.evaluate(() => hideSettingsPanel()).catch(() => undefined);
    await main('cleanup', { dsId, vId });
    await win.evaluate(() => selectSection('visuals')).catch(() => undefined);
    await win.waitForTimeout(400);
  }
}
