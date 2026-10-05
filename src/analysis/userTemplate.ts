// USER TEMPLATES — a dashboard turned into a template, captured. MAIN PROCESS,
// PURE: records in, a template out. No fs, no model.
//
// A user template is the dashboard's STRUCTURE with every column it names
// replaced by a ROLE (userTemplateRefs.ts): sheets and cards with their layouts
// for every size, the dashboard's filters, style and parameters, each visual's
// whole spec (encoding, styling overrides, filters, analytics), the calculated
// fields those read, and the saved metrics the KPI tiles and text tokens name.
// Applying it (userTemplateApply.ts) maps roles to another dataset's columns
// through the SAME `mapRoles` the built-in gallery uses, then writes the refs
// back.
//
// ONE DATASET. A template binds the dashboard's main dataset — the one most of
// its tiles read. A tile on any other dataset is left out and counted, so the
// dialog can say so, rather than carried as a reference that could never map.

import type { ParsedColumn } from '../data/parse';
import type { ColumnSummary } from '../data/datasetStats';
import { words } from './starterPlan';
import type { RoleKind, TemplateRole } from './templateRoles';
import { formulaToRefs, jsonToRefs, type RefNames } from './userTemplateRefs';

export const TEMPLATE_FORMAT = 'ordinate-template';
export const TEMPLATE_VERSION = 1;

export interface TemplateVisual { ref: string; spec: Record<string, unknown> }
export interface TemplateCalc { ref: string; name: string; expression: string }
export interface TemplateMetric { ref: string; name: string; spec: Record<string, unknown> }

export interface TemplateBody {
  sheets: unknown[];
  filters: unknown[];
  style: unknown;
  parameters: unknown[];
  visuals: TemplateVisual[];
  calcFields: TemplateCalc[];
  metrics: TemplateMetric[];
}

export interface UserTemplate {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  roles: TemplateRole[];
  body: TemplateBody;
  /** `data:image/png;base64,…`, rendered from the source dashboard. '' = none. */
  thumbnail: string;
  /** The dashboard it was captured from — what makes it travel with a bundle. */
  sourceAnalysisId?: string;
}

/** A role as the Save dialog shows it: where it came from and where it is used. */
export interface CapturedRole extends TemplateRole {
  column: string;
  uses: number;
  where: string[];
}

export interface CaptureInput {
  analysis: { id?: string; name: string; sheets: unknown[]; filters?: unknown[]; style?: unknown; parameters?: unknown[] };
  /** The visuals the cards reference, by id. Others are ignored. */
  visuals: Array<{ id: string; name: string; datasetId: string; chartType: string; encoding: unknown; overrides?: unknown; filters?: unknown; analytics?: unknown }>;
  dataset: { id: string; columns: ParsedColumn[]; steps?: unknown[]; summaries?: ColumnSummary[] };
  /** The project's metrics; only the main dataset's referenced ones are kept. */
  metrics: Array<{ id: string; name: string; datasetId: string; definition: unknown; filters?: unknown; format?: unknown; description?: unknown; direction?: unknown }>;
}

export interface CaptureResult {
  roles: CapturedRole[];
  body: TemplateBody;
  /** Tiles left out because they read another dataset. */
  skipped: number;
  tiles: number;
}

const NOT_A_MEASURE = new Set(['id', 'code', 'zip', 'postcode', 'year', 'month', 'day', 'week', 'quarter',
  'lat', 'lon', 'lng', 'latitude', 'longitude']);
const ID_WORDS = new Set(['id', 'code', 'key', 'sku', 'uuid', 'email', 'number', 'no']);
/** Geo levels whose category column holds PLACE NAMES (not coordinates). */
const NAMED_GEO = new Set(['country', 'us_state', 'us_county', 'us_city', 'us_zip', 'world_city', 'custom']);
const DATASET_KEYS = ['datasetId', 'categoryDatasetId', 'seriesDatasetId'];
const ID_DISTINCT_MIN = 200;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

