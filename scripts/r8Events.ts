// Round 8 smoke SECTION: event annotations, driven through the REAL app. Not a
// standalone smoke — scripts/smoke-round8.ts calls eventsSection(s, fx).
//
//   Seeds "Daily orders" (Sep–Dec 2023, West doubles in December) and a line
//   visual by month → Data → Events: the designed empty state → New event
//   "Holiday campaign" Nov 24 – Dec 31 through the dialog → a CSV imported
//   through the real file input → the US holiday calendar switched on → the
//   chart reply carries every event at MONTH grain (a band over Nov–Dec, the
//   launch marker on Oct, Thanksgiving on Nov) → the builder draws them, a
//   hover shows the title, Format → "Event markers" hides and restores them →
//   Insights and Key drivers say "during 'Holiday campaign'" → the report path
//   and a published dashboard carry the markers → one event deleted from its
//   row. Deletes everything it made; leaves the Data list on its Datasets tab.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis } from './smokeFixture';

const path: typeof import('path') = require('path');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');

type Win = Smoke['win'];
// Hub globals, read by bare name inside evaluate — not on window.
declare const chartInstances: { get(el: unknown): any };
declare const openSavedVisual: (id: string) => Promise<void>;
declare const selectSection: (s: string) => void;
declare const closeVisualBuilder: () => void;

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

const fill = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string }) => {
    const el = document.querySelector(a.q) as HTMLInputElement | null;
    if (!el) return false;
    el.value = a.v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, { q: sel, v: value });

/** The builder chart's events plugin, or null. */
const builderEvents = (win: Win): Promise<{ n: number; titles: string[] } | null> => win.evaluate(() => {
  const c = chartInstances.get(document.getElementById('viz-area'));
  const p = c && (c.config.plugins || []).find((x: any) => x && x.id === 'ordEvents');
  return p ? { n: p.events.length, titles: p.events.map((e: any) => e.title) } : null;
});

