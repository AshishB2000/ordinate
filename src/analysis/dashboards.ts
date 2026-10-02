// Card / Page shapes and their defensive sanitizers — MAIN PROCESS ONLY.
// The filename is historical (this module once persisted a separate "Dashboard"
// record; that published-snapshot artifact was deleted when Analyses became the
// single Dashboard surface). What remains, and what the rest of the app imports
// from here, is the shared structural vocabulary: the Card/Page/CardLayout/
// CardMetric/CardVisual/CardControl types and GRID_COLS, plus the sanitizers that
// clamp untrusted renderer/disk input onto them — plus, at the bottom, the
// DashboardStyle vocabulary (three orthogonal presentation axes + the four
// named presets) and its own clamp, which lives here for the same reason: it is
// shared by the record (analysis.ts), the IPC edge and the offline export, and a
// second copy of an enum whitelist is how enum whitelists drift apart.
// An Analysis sheet IS a `Page`;
// `src/analysis/analysis.ts` re-exports these types and calls sanitizePages /
// sanitizeDashboardFilters, and `src/ipc/dashboards.ts` uses sanitizeDashboardFilters
// for the metric-card filter path.
//
// Cards come in four types: visual (references a saved Visual by id), text
// (heading + body), metric (a dataset column + aggregation → ONE app-computed
// number, produced only by the pure metricValue.ts helper — never stored, never
// from the model), and control (a dropdown/multi-select/date-range filter widget —
// only its DEFINITION lives here; the reader's live selection becomes a FilterStep
// via dashboardFilters.ts's controlSteps).
//
// A card does NOT validate that referenced visualId/datasetId still exist — a
// dangling reference is handled gracefully at render time (the card shows a
// placeholder), so deleting a visual/dataset never corrupts a sheet.
//
// This module takes a VALUE import of ./visuals for its three CardVisual
// sanitizers. There is no cycle (visuals.ts imports projects/datasets/transforms
// and never dashboards), and calling the real sanitizers is deliberate: a
// CardVisual is untrusted renderer/disk input and duplicating a security
// whitelist is how whitelists drift.

import { randomUUID } from 'crypto';
import { sanitizeChartType, sanitizeEncoding, sanitizeOverrides, sanitizeFilters } from './visuals';
import type { Visual } from './visuals';
import { sanitizeSteps } from '../data/transforms';
import type { FilterStep } from '../data/transforms';
import { sanitizePeriod, sanitizeCompare } from './dateIntel';
import type { CompareMode, PeriodPreset } from './dateIntel';
import { sanitizeTableCalc } from './tableCalc';
import type { TableCalc } from './tableCalc';
import { themeModel } from './themeTokens';
import { sanitizeStatsSpec } from './stats/spec';
import type { StatsSpec } from './stats/spec';
import { sanitizeRadiusValue } from './geo/radius';
import type { RadiusValue } from './geo/radius';

// Tile actions and the card kinds beyond these four live in one PURE module
// the renderer loads too (renderer/hub/cardModel.ts, the geoMatch pattern), so
// what a card may store is decided here by the same code the editor runs.
const cardModel = require('../../renderer/hub/cardModel') as {
  EXTRA_TYPES: string[];
  sanitizeExtras: (o: Record<string, unknown>, card: Card) => boolean;
};

/** One tile on an EDITED tablet or phone layout (renderer/hub/sizeLayout.ts). */
export interface SizeItem { id: string; hidden?: true; h?: number }
export interface SizeLayout { items: SizeItem[] }
/** Only the sizes someone EDITED; a missing size is derived from desktop. */
export interface PageLayouts { tablet?: SizeLayout; phone?: SizeLayout }
export interface SizeCell { x: number; y: number; w: number; h: number }

