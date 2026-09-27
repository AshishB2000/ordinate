// Smoke SECTION: the cohort and event-funnel visuals, end to end in the REAL app.
//
// Not a smoke file of its own: `cohortsSection(s, ids)` runs against an app a
// smoke runner launched, on the bundled sample project. The sample's "Retail
// orders" has no entity id and no event name, so a small, deterministic event
// log is seeded through the ordinary main-process save path first.
//
// It drives the builder the way a user does — "+ More" → Cohort, the shelves,
// the Retention-curve toggle; "+ More" → Event funnel, steps picked from the
// event column's own values, the window, a breakdown — and holds every figure
// on screen to MAIN's own computation of the same dataset (the JS reference,
// asked in the main process), never to numbers written down here. Then it
// saves both, checks their gallery thumbnails and captions, and runs an export.

import { ok } from './selfcheck';
import { domDriver } from './smokeFixture';
import type { Smoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
type Ids = { projectId: string; datasetId: string; dashboardId: string };

// Hub globals, read by bare name inside page.evaluate. `Chart` is the UMD global.
declare const Chart: any;
declare function engineReportGrid(type: string, data: any, maxRows: number): { head: string[][]; body: string[][] } | null;

const DATASET = 'Product events';
const COHORT_ENC = { entity: 'user', date: 'ts', grain: 'month', show: 'retention', curve: false };
const FUNNEL_ENC = { entity: 'user', event: 'event', time: 'ts', steps: ['signup', 'activate', 'purchase'], window: { n: 14, unit: 'days' } };

/** 60 users over four months: signups, activations, purchases and return visits. */
function eventLog(): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = [];
  const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const DAY = 86_400_000;
  for (let i = 0; i < 60; i += 1) {
    const user = `u${String(i).padStart(3, '0')}`;
    const plan = ['free', 'pro', 'team'][i % 3];
    const t0 = Date.UTC(2024, 0, 3, 9) + i * 2 * DAY;
    rows.push([user, 'signup', stamp(t0), 0, plan]);
    if (i % 5 !== 0) rows.push([user, 'activate', stamp(t0 + (1 + (i % 4)) * 6 * 3_600_000), 0, plan]);
    if (i % 3 !== 2) rows.push([user, 'purchase', stamp(t0 + (1 + (i % 7)) * 2 * DAY), 20 + (i % 5) * 10, plan]);
    for (let m = 1; m <= 3; m += 1) if ((i + m) % 3 !== 0) rows.push([user, 'visit', stamp(t0 + m * 30 * DAY), 0, plan]);
  }
  rows.push(['u000', 'signup', stamp(Date.UTC(2024, 0, 3, 9)), 0, 'free']); // an exact duplicate
  return rows;
}

async function openBuilder(win: Win): Promise<boolean> {
  const { clickExact, clickId } = domDriver(win);
  await clickExact('Visuals');
  await win.waitForTimeout(900);
  if (!(await clickId('viz-new-btn'))) return false;
  await win.waitForTimeout(900);
  const picked = await win.evaluate((name: string) => {
    const row = [...document.querySelectorAll('.vn-row')].find((x) => (x.textContent || '').includes(name)) as HTMLElement | undefined;
    const manual = document.querySelector('.js-vn-manual') as HTMLElement | null;
    if (!row || !manual) return false;
    row.click();
    manual.click();
    return true;
  }, DATASET);
  if (!picked) return false;
  await win.waitForTimeout(2500);
  return win.evaluate(() => (document.getElementById('viz-builder') as HTMLElement).hidden === false);
}

/** Pick a chart type through the picker the user has: a chip, or "+ More". */
async function pickType(win: Win, label: string): Promise<boolean> {
  const direct = await win.evaluate((l: string) => {
    const chip = [...document.querySelectorAll('#viz-switcher-mount .cv-viz-chip')].find((b) => (b.textContent || '').trim() === l) as HTMLElement | undefined;
    if (chip) { chip.click(); return true; }
    const more = [...document.querySelectorAll('#viz-switcher-mount button')].find((b) => /More/i.test(b.textContent || '')) as HTMLElement | undefined;
    if (more) more.click();
    return false;
  }, label);
  if (!direct) {
    await win.waitForTimeout(500);
    const tile = await win.evaluate((l: string) => {
      const t = [...document.querySelectorAll('.cv-more-panel .cv-more-item')].find((b) => (b.textContent || '').trim() === l) as HTMLElement | undefined;
      if (!t) return false;
      t.click();
      return true;
    }, label);
    if (!tile) return false;
  }
  await win.waitForTimeout(2500);
  return true;
}

