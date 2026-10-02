// Depth round 6 smoke SECTION: geospatial analysis, driven through the REAL UI.
// Not a smoke of its own — scripts/smoke-round6.ts calls geoSection(s, fx) on its
// one launch and fixture.
//
//   A "Stores" dataset (400 points around Austin, Dallas, Houston and Denver,
//   a measure, and origin → destination pairs) is seeded through main. Then:
//   the visual builder's Map regions → Hexbin density draws hexagons (the
//   MapLibre source's features counted in the page) at the level main computed;
//   → Flows draws one line per route; the Prepare panel's "Assign regions" step
//   previews its match rate and, saved (as a job), writes Texas / Colorado into
//   a region column; a calculated field with distance_km writes the haversine
//   this file computes itself; and a dashboard's radius control — added through
//   + Control, a place typed and resolved offline, 25 km applied — moves the
//   KPI to exactly the sum main computes over the same filter. Everything this
//   section created is removed at the end, and the app is left on the Data list.
//
// WebGL runs on SwiftShader in CI (launchSmoke): assertions read features and
// data, never pixels.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis, domDriver } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level globals, read by bare name inside evaluate (never window.x — they are const/let or functions).
declare const getMapInContainer: any;
declare const selectSection: any;
declare const openVisualBuilder: any;
declare const openSavedDataset: any;
declare const dxSelectTab: any;

const CITIES: Array<[string, number, number]> = [
  ['Austin', 30.2672, -97.7431], ['Dallas', 32.7767, -96.797], ['Houston', 29.7604, -95.3698], ['Denver', 39.7392, -104.9903],
];
const N = 400;
const R_KM = 6371.0088;

/** The fixture rows — deterministic, so this file can compute every expectation itself. */
function storeRows(): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];
  for (let i = 0; i < N; i += 1) {
    const [name, la, lo] = CITIES[i % 4];
    const [dname, dla, dlo] = CITIES[(i + 1) % 4];
    // ±0.08° — every point stays well inside its state.
    const lat = Math.round((la + (((i * 37) % 17) - 8) / 100) * 1e5) / 1e5;
    const lng = Math.round((lo + (((i * 53) % 17) - 8) / 100) * 1e5) / 1e5;
    rows.push([i + 1, lat, lng, (i % 50) + 1, name, la, lo, dname, dla, dlo]);
  }
  return rows;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const d = Math.PI / 180;
  const s1 = Math.sin(((lat2 - lat1) * d) / 2);
  const s2 = Math.sin(((lon2 - lon1) * d) / 2);
  const a = s1 * s1 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * s2 * s2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(250);
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

/** Set a <select> / <input> and fire what a user's change fires. */
const setValue = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string }) => {
    const el = document.querySelector(a.q) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return false;
    el.value = a.v;
    if (el.value !== a.v) return false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { q: sel, v: value });