// Layouts for every size, the same way: one pure module the hub loads too, so
// the whitelist below and the derivation the editor draws are the same code.
export const sizeLayout = require('../../renderer/hub/sizeLayout') as {
  SMALL_SIZES: Array<'tablet' | 'phone'>;
  BREAKPOINTS: { phone: number; tablet: number };
  COLS: Record<'desktop' | 'tablet' | 'phone', number>;
  pickSize: (width: number) => 'desktop' | 'tablet' | 'phone';
  presentSize: (width: number) => 'desktop' | 'tablet';
  sanitizeLayouts: (raw: unknown, cards: Card[]) => PageLayouts | undefined;
  resolve: (cards: Card[], stored: SizeLayout | undefined, size: string, viewHidden?: Set<string>) => {
    size: string; cols: number; edited: boolean; items: Array<SizeCell & { id: string }>; hidden: string[]; rows: number;
  };
  publishCells: (cards: Card[], layouts: PageLayouts | undefined) => Record<string, Partial<Record<'tablet' | 'phone', SizeCell | { hidden: true }>>>;
};

export type CardType = 'visual' | 'text' | 'metric' | 'control' | 'nav' | 'image' | 'divider' | 'container' | 'tabs' | 'stats' | 'summary';
export type CardAction = 'delete-sample';
export type MetricAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';
/**
 * `parameter` is the odd one out: it filters no column itself. It is the
 * reader's handle on one of the dashboard's `parameters` (analysis/params.ts),
 * which filters, formulas and titles reference by name.
 */
export type ControlKind = 'dropdown' | 'multi' | 'date_range' | 'parameter' | 'radius';

/**
 * The shape of a control's current (or author-set default) selection — one
 * variant per `ControlKind`. Shared between `CardControl.default` (an
 * AUTHORING-time value, sanitized/stored below) and `controlSteps`'s `state`
 * parameter (src/dashboardFilters.ts) — a READER's live selection, which is
 * deliberately never persisted here or anywhere else.
 */
export type ControlValue =
  | { value: string } // dropdown
  | { values: string[] } // multi
  | { from?: string; to?: string } // date_range: two fixed ISO dates…
  | { preset: PeriodPreset; n?: number } // …or a RELATIVE period, resolved at query time
  | RadiusValue; // radius (r6:geo) — a centre and a distance, see ./geo/radius

export interface CardControl {
  kind: ControlKind;
  label: string; // shown above the control
  datasetId: string; // where options come from (UUID-checked)
  column: string; // the column it filters
  default?: ControlValue; // optional author-set initial value
  /** `parameter` only: which of the dashboard's parameters this control moves.
   *  Its default is the parameter's own `value`, not `default` above. */
  paramId?: string;
  /** `radius` only: the longitude column; `column` is the latitude. */
  lngColumn?: string;
}

// The fixed column count the renderer's CSS grid uses (kept in sync with the
// .dash-grid class in hub.css). Exported so callers/tests share one source.
export const GRID_COLS = 12;

export interface CardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardMetric {
  datasetId: string;
  column: string;
  aggregation: MetricAggregation;
  label?: string;
  format?: 'auto' | 'plain' | 'thousands' | 'compact' | 'percent' | 'currency';
  /**
   * The saved Metric this card shows, when it shows one.
   *
   * ADDITIVE, and deliberately never a replacement: `column`/`aggregation` stay
   * REQUIRED and stay filled in, so a card whose metric was deleted keeps
   * showing its number the way a card with a dangling `visualId` keeps showing
   * a placeholder rather than corrupting the sheet. When present it wins — the
   * handler resolves the metric (which may be a formula no column/aggregation
   * pair could express) and formats with the metric's own format instead of
   * guessing one from `format` above.
   */
  metricId?: string;
  /**
   * Compare the figure with another period — computed on every render as a
   * SECOND scoped resolution (the same filters with their date ranges moved),
   * never stored. `from`/`to` only for `custom`.
   */
  compare?: { mode: CompareMode; from?: string; to?: string };
  /**
   * "Calculate as" — the figure as a table calculation over the metric's own
   * period series (ipc/tableCalc.ts), recomputed on every render, never stored.
   */
  calc?: TableCalc;
  /** Show the metric under this saved what-if scenario (src/analysis/scenarios.ts). */
  scenarioId?: string;
}

/**
 * A by-value copy of a Visual's DEFINITION, taken at publish time — NOT a copy
 * of its data. Every figure a published card shows is still recomputed on open
 * from the LIVE dataset (`visual:data` takes exactly these fields), so a
 * published dashboard shows current data through a frozen definition.
 *
 * Derived with `Pick<Visual, …>` on purpose: if `Visual` grows a field, this
 * type does not silently acquire it. This inline-snapshot shape is vestigial —
 * nothing populates `card.visual` now that publishing is gone — but the
 * sanitizer keeps handling it defensively so an old on-disk record never throws.
 */
