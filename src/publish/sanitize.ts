// The published site's whitelist — PURE. The return of `sanitizePage` is the
// ONLY thing serialized into a published page.
//
// Built ON `dashboardExport.sanitizeBundle`, not beside it: a published
// dashboard's name, style, brand and controls summary go through that function
// verbatim, and every new field reuses its primitives (sanitizeChartData,
// sanitizePng, sanitizeLayout, sanitizeBrand). What is NEW here is the shape a
// live filter bar needs — controls, combination keys, per-tile variants — plus
// pivots, maps, boundaries and story blocks. Every one of them is clamped to
// labels, finite numbers, closed enums and `data:image` URIs; a key that is not
// named below is dropped, so a stray config field, a secret, a raw row or an
// http(s) URL cannot reach a published file.

import { sanitizeBundle, sanitizeChartData, sanitizePng, sanitizeLayout } from '../analysis/dashboardExport';
import type { ExportChartData } from '../analysis/dashboardExport';
import { sanitizeFormatPrefs } from '../app/format';

const MAX_STR = 20_000;
const MAX_LABEL = 400;
const MAX_OPTIONS = 60;

/** Chart ids the published renderer knows; anything else draws as a column chart. */
export const PUBLISHED_CHART_TYPES: ReadonlySet<string> = new Set([
  'column', 'bar', 'clustered_column', 'clustered_bar', 'stacked_column', 'stacked_bar',
  'pct_stacked_column', 'pct_stacked_bar', 'line', 'line_markers', 'area', 'stacked_area',
  'pie', 'donut', 'scatter', 'bubble', 'radar', 'combo', 'histogram', 'funnel', 'pareto',
  'waterfall', 'gauge', 'treemap', 'heatmap', 'sankey', 'candlestick', 'boxplot', 'bullet',
  'calendar', 'pivot', 'table', 'map_bubble', 'map_choropleth',
]);
// A cohort's `{labels, series}` IS its retention curve and an event funnel's is
// its per-step counts, so the page draws them as the chart they already are.
// Their grids never reach a page: `sanitizePayload` names no key for them.
const PUBLISHED_AS: ReadonlyMap<string, string> = new Map([['cohort', 'line'], ['event_funnel', 'funnel']]);
const GEO_LEVELS: ReadonlySet<string> = new Set([
  'country', 'us_state', 'us_county', 'us_city', 'us_zip', 'world_city', 'point', 'custom',
]);
const CONTROL_KINDS: ReadonlySet<string> = new Set(['dropdown', 'multi', 'date_range', 'parameter']);
const TONES: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'danger']);
const ROW_KINDS: ReadonlySet<string> = new Set(['leaf', 'subtotal']);
const FILE_RE = /^[a-z0-9][a-z0-9-]{0,80}\.html$/;
const KEY_RE = /^(\d{1,3}(\.\d{1,3}){0,15})?$/;
// Raster only — an SVG data: URL is a document that can carry script.
const RASTER_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, max = MAX_STR): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : dflt;
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

export interface SiteNavItem { file: string; kind: 'dashboard' | 'story' | 'scorecard'; name: string }

function sanitizeNav(raw: unknown): SiteNavItem[] {
  return arr(raw, 200).map((r) => {
    const o = obj(r);
    const kind = o.kind === 'story' || o.kind === 'scorecard' ? o.kind : 'dashboard';
    return { file: FILE_RE.test(str(o.file)) ? str(o.file) : '', kind, name: str(o.name, MAX_LABEL) } as SiteNavItem;
  }).filter((n) => n.file);
}

function sanitizePivot(raw: unknown): unknown {
  const o = obj(raw);
  const grid2 = (v: unknown, f: (x: unknown) => unknown) => arr(v, 5000).map((r) => arr(r, 2000).map(f));
  const nums = (v: unknown) => arr(v, 2000).map(num);
  return {
    rowHeaders: grid2(o.rowHeaders, (x) => str(x, MAX_LABEL)),
    colHeaders: grid2(o.colHeaders, (x) => str(x, MAX_LABEL)),
    cells: grid2(o.cells, num),
    rowTotals: o.rowTotals === null ? null : grid2(o.rowTotals, num),
    colTotals: o.colTotals === null ? null : nums(o.colTotals),
    grand: o.grand === null ? null : nums(o.grand),
    rowKinds: arr(o.rowKinds, 5000).map((k) => (ROW_KINDS.has(k as string) ? k : 'leaf')),
    valueNames: arr(o.valueNames, 8).map((x) => str(x, MAX_LABEL)),
    valueCount: int(o.valueCount, 0, 8, 0),
    formats: arr(o.formats, 8).map((x) => str(x, 40)),
    showAs: arr(o.showAs, 8).map((x) => str(x, 40)),
    rowGroupCount: int(o.rowGroupCount, 0, 1_000_000, 0),
    colGroupCount: int(o.colGroupCount, 0, 1_000_000, 0),
    truncated: o.truncated === true,
  };
}