/** Every string under a dataset-id key, anywhere in v. */
function datasetIdsIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) datasetIdsIn(x, out); return out; }
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v as Obj)) {
    if (DATASET_KEYS.includes(k) && typeof x === 'string' && x) out.push(x);
    else datasetIdsIn(x, out);
  }
  return out;
}

/** Every `metricId` string anywhere in v. */
function metricIdsIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) metricIdsIn(x, out); return out; }
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v as Obj)) {
    if (k === 'metricId' && typeof x === 'string') out.push(x);
    else metricIdsIn(x, out);
  }
  return out;
}

/** "order_date" → "Order date". */
export function roleLabel(column: string): string {
  const s = words(column).join(' ') || column;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Name fragments the mapper matches on: the whole name, then its words. */
export function roleHints(column: string): string[] {
  const ws = words(column);
  return Array.from(new Set(ws.length > 1 ? [ws.join(' '), ...ws] : ws));
}

/**
 * The part a column plays, from its DECLARED type first and its usage second —
 * the same type gate `mapRoles` applies, so an inferred role can always map
 * back onto the column it came from.
 */
export function inferKind(col: ParsedColumn, geoUsed: boolean, s?: ColumnSummary): RoleKind {
  const ws = words(col.name);
  if (col.type === 'date') return 'date';
  if (col.type === 'number') return ws.some((w) => NOT_A_MEASURE.has(w) || ID_WORDS.has(w)) ? 'id' : 'measure';
  if (geoUsed) return 'geo';
  const distinct = s && typeof s.distinct === 'number' ? s.distinct : 0;
  const ratio = s && s.nonEmpty ? distinct / s.nonEmpty : 0;
  if (ws.some((w) => ID_WORDS.has(w)) || (distinct > ID_DISTINCT_MIN && ratio > 0.5)) return 'id';
  return 'dimension';
}

/** What the dialog calls an element when it says where a role is used. */
function cardLabel(c: Obj, visualName: (id: string) => string): string {
  const m = obj(c.metric);
  const ctl = obj(c.control);
  if (c.type === 'visual') return visualName(String(c.visualId || ''));
  if (c.type === 'metric') return String(m.label || m.column || 'KPI');
  if (c.type === 'control') return `${String(ctl.label || ctl.column || 'Control')} filter`;
  return String(c.type || 'Tile');
}

/**
 * Capture a dashboard as a template body plus the roles it needs.
 */
export function captureTemplate(input: CaptureInput): CaptureResult {
  const ds = input.dataset;
  const dsId = ds.id;
  const visualById = new Map(input.visuals.map((v) => [v.id, v]));
  const onDs = (v: unknown): boolean => datasetIdsIn(v).every((id) => id === dsId);
  const visualOk = (id: string): boolean => {
    const v = visualById.get(id);
    return !!v && v.datasetId === dsId && onDs(v.encoding);
  };

  // 1. The cards this dataset can carry. Sample-only `action` buttons and a
  //    project's what-if scenario do not travel.
  let skipped = 0;
  let tiles = 0;
  const sheets: Obj[] = [];
  for (const raw of input.analysis.sheets || []) {
    const page = obj(raw);
    const cards: Obj[] = [];
    for (const rc of Array.isArray(page.cards) ? page.cards : []) {
      const c = { ...obj(rc) };
      const keep = c.type === 'visual' ? visualOk(String(c.visualId || ''))
        : c.type === 'metric' || c.type === 'control' || c.type === 'stats' ? onDs(c) : true;
      if (!keep) { skipped += 1; continue; }
      delete c.action;
      if (c.metric) { const m = { ...obj(c.metric) }; delete m.scenarioId; c.metric = m; }
      cards.push(c);
      tiles += 1;
    }
    sheets.push({ ...page, cards });
  }
  const visualIds: string[] = [];
  for (const p of sheets) {
    for (const c of p.cards as Obj[]) {
      const id = String(c.visualId || '');
      if (c.type === 'visual' && !visualIds.includes(id)) visualIds.push(id);
    }
  }
  const visualSpec = (id: string): Obj => {
    const v = visualById.get(id)!;
    const spec: Obj = { name: v.name, chartType: v.chartType, encoding: v.encoding, overrides: v.overrides || {}, filters: v.filters || [] };
    if (v.analytics) spec.analytics = v.analytics;
    return spec;
  };
  const filters = (Array.isArray(input.analysis.filters) ? input.analysis.filters : []).filter(onDs);
  const parameters = Array.isArray(input.analysis.parameters) ? input.analysis.parameters : [];

  // 2. The metrics: named by a tile's metricId, a measure's metricId or a
  //    `{{token}}`, then every metric those formulas name — this dataset's only.
  const dsMetrics = input.metrics.filter((m) => m.datasetId === dsId);
  const wanted = new Set<string>(metricIdsIn([sheets, visualIds.map(visualSpec)]));
  const tokenNames: string[] = [];
  const allNames: RefNames = { columns: new Map(), metrics: new Map(dsMetrics.map((m) => [m.name.toLowerCase(), m.id])), ids: new Map() };
  jsonToRefs([sheets, visualIds.map(visualSpec)], allNames, (id) => tokenNames.push(id));
  for (const id of tokenNames) wanted.add(id);
  const ordered: typeof dsMetrics = [];
  const visit = (m: (typeof dsMetrics)[number], seen: Set<string>): void => {
    if (ordered.includes(m) || seen.has(m.id)) return;
    seen.add(m.id);
    const f = obj(m.definition).formula;
    if (typeof f === 'string') {
      // Dependencies first, so a formula metric is created after what it names.
      formulaToRefs(f, allNames, 'metric', (id) => {
        const dep = dsMetrics.find((x) => x.id === id);
        if (dep) visit(dep, seen);
      });
    }
    ordered.push(m);
  };
  for (const m of dsMetrics) if (wanted.has(m.id)) visit(m, new Set());
  const metricSpec = (m: (typeof dsMetrics)[number]): Obj => {
    const spec: Obj = { definition: m.definition, filters: m.filters || [], format: m.format || {} };
    if (m.description) spec.description = m.description;
    if (m.direction) spec.direction = m.direction;
    return spec;
  };

  // 3. Which columns are used — through cards, visuals, filters, parameters,
  //    metrics and, transitively, the calculated fields those read.
  const colNames = new Set(ds.columns.map((c) => c.name));
  const ident: RefNames = { columns: new Map([...colNames].map((n) => [n, n])), metrics: new Map(), ids: new Map() };
  const used = new Set<string>();
  jsonToRefs([sheets, visualIds.map(visualSpec), filters, parameters, ordered.map(metricSpec)], ident, (n) => used.add(n));
  const calcSteps = new Map<string, string>();
  for (const s of Array.isArray(ds.steps) ? ds.steps : []) {
    const o = obj(s);
    if (o.type === 'calculated_field' && typeof o.name === 'string' && typeof o.expression === 'string') calcSteps.set(o.name, o.expression);
  }
  const queue = [...used].filter((n) => calcSteps.has(n));
  while (queue.length) {
    const n = queue.shift()!;
    formulaToRefs(calcSteps.get(n)!, ident, 'calc', (x) => {
      if (used.has(x)) return;
      used.add(x);
      if (calcSteps.has(x)) queue.push(x);
    });
  }

  // 4. Ids. Roles in the dataset's column order; calculated fields in pipeline
  //    order (so one that reads another comes after it); visuals and metrics in
  //    the order the sheet uses them.
  const names: RefNames = { columns: new Map(), metrics: new Map(), ids: new Map([[dsId, 'ds']]) };
  const roleCols = ds.columns.filter((c) => used.has(c.name) && !calcSteps.has(c.name));
  roleCols.forEach((c, i) => names.columns.set(c.name, 'r' + (i + 1)));
  const calcNames = [...calcSteps.keys()].filter((n) => used.has(n));
  calcNames.forEach((n, i) => names.columns.set(n, 'c' + (i + 1)));
  ordered.forEach((m, i) => { names.metrics.set(m.name.toLowerCase(), 'm' + (i + 1)); names.ids.set(m.id, 'm' + (i + 1)); });
  visualIds.forEach((id, i) => names.ids.set(id, 'v' + (i + 1)));

  // 5. The rewrite, counting every use of every role and naming where it is.
  const uses = new Map<string, number>();
  const where = new Map<string, Set<string>>();
  const counted = (label: string) => (id: string): void => {
    uses.set(id, (uses.get(id) || 0) + 1);
    if (!where.has(id)) where.set(id, new Set());
    where.get(id)!.add(label);
  };
  const visualName = (id: string): string => (visualById.get(id) || { name: 'Chart' }).name || 'Chart';
  const body: TemplateBody = {
    sheets: sheets.map((p) => ({
      ...p,
      cards: (p.cards as Obj[]).map((c) => jsonToRefs(c, names, c.type === 'visual' ? undefined : counted(cardLabel(c, visualName)))),
    })),
    filters: filters.map((f) => jsonToRefs(f, names, counted('Dashboard filter'))),
    style: input.analysis.style ?? {},
    parameters: parameters.map((p) => jsonToRefs(p, names, counted(`Parameter ${String(obj(p).name || '')}`.trim()))),
    visuals: visualIds.map((id) => ({ ref: names.ids.get(id)!, spec: jsonToRefs(visualSpec(id), names, counted(visualName(id))) as Obj })),
    calcFields: calcNames.map((n) => ({
      ref: names.columns.get(n)!,
      name: n,
      expression: formulaToRefs(calcSteps.get(n)!, names, 'calc', counted(`Calculated field ${n}`)),
    })),
    metrics: ordered.map((m) => ({ ref: names.ids.get(m.id)!, name: m.name, spec: jsonToRefs(metricSpec(m), names, counted(`Metric ${m.name}`)) as Obj })),
  };

  const geoUsed = new Set<string>();
  for (const id of visualIds) {
    const enc = obj(visualById.get(id)!.encoding);
    const geo = obj(enc.geo);
    if (typeof geo.level === 'string' && NAMED_GEO.has(geo.level) && typeof enc.category === 'string') geoUsed.add(enc.category);
  }
  const summary = (n: string): ColumnSummary | undefined => (ds.summaries || []).find((s) => s.name === n);
  const roles: CapturedRole[] = roleCols.map((c) => {
    const id = names.columns.get(c.name)!;
    return {
      id,
      label: roleLabel(c.name),
      kind: inferKind(c, geoUsed.has(c.name), summary(c.name)),
      required: true,
      hints: roleHints(c.name),
      column: c.name,
      uses: uses.get(id) || 0,
      where: [...(where.get(id) || [])],
    };
  });
  return { roles, body, skipped, tiles };
}

/** The dataset a dashboard is MOSTLY about: the one most of its tiles read. */
export function mainDatasetId(sheets: unknown[], visualDataset: (visualId: string) => string | undefined): string {
  const n = new Map<string, number>();
  for (const p of sheets) {
    for (const rc of Array.isArray(obj(p).cards) ? (obj(p).cards as unknown[]) : []) {
      const c = obj(rc);
      const id = c.type === 'visual' ? visualDataset(String(c.visualId || '')) : datasetIdsIn(c)[0];
      if (id) n.set(id, (n.get(id) || 0) + 1);
    }
  }
  let best = '';
  for (const [id, k] of n) if (!best || k > (n.get(best) || 0)) best = id;
  return best;
}