export type CardVisual = Pick<
  Visual,
  'datasetId' | 'name' | 'chartType' | 'encoding' | 'overrides' | 'filters'
>;

export interface Card {
  id: string; // UUID — a stable key only, never a filesystem path
  type: CardType;
  layout: CardLayout;

  /** Authoring-time REFERENCE — analysis sheets and legacy dashboards. */
  visualId?: string; // type 'visual'

  /**
   * Publish-time SNAPSHOT. WHEN PRESENT IT WINS: no render path may resolve
   * `visualId`. A published card keeps `visualId` too, but only as (i) the
   * republish source and (ii) an "open the source visual" affordance.
   */
  visual?: CardVisual; // type 'visual'

  heading?: string; // type 'text'
  text?: string; // type 'text'
  /**
   * An app-owned button on a text card. A closed one-value enum, and the ONLY
   * value is the bundled sample's "delete this project".
   *
   * Deliberately absent from PlannedText, so no plan — and therefore no
   * model-authored dashboard — can grow a delete button on someone's sheet. The
   * only writer is src/app/sampleProject.ts, patching its own note card.
   */
  action?: CardAction; // type 'text'
  metric?: CardMetric; // type 'metric'
  control?: CardControl; // type 'control'
  /** Click / menu / hover behaviours of a visual tile (renderer/hub/cardModel.ts). */
  // ponytail: shapes owned and sanitized by cardModel; typed loosely across the require
  actions?: any[]; // type 'visual'
  nav?: any; // type 'nav'
  image?: any; // type 'image' — a project asset (app/projectAssets.ts), fit, alt
  divider?: any; // type 'divider'
  container?: any; // type 'container' — title, background, padding, collapsible
  tabs?: any; // type 'tabs' — the named tabs
  /** type 'stats' — the analysis SPEC only (analysis/stats/spec.ts); figures are recomputed on every render. */
  stats?: StatsSpec;
  /** The container / tabs card this card sits in, and which tab. Cards stay a flat list. */
  parentId?: string;
  tabId?: string;
}

export interface Page {
  id: string;
  name: string;
  cards: Card[];
  /** Edited tablet / phone layouts. Absent = both derived from the cards' desktop grid. */
  layouts?: PageLayouts;
}

// Ids arrive from the renderer over IPC. Validate the SHAPE before either id ever
// reaches a filesystem path — an id like ".." would otherwise escape the project's
// dashboards dir. Copied verbatim from visuals.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

const CARD_TYPES: ReadonlySet<string> = new Set(['visual', 'text', 'metric', 'control', ...cardModel.EXTRA_TYPES, 'stats', 'summary']);
/** Exported so analysisPlan's metric validation clamps against THIS set rather
 *  than a fourth copy of it — dashboardDelta.ts already restates one, and it
 *  says so apologetically. One whitelist, one place to widen it. */
export const METRIC_AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const CONTROL_KINDS: ReadonlySet<string> = new Set(['dropdown', 'multi', 'date_range', 'parameter', 'radius']);
const METRIC_FORMATS: ReadonlySet<string> = new Set([
  'auto',
  'plain',
  'thousands',
  'compact',
  'percent',
  'currency',
]);

// ── Defensive whitelisting (never throw — "keep known keys, clamp, drop rest") ──

// Coerce one field to a finite non-negative integer with a fallback.
function intOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

// Clamp an untrusted layout onto the fixed grid: w ∈ [1, GRID_COLS], h ≥ 1,
// x ∈ [0, GRID_COLS-1], y ≥ 0, and x + w ≤ GRID_COLS (overflow shrinks w).
export function sanitizeLayout(raw: unknown): CardLayout {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  let x = intOr(o.x, 0);
  let y = intOr(o.y, 0);
  let w = intOr(o.w, 1);
  let h = intOr(o.h, 1);

  if (x < 0) x = 0;
  if (x > GRID_COLS - 1) x = GRID_COLS - 1;
  if (y < 0) y = 0;
  if (w < 1) w = 1;
  if (w > GRID_COLS) w = GRID_COLS;
  if (h < 1) h = 1;
  if (x + w > GRID_COLS) w = GRID_COLS - x; // overflow shrinks width

  return { x, y, w, h };
}