function sanitizeGeo(raw: unknown): unknown {
  const o = obj(raw);
  const level = GEO_LEVELS.has(o.level as string) ? o.level : 'country';
  const items = arr(o.items, 20_000).map((r) => {
    const i = obj(r);
    const out: Obj = { name: str(i.name, MAX_LABEL), value: num(i.value) };
    if (num(i.lat) !== null) out.lat = num(i.lat);
    if (num(i.lng) !== null) out.lng = num(i.lng);
    if (typeof i.color === 'string') out.color = str(i.color, MAX_LABEL);
    else if (num(i.color) !== null) out.color = num(i.color);
    return out;
  });
  return { level, items, points: o.points === true };
}

/** One tile answer: a chart, a metric, or a said-so error. */
export function sanitizePayload(raw: unknown): unknown {
  const o = obj(raw);
  if (typeof o.error === 'string') return { error: str(o.error, MAX_LABEL) };
  if ('display' in o || ('value' in o && !('labels' in o))) {
    return { value: num(o.value), display: str(o.display, 120), caption: str(o.caption, MAX_LABEL) };
  }
  const data: ExportChartData = sanitizeChartData(o);
  const out: Obj = {
    labels: data.labels.map((l) => (typeof l === 'string' ? l.slice(0, MAX_LABEL) : l)),
    series: data.series.map((s) => ({ label: s.label.slice(0, MAX_LABEL), values: s.values })),
    caption: str(o.caption, MAX_LABEL),
  };
  if (o.pivot) out.pivot = sanitizePivot(o.pivot);
  if (o.geo) out.geo = sanitizeGeo(o.geo);
  if (typeof o.hidden === 'string') out.hidden = str(o.hidden, MAX_LABEL);
  return out;
}

function sanitizeCard(raw: unknown): unknown {
  const o = obj(raw);
  const kind = o.kind;
  const layout = sanitizeLayout(o.layout);
  const title = str(o.title, MAX_LABEL);
  if (kind === 'text') return { kind, layout, title, heading: str(o.heading, MAX_LABEL), text: str(o.text) };
  if (kind === 'broken') return { kind, layout, title, reason: str(o.reason, MAX_LABEL) || 'Source removed' };
  if (kind !== 'chart' && kind !== 'metric') return null;
  const payloads = arr(o.payloads, 5000).map(sanitizePayload);
  const variants = arr(o.variants, 5000).map((v) => int(v, 0, Math.max(0, payloads.length - 1), 0));
  const card: Obj = { kind, layout, title, variants, payloads };
  if (kind === 'chart') {
    card.chartType = PUBLISHED_CHART_TYPES.has(o.chartType as string) ? o.chartType
      : PUBLISHED_AS.get(o.chartType as string) || 'column';
    card.category = str(o.category, MAX_LABEL);
  }
  return card;
}

function sanitizeControl(raw: unknown): unknown {
  const o = obj(raw);
  const options = arr(o.options, MAX_OPTIONS).map((x) => str(x, MAX_LABEL));
  return {
    id: str(o.id, 64),
    label: str(o.label, MAX_LABEL),
    kind: CONTROL_KINDS.has(o.kind as string) ? o.kind : 'dropdown',
    column: str(o.column, MAX_LABEL),
    options: options.length ? options : ['All'],
    defaultIndex: int(o.defaultIndex, 0, Math.max(0, options.length - 1), 0),
  };
}

function sanitizeDashboard(raw: unknown): unknown {
  const o = obj(raw);
  // The fields a dashboard export already has go through ITS whitelist.
  const base = sanitizeBundle({ name: o.name, style: o.style, brand: o.brand, controlsSummary: o.controlsSummary, pages: [] });
  const keys = arr(o.keys, 5000).map((k) => str(k, 64)).filter((k) => KEY_RE.test(k));
  return {
    name: base.name,
    style: base.style,
    brand: base.brand,
    controls: arr(o.controls, 16).map(sanitizeControl),
    mode: o.mode === 'single' ? 'single' : 'all',
    keys: keys.length ? keys : [''],
    sheets: arr(o.sheets, 50).map((sh) => {
      const s = obj(sh);
      return { name: str(s.name, MAX_LABEL) || 'Sheet', cards: arr(s.cards, 400).map(sanitizeCard).filter(Boolean) };
    }),
  };
}

