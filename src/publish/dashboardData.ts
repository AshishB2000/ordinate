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
import { resolveMetric } from '../ipc/metrics';
import { computeStatsTile } from '../ipc/stats';
import { computeSummary } from '../ipc/summary';
import { statsTitle } from '../analysis/stats/present';
import { planCombos, parseKey, comboKey, MAX_OPTIONS_PER_CONTROL } from './combos';
import { viewControlValue, viewParamValue, viewPageIndex } from '../analysis/savedViews'; // r10:views
import type { SavedView } from '../analysis/savedViews';
import type { ComboPlan, ControlDomain } from './combos';
import { sanitizeRadiusValue } from '../analysis/geo/radius';

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
function publishedViews(a: analysis.Analysis, specs: ControlSpec[], plan: ComboPlan): PublishedView[] {
  const out: PublishedView[] = [];
  for (const v of a.views || []) {
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
  return {
    labels: data.labels,
    series: data.series.map((s) => ({ label: s.name, values: s.values })),
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

async function distinct(projectId: string, datasetId: string, column: string): Promise<string[]> {
  const req = { limit: MAX_OPTIONS_PER_CONTROL, search: '' };
  const src = await datasets.residentSource(projectId, datasetId);
  const fast = src ? await readDistinctPage(src, column, req) : null;
  if (fast) return fast.values.map((v) => String(v));
  const ds = await datasets.getDataset(projectId, datasetId);
  return ds ? distinctValuesPageJs(ds.columns, ds.rows, column, req).values.map((v) => String(v)) : [];
}

async function controlSpec(projectId: string, card: Card, a: analysis.Analysis): Promise<ControlSpec | null> {
  const control = card.control;
  if (!control) return null;
  const id = card.id;
  const label = control.label || control.column || 'Filter';
  if (control.kind === 'dropdown' || control.kind === 'multi') {
    const values = await distinct(projectId, control.datasetId, control.column);
    const def = control.default as any; // ControlValue union, narrowed by kind here
    const want = control.kind === 'dropdown' ? def && def.value : def && Array.isArray(def.values) ? def.values[0] : undefined;
    const idx = typeof want === 'string' ? values.indexOf(want) : -1;
    return {
      card, control,
      domain: { id, label, options: ['All', ...values], defaultIndex: idx >= 0 ? idx + 1 : 0 },
      states: [null, ...values.map((v) => (control.kind === 'dropdown' ? { value: v } : { values: [v] }))],
    };
  }
  if (control.kind === 'date_range') {
    const opts = DATE_OPTIONS.slice();
    const def = control.default as any; // ControlValue union
    let defaultIndex = 0;
    if (def && (def.preset || def.from || def.to)) {
      const same = opts.findIndex((o) => JSON.stringify(o.state) === JSON.stringify(def));
      if (same >= 0) defaultIndex = same + 1;
      else {
        const text = def.preset && def.preset !== 'custom'
          ? describePeriod({ preset: def.preset as PeriodPreset, n: def.n }, getCalendar())
          : [def.from, def.to].filter(Boolean).join(' – ');
        opts.unshift({ state: def, label: text || 'Default range' });
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

/** Every control card on every sheet, in reading order. */
async function controlSpecs(projectId: string, a: analysis.Analysis): Promise<ControlSpec[]> {
  const out: ControlSpec[] = [];
  for (const sheet of a.sheets) {
    for (const card of sheet.cards) {
      if (!card || card.type !== 'control') continue;
      const spec = await controlSpec(projectId, card, a);
      if (spec) out.push(spec);
    }
  }
  return out;
}

/** The plan without computing a single tile — for the dialog's summary line. */
export async function planDashboard(projectId: string, analysisId: string, maxCombos: number) {
  const a = await analysis.getAnalysis(projectId, analysisId);
  if (!a) return null;
  const specs = await controlSpecs(projectId, a);
  const plan = planCombos(specs.map((s) => s.domain), maxCombos);
  const tiles = a.sheets.reduce((n, s) => n + s.cards.filter((c) => c && c.type !== 'control').length, 0);
  return { id: a.id, name: a.name, plan, tiles, analysis: a, specs };
}

/** The filters and parameter values one combination stands for. */
function comboScope(a: analysis.Analysis, specs: ControlSpec[], plan: ComboPlan, key: string): { filters: FilterStep[]; params: ParamValues } {
  const picks = parseKey(key);
  const params = paramValues((a.parameters || []).map((p) => ({ name: p.name, kind: p.kind, value: p.value, min: p.min, max: p.max })));
  const filters: FilterStep[] = Array.isArray(a.filters) ? a.filters.slice() : [];
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

async function resolveVisual(projectId: string, card: Card): Promise<Pick<Visual, 'datasetId' | 'name' | 'chartType' | 'encoding' | 'filters' | 'overrides'> | null> {
  if (card.visual && card.visual.datasetId) return card.visual;
  if (!card.visualId) return null;
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
  opts: { defaultOnly?: boolean } = {},
): Promise<PublishedDashboard | null> {
  const planned = await planDashboard(projectId, analysisId, maxCombos);
  if (!planned) return null;
  const { analysis: a, specs } = planned;
  // `defaultOnly`: just the state the dashboard opens on — the size estimate
  // the Publish dialog shows before anything is written.
  const plan = opts.defaultOnly ? { ...planned.plan, keys: [planned.plan.keys[0]] } : planned.plan;
  const geoLevels = new Set<string>();
  const boundaryIds = new Set<string>();
  const total = Math.max(1, planned.tiles * plan.keys.length);
  let done = 0;
  const scopes = plan.keys.map((k) => comboScope(a, specs, plan, k));

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
        const v = await resolveVisual(projectId, card);
        if (!v) {
          cards.push({ ...base, kind: 'broken', title: 'Visual', reason: 'This visual was deleted.' });
          done += plan.keys.length;
          continue;
        }
        const enc = sanitizeEncoding(v.encoding);
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
        for (const scope of scopes) {
          if (ctx.checkCancelled) ctx.checkCancelled();
          const bound = resolveFilterParams(scope.filters, scope.params);
          let payload: any = null;
          if (m.metricId) {
            const r = await resolveMetric(projectId, m.metricId, { filters: bound.steps, params: scope.params });
            if (r && r.ok) {
              if (!m.label && r.name) title = r.name;
              payload = { value: r.value, display: r.display };
            }
          }
          if (!payload) {
            const r = await computeCardMetric(projectId, m.datasetId, { column: m.column, aggregation: m.aggregation }, bound.steps, scope.params);
            payload = r.ok
              ? { value: r.value, display: r.value == null ? '—' : formatValue(r.value, m.format || 'auto') }
              : { error: 'Source removed' };
          }
          if (!payload.error) payload.caption = tileCaption({ kpis: [{ label: title, value: payload.value }] });
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
      if (card.type === 'summary') {
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
    views: publishedViews(a, specs, plan),
  };
}