/** The builder's map-settings field whose label reads `label`. */
const mapField = (win: Win, label: string, value: string): Promise<boolean> =>
  win.evaluate((a: { l: string; v: string }) => {
    const f = [...document.querySelectorAll('#viz-encoding-mount .enc-map-field')]
      .find((x) => (x.querySelector('.viz-field-label')?.textContent || '').trim() === a.l);
    const sel = f && (f.querySelector('select') as HTMLSelectElement | null);
    if (!sel) return false;
    sel.value = a.v;
    if (sel.value !== a.v) return false;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { l: label, v: value });

/** What the map in the builder's viz area has drawn, read off MapLibre itself. */
const drawn = (win: Win, source: string): Promise<{ features: number; layer: boolean; wrap: Record<string, string> }> =>
  win.evaluate((src: string) => {
    const area = document.getElementById('viz-area');
    const map = area ? getMapInContainer(area) : null;
    const wrap = area ? (area.querySelector('.cv-map-wrap') as HTMLElement | null) : null;
    let features = -1;
    try { features = map && map.getSource(src) ? map.querySourceFeatures(src).length : -1; } catch (_) { features = -1; }
    return { features, layer: !!(map && (map.getLayer('cv-hex-fill') || map.getLayer('cv-flow-lines'))), wrap: wrap ? Object.fromEntries(Object.entries(wrap.dataset)) as Record<string, string> : {} };
  }, source);

export async function geoSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const { fillPrompt, clickId } = domDriver(win);
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  // ponytail: main-process calls go through the SAME module instances main registered its handlers on.
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => { // any: a JSON arg bag
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    if (a.fn === 'seed') {
      const ds = await datasets.saveDataset(a.pid, {
        name: 'Stores', sourceKind: 'csv',
        columns: [
          { name: 'id', type: 'number' }, { name: 'lat', type: 'number' }, { name: 'lng', type: 'number' },
          { name: 'amount', type: 'number' }, { name: 'origin', type: 'text' }, { name: 'olat', type: 'number' },
          { name: 'olng', type: 'number' }, { name: 'dest', type: 'text' }, { name: 'dlat', type: 'number' }, { name: 'dlng', type: 'number' },
        ],
        rows: a.rows,
      });
      return ds ? ds.id : '';
    }
    if (a.fn === 'reply') {
      const { sanitizeEncoding } = req('./src/analysis/visuals.js');
      return req('./src/ipc/geoViz.js').geoVizReply(a.pid, a.id, sanitizeEncoding(a.encoding), []);
    }
    if (a.fn === 'rows') {
      const ds = await datasets.getDataset(a.pid, a.id);
      return ds ? { columns: ds.columns.map((c: any) => c.name), rows: ds.rows.slice(0, 8), steps: ds.steps } : null;
    }
    if (a.fn === 'visuals') return (await req('./src/analysis/visuals.js').listVisuals(a.pid)).filter((v: any) => /^Store /.test(v.name));
    if (a.fn === 'jobs') return req('./src/app/jobs.js').snapshot();
    if (a.fn === 'radiusSum') {
      const ds = await datasets.getDataset(a.pid, a.id);
      const { applyPipeline, sanitizeSteps } = req('./src/data/transforms.js');
      const { computeMetric } = req('./src/analysis/metricValue.js');
      const rows = applyPipeline({ columns: ds.columns, rows: ds.rows }, sanitizeSteps(a.steps)).rows;
      return { sum: computeMetric(ds.columns, rows, { column: 'amount', aggregation: 'sum' }), n: rows.length };
    }
    if (a.fn === 'cleanup') {
      const visuals = req('./src/analysis/visuals.js');
      for (const v of await visuals.listVisuals(a.pid)) if (/^Store /.test(v.name)) await visuals.deleteVisual(a.pid, v.id);
      const analysis = req('./src/analysis/analysis.js');
      for (const x of await analysis.listAnalyses(a.pid)) if (x.name === 'Geo board') await analysis.deleteAnalysis(a.pid, x.id);
      await datasets.deleteDataset(a.pid, a.id);
      return true;
    }
    return null;
  }, { fn, pid, ...arg }) as Promise<T>;

  const rows = storeRows();
  const dsId: string = await main('seed', { rows });
  ok('geo: seeded the Stores dataset', !!dsId);
  if (!dsId) return;

  try {
    // ── 1. Hexbin, through the builder's Map regions ────────────────────────
    await openProject(win, pid);
    await win.evaluate(() => selectSection('visuals'));
    await win.waitForTimeout(600);
    await win.evaluate((id: string) => openVisualBuilder(id), dsId);
    await until(win, () => win.evaluate(() => !!document.querySelector('#viz-encoding-mount .js-enc-geo')));
    const offered = await win.evaluate(() => [...document.querySelectorAll('#viz-encoding-mount .js-enc-geo option')].map((o) => (o as HTMLOptionElement).value));
    ok('geo: Map regions offers Hexbin density and Flows', offered.includes('hexbin') && offered.includes('flow'), JSON.stringify(offered));
    await setValue(win, '#viz-encoding-mount .js-enc-geo', 'hexbin');
    const hexDrawn = await until(win, async () => (await drawn(win, 'cv-hex')).features > 0, 30_000);
    const hex = await drawn(win, 'cv-hex');
    ok('geo: the hexbin map draws hexagon features in MapLibre', hexDrawn && hex.layer, JSON.stringify(hex));
    const chip = await text(win, '#viz-switcher-mount .cv-viz-chip.active');
    ok('geo: the picker offers ONLY the hexbin map for density data, selected', chip === 'Hexbin map'
      && await win.evaluate(() => document.querySelectorAll('#viz-switcher-mount .cv-viz-chip').length === 1), chip);
    // The drawn level's hexagons are exactly main's for that level.
    const reply: any = await main('reply', { id: dsId, encoding: { category: 'origin', values: [{ column: 'amount', aggregation: 'sum' }], geo: { level: 'hexbin', lat: 'lat', lon: 'lng' } } });
    const level = reply && reply.ok ? reply.data.geo.hex.levels.find((l: any) => String(l.res) === hex.wrap.hexRes) : null; // any: the reply JSON
    ok('geo: the level on screen has main\'s hexagon count for that level', !!level && String(level.hexes.length) === hex.wrap.hexes,
      `${hex.wrap.hexes} drawn at level ${hex.wrap.hexRes}; main ${level && level.hexes.length}`);
    ok('geo: every point is in a hexagon (400)', !!reply && reply.data.geo.hex.points === N && reply.data.geo.hex.skipped === 0);
    const note = await text(win, '#viz-area .geo-map-note');
    ok('geo: the map says how many points and hexagons it drew', /400 points · [\d,]+ hexagons · level \d of 8/.test(note), note);
    // Zoom in: the grid swaps to a finer level — from the SAME reply, no recompute.
    const before = hex.wrap.hexRes;
    await win.evaluate(() => { const m = getMapInContainer(document.getElementById('viz-area')); m.jumpTo({ zoom: m.getZoom() + 4 }); m.fire('zoomend'); });
    const finer = await until(win, async () => Number((await drawn(win, 'cv-hex')).wrap.hexRes) > Number(before), 8000);
    ok('geo: zooming in swaps to a finer hexagon level', finer, JSON.stringify((await drawn(win, 'cv-hex')).wrap));
    await shot('r6-geo-hexbin.png');
    ok('geo: Save visual', await click(win, '#viz-save-btn'));
    await win.waitForTimeout(400);
    await fillPrompt('Store density');
    await until(win, async () => (await main<any[]>('visuals')).length === 1, 10_000);
    const saved: any[] = await main('visuals');
    ok('geo: the visual is saved as map_hexbin with its geo level', saved.length === 1 && saved[0].chartType === 'map_hexbin', JSON.stringify(saved));

    // ── 2. Flow map ──────────────────────────────────────────────────────────
    await win.evaluate((id: string) => openVisualBuilder(id), dsId);
    await until(win, () => win.evaluate(() => !!document.querySelector('#viz-encoding-mount .js-enc-geo')));
    await setValue(win, '#viz-encoding-mount .js-enc-geo', 'flow');
    await win.waitForTimeout(300);
    const set = [await mapField(win, 'Origin latitude', 'olat'), await mapField(win, 'Origin longitude', 'olng'),
      await mapField(win, 'Destination latitude', 'dlat'), await mapField(win, 'Destination longitude', 'dlng'),
      await mapField(win, 'Origin name', 'origin'), await mapField(win, 'Destination name', 'dest')];
    ok('geo: the flow fields (origin, destination, names) are in the map settings', set.every(Boolean), JSON.stringify(set));
    // The map redraws after each field; wait for the one drawn from all six.
    const routes = await until(win, async () => (await drawn(win, 'cv-flow')).wrap.flows === '4', 30_000);
    const flow = await drawn(win, 'cv-flow');
    ok('geo: the flow map draws one line per route (4)', routes && flow.wrap.flows === '4', JSON.stringify(flow));
    const flowNote = await text(win, '#viz-area .geo-map-note');
    ok('geo: …and says so', /^4 routes · 400 rows$/.test(flowNote), flowNote);
    const hover = await win.evaluate(() => {
      const m = getMapInContainer(document.getElementById('viz-area'));
      const f = m.querySourceFeatures('cv-flow')[0];
      return f ? String(f.properties.__name) : '';
    });
    ok('geo: a route is named origin → destination', /^(Austin|Dallas|Houston|Denver) → (Austin|Dallas|Houston|Denver)$/.test(hover), hover);
    await shot('r6-geo-flow.png');
    ok('geo: Save the flow map', await click(win, '#viz-save-btn'));
    await win.waitForTimeout(400);
    await fillPrompt('Store flows');
    await until(win, async () => (await main<any[]>('visuals')).length === 2, 10_000);
    ok('geo: the flow visual is saved as map_flow', (await main<any[]>('visuals')).some((v) => v.chartType === 'map_flow'));
    await click(win, '#viz-cancel-btn');
    await win.waitForTimeout(400);

    // ── 3. Assign regions (spatial join) in Prepare ─────────────────────────
    await win.evaluate(async (id: string) => {
      selectSection('datasets');
      await openSavedDataset(id);
      dxSelectTab('ds-tab-prepare', true);
    }, dsId);
    await win.waitForTimeout(1200);
    const added = await win.evaluate(async () => {
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      (document.getElementById('ds-step-add') as HTMLElement).click();
      await pause(300);
      const item = [...document.querySelectorAll('.chart-menu-item')].find((b) => (b.textContent || '').trim() === 'Assign regions (spatial join)') as HTMLElement | undefined;
      if (!item) return false;
      item.click();
      await pause(500);
      return !(document.getElementById('ds-step-editor') as HTMLElement).hidden;
    });
    ok('geo: the Add-step menu offers Assign regions, and its editor opens', added);
    const tiles = await win.evaluate(() => [...document.querySelectorAll('#ds-step-editor .sj-source')].map((b) => (b as HTMLElement).dataset.source));
    ok('geo: the editor offers US states, countries and US counties', ['us_state', 'country', 'us_county'].every((t) => tiles.includes(t)), JSON.stringify(tiles));
    const pv = await until(win, () => win.evaluate(() => /points matched/.test(document.querySelector('#ds-step-editor .pp-preview')?.textContent || '')), 20_000);
    const preview = await text(win, '#ds-step-editor .pp-preview > div');
    ok('geo: the preview counts the match — 400 of 400 points in 2 regions', pv && preview === '400 of 400 points matched · 2 regions', preview);
    const chips = await win.evaluate(() => [...document.querySelectorAll('#ds-step-editor .sj-top-chip')].map((c) => (c.textContent || '').trim()));
    ok('geo: …with the busiest regions (Texas 300, Colorado 100)', JSON.stringify(chips) === JSON.stringify(['Texas · 300', 'Colorado · 100']), JSON.stringify(chips));
    await shot('r6-geo-spatial-join.png');
    await win.evaluate(() => {
      const b = [...document.querySelectorAll('#ds-step-editor .ds-step-editor-actions button')].find((x) => (x.textContent || '').trim() === 'Save step') as HTMLElement | undefined;
      b?.click();
    });
    const joined = await until(win, async () => {
      const r: any = await main('rows', { id: dsId });
      return !!r && r.columns.includes('region');
    }, 30_000);
    const after: any = await main('rows', { id: dsId });
    // Row i is city i % 4: Austin, Dallas, Houston (Texas), Denver (Colorado).
    ok('geo: the region column is written — Texas for the Texas cities, Colorado for Denver', joined
      && JSON.stringify(after.rows.slice(0, 4).map((r: any[]) => r[after.columns.indexOf('region')])) === JSON.stringify(['Texas', 'Texas', 'Texas', 'Colorado']),
      JSON.stringify(after && after.rows.slice(0, 4)));
    const jobs: any = await main('jobs');
    ok('geo: the join ran as a compute job', [...(jobs.active || []), ...(jobs.recent || [])].some((j: any) => j.kind === 'compute' && /Assign regions — Stores/.test(j.label)),
      JSON.stringify((jobs.recent || []).slice(0, 3).map((j: any) => j.label)));
    ok('geo: the step list names the step', /Assign region from lat, lng by US states/.test(await text(win, '#ds-steps-list .ds-step-summary')),
      await text(win, '#ds-steps-list .ds-step-summary'));

    // ── 4. A calculated field with distance_km ───────────────────────────────
    await win.evaluate(async () => {
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      (document.getElementById('ds-step-add') as HTMLElement).click();
      await pause(300);
      ([...document.querySelectorAll('.chart-menu-item')].find((b) => (b.textContent || '').trim() === 'Calculated field') as HTMLElement | undefined)?.click();
    });
    const fx0 = await win.waitForSelector('.fx-modal', { timeout: 10_000 }).then(() => true).catch(() => false);
    ok('geo: the formula editor opens', fx0);
    if (fx0) {
      const fnListed = await win.evaluate(() => [...document.querySelectorAll('.fx-modal .fx-item-fn')].some((b) => /distance_km/.test(b.textContent || '')));
      ok('geo: distance_km is in the function list', fnListed);
      await win.fill('.fx-modal .fx-name', 'km_to_austin');
      await win.fill('.fx-modal .fx-input', 'distance_km([lat], [lng], 30.2672, -97.7431)');
      await win.waitForTimeout(1200);
      ok('geo: the formula previews with no error', await win.evaluate(() => !!document.querySelector('.fx-modal .fx-table td.fx-res')
        && document.querySelectorAll('.fx-modal .fx-msg-err').length === 0));
      await click(win, '.fx-modal .btn-primary');
      await until(win, async () => ((await main<any>('rows', { id: dsId })) || { columns: [] }).columns.includes('km_to_austin'), 20_000);
      const withKm: any = await main('rows', { id: dsId });
      const ci = withKm.columns.indexOf('km_to_austin');
      const want = rows.slice(0, 4).map((r) => haversine(r[1] as number, r[2] as number, 30.2672, -97.7431));
      const got = withKm.rows.slice(0, 4).map((r: any[]) => r[ci]);
      ok('geo: distance_km writes the haversine km (R = 6371.0088), row for row', got.every((v: any, i: number) => typeof v === 'number' && Math.abs(v - want[i]) < 1e-9),
        JSON.stringify({ got, want }));
    }

    // ── 5. A radius control on a dashboard ───────────────────────────────────
    await seedAnalysis(app, pid, {
      name: 'Geo board',
      sheets: [{ name: 'Sheet 1', cards: [
        // `plain`: the whole figure, so the page's number can be compared with main's exactly.
        { type: 'metric', metric: { datasetId: dsId, column: 'amount', aggregation: 'sum', label: 'Store revenue', format: 'plain' } as any, layout: { x: 0, y: 0, w: 4, h: 2 } }, // any: SeedCard's metric has no format field
      ] }],
    });
    await win.evaluate(() => selectSection('analyses'));
    await win.waitForTimeout(1200);
    ok('geo: the dashboard opens', await openSeededAnalysis(win, 'Geo board'));
    const kpi = (): Promise<string> => text(win, '#dash-grid .dash-card .dash-metric-value');
    const all: any = await main('radiusSum', { id: dsId, steps: [] });
    await until(win, async () => Number((await kpi()).replace(/[^\d.-]/g, '')) === all.sum, 15_000);
    ok('geo: unfiltered, the KPI is the whole sum', Number((await kpi()).replace(/[^\d.-]/g, '')) === all.sum, `${await kpi()} vs ${all.sum}`);

    ok('geo: + Control opens the dialog', await clickId('dash-add-control'));
    await win.waitForTimeout(500);
    const kinds = await win.evaluate(() => [...document.querySelectorAll('.dash-control-modal .dc-kind-tile')].map((t) => (t as HTMLElement).dataset.kind));
    ok('geo: the dialog offers a Radius kind', kinds.includes('radius'), JSON.stringify(kinds));
    await click(win, '.dash-control-modal .dc-kind-tile[data-kind="radius"]');
    const radiusDialog = await until(win, () => win.evaluate(() => !!document.querySelector('.geo-radius-modal')), 5000);
    ok('geo: Radius opens its own dialog', radiusDialog);
    await win.evaluate(() => {
      const box = document.querySelector('.geo-radius-modal') as HTMLElement;
      const dsSel = box.querySelector('.dm-field select') as HTMLSelectElement;
      const opt = [...dsSel.options].find((o) => o.textContent === 'Stores');
      if (opt) { dsSel.value = opt.value; dsSel.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    const cols = await until(win, () => win.evaluate(() => {
      const sels = [...document.querySelectorAll('.geo-radius-modal .geo-radius-cols select')] as HTMLSelectElement[];
      return sels.length === 2 && sels[0].value === 'lat' && sels[1].value === 'lng';
    }), 8000);
    ok('geo: the latitude and longitude columns are detected', cols);
    await shot('r6-geo-radius-dialog.png');
    await click(win, '.geo-radius-modal .ws-modal-actions .btn-primary');
    const chipOn = await until(win, () => win.evaluate(() => !!document.querySelector('#dash-fb-chips .dash-ctrl-radius')), 8000);
    ok('geo: the radius chip is in the filter bar, reading Anywhere', chipOn && (await text(win, '#dash-fb-chips .dash-ctrl-radius')) === 'Anywhere');

    await click(win, '#dash-fb-chips .dash-ctrl-radius');
    await win.waitForSelector('.geo-radius-pop', { timeout: 5000 }).catch(() => null);
    await win.fill('.geo-radius-pop .geo-radius-place', 'Atlantis');
    await until(win, () => win.evaluate(() => !!document.querySelector('.geo-radius-pop .geo-radius-match.is-err')), 8000);
    ok('geo: an unknown place says so, and Apply stays off', /No place called "Atlantis"/.test(await text(win, '.geo-radius-pop .geo-radius-match'))
      && await win.evaluate(() => (document.querySelector('.geo-radius-pop .dash-ctrl-popover-actions .btn-primary') as HTMLButtonElement).disabled));
    await win.fill('.geo-radius-pop .geo-radius-place', '');
    await win.type('.geo-radius-pop .geo-radius-place', 'Austin, TX', { delay: 20 });
    await until(win, () => win.evaluate(() => !!document.querySelector('.geo-radius-pop .geo-radius-match.is-ok')), 8000);
    const match = await text(win, '.geo-radius-pop .geo-radius-match');
    ok('geo: the place resolves offline and shows the match before applying', /^Austin, TX · 30\.\d+, -97\.\d+$/.test(match), match);
    await win.evaluate(() => {
      ([...document.querySelectorAll('.geo-radius-pop .geo-radius-preset')].find((b) => (b.textContent || '') === '25 km') as HTMLElement | undefined)?.click();
    });
    await shot('r6-geo-radius-pop.png');
    await click(win, '.geo-radius-pop .dash-ctrl-popover-actions .btn-primary');
    // What main computes for the same filter: the centre the offline table gives Austin, TX.
    const center: any = await app.evaluate(async () => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      return req('./src/analysis/places.js').resolvePlace('Austin, TX');
    });
    const want: any = await main('radiusSum', { id: dsId, steps: [
      { type: 'filter', column: 'lat', op: 'within_km', radius: { lngColumn: 'lng', lat: center.lat, lng: center.lng, km: 25 } },
    ] });
    ok('geo: 25 km of Austin keeps the Austin rows only (100)', want.n === 100, String(want.n));
    const moved = await until(win, async () => Number((await kpi()).replace(/[^\d.-]/g, '')) === want.sum, 15_000);
    ok('geo: the KPI moves to exactly the sum main computes within 25 km of Austin', moved, `${await kpi()} vs ${want.sum}`);
    ok('geo: the chip reads the radius', (await text(win, '#dash-fb-chips .dash-ctrl-radius')) === 'within 25 km of Austin, TX',
      await text(win, '#dash-fb-chips .dash-ctrl-radius'));
    await shot('r6-geo-radius-applied.png');

    // Clear it: the whole sum is back.
    await click(win, '#dash-fb-chips .dash-ctrl-radius');
    await win.waitForSelector('.geo-radius-pop', { timeout: 5000 }).catch(() => null);
    await win.evaluate(() => {
      ([...document.querySelectorAll('.geo-radius-pop .dash-ctrl-popover-actions button')].find((b) => (b.textContent || '').trim() === 'Anywhere') as HTMLElement | undefined)?.click();
    });
    const back = await until(win, async () => Number((await kpi()).replace(/[^\d.-]/g, '')) === all.sum, 15_000);
    ok('geo: Anywhere clears the radius and the whole sum is back', back, await kpi());
    await win.evaluate(() => (document.getElementById('dash-back-btn') as HTMLElement | null)?.click());
    await win.waitForTimeout(800);
  } finally {
    await main('cleanup', { id: dsId }).catch(() => null);
    await win.evaluate(() => {
      document.querySelectorAll('.ws-modal-overlay, .dash-ctrl-popover').forEach((o) => o.remove());
      selectSection('datasets');
    }).catch(() => null);
    await win.waitForTimeout(600);
    // Neutral means the LIST: the points dataset's page is still open behind the section switch.
    await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); }).catch(() => null);
    await win.waitForTimeout(400);
  }
}