/**
 * Whitelist an untrusted inline visual snapshot. DELEGATES to the real
 * visuals.ts sanitizers (`sanitizeChartType`/`sanitizeEncoding`/
 * `sanitizeOverrides`/`sanitizeFilters`) rather than reimplementing them, so a
 * published card can never be a looser whitelist than the Visual it was copied
 * from. Returns null when there is no dataset to draw from — a snapshot without
 * one carries nothing renderable.
 *
 * `datasetId` is checked as a non-empty string, not as a UUID, matching the
 * metric-card rule above: it never touches a path here, and every consumer
 * (`datasets.getDataset`/`getDatasetMeta`) re-validates the UUID shape before
 * one is built.
 */
export function sanitizeCardVisual(raw: unknown): CardVisual | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const datasetId = typeof o.datasetId === 'string' ? o.datasetId : '';
  if (!datasetId) return null;
  const chartType = sanitizeChartType(o.chartType);
  const encoding = sanitizeEncoding(o.encoding);
  return {
    datasetId,
    name: typeof o.name === 'string' ? o.name : '',
    chartType,
    encoding,
    overrides: sanitizeOverrides(o.overrides, { chartType, encoding }),
    filters: sanitizeFilters(o.filters),
  };
}

// Whitelist an untrusted control `default` (or, via controlSteps, a live
// selection of the same shape) against the ONE variant its own `kind` allows —
// a dropdown default carrying `{values:[...]}` (the multi shape) is a shape
// mismatch, not a value error, so it is silently stripped rather than dropping
// the whole card (same severity as an unrecognized `metric.format` above).
// Absence (or an object with none of the fields for this kind) → undefined,
// which callers treat as "no default".
function sanitizeControlDefault(kind: ControlKind, raw: unknown): ControlValue | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return undefined;

  if (kind === 'dropdown') {
    return typeof o.value === 'string' ? { value: o.value } : undefined;
  }
  if (kind === 'multi') {
    if (!Array.isArray(o.values)) return undefined;
    return { values: o.values.filter((v): v is string => typeof v === 'string') };
  }
  if (kind === 'radius') return sanitizeRadiusValue(o);
  // date_range — a relative preset wins over dates when both are present.
  if (typeof o.preset === 'string' && o.preset !== 'custom') {
    const p = sanitizePeriod(o);
    if (!p) return undefined;
    return p.n != null ? { preset: p.preset, n: p.n } : { preset: p.preset };
  }
  const from = typeof o.from === 'string' ? o.from : undefined;
  const to = typeof o.to === 'string' ? o.to : undefined;
  if (from === undefined && to === undefined) return undefined;
  const out: { from?: string; to?: string } = {};
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out;
}

