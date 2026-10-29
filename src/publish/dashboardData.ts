// A dashboard's data for a published site — MAIN PROCESS.
//
// Everything a published page shows is computed HERE, by the app, through the
// same functions the live dashboard calls: `vizDataFor` for a chart, a pivot or
// a map, `computeCardMetric` / `resolveMetric` for a KPI, `tileCaption` for the
// sentence under a tile, `app/format` for every figure's text. The page itself
// only lays those answers out and switches between them.
//
// THE FILTER BAR. Each control becomes a short list of options (./combos.ts);
// every combination the plan allows is computed for every tile. A tile stores
// its DISTINCT answers once (`payloads`) and one index per combination
// (`variants`), because most combinations leave most tiles unchanged — a KPI
// over another dataset, a chart the control's column does not reach.

import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as datasets from '../data/datasets';
import { sanitizeEncoding } from '../analysis/visuals';
import type { Visual, VizEncoding } from '../analysis/visuals';
import type { VizDataResult } from '../analysis/vizData';
import { mergeDashboardFilters, controlSteps } from '../analysis/dashboardFilters';
import { sizeLayout } from '../analysis/dashboards';
import type { Card, CardControl, ControlValue, SizeCell } from '../analysis/dashboards';
import { paramValues, resolveFilterParams, substituteText, paramDisplay } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import { describePeriod, getCalendar } from '../analysis/dateIntel';
import type { PeriodPreset } from '../analysis/dateIntel';
import { tileCaption } from '../analysis/captions';
import { formatValue } from '../app/format';
import { readDistinctPage, distinctValuesPageJs } from '../engine/datasetPage';
import type { FilterStep } from '../data/transforms';
import { vizDataFor } from '../ipc/visuals';
import { withEvents } from '../ipc/events'; // r8:events
import { computeCardMetric } from '../ipc/dashboards';
import { liveDistinct } from '../ipc/liveProfile';
import { isLiveFigureError } from '../engine/live/liveFigureError';
import { resolveMetric } from '../ipc/metrics';
import { computeStatsTile } from '../ipc/stats';
import { computeSummary } from '../ipc/summary';
import { statsTitle } from '../analysis/stats/present';
import { metricTreePayload, treeAllowed } from './metricTreePublish';
import { planCombos, parseKey, comboKey, MAX_OPTIONS_PER_CONTROL } from './combos';
import { viewControlValue, viewParamValue, viewPageIndex } from '../analysis/savedViews'; // r10:views
import type { SavedView } from '../analysis/savedViews';
import type { ComboPlan, ControlDomain } from './combos';
import { sanitizeRadiusValue } from '../analysis/geo/radius';
import { lockedOptions, metricAllowed, visualAllowed, type Lock } from './embedLock';
import { embedTileLocked } from '../server/embedMessages';
import { withChartFigures, type ChartFigures } from '../analysis/chartShapes';
import { figureAsk } from '../analysis/figureAsk';
import { kpiSubtitle } from './kpiSubtitle';

export interface PublishedControl {
  id: string;
  label: string;
  kind: 'dropdown' | 'multi' | 'date_range' | 'parameter';
  /** The column a click on a chart label can select through this control. */
  column: string;
  options: string[];
  defaultIndex: number;
}

export interface PublishedCard {
  id: string;
  kind: 'chart' | 'metric' | 'text' | 'broken' | 'summary';
  layout: { x: number; y: number; w: number; h: number };
  /** The card's cell on the tablet and phone grids (or hidden there) — the
   *  page's CSS breakpoints switch between these and `layout`. */
  sizes?: Partial<Record<'tablet' | 'phone', SizeCell | { hidden: true }>>;
  title: string;
  /** The app's chart id (column, line, pie, pivot, table, map_choropleth…). */
  chartType?: string;
  /** The category column, so a click on a label can drive a control. */
  category?: string;
  heading?: string;
  text?: string;
  reason?: string;
  /** combination index → index into `payloads`. */
  variants: number[];
  payloads: unknown[];
}

export interface PublishedDashboard {
  id: string;
  name: string;
  style: unknown;
  controls: PublishedControl[];
  mode: 'all' | 'single';
  keys: string[];
  dropped: ComboPlan['dropped'];
  fullCount: number;
  sheets: Array<{ name: string; cards: PublishedCard[] }>;
  /** Boundary sets the map tiles draw, by level (country, us_state…). */
  geoLevels: string[];
  /** Custom project boundaries the map tiles draw, by id. */
  boundaryIds: string[];
  /** Saved views the page offers as a dropdown: a pick per control, a sheet. */
  views: PublishedView[];
}