const setSelect = (win: Win, id: string, value: string): Promise<boolean> => win.evaluate((a: { id: string; value: string }) => {
  const s = document.getElementById(a.id) as HTMLSelectElement | null;
  if (!s || ![...s.options].some((o) => o.value === a.value)) return false;
  s.value = a.value;
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, { id, value });

/** Main's own answer for the seeded dataset — the JS reference, in the main process. */
async function mainAnswer(s: Smoke, pid: string, did: string, enc: any): Promise<any> {
  return s.app.evaluate(async (_e, a: { pid: string; did: string; enc: any }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const ds = await req('./src/data/datasets.js').getDataset(a.pid, a.did);
    const visuals = req('./src/analysis/visuals.js');
    const r = req('./src/analysis/engineViz.js').engineVizData(ds.columns, ds.rows, visuals.sanitizeEncoding(a.enc), []);
    const caps = req('./src/analysis/captions.js');
    const fe = req('./src/analysis/funnelEvents.js');
    const f = r.data.eventFunnel;
    return {
      data: r.data,
      caption: caps.tileCaption({ chartType: r.data.cohort ? 'cohort' : 'event_funnel', data: r.data }),
      durations: f ? f.medianMs.map((m: number | null) => fe.durationText(m)) : [],
    };
  }, { pid, did, enc });
}

const pct1 = (v: number): string => `${Math.round(v * 10) / 10}%`;

async function waitFor(win: Win, selector: string, ms = 20_000): Promise<boolean> {
  return win.waitForFunction((sel: string) => !!document.querySelector(sel), selector, { timeout: ms }).then(() => true, () => false);
}

async function saveAs(win: Win, name: string): Promise<boolean> {
  const { clickId, fillPrompt } = domDriver(win);
  if (!(await clickId('viz-save-btn'))) return false;
  await win.waitForTimeout(700);
  const done = await fillPrompt(name);
  await win.waitForTimeout(2500);
  return done;
}

async function galleryCard(win: Win, name: string, label: string): Promise<{ labelled: boolean; thumb: boolean }> {
  await win.waitForFunction((n: string) => {
    const card = [...document.querySelectorAll('.viz-card')].find((c) => (c.textContent || '').includes(n));
    return !!card && !!card.querySelector('.viz-card-tile--thumb canvas');
  }, name, { timeout: 15_000 }).catch(() => { /* asserted below */ });
  return win.evaluate((a: { n: string; l: string }) => {
    const card = [...document.querySelectorAll('.viz-card')].find((c) => (c.textContent || '').includes(a.n));
    return {
      labelled: !!card && (card.textContent || '').includes(a.l),
      thumb: !!card && !!card.querySelector('.viz-card-tile--thumb canvas'),
    };
  }, { n: name, l: label });
}

export async function cohortsSection(s: Smoke, ids: Ids): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;

  // ── Seed the event log through the ordinary save path ────────────────────
  const seeded: { datasetId: string; rowCount: number } = await s.app.evaluate(async (_e, a: { pid: string; name: string; rows: any[] }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const ds = await datasets.saveDataset(a.pid, {
      name: a.name, sourceKind: 'csv', rows: a.rows,
      columns: [{ name: 'user', type: 'text' }, { name: 'event', type: 'text' }, { name: 'ts', type: 'date' },
        { name: 'value', type: 'number' }, { name: 'plan', type: 'text' }],
    });
    return { datasetId: ds ? ds.id : '', rowCount: ds ? ds.rowCount : 0 };
  }, { pid: ids.projectId, name: DATASET, rows: eventLog() });
  ok('cohorts: an event log is seeded through datasets.saveDataset', !!seeded.datasetId && seeded.rowCount > 150, JSON.stringify(seeded));
  if (!seeded.datasetId) return;

  // ── Build a cohort from the shelves ───────────────────────────────────────
  ok('cohorts: the builder opens on the event log', await openBuilder(win));
  ok('cohorts: "+ More" offers Cohort', await pickType(win, 'Cohort'));
  const shelves = await win.evaluate(() => {
    const box = document.getElementById('ws-visuals') as HTMLElement;
    const panel = [...box.querySelectorAll('.eb-panel')].find((p) => !(p as HTMLElement).hidden) as HTMLElement | undefined;
    const cat = box.querySelector('.viz-build-row[data-well="category"]') as HTMLElement | null;
    const filters = box.querySelector('.js-enc-filters-row') as HTMLElement | null;
    return {
      labels: panel ? [...panel.querySelectorAll('.viz-field-label')].map((l) => (l.textContent || '').trim()) : [],
      chartFieldsHidden: !!cat && cat.hidden, filtersShown: !!filters && !filters.hidden,
      dateOptions: [...(document.getElementById('eb-c-date') as HTMLSelectElement).options].map((o) => o.value).filter(Boolean),
      valueOptions: [...(document.getElementById('eb-c-value') as HTMLSelectElement).options].map((o) => o.value).filter(Boolean),
    };
  });
  ok('cohorts: the cohort shelves replace Category/Measures, Filters stays',
     shelves.labels.join('|') === 'Entity|Event date|Value|Grain|Show|Retention curve' && shelves.chartFieldsHidden && shelves.filtersShown,
     JSON.stringify(shelves));
  ok('cohorts: shelves only offer suitable columns (dates for the date, numbers for a value)',
     shelves.dateOptions.join() === 'ts' && shelves.valueOptions.join() === 'value', JSON.stringify(shelves));
  ok('cohorts: entity and event date set from the shelves',
     (await setSelect(win, 'eb-c-entity', 'user')) && (await setSelect(win, 'eb-c-date', 'ts')));
  await win.waitForTimeout(2200);
  ok('cohorts: the heatmap renders as a <table>', await waitFor(win, '#viz-area .ch-table tbody tr'));

  const want = await mainAnswer(s, ids.projectId, seeded.datasetId, { category: 'ts', values: [], cohort: COHORT_ENC });
  const grid = want.data.cohort;
  const shown = await win.evaluate(() => {
    const t = document.querySelector('#viz-area .ch-table') as HTMLElement;
    return {
      head: [...t.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim()),
      rows: [...t.querySelectorAll('tbody tr')].map((tr) => ({
        label: (tr.querySelector('th')?.textContent || '').trim(),
        size: (tr.querySelector('.ch-size')?.textContent || '').trim(),
        cells: [...tr.querySelectorAll('.ch-cell')].map((td) => (td.classList.contains('is-blank') ? null : (td.textContent || '').trim())),
      })),
      shaded: [...t.querySelectorAll('tbody .ch-cell')].some((td) => !!(td as HTMLElement).style.backgroundColor),
    };
  });
  ok('cohorts: the cohorts and their sizes are main\'s',
     JSON.stringify(shown.rows.map((r) => r.label)) === JSON.stringify(grid.cohorts)
     && JSON.stringify(shown.rows.map((r) => Number(r.size))) === JSON.stringify(grid.sizes),
     JSON.stringify({ shown: shown.rows.map((r) => [r.label, r.size]), main: [grid.cohorts, grid.sizes] }));
  const cellsMatch = shown.rows.every((r, i) => r.cells.length === grid.periods
    && r.cells.every((c, k) => (grid.cells[i][k] == null ? c === null : c === pct1(grid.cells[i][k]))));
  ok('cohorts: every cell is main\'s figure, and the triangle is blank past the data', cellsMatch
     && shown.rows[shown.rows.length - 1].cells.some((c) => c === null) && shown.rows[0].cells.every((c) => c !== null),
     JSON.stringify(shown.rows.slice(-2)));
  ok('cohorts: cells are shaded from the theme ramp', shown.shaded);
  ok('cohorts: the header names each period', shown.head[2] === 'Month 0' && shown.head.length === grid.periods + 2, shown.head.join());

  // ── The retention-curve toggle ────────────────────────────────────────────
  ok('cohorts: the Retention curve toggle is on the shelf', await win.evaluate(() => {
    const cb = document.querySelector('#ws-visuals .eb-check input') as HTMLInputElement | null;
    if (!cb) return false;
    cb.click();
    return cb.checked;
  }));
  await win.waitForTimeout(2500);
  const curve = await win.evaluate(() => {
    const canvas = document.querySelector('#viz-area .ch-curve canvas') as HTMLCanvasElement | null;
    const chart = canvas ? Chart.getChart(canvas) : null;
    if (!chart) return null;
    const sets = chart.data.datasets.map((d: any) => ({ label: d.label, width: d.borderWidth }));
    return { type: chart.config.type, sets };
  });
  const avg = curve ? curve.sets.find((x: any) => x.label === 'Average') : null;
  ok('cohorts: the curve draws one line per cohort plus the average',
     !!curve && curve.type === 'line' && curve.sets.length === grid.cohorts.length + 1
     && JSON.stringify(curve.sets.slice(0, -1).map((x: any) => x.label)) === JSON.stringify(grid.cohorts), JSON.stringify(curve));
  ok('cohorts: …with the average drawn bold', !!avg && avg.width > Math.max(...curve!.sets.filter((x: any) => x !== avg).map((x: any) => x.width)));
  ok('cohorts: the view\'s own Table button switches back', await win.evaluate(async () => {
    const b = [...document.querySelectorAll('#viz-area .ch-wrap .eng-seg-btn')].find((x) => (x.textContent || '').trim() === 'Table') as HTMLElement | undefined;
    if (!b) return false;
    b.click();
    await new Promise((r) => setTimeout(r, 300));
    return !!document.querySelector('#viz-area .ch-table') && b.getAttribute('aria-pressed') === 'true';
  }));

  const typeset = await win.evaluate(async (a: { pid: string; did: string; enc: any }) => {
    const r = await (window as any).hub.computeVisualData(a.pid, a.did, a.enc, []); // any: the preload bridge is a renderer global
    const g = engineReportGrid('cohort', r.data, 40);
    return g ? { head: g.head[0], rows: g.body.length } : null;
  }, { pid: ids.projectId, did: seeded.datasetId, enc: { category: 'ts', values: [], cohort: COHORT_ENC } });
  ok('cohorts: a report page typesets the table (export path)', !!typeset && typeset.head[0] === 'Cohort'
     && typeset.rows === grid.cohorts.length + 1, JSON.stringify(typeset));

  ok('cohorts: saving it', await saveAs(win, 'Signup cohorts'));
  const cCard = await galleryCard(win, 'Signup cohorts', 'Cohort');
  ok('cohorts: the gallery card is labelled Cohort and carries a live thumbnail', cCard.labelled && cCard.thumb, JSON.stringify(cCard));
  ok('cohorts: the caption is main\'s sentence about the triangle',
     /^Month-\d retention averages [\d.]+%; the \d{4}-\d{2} cohort retains best at [\d.]+%$/.test(want.caption), want.caption);

  // ── Build an event funnel ─────────────────────────────────────────────────
  ok('funnel: the builder opens again', await openBuilder(win));
  ok('funnel: "+ More" offers Event funnel', await pickType(win, 'Event funnel'));
  ok('funnel: an empty funnel shows what it still needs, not a blank box', await waitFor(win, '#viz-area .eng-empty .eng-empty-title'));
  ok('funnel: entity, event name and timestamp from the shelves',
     (await setSelect(win, 'eb-f-entity', 'user')) && (await setSelect(win, 'eb-f-event', 'event')) && (await setSelect(win, 'eb-f-time', 'ts')));
  await win.waitForTimeout(1200);
  for (const step of ['activate', 'signup', 'purchase']) {
    await win.evaluate(() => (document.querySelector('#ws-visuals .eb-add') as HTMLElement).click());
    await win.waitForTimeout(700);
    ok(`funnel: step "${step}" is picked from the column's own values`, await win.evaluate((v: string) => {
      const b = [...document.querySelectorAll('.project-card-popup button')].find((x) => (x.textContent || '').trim() === v) as HTMLElement | undefined;
      if (!b) return false;
      b.click();
      return true;
    }, step));
    await win.waitForTimeout(900);
  }
  ok('funnel: steps reorder — "signup" moves ahead of "activate"', await win.evaluate(async () => {
    const up = [...document.querySelectorAll('#ws-visuals .eb-step .eb-move')].find((b) => (b.getAttribute('aria-label') || '') === 'Move signup earlier') as HTMLElement | undefined;
    if (!up) return false;
    up.click();
    await new Promise((r) => setTimeout(r, 200));
    return [...document.querySelectorAll('#ws-visuals .eb-step .enc-pill-name')].map((n) => n.textContent).join('>') === 'signup>activate>purchase';
  }));
  ok('funnel: a 14-day window', await win.evaluate(() => {
    const n = document.getElementById('eb-f-window') as HTMLInputElement;
    n.value = '14';
    n.dispatchEvent(new Event('change', { bubbles: true }));
    return n.value === '14';
  }));
  await win.waitForTimeout(2500);
  ok('funnel: the steps render', await waitFor(win, '#viz-area .ef-steps .ef-step'));

  const fWant = await mainAnswer(s, ids.projectId, seeded.datasetId, { category: 'event', values: [], eventFunnel: FUNNEL_ENC });
  const f = fWant.data.eventFunnel;
  const fShown = await win.evaluate(() => [...document.querySelectorAll('#viz-area .ef-step')].map((li) => ({
    label: (li.querySelector('.ef-label')?.textContent || '').trim(),
    count: (li.querySelector('.ef-count')?.textContent || '').trim(),
    rates: [...li.querySelectorAll('.ef-rate')].map((x) => (x.textContent || '').trim()),
    time: (li.querySelector('.ef-time')?.textContent || '').trim(),
  })));
  ok('funnel: counts are main\'s, step by step', JSON.stringify(fShown.map((x) => x.label)) === JSON.stringify(f.steps)
     && JSON.stringify(fShown.map((x) => Number(x.count))) === JSON.stringify(f.counts) && f.counts[2] > 0 && f.counts[2] < f.counts[0],
     JSON.stringify({ shown: fShown, main: f.counts }));
  ok('funnel: both rates are main\'s', fShown.every((x, k) => (k === 0 ? x.rates[0] === 'entered'
     : x.rates[0] === `${pct1(f.pctOfFirst[k])} of first` && x.rates[1] === `${pct1(f.pctOfPrev[k])} of previous`)), JSON.stringify(fShown));
  ok('funnel: the median time between steps is main\'s', fShown.every((x, k) => k === 0 || x.time === `median ${fWant.durations[k]} after step ${k}`),
     JSON.stringify({ shown: fShown.map((x) => x.time), main: fWant.durations }));

  ok('funnel: a breakdown by plan', await setSelect(win, 'eb-f-breakdown', 'plan'));
  await win.waitForTimeout(2500);
  const bWant = await mainAnswer(s, ids.projectId, seeded.datasetId, { category: 'event', values: [], eventFunnel: { ...FUNNEL_ENC, breakdown: 'plan' } });
  const bShown = await win.evaluate(() => [...document.querySelectorAll('#viz-area .ef-bd-table tbody tr')].map((tr) => ({
    label: (tr.querySelector('th')?.textContent || '').trim(),
    counts: [...tr.querySelectorAll('.ef-bd-count')].map((x) => Number(x.textContent)),
  })));
  const groups = bWant.data.eventFunnel.breakdown.groups;
  ok('funnel: the breakdown table is main\'s groups and counts',
     JSON.stringify(bShown) === JSON.stringify(groups.map((g: any) => ({ label: g.label, counts: g.counts }))),
     JSON.stringify({ shown: bShown, main: groups }));

  // ── Export: the funnel's own Export CSV, through the native save panel ─────
  const csvPath = path.join(os.tmpdir(), `ordinate-funnel-${Date.now()}.csv`);
  await s.app.evaluate((electron, file: string) => {
    const d = electron.dialog as any; // any: stubbing a native panel for the run
    d.__origSave = d.__origSave || d.showSaveDialog;
    d.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, csvPath);
  await win.evaluate(() => (document.querySelector('#viz-area .ef-wrap .eng-csv') as HTMLElement).click());
  await win.waitForTimeout(1500);
  await s.app.evaluate((electron) => {
    const d = electron.dialog as any; // any: restoring the stub
    if (d.__origSave) d.showSaveDialog = d.__origSave;
  });
  const csv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : '';
  ok('funnel: Export CSV writes the steps and the breakdown', /^﻿?Step,Entities,/.test(csv)
     && csv.includes(`signup,${f.counts[0]},`) && /\r\nplan,signup,activate,purchase\r\n/.test(csv), JSON.stringify(csv.slice(0, 200)));
  try { fs.rmSync(csvPath, { force: true }); } catch { /* temp file */ }

  ok('funnel: saving it', await saveAs(win, 'Signup funnel'));
  const fCard = await galleryCard(win, 'Signup funnel', 'Event funnel');
  ok('funnel: the gallery card is labelled Event funnel and carries a live thumbnail', fCard.labelled && fCard.thumb, JSON.stringify(fCard));
  const fCaption: string = await win.evaluate(async (a: { pid: string; did: string; enc: any }) => {
    const r = await (window as any).hub.computeVisualData(a.pid, a.did, a.enc, []); // any: the preload bridge is a renderer global
    return (window as any).hub.reportsCaption({ chartType: 'event_funnel', data: r.data }); // any: the preload bridge is a renderer global
  }, { pid: ids.projectId, did: seeded.datasetId, enc: { category: 'event', values: [], eventFunnel: { ...FUNNEL_ENC, breakdown: 'plan' } } });
  ok('funnel: the caption is main\'s sentence', fCaption === bWant.caption
     && /^\d+ entered signup; [\d.]+% reached purchase within 14 days; the biggest drop is /.test(fCaption), fCaption);

  ok('cohorts + funnel: no renderer console error during the section', s.errors.length === errorsBefore,
     s.errors.slice(errorsBefore, errorsBefore + 5).join('\n'));
}