// Whitelist one untrusted card by type. An unknown type, or a type missing its
// required payload, → null (dropped by sanitizeCards). Each card gets a stable
// UUID key (a stray/invalid stored id is regenerated).
export function sanitizeCard(raw: unknown): Card | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const type = typeof o.type === 'string' && CARD_TYPES.has(o.type) ? (o.type as CardType) : null;
  if (!type) return null;

  const id = isValidId(o.id) ? o.id : randomUUID();
  const layout = sanitizeLayout(o.layout);
  const card: Card = { id, type, layout };
  if (!cardModel.sanitizeExtras(o, card)) return null;
  if (cardModel.EXTRA_TYPES.includes(type)) return card;

  // The Summary card stores nothing: its sentences are recomputed from the
  // sheet's own tiles on every render (src/ipc/summary.ts).
  if (type === 'summary') return card;

  if (type === 'stats') {
    // A statistics tile stores its SPEC, whitelisted field by field; a card
    // with no valid spec has nothing to compute and is dropped.
    const stats = sanitizeStatsSpec(o.stats);
    if (!stats) return null;
    card.stats = stats;
    return card;
  }

  if (type === 'visual') {
    // TWO-SHAPED (v3): a visual card is meaningful with a valid `visualId`
    // (authoring) OR a well-formed inline `visual` (published). Both may be
    // present — a published card keeps its reference for republish — and a card
    // carrying NEITHER still has nothing to draw, so it is dropped as before.
    if (isValidId(o.visualId)) card.visualId = o.visualId;
    const inline = sanitizeCardVisual(o.visual);
    if (inline) card.visual = inline;
    if (card.visualId === undefined && card.visual === undefined) return null;
    return card;
  }

  if (type === 'text') {
    if (typeof o.heading === 'string') card.heading = o.heading;
    if (typeof o.text === 'string') card.text = o.text;
    if (o.action === 'delete-sample') card.action = 'delete-sample';
    // A text card with neither heading nor body carries no content → drop it.
    if (card.heading === undefined && card.text === undefined) return null;
    return card;
  }

  if (type === 'control') {
    // needs a known kind + a UUID-checked datasetId + a non-empty column —
    // unknown kind, same discipline as the whole-card `type` check above,
    // drops the card; an invalid datasetId drops it too (unlike metric's
    // datasetId, which never touches a path, this one is explicitly
    // UUID-checked per the spec). `column` is required like metric's own
    // column/aggregation (it decides what the control actually filters — a
    // blank one would silently no-op every FilterStep it produces); `label`
    // stays optional/decorative, so it alone defaults rather than dropping.
    const c = o.control && typeof o.control === 'object' ? (o.control as Record<string, unknown>) : null;
    if (!c) return null;
    const kind =
      typeof c.kind === 'string' && CONTROL_KINDS.has(c.kind) ? (c.kind as ControlKind) : null;
    // A PARAMETER control filters no column: it needs only the id of the
    // parameter it moves. A dangling id degrades to a "parameter removed" chip.
    if (kind === 'parameter') {
      if (!isValidId(c.paramId)) return null;
      card.control = {
        kind, label: typeof c.label === 'string' ? c.label : '', datasetId: '', column: '', paramId: c.paramId,
      };
      return card;
    }
    const column = typeof c.column === 'string' ? c.column : '';
    if (!kind || !isValidId(c.datasetId) || !column) return null;
    const control: CardControl = {
      kind,
      label: typeof c.label === 'string' ? c.label : '',
      datasetId: c.datasetId,
      column,
    };
    // A radius reads TWO columns; without the longitude it filters nothing.
    if (kind === 'radius') {
      if (typeof c.lngColumn !== 'string' || !c.lngColumn) return null;
      control.lngColumn = c.lngColumn;
    }
    const def = sanitizeControlDefault(kind, c.default);
    if (def) control.default = def;
    card.control = control;
    return card;
  }

  // metric — needs a dataset column + a known aggregation.
  const m = o.metric && typeof o.metric === 'object' ? (o.metric as Record<string, unknown>) : null;
  if (!m) return null;
  const datasetId = typeof m.datasetId === 'string' ? m.datasetId : '';
  const column = typeof m.column === 'string' ? m.column : '';
  const aggregation =
    typeof m.aggregation === 'string' && METRIC_AGGS.has(m.aggregation)
      ? (m.aggregation as MetricAggregation)
      : null;
  // UUID-shaped only: this id reaches a filesystem path in the metrics store,
  // and the guard belongs at the edge that accepts it, not at the one that
  // uses it.
  const metricId = typeof m.metricId === 'string' && UUID_RE.test(m.metricId) ? m.metricId : '';
  // A card that names a saved Metric may legitimately have NO column: a formula
  // metric (`[Profit] / [Revenue]`) is not a column rolled up, and there is
  // nothing honest to put there. Every other metric card still requires one —
  // without a metricId, a card with no column is a card with no number.
  if (!datasetId || !aggregation || (!column && !metricId)) return null;
  const metric: CardMetric = { datasetId, column, aggregation };
  if (typeof m.label === 'string') metric.label = m.label;
  if (metricId) metric.metricId = metricId;
  if (typeof m.format === 'string' && METRIC_FORMATS.has(m.format)) {
    metric.format = m.format as CardMetric['format'];
  }
  const compare = sanitizeCompare(m.compare);
  if (compare) metric.compare = compare;
  const calc = sanitizeTableCalc(m.calc);
  if (calc) metric.calc = calc;
  if (metricId && typeof m.scenarioId === 'string' && UUID_RE.test(m.scenarioId)) metric.scenarioId = m.scenarioId;
  card.metric = metric;
  return card;
}