export interface PublishedView { name: string; sheet: number; picks: number[]; default: boolean }

/**
 * A saved view as a published page can show it: the option each control lands
 * on, and the sheet. A view whose combination the site does not carry (a
 * "one filter at a time" site, two filters moved) is left out rather than
 * shown on the wrong figures.
 */
function publishedViews(a: analysis.Analysis, specs: ControlSpec[], plan: ComboPlan, lock?: Lock | null): PublishedView[] {
  const out: PublishedView[] = [];
  // Under an embed's lock a view that sets a control the bar left out is dropped: its NAME may be another customer's.
  const left = lock ? a.sheets.flatMap((s) => s.cards).filter((c) => c && c.type === 'control' && !specs.some((x) => x.card.id === c.id)) : [];
  for (const v of a.views || []) {
    if (left.some((c) => viewControlValue(v, c) !== null)) continue;
    const picks = specs.map((s, i) => viewPick(a, v, s, plan.domains[i]));
    // A pick the page does not carry (-1) leaves the view out: showing the
    // default figures under the view's name would be a wrong answer, not a near one.
    if (picks.some((p) => p < 0) || !plan.keys.includes(comboKey(picks))) continue;
    out.push({ name: v.name, sheet: viewPageIndex(v, a.sheets), picks, default: v.id === a.defaultViewId });
  }
  return out;
}

function viewPick(a: analysis.Analysis, view: SavedView, s: ControlSpec, domain: ControlDomain): number {
  let label: string | undefined;
  if (s.control.kind === 'parameter') {
    const p = (a.parameters || []).find((x) => x.id === s.control.paramId);
    const v = p ? viewParamValue(view, p) : null;
    label = Array.isArray(v) ? String(v[0]) : String(v);
  } else {
    const want = JSON.stringify(viewControlValue(view, s.card));
    const at = s.states.findIndex((st) => JSON.stringify(st ?? null) === want);
    label = at >= 0 ? s.domain.options[at] : undefined;
  }
  return label === undefined ? -1 : domain.options.indexOf(label);
}

export interface BuildProgress {
  progress?: (fraction: number, note?: string) => void;
  checkCancelled?: () => void;
}

/**
 * A chart answer on its way OUT of the app — the share-policy hook. Gets the
 * `visual:data` shape and returns it (labels masked, say) or `{ hidden }`
 * when the tile must not be published at all.
 */
/**
 * What an EMBED builds under (src/publish/embedPage.ts): the dashboard as it
 * was PUBLISHED (its record and visuals, kept with the link) instead of the
 * editable one, and the token's locked filters (./embedLock.ts). Absent for
 * a publish or an export.
 */
export interface BuildScope {
  def?: PublishedDef;
  lock?: Lock | null;
}

/** A dashboard's definition as it was published: the record and every visual its cards name. */
export interface PublishedDef {
  analysis: analysis.Analysis;
  visuals: Record<string, Visual>;
}

export type Outgoing = (datasetId: string, encoding: VizEncoding, data: VizDataResult['data']) => Promise<VizDataResult['data'] | { hidden: string }>;

/**
 * One chart answer as a published page stores it. The policy runs FIRST and
 * the caption is written from what survived it — a caption names leading
 * labels, so one written before masking would publish the very label the
 * policy hid. Series go from the app's `{name}` to the export's `{label}`.
 */
const sameLabels = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((l, i) => Object.is(l, b[i]));

export async function chartPayload(
  datasetId: string,
  encoding: VizEncoding,
  chartType: string,
  overrides: unknown,
  raw: VizDataResult['data'],
  outgoing?: Outgoing,
): Promise<Record<string, unknown>> {
  let data = raw;
  if (outgoing) {
    const shaped = await outgoing(datasetId, encoding, raw);
    if ('hidden' in shaped) return { hidden: shaped.hidden };
    data = shaped;
  }
  // The figures the chart draws, off the series as shaped for the page (analysis/chartShapes) — and so its caption's.
  data = withChartFigures(data, figureAsk(chartType, overrides));
  const { figures } = data as { figures?: ChartFigures };
  return {
    labels: data.labels,
    series: data.series.map((s) => ({ label: s.name, values: s.values })),
    ...(figures ? { figures } : {}),
    ...(data.pivot ? { pivot: data.pivot } : {}),
    ...(data.geo ? { geo: data.geo } : {}),
    // r8:events — event markers, only while the shaped labels are still the ones they index.
    ...(raw.events && (overrides as any)?.showEvents !== false && sameLabels(raw.labels, data.labels) ? { events: raw.events } : {}), // any: a visual's overrides record
    caption: tileCaption({ chartType, data, geo: data.geo, pivot: data.pivot, overrides: overrides as any }), // any: a visual's overrides record
  };
}