function sanitizeBlock(raw: unknown): unknown {
  const o = obj(raw);
  switch (o.kind) {
    case 'text': return { kind: 'text', text: str(o.text) };
    case 'callout': return { kind: 'callout', tone: TONES.has(o.tone as string) ? o.tone : 'info', text: str(o.text) };
    case 'divider': return { kind: 'divider' };
    case 'image': {
      const src = typeof o.src === 'string' && RASTER_RE.test(o.src) ? o.src : '';
      return src ? { kind: 'image', src, alt: str(o.alt, MAX_LABEL), caption: str(o.caption, MAX_LABEL) } : null;
    }
    case 'chart': return {
      kind: 'chart', title: str(o.title, MAX_LABEL), caption: str(o.caption, MAX_LABEL),
      chartType: PUBLISHED_CHART_TYPES.has(o.chartType as string) ? o.chartType : 'column',
      data: sanitizePayload(o.data),
    };
    case 'metrics': return {
      kind: 'metrics', caption: str(o.caption, MAX_LABEL),
      metrics: arr(o.metrics, 8).map((m) => { const x = obj(m); return { name: str(x.name, MAX_LABEL), display: str(x.display, 120), value: num(x.value) }; }),
    };
    case 'broken': return { kind: 'broken', reason: str(o.reason, MAX_LABEL) || 'Source removed' };
    default: return null;
  }
}

/** A boundary set: names and coordinates, nothing else. */
export function sanitizeBoundary(raw: unknown): unknown {
  const o = obj(raw);
  const coords = (v: unknown, depth: number): unknown =>
    depth === 0 ? num(v) : arr(v, 1_000_000).map((x) => coords(x, depth - 1));
  const features = arr(o.features, 20_000).map((f) => {
    const x = obj(f);
    const p = obj(x.properties);
    const g = obj(x.geometry);
    const type = g.type === 'MultiPolygon' ? 'MultiPolygon' : 'Polygon';
    const props: Obj = { name: str(p.name, MAX_LABEL) };
    for (const k of ['iso2', 'state', 'kind']) if (typeof p[k] === 'string') props[k] = str(p[k], 80);
    return { properties: props, geometry: { type, coordinates: coords(g.coordinates, type === 'Polygon' ? 3 : 4) } };
  });
  return { features };
}

const SCORE_STATUS: ReadonlySet<string> = new Set(['good', 'warn', 'off', 'none']);
const SCORE_TONE: ReadonlySet<string> = new Set(['good', 'bad', 'flat', 'neutral']);

/** A scorecard page: display strings, finite numbers and closed enums only. */
function sanitizeScorecard(raw: unknown): Obj {
  const o = obj(raw);
  const w = obj(o.window);
  return {
    name: str(o.name, MAX_LABEL) || 'Scorecard',
    period: ['week', 'month', 'quarter', 'year'].includes(str(o.period)) ? str(o.period) : 'month',
    window: { label: str(w.label, 80), from: str(w.from, 10), to: str(w.to, 10) },
    rows: arr(o.rows, 60).map((r) => {
      const x = obj(r);
      return {
        name: str(x.name, MAX_LABEL), display: str(x.display, 80), targetDisplay: str(x.targetDisplay, 80),
        attainment: num(x.attainment), status: SCORE_STATUS.has(str(x.status)) ? str(x.status) : 'none',
        deltaDisplay: str(x.deltaDisplay, 80), pct: num(x.pct), tone: SCORE_TONE.has(str(x.tone)) ? str(x.tone) : 'flat',
        spark: arr(x.spark, 24).map(num), owner: str(x.owner, 80), group: str(x.group, 80),
      };
    }),
    groups: arr(o.groups, 60).map((g) => {
      const x = obj(g);
      return { group: str(x.group, 80), onTrack: int(x.onTrack, 0, 60, 0), scored: int(x.scored, 0, 60, 0), total: int(x.total, 0, 60, 0) };
    }),
  };
}

/**
 * One published page. `site` is the nav and the site-wide text; exactly one of
 * `dashboard` / `story` / `scorecard` is the page itself.
 */
export function sanitizePage(raw: unknown): Obj {
  const o = obj(raw);
  const site = obj(o.site);
  const geo: Obj = {};
  for (const [k, v] of Object.entries(obj(o.geo)).slice(0, 12)) {
    if (/^[a-z_]{2,20}$|^custom:[0-9a-f-]{36}$/i.test(k)) geo[k] = sanitizeBoundary(v);
  }
  const { brand, theme } = sanitizeBundle({ brand: o.brand, theme: o.theme, pages: [] });
  const out: Obj = {
    site: {
      title: str(site.title, MAX_LABEL) || 'Published dashboards',
      nav: sanitizeNav(site.nav),
      generatedAt: str(site.generatedAt, 40),
      logo: sanitizePng(site.logo) || undefined,
    },
    formats: sanitizeFormatPrefs(o.formats),
    brand,
    ...(theme ? { theme } : {}),
    geo,
  };
  if (o.kind === 'story') {
    const s = obj(o.story);
    out.kind = 'story';
    out.story = { name: str(s.name, MAX_LABEL) || 'Story', blocks: arr(s.blocks, 400).map(sanitizeBlock).filter(Boolean) };
  } else if (o.kind === 'scorecard') {
    out.kind = 'scorecard';
    out.scorecard = sanitizeScorecard(o.scorecard);
  } else if (o.kind === 'index') {
    out.kind = 'index';
  } else {
    out.kind = 'dashboard';
    out.dashboard = sanitizeDashboard(o.dashboard);
  }
  return out;
}