// Map+filter: keep only cards that survive sanitizeCard.
export function sanitizeCards(raw: unknown): Card[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: Card[] = [];
  for (const c of arr) {
    const card = sanitizeCard(c);
    if (card) out.push(card);
  }
  return out;
}

// Whitelist one page: a UUID id (regenerated if missing/invalid), a non-empty
// name (defaulted), sanitized cards, and any edited tablet/phone layouts.
export function sanitizePage(raw: unknown): Page {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = isValidId(o.id) ? o.id : randomUUID();
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Page 1';
  const cards = sanitizeCards(o.cards);
  // Against the SANITIZED cards: a card whose id was regenerated above, or that
  // was dropped, takes its layout entries with it.
  const layouts = sizeLayout.sanitizeLayouts(o.layouts, cards);
  return layouts ? { id, name, cards, layouts } : { id, name, cards };
}

// Whitelist the pages array. A dashboard always has ≥1 page — an empty/invalid
// input yields a single default page.
export function sanitizePages(raw: unknown): Page[] {
  const arr = Array.isArray(raw) ? raw : [];
  const pages = arr.map((p) => sanitizePage(p));
  if (pages.length === 0) return [{ id: randomUUID(), name: 'Page 1', cards: [] }];
  return pages;
}

// ── Dashboard style ─────────────────────────────────────────────────────────
//
// PRESENTATION ONLY, on three ORTHOGONAL axes: theme owns the surface/text/
// border tokens, density owns the grid gap + row height, accent owns
// --accent*/--chart*. They compile to three CSS classes applied together on one
// element (`dash-theme--x dash-density--y dash-accent--z`), so adding a theme
// never means restating every accent.
//
// A style must NEVER move a card. The grid stays GRID_COLS wide in every
// preset, because a card's x/w are layout COORDINATES: a "restyle" that also
// re-flowed the sheet would silently re-author work the user placed by hand.

export interface DashboardStyle {
  /**
   * 'auto' declares NO tokens, so the sheet inherits the app's [data-theme] —
   * which is what a dashboard nobody has restyled should do. The other three are
   * deliberate overrides: a dashboard can be pinned light or dark for presenting
   * regardless of how the app is set.
   */
  theme: 'auto' | 'clean' | 'executive' | 'dark';
  density: 'comfortable' | 'compact';
  accent: 'blue' | 'teal' | 'slate';
  /** A custom accent, `#rrggbb`. Wins over `accent` and over the workspace's
   *  brand accent, for this dashboard only. Strict hex, so safe in CSS. */
  accentHex?: string;
  /** Which logo this dashboard's surfaces carry. Absent = the workspace's;
   *  'custom' = its own, stored in userData/branding (app/branding.ts). */
  logo?: 'none' | 'custom';
  /** A workspace theme (src/app/themeStore.ts) over the three axes: a theme's
   *  UUID, or 'none' to opt out of the workspace default. Absent = follow the
   *  workspace. An id that no longer resolves falls through, never breaks. */
  themeId?: string;
  /** The user (or the Assistant on their behalf) picked this, so it is an
   *  override to keep rather than a default to migrate. Absent means defaulted. */
  chosen?: true;
}

export const DEFAULT_DASHBOARD_STYLE: DashboardStyle = {
  theme: 'auto',
  density: 'comfortable',
  accent: 'blue',
};

/**
 * The named triples the picker offers. A preset is a SHORTCUT over the three
 * axes, never a fourth axis — nothing is persisted as "the executive preset",
 * only as the triple it expands to, so a user who nudges one axis afterwards
 * does not end up with a record that lies about which preset it is.
 */
export type DashboardStylePreset = 'auto' | 'clean' | 'executive' | 'dense' | 'dark';