const DATE_OPTIONS: Array<{ state: ControlValue; label: string }> = [
  { state: { preset: 'last_n_days', n: 7 } as ControlValue, label: 'Last 7 days' },
  { state: { preset: 'last_n_days', n: 30 } as ControlValue, label: 'Last 30 days' },
  { state: { preset: 'last_n_days', n: 90 } as ControlValue, label: 'Last 90 days' },
  { state: { preset: 'ytd' } as ControlValue, label: 'Year to date' },
  { state: { preset: 'last_n_months', n: 12 } as ControlValue, label: 'Last 12 months' },
];

/** What one control contributes: its option labels, and the state behind each. */
interface ControlSpec {
  card: Card;
  control: CardControl;
  domain: ControlDomain;
  /** Option index → the control state (null = "All"), or for a parameter, its value. */
  states: unknown[];
}

async function distinct(projectId: string, datasetId: string, column: string): Promise<string[] | string> {
  const req = { limit: MAX_OPTIONS_PER_CONTROL, search: '' };
  const live = await liveDistinct(projectId, datasetId, column, req);
  if (live) return 'values' in live ? live.values : live.error; // Live: the profile's sample values, or the sentence saying why there is no list
  const src = await datasets.residentSource(projectId, datasetId);
  const fast = src ? await readDistinctPage(src, column, req) : null;
  if (fast) return fast.values.map((v) => String(v));
  const ds = await datasets.getDataset(projectId, datasetId);
  return ds ? distinctValuesPageJs(ds.columns, ds.rows, column, req).values.map((v) => String(v)) : [];
}