export async function eventsSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  // ponytail: main-side reads/writes through the same module instances main.js registered — any, as in r6Input.ts
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const store = req('./src/analysis/eventStore.js');
    if (a.fn === 'seed') {
      const rows: any[][] = [];
      const start = Date.UTC(2023, 8, 1);
      for (let d = 0; d < 122; d++) {
        const iso = new Date(start + d * 86400000).toISOString().slice(0, 10);
        rows.push([iso, 'East', 100]);
        rows.push([iso, 'West', iso >= '2023-12-01' ? 200 : 100]);
      }
      const ds = await datasets.saveDataset(a.pid, { name: 'Daily orders', sourceKind: 'csv',
        columns: [{ name: 'date', type: 'date' }, { name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], rows });
      const v = await visuals.saveVisual(a.pid, { datasetId: ds.id, name: 'Orders by month', chartType: 'line',
        encoding: { category: 'date', grain: 'month', values: [{ column: 'revenue', aggregation: 'sum' }] } });
      return { dsId: ds.id, vId: v.id };
    }
    if (a.fn === 'store') return store.load(a.pid);
    if (a.fn === 'insights') {
      const { listInsights } = req('./src/ipc/insights.js');
      return (await listInsights(a.pid, a.dsId)).map((i: any) => i.title);
    }
    if (a.fn === 'drivers') {
      const { driversFor } = req('./src/ipc/drivers.js');
      const r = await driversFor(a.pid, { datasetId: a.dsId, metric: { column: 'revenue', aggregation: 'sum' }, filters: [], compare: { mode: 'latest', column: 'date' }, path: [] });
      return r && r.ok ? { caption: r.caption, events: r.events || [] } : { error: r && r.error };
    }
    if (a.fn === 'publish') {
      const { buildDashboard } = req('./src/publish/dashboardData.js');
      const { sanitizePayload } = req('./src/publish/sanitize.js');
      const pub = await buildDashboard(a.pid, a.anId, 1);
      const card = pub && pub.sheets[0].cards.find((c: any) => c.kind === 'chart');
      const payload = card ? card.payloads[card.variants[0]] : null;
      return payload ? (sanitizePayload(payload) as any).events || null : null;
    }
    if (a.fn === 'hideEvents') {
      await visuals.updateVisual(a.pid, a.vId, { overrides: { showEvents: false } });
      return (await visuals.getVisual(a.pid, a.vId)).overrides;
    }
    if (a.fn === 'cleanup') {
      await store.save(a.pid, { events: [], calendars: [] });
      if (a.anId) await req('./src/analysis/analysis.js').deleteAnalysis(a.pid, a.anId);
      await visuals.deleteVisual(a.pid, a.vId);
      await datasets.deleteDataset(a.pid, a.dsId);
      return true;
    }
    return null;
  }, { fn, pid, ...arg }) as Promise<T>;

  const { dsId, vId } = await main<{ dsId: string; vId: string }>('seed');
  const enc = { category: 'date', grain: 'month', values: [{ column: 'revenue', aggregation: 'sum' }] };
  let anId = '';

  try {
    await openProject(win, pid);
    await win.evaluate(() => selectSection('datasets'));
    await win.waitForTimeout(800);
    await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
    await win.waitForTimeout(300);

    // ── The tab and its empty state ──────────────────────────────────────────
    ok('events: the Data page has an Events tab', await click(win, '#ds-tab-events'));
    await until(win, () => win.evaluate(() => !(document.getElementById('ev-wrap') as HTMLElement).hidden), 5000);
    ok('events: the tab is selected and its sentence is the header\'s',
      (await win.evaluate(() => document.getElementById('ds-tab-events')!.getAttribute('aria-selected'))) === 'true'
        && /Every chart with a date axis marks them/.test(await text(win, '#ds-sub')));
    ok('events: an empty project shows the designed empty state with both doors',
      await until(win, async () => (await text(win, '#ev-empty .ws-empty-h')) === 'No events yet')
        && await win.evaluate(() => !!document.getElementById('ev-empty-new')?.getClientRects().length && !!document.getElementById('ev-empty-import')?.getClientRects().length));
    ok('events: the six holiday calendars are offered, all off',
      await until(win, () => win.evaluate(() => document.querySelectorAll('#ev-cals .cm-switch').length === 6
        && !document.querySelector('#ev-cals .cm-switch-on'))));
    await shot('events-empty.png');

    // ── New event through the dialog ─────────────────────────────────────────
    ok('events: New event opens the editor', await click(win, '#ev-new') && await until(win, () => win.evaluate(() => !!document.querySelector('.ev-modal')), 5000));
    ok('events: it is a real dialog, focus on the title', await win.evaluate(() => {
      const box = document.querySelector('.ev-modal');
      return !!box && box.getAttribute('role') === 'dialog' && document.activeElement === box.querySelector('.ev-in-title');
    }));
    await fill(win, '.ev-modal .ev-in-title', 'Holiday campaign');
    await click(win, '.ev-modal .ev-kind-opt[data-kind="campaign"]');
    await fill(win, '.ev-modal .ev-in-date', '2023-11-24');
    await fill(win, '.ev-modal .ev-in-end', '2023-12-31');
    await shot('events-editor.png');
    await click(win, '.ev-modal .ev-save');
    ok('events: saving closes the dialog and lists the event',
      await until(win, () => win.evaluate(() => !document.querySelector('.ev-modal') && document.querySelectorAll('#ev-list .ev-row').length === 1)));
    const row = await text(win, '#ev-list .ev-row');
    ok('events: the row reads title, kind, dates, length and scope',
      /Holiday campaign/.test(row) && /Campaign/.test(row) && /Nov 24, 2023 – Dec 31, 2023/.test(row) && /38 days · drawn as a band/.test(row) && /All charts/.test(row), row);

    // ── CSV through the real file input ──────────────────────────────────────
    const csv = path.join(os.tmpdir(), `ordinate-events-${process.pid}.csv`);
    fs.writeFileSync(csv, 'date,title,kind\n2023-10-10,v2 launch,launch\nnot a date,Broken,other\n', 'utf8');
    await win.setInputFiles('#ev-file', csv);
    ok('events: a CSV imports its readable rows and says what it skipped',
      await until(win, async () => /Imported 1 event .*1 row skipped/.test(await text(win, '#ev-msg'))), await text(win, '#ev-msg'));
    fs.rmSync(csv, { force: true });
    ok('events: the list shows both, newest first, with kind filters',
      await until(win, () => win.evaluate(() => {
        const titles = [...document.querySelectorAll('#ev-list .ev-title')].map((b) => b.textContent);
        return JSON.stringify(titles) === JSON.stringify(['Holiday campaign', 'v2 launch']) && document.querySelectorAll('#ev-kinds .ev-pill').length === 3;
      })));

    // ── A holiday calendar ───────────────────────────────────────────────────
    await click(win, '#ev-cals .cm-switch[data-cal="US"]');
    ok('events: switching on United States stores the calendar',
      await until(win, async () => JSON.stringify((await main<any>('store')).calendars) === '["US"]'));
    const stored: any = await main('store');
    ok('events: events.json holds the two events, sanitized', stored.events.length === 2
      && stored.events.some((e: any) => e.title === 'Holiday campaign' && e.date === '2023-11-24' && e.end === '2023-12-31' && e.kind === 'campaign'));
    await shot('events-list.png');

    // ── Matched in MAIN at the chart's grain ─────────────────────────────────
    const reply: any = await win.evaluate((a: any) => (window as any).hub.computeVisualData(a.pid, a.dsId, a.enc, []), { pid, dsId, enc });
    const marks: any[] = (reply && reply.data && reply.data.events) || [];
    const find = (t: string) => marks.find((m) => m.title === t);
    ok('events: the chart is a month axis', reply && JSON.stringify(reply.data.labels) === '["2023-09","2023-10","2023-11","2023-12"]', JSON.stringify(reply && reply.data.labels));
    ok('events: the campaign is a band over Nov and Dec', !!find('Holiday campaign') && find('Holiday campaign').from === 2 && find('Holiday campaign').to === 3 && find('Holiday campaign').range === true, JSON.stringify(marks));
    ok('events: the launch is a marker on Oct', !!find('v2 launch') && find('v2 launch').from === 1 && find('v2 launch').range === false);
    ok('events: Thanksgiving 2023 (US) lands on Nov', !!find('Thanksgiving Day (US)') && find('Thanksgiving Day (US)').from === 2 && find('Thanksgiving Day (US)').when === 'Nov 23, 2023');

    // ── Drawn in the builder ─────────────────────────────────────────────────
    await win.evaluate(() => selectSection('visuals'));
    await win.waitForTimeout(600);
    await win.evaluate((id: string) => openSavedVisual(id), vId);
    ok('events: the builder chart carries the events plugin with every mark',
      await until(win, async () => ((await builderEvents(win)) || { n: 0 }).n === marks.length, 20_000), JSON.stringify(await builderEvents(win)));
    const hovered = await win.evaluate(() => {
      const c = chartInstances.get(document.getElementById('viz-area'));
      const p = (c.config.plugins || []).find((x: any) => x && x.id === 'ordEvents');
      const i = p.events.findIndex((e: any) => e.title === 'v2 launch');
      const x = c.scales.x.getPixelForValue(p.events[i].from);
      const r = (c.canvas as HTMLCanvasElement).getBoundingClientRect();
      c.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + c.chartArea.top + 9, bubbles: true }));
      return p.hovered() === p.events[i].id;
    });
    ok('events: hovering the launch icon shows its title', hovered);
    await shot('events-chart.png');

    await win.evaluate(() => (document.querySelector('.viz-builder-stage .cv-chart-menu-btn') as HTMLElement | null)?.click());
    await win.waitForTimeout(300);
    await win.evaluate(() => (document.getElementById('cm-customize-toggle') as HTMLElement | null)?.click());
    await win.evaluate(() => {
      const head = [...document.querySelectorAll('#cm-format-mount .an-sec-head')].find((h) => (h.textContent || '').trim() === 'Axes') as HTMLElement | undefined;
      head?.click();
    });
    ok('events: Format → Axes offers "Event markers", on', await until(win, () => win.evaluate(() =>
      document.querySelector('#cm-format-mount [data-fmt-key="events"]')?.getAttribute('aria-checked') === 'true')));
    await click(win, '#cm-format-mount [data-fmt-key="events"]');
    ok('events: switching it off redraws the chart without markers', await until(win, async () => (await builderEvents(win)) === null));
    await click(win, '#cm-format-mount [data-fmt-key="events"]');
    ok('events: and back on', await until(win, async () => ((await builderEvents(win)) || { n: 0 }).n === marks.length));
    await win.keyboard.press('Escape');
    await win.evaluate(() => { if (typeof closeVisualBuilder === 'function') closeVisualBuilder(); });
    await win.waitForTimeout(400);

    const ov: any = await main('hideEvents', { vId });
    ok('events: the toggle is stored on the visual, backward compatible (absent = on)', ov && ov.showEvents === false);

    // ── Insights and Key drivers name it ─────────────────────────────────────
    const titles: string[] = await main('insights', { dsId });
    ok('events: an insight about December says it happened during the campaign',
      titles.some((t) => /2023-12, during 'Holiday campaign'/.test(t)), JSON.stringify(titles));
    const dr: any = await main('drivers', { dsId });
    ok('events: Key drivers\' caption names the campaign', !!dr && /, during 'Holiday campaign'/.test(dr.caption || '') && dr.events.some((e: any) => e.title === 'Holiday campaign'), JSON.stringify(dr));

    // ── Reports and publish ──────────────────────────────────────────────────
    const rep: any = await win.evaluate((a: any) => (window as any).hubPrivacy.visualData(a.pid, a.dsId, a.enc, [], undefined, 'report'), { pid, dsId, enc });
    ok('events: the report path carries the markers into the PNG\'s chart', !!rep && rep.ok !== false && Array.isArray(rep.data.events) && rep.data.events.length === marks.length);
    anId = await seedAnalysis(app, pid, { name: 'Events publish check', sheets: [{ name: 'Sheet 1', cards: [{ type: 'visual', visualId: vId, layout: { x: 0, y: 0, w: 6, h: 4 } }] }] });
    // The visual hides its markers now (stored above), so a page must not draw them…
    const hidden: any = await main('publish', { anId });
    ok('events: a visual that hides its markers publishes none', hidden === null || (Array.isArray(hidden) && hidden.length === 0), JSON.stringify(hidden));
    await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      await req('./src/analysis/visuals.js').updateVisual(a.pid, a.vId, { overrides: {} });
    }, { pid, vId });
    const published: any = await main('publish', { anId });
    ok('events: a published dashboard carries the whitelisted markers',
      Array.isArray(published) && published.some((e: any) => e.title === 'Holiday campaign' && e.from === 2 && e.to === 3)
        && published.every((e: any) => JSON.stringify(Object.keys(e)) === '["kind","title","when","from","to","range"]'), JSON.stringify(published));

    // ── Delete from the row ──────────────────────────────────────────────────
    await win.evaluate(() => selectSection('datasets'));
    await win.waitForTimeout(500);
    await click(win, '#ds-tab-events');
    await until(win, () => win.evaluate(() => document.querySelectorAll('#ev-list .ev-row').length === 2));
    win.once('dialog', (d: any) => { void d.accept(); });
    await win.evaluate(() => {
      const r = [...document.querySelectorAll('#ev-list .ev-row')].find((x) => /v2 launch/.test(x.textContent || ''));
      (r?.querySelectorAll('.mp-actions button')[1] as HTMLElement | undefined)?.click();
    });
    ok('events: deleting a row removes it from the list and the store',
      await until(win, async () => (await win.evaluate(() => document.querySelectorAll('#ev-list .ev-row').length)) === 1
        && (await main<any>('store')).events.length === 1));
  } finally {
    await main('cleanup', { dsId, vId, anId });
    await win.evaluate(() => {
      document.querySelectorAll('.ws-modal-overlay').forEach((o) => o.remove());
      (document.getElementById('ds-tab-datasets') as HTMLElement | null)?.click();
    });
    await win.waitForTimeout(300);
  }
}