export const DASHBOARD_STYLE_PRESETS: Record<DashboardStylePreset, DashboardStyle> = {
  // `auto` is the one that declares nothing and follows the app. `clean` is the
  // same look pinned, for a dashboard that must stay light whatever the app is.
  auto: { theme: 'auto', density: 'comfortable', accent: 'blue' },
  clean: { theme: 'clean', density: 'comfortable', accent: 'blue', chosen: true },
  executive: { theme: 'executive', density: 'comfortable', accent: 'slate', chosen: true },
  dense: { theme: 'auto', density: 'compact', accent: 'blue' },
  dark: { theme: 'dark', density: 'comfortable', accent: 'blue', chosen: true },
};

const STYLE_THEMES: ReadonlySet<string> = new Set(['auto', 'clean', 'executive', 'dark']);
const STYLE_DENSITIES: ReadonlySet<string> = new Set(['comfortable', 'compact']);
const STYLE_ACCENTS: ReadonlySet<string> = new Set(['blue', 'teal', 'slate']);

/**
 * Clamp an untrusted style onto the three closed enums. Differs from
 * visuals.sanitizeOverrides in one way that matters: there an unrecognized enum
 * is DROPPED (absence means "use the buildChart default"), but every axis here
 * is REQUIRED — a style with no theme has no meaning — so a junk value falls
 * back to that axis's default instead.
 *
 * Nothing from `raw` is ever echoed. Each field is one of the three literals
 * that was already a member of the allowed set, which is what makes the result
 * safe to interpolate into a class name and into exported CSS. Never throws:
 * a non-object (null, a number, an array, a string) is simply the default.
 *
 * Returns a FRESH object every call. Handing out DEFAULT_DASHBOARD_STYLE itself
 * would let one caller's `style.theme = 'dark'` restyle every record that had
 * ever defaulted — the same aliasing bug a shared `[]` literal causes.
 */
export function sanitizeStyle(raw: unknown): DashboardStyle {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  // MIGRATION, no version bump. 'clean' used to be the default, so almost every
  // stored 'clean' was written by that default rather than chosen — and it pins
  // the light tokens on the sheet, which is why a dark app showed white
  // dashboards. A 'clean' the user actually picked carries `chosen`, and keeps
  // its override; one without it is read as 'auto' and follows the app.
  const chosen = o.chosen === true;
  const rawTheme = typeof o.theme === 'string' && STYLE_THEMES.has(o.theme)
    ? (o.theme as DashboardStyle['theme'])
    : DEFAULT_DASHBOARD_STYLE.theme;
  const theme = rawTheme === 'clean' && !chosen ? 'auto' : rawTheme;
  return {
    theme,
    density:
      typeof o.density === 'string' && STYLE_DENSITIES.has(o.density)
        ? (o.density as DashboardStyle['density'])
        : DEFAULT_DASHBOARD_STYLE.density,
    accent:
      typeof o.accent === 'string' && STYLE_ACCENTS.has(o.accent)
        ? (o.accent as DashboardStyle['accent'])
        : DEFAULT_DASHBOARD_STYLE.accent,
    ...(typeof o.accentHex === 'string' && /^#[0-9a-f]{6}$/i.test(o.accentHex)
      ? { accentHex: o.accentHex.toLowerCase() } : {}),
    ...(o.logo === 'none' || o.logo === 'custom' ? { logo: o.logo } : {}),
    ...(themeModel.sanitizeThemeId(o.themeId) ? { themeId: themeModel.sanitizeThemeId(o.themeId) } : {}),
    // Last, so a preset literal and its sanitized copy serialise identically.
    ...(chosen ? { chosen: true as const } : {}),
  };
}

// Whitelist untrusted dashboard-wide filters: delegate to the shared
// transforms.sanitizeSteps (drops unknown types/fields) and keep ONLY `filter`
// steps — a dashboard filter is a row predicate, never a column-mutating transform.
// A non-array / absent input → [] (backward-compatible v1 → v2 default). Kept
// separate from visuals.sanitizeFilters because these are the DASHBOARD's own
// filters, not a visual's — the two happen to share a rule, not a meaning.
// (This module does import visuals.ts as of v3, for the CardVisual sanitizers.)
export function sanitizeDashboardFilters(raw: unknown): FilterStep[] {
  return sanitizeSteps(raw).filter((s): s is FilterStep => s.type === 'filter');
}