async function controlSpec(projectId: string, card: Card, a: analysis.Analysis, unlisted: Unlisted[], lock?: Lock | null, outgoing?: Outgoing): Promise<ControlSpec | null> {
  const control = card.control;
  if (!control) return null;
  const id = card.id;
  const label = control.label || control.column || 'Filter';
  if (control.kind === 'dropdown' || control.kind === 'multi') {
    // Under an embed's lock the options are data too: only what exists inside it (./embedLock.ts).
    let values = lock ? await lockedOptions(lock, projectId, control, MAX_OPTIONS_PER_CONTROL) : await distinct(projectId, control.datasetId, control.column);
    if (typeof values === 'string') { unlisted.push({ control: label, reason: values }); return null; } // left out, and the plan says why — never an empty "All"
    if (!lock) {
      // Each saved view's value here (its pick, else the author's default) leads the list, so a view picking value
      // #100 of a long column is still on the page and survives the plan's trim. Never under a lock: a view is not
      // evidence of what exists inside it. No views → the list as it was.
      const picks = (a.views || []).map((v) => viewControlValue(v, card) as any); // any: ControlValue union, narrowed by kind here
      const front = [...new Set(picks.map((p) => (!p ? undefined : control.kind === 'dropdown' ? p.value : Array.isArray(p.values) && p.values.length === 1 ? p.values[0] : undefined))
        .filter((p): p is string => typeof p === 'string' && p !== ''))];
      values = [...front, ...values.filter((v) => !front.includes(v))];
    }
    const def = control.default as any; // ControlValue union, narrowed by kind here
    const want = control.kind === 'dropdown' ? def && def.value : def && Array.isArray(def.values) ? def.values[0] : undefined;
    const idx = typeof want === 'string' ? values.indexOf(want) : -1;
    // The options are VALUES of the column, so the Share policy shapes them as it does a chart's labels: tokens
    // (each state keeps its raw value — it filters here, never leaves), or the control left out.
    let shown = values;
    if (outgoing) {
      const shaped = await outgoing(control.datasetId, { category: control.column, values: [] }, { labels: values, series: [] });
      if ('hidden' in shaped) { unlisted.push({ control: label, reason: shaped.hidden }); return null; }
      shown = shaped.labels.map(String);
    }
    return {
      card, control,
      domain: { id, label, options: ['All', ...shown], defaultIndex: idx >= 0 ? idx + 1 : 0 },
      states: [null, ...values.map((v) => (control.kind === 'dropdown' ? { value: v } : { values: [v] }))],
    };
  }
  if (control.kind === 'date_range') {
    const opts = DATE_OPTIONS.slice();
    const def = control.default as any; // ControlValue union
    const text = (st: any): string => st.preset && st.preset !== 'custom' // any: ControlValue union
      ? describePeriod({ preset: st.preset as PeriodPreset, n: st.n }, getCalendar())
      : [st.from, st.to].filter(Boolean).join(' – ');
    // Off a lock, each saved view's range leads the presets, once (by state and by label) — as a dropdown's picks do.
    if (!lock) {
      const front: typeof opts = [];
      for (const v of a.views || []) {
        const st = viewControlValue(v, card) as any; // any: ControlValue union
        const label = st && (st.preset || st.from || st.to) ? text(st) : '';
        if (label && ![...front, ...opts].some((o) => JSON.stringify(o.state) === JSON.stringify(st) || o.label === label)) front.push({ state: st, label });
      }
      opts.unshift(...front);
    }
    let defaultIndex = 0;
    if (def && (def.preset || def.from || def.to)) {
      const same = opts.findIndex((o) => JSON.stringify(o.state) === JSON.stringify(def));
      if (same >= 0) defaultIndex = same + 1;
      else {
        opts.unshift({ state: def, label: text(def) || 'Default range' });
        defaultIndex = 1;
      }
    }
    return {
      card, control,
      domain: { id, label, options: ['All time', ...opts.map((o) => o.label)], defaultIndex },
      states: [null, ...opts.map((o) => o.state)],
    };
  }
  if (control.kind === 'radius') {
    // r6:geo — a published page has no place table to type into, so the menu is
    // the author's saved radius and "Anywhere".
    const def = sanitizeRadiusValue(control.default);
    return {
      card, control,
      domain: { id, label, options: def ? ['Anywhere', def.value] : ['Anywhere'], defaultIndex: def ? 1 : 0 },
      states: def ? [null, def] : [null],
    };
  }
  // parameter: the parameter's own list, or just its current value.
  const p = (a.parameters || []).find((x) => x.id === control.paramId);
  if (!p) return null;
  const list = Array.isArray(p.list) ? p.list.map(String).slice(0, MAX_OPTIONS_PER_CONTROL) : [];
  const current = paramDisplay(p.kind, p.value);
  const options = list.length ? list : [current];
  const defaultIndex = Math.max(0, options.indexOf(Array.isArray(p.value) ? String(p.value[0]) : String(p.value)));
  return {
    card, control,
    domain: { id, label: control.label || p.name, options, defaultIndex },
    states: list.length ? list : [p.value],
  };
}

export interface Unlisted { control: string; reason: string } // a control a page cannot offer (a Live column with no list of values), and why
/** Every control card on every sheet, in reading order; the ones left out go onto `unlisted`. */
async function controlSpecs(projectId: string, a: analysis.Analysis, unlisted: Unlisted[], lock?: Lock | null, outgoing?: Outgoing): Promise<ControlSpec[]> {
  const out: ControlSpec[] = [];
  for (const sheet of a.sheets) {
    for (const card of sheet.cards) {
      if (!card || card.type !== 'control') continue;
      const spec = await controlSpec(projectId, card, a, unlisted, lock, outgoing);
      if (spec) out.push(spec);
    }
  }
  return out;
}

/** The plan without computing a single tile — for the dialog's summary line. `outgoing`: the Share policy, for the option labels. */
export async function planDashboard(projectId: string, analysisId: string, maxCombos: number, scope: BuildScope = {}, outgoing?: Outgoing) {
  const a = scope.def ? (scope.def.analysis.id === analysisId ? scope.def.analysis : null) : await analysis.getAnalysis(projectId, analysisId);
  if (!a) return null;
  const unlisted: Unlisted[] = [];
  const specs = await controlSpecs(projectId, a, unlisted, scope.lock, outgoing);
  const plan = planCombos(specs.map((s) => s.domain), maxCombos);
  const tiles = a.sheets.reduce((n, s) => n + s.cards.filter((c) => c && c.type !== 'control').length, 0);
  return { id: a.id, name: a.name, plan, tiles, analysis: a, specs, unlisted };
}

/**
 * The filters and parameter values one combination stands for. An embed's
 * locked steps come FIRST and are literal values (no parameter reference —
 * makeLock refuses one), so binding parameters can never drop or change them.
 */
function comboScope(a: analysis.Analysis, specs: ControlSpec[], plan: ComboPlan, key: string, lock?: Lock | null): { filters: FilterStep[]; params: ParamValues } {
  const picks = parseKey(key);
  const params = paramValues((a.parameters || []).map((p) => ({ name: p.name, kind: p.kind, value: p.value, min: p.min, max: p.max })));
  const filters: FilterStep[] = [...(lock ? lock.steps : []), ...(Array.isArray(a.filters) ? a.filters : [])];
  specs.forEach((s, i) => {
    // The plan may have TRIMMED this control's options; map back by label.
    const label = plan.domains[i] ? plan.domains[i].options[picks[i] ?? 0] : undefined;
    const at = label === undefined ? 0 : Math.max(0, s.domain.options.indexOf(label));
    const state = s.states[at];
    if (s.control.kind === 'parameter') {
      const p = (a.parameters || []).find((x) => x.id === s.control.paramId);
      if (p) {
        const one = paramValues([{ name: p.name, kind: p.kind, value: state, min: p.min, max: p.max }]);
        for (const [k, v] of one) params.set(k, v);
      }
      return;
    }
    for (const step of controlSteps(s.control, state as ControlValue | null)) filters.push(step);
  });
  return { filters, params };
}

/** Store an answer once per distinct value; return its index. */
function intern(store: { payloads: unknown[]; seen: Map<string, number> }, payload: unknown): number {
  const k = JSON.stringify(payload);
  const hit = store.seen.get(k);
  if (hit !== undefined) return hit;
  store.payloads.push(payload);
  store.seen.set(k, store.payloads.length - 1);
  return store.payloads.length - 1;
}

async function resolveVisual(projectId: string, card: Card, def?: PublishedDef): Promise<Pick<Visual, 'datasetId' | 'name' | 'chartType' | 'encoding' | 'filters' | 'overrides'> | null> {
  if (card.visual && card.visual.datasetId) return card.visual;
  if (!card.visualId) return null;
  // The published definition never falls back to the editable visual: what was not published is not shown.
  if (def) return Object.prototype.hasOwnProperty.call(def.visuals, card.visualId) ? def.visuals[card.visualId] : null;
  return visuals.getVisual(projectId, card.visualId);
}

/**
 * Compute a whole dashboard for publishing: every tile, every combination.
 * `outgoing` is the share-policy hook (masking/dropping sensitive labels).
 */
export async function buildDashboard(
  projectId: string,
  analysisId: string,
  maxCombos: number,
  ctx: BuildProgress = {},
  outgoing?: Outgoing,
  opts: { defaultOnly?: boolean } & BuildScope = {},
): Promise<PublishedDashboard | null> {
  const planned = await planDashboard(projectId, analysisId, maxCombos, opts, outgoing);
  const lock = opts.lock ?? null;
  if (!planned) return null;
  const { analysis: a, specs } = planned;
  // `defaultOnly`: just the state the dashboard opens on — the size estimate
  // the Publish dialog shows before anything is written.
  const plan = opts.defaultOnly ? { ...planned.plan, keys: [planned.plan.keys[0]] } : planned.plan;
  const geoLevels = new Set<string>();
  const boundaryIds = new Set<string>();
  const total = Math.max(1, planned.tiles * plan.keys.length);
  let done = 0;
  const scopes = plan.keys.map((k) => comboScope(a, specs, plan, k, lock));
  // A tile that cannot honour the lock is refused, never drawn unscoped (./embedLock.ts).
  const refuse = (base: { id: string; layout: PublishedCard['layout']; variants: number[]; payloads: unknown[] }, title: string): PublishedCard =>
    ({ ...base, kind: 'broken', title, reason: embedTileLocked() });

  const sheets: PublishedDashboard['sheets'] = [];
  for (const sheet of a.sheets) {
    const cards: PublishedCard[] = [];
    for (const card of sheet.cards) {
      if (!card || card.type === 'control') continue;
      if (ctx.checkCancelled) ctx.checkCancelled();
      const base = { id: card.id, layout: { ...card.layout }, variants: [] as number[], payloads: [] as unknown[] };
      const store = { payloads: base.payloads, seen: new Map<string, number>() };
      const defaults = scopes[0] ? scopes[0].params : new Map();

      if (card.type === 'text') {
        cards.push({ ...base, kind: 'text', title: '', heading: substituteText(card.heading || '', defaults), text: substituteText(card.text || '', defaults) });
        done += plan.keys.length;
        continue;
      }
      if (card.type === 'visual') {
        const v = await resolveVisual(projectId, card, opts.def);
        if (!v) {
          cards.push({ ...base, kind: 'broken', title: 'Visual', reason: 'This visual was deleted.' });
          done += plan.keys.length;
          continue;
        }
        const enc = sanitizeEncoding(v.encoding);
        if (lock && !(await visualAllowed(lock, projectId, v.datasetId, enc))) {
          cards.push(refuse(base, substituteText(v.name || 'Visual', defaults)));
          done += plan.keys.length;
          continue;
        }
        if (enc.geo) {
          if (enc.geo.level === 'custom' && enc.geo.boundaryId) boundaryIds.add(enc.geo.boundaryId);
          else geoLevels.add(enc.geo.level);
        }
        for (const scope of scopes) {
          if (ctx.checkCancelled) ctx.checkCancelled();
          const merged = mergeDashboardFilters(scope.filters, v.filters);
          const bound = resolveFilterParams(merged, scope.params);
          const reply = await withEvents(await vizDataFor(projectId, v.datasetId, enc, bound.steps, { params: scope.params }), projectId, v.datasetId, bound.steps);
          const payload = reply.ok
            ? await chartPayload(v.datasetId, enc, v.chartType || 'column', v.overrides, reply.data, outgoing)
            : { error: reply.error || 'Could not compute this tile.' };
          base.variants.push(intern(store, payload));
          done++;
          if (ctx.progress) ctx.progress(done / total, `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} tile answers`);
        }
        cards.push({
          ...base, kind: 'chart', title: substituteText(v.name || 'Visual', defaults),
          chartType: v.chartType || 'column', category: enc.category,
        });
        continue;
      }
      if (card.type === 'metric' && card.metric) {
        const m = card.metric;
        let title = m.label || `${m.aggregation} of ${m.column}`;
        if (lock && !(await metricAllowed(lock, projectId, m))) {
          cards.push(refuse(base, title));
          done += plan.keys.length;
          continue;
        }
        let subtitle: string | undefined;
        for (const scope of scopes) {
          if (ctx.checkCancelled) ctx.checkCancelled();
          const bound = resolveFilterParams(scope.filters, scope.params);
          let payload: any = null;
          let viaMetric = false;
          try {
            if (m.metricId) {
              const r = await resolveMetric(projectId, m.metricId, { filters: bound.steps, params: scope.params });
              if (r && r.ok) {
                if (!m.label && r.name) title = r.name;
                payload = { value: r.value, display: r.display };
                viaMetric = true;
              }
            }
            if (!payload) {
              const r = await computeCardMetric(projectId, m.datasetId, { column: m.column, aggregation: m.aggregation }, bound.steps, scope.params);
              payload = r.ok
                ? { value: r.value, display: r.value == null ? '—' : formatValue(r.value, m.format || 'auto') }
                : { error: 'Source removed' };
            }
          } catch (err) {
            // A Live KPI its warehouse could not give (L2.4): this tile says so, as a chart tile does — the page still publishes.
            if (!isLiveFigureError(err)) throw err;
            payload = { error: err.message };
          }
          if (!payload.error) {
            payload.caption = tileCaption({ kpis: [{ label: title, value: payload.value }] });
            // What it measures, under the figure as the app's KPI tile reads: an aggregation and a column, never a
            // filter's or a formula's literal, never a column the Share policy marks (./kpiSubtitle).
            if (subtitle === undefined) subtitle = await kpiSubtitle(projectId, m, title, viaMetric); // the same for every combination
            if (subtitle) payload.subtitle = subtitle;
          }
          base.variants.push(intern(store, payload));
          done++;
          if (ctx.progress) ctx.progress(done / total, `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} tile answers`);
        }
        cards.push({ ...base, kind: 'metric', title });
        continue;
      }
      if (card.type === 'stats' && card.stats) {
        // A statistics tile (src/ipc/stats.ts), recomputed per combination and
        // published as a chart or a numbers-only table — through the share policy.
        let chartType = card.stats.view === 'chart' ? '' : 'table';
        if (lock && !(await lock.covers(projectId, card.stats.datasetId))) {
          cards.push(refuse(base, statsTitle(card.stats)));
          done += plan.keys.length;
          continue;
        }
        for (const scope of scopes) {
          if (ctx.checkCancelled) ctx.checkCancelled();
          const bound = resolveFilterParams(scope.filters, scope.params);
          const r = await computeStatsTile(projectId, card.stats, bound.steps, 'publish');
          let payload: Record<string, unknown>;
          if (r.ok) {
            const d = card.stats.view === 'chart' ? r.tile.chart.data : r.tile.numeric;
            if (!chartType) chartType = r.tile.chart.chartType;
            payload = { labels: d.labels, series: d.series.map((s) => ({ label: s.name, values: s.values })), caption: r.tile.sentence || r.tile.subtitle };
          } else {
            payload = 'hiddenByPolicy' in r ? { hidden: r.error } : { error: r.error };
          }
          base.variants.push(intern(store, payload));
          done++;
          if (ctx.progress) ctx.progress(done / total, `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} tile answers`);
        }
        cards.push({ ...base, kind: 'chart', title: statsTitle(card.stats), chartType: chartType || 'column' });
        continue;
      }
      if (card.type === 'metricTree' && card.metricTree) {
        // A metric tree (./metricTreePublish): a numbers table of the tree per combination. Under a
        // lock, only a tree of plain metrics over covered datasets is drawn (treeAllowed).
        if (lock && !(await treeAllowed(lock, projectId, card.metricTree.metricId))) {
          cards.push(refuse(base, 'Metric tree'));
          continue;
        }
        for (const scope of scopes) {
          if (ctx.checkCancelled) ctx.checkCancelled();
          base.variants.push(intern(store, await metricTreePayload(projectId, card.metricTree, resolveFilterParams(scope.filters, scope.params).steps, scope.params)));
          done++;
        }
        cards.push({ ...base, kind: 'chart', title: 'Metric tree', chartType: 'table' });
        continue;
      }
      if (card.type === 'summary') {
        // Its facts (insights, quality, alerts) are about whole datasets: never under a lock.
        if (lock) {
          cards.push(refuse(base, 'Summary'));
          done += plan.keys.length;
          continue;
        }
        // The Summary card (src/ipc/summary.ts), recomputed per combination —
        // minus any sentence quoting a column the share policy withholds.
        for (const scope of scopes) {
          if (ctx.checkCancelled) ctx.checkCancelled();
          const list = await computeSummary(projectId, a.sheets, { analysisId: a.id, filters: scope.filters, params: scope.params, outbound: true });
          base.variants.push(intern(store, { sentences: list.map((x) => x.text) }));
          done++;
        }
        cards.push({ ...base, kind: 'summary', title: 'Summary' });
        continue;
      }
      // Image, nav, divider, container and tabs cards carry no figures; a
      // published page draws the figures and the text, and leaves the chrome.
      done += plan.keys.length;
    }
    // Tablet and phone, laid out over exactly the tiles this page draws — the
    // same derivation (and the same edited layouts) the hub shows.
    const drawn = new Set(cards.map((c) => c.id));
    const cells = sizeLayout.publishCells(sheet.cards.filter((c) => c && drawn.has(c.id)), sheet.layouts);
    for (const c of cards) if (cells[c.id]) c.sizes = cells[c.id];
    sheets.push({ name: sheet.name || 'Sheet', cards });
  }

  return {
    id: a.id,
    name: a.name,
    style: a.style,
    controls: specs.map((s, i) => ({
      id: s.card.id,
      label: plan.domains[i].label,
      // A radius publishes as a menu of its author's radius and "Anywhere" (below).
      kind: s.control.kind === 'radius' ? 'dropdown' : s.control.kind,
      column: s.control.kind === 'radius' ? '' : s.control.column,
      options: plan.domains[i].options,
      defaultIndex: plan.domains[i].defaultIndex,
    })),
    mode: plan.mode,
    keys: plan.keys,
    dropped: plan.dropped,
    fullCount: plan.fullCount,
    sheets,
    geoLevels: [...geoLevels],
    boundaryIds: [...boundaryIds],
    views: publishedViews(a, specs, plan, lock),
  };
}
