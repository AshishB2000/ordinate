// EDIT DELTAS — the validator between an untrusted model envelope and a real
// mutation of an existing dashboard. MAIN PROCESS ONLY.
//
// `analysisPlan.validatePlan` decides what a model may CREATE. This decides what
// a model may CHANGE, and it is the stricter of the two: a create that lands
// wrong leaves a bad card next to good ones, while an edit that lands wrong
// silently rewrites a card the user built by hand. So the rules are the same
// ones, applied with less tolerance:
//
//   - PURE, SYNCHRONOUS, TOTAL. Never throws. Garbage in → `{ops: [], dropped:
//     [...]}` out. Every branch is a type guard, never a cast.
//   - DROP, NEVER REPAIR. An off-list chart type is dropped, not coerced to
//     'column'. An unresolvable tile is dropped, not guessed at.
//   - SANITISE, THEN VALIDATE. `visuals.sanitizeEncoding`/`sanitizeFilters`
//     first (they are the whitelist the rest of the app already trusts), then
//     existence and type checks against the real records in `ctx`.
//   - EVERY REFUSAL IS REPORTED, with a JSON path and a sentence naming the
//     offending value, because a user who asked for a change is owed the
//     difference between what was proposed and what was applied.
//   - DROP GRANULARITY MATCHES BLAST RADIUS. A bad field inside one op drops
//     THAT op; its siblings are unaffected.
//   - DETERMINISTIC. Same (envelope, context) ⇒ byte-identical result. No
//     clock, no randomness, no ambient state.
//
// What this module does NOT do: geometry. An op never carries x/y/w/h — the app
// packs cards onto the grid (dashboards.sanitizeLayout / the analysisPlan
// packer), and a model that tries to place a card by coordinate is refused
// rather than obeyed. `moveTile` says "top"/"before that one"; the app turns
// that into numbers.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import * as visuals from './visuals';
import type { VizEncoding } from './visuals';
import type { ControlKind, MetricAggregation } from './dashboards';
import { METRIC_AGGS } from './dashboards';
import { CHART_TYPE_IDS } from './analysisPlan';
import type { PlanDataset } from './analysisPlan';

/** Aggregations that need a `number` column — the same set `validatePlan` uses,
 *  restated because it is private there. `count` is the only one that works on
 *  any column: it counts non-empty cells (metricValue.computeMetric). */
const NUMERIC_AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'min', 'max', 'none']);

const CONTROL_KINDS: ReadonlySet<string> = new Set(['dropdown', 'multi', 'date_range']);

// ── Shapes ─────────────────────────────────────────────────────────────────

export type DeltaOpKind =
  | 'addTile' | 'addMetric' | 'replaceTileEncoding' | 'removeTile' | 'moveTile'
  | 'addControl' | 'renamePage' | 'addPage' | 'setTitle';

/** One existing tile, flattened for resolution. Titles come from the Visual
 *  record (visual cards), metric label, text heading, or control label. */
export interface DeltaTile {
  cardId: string;
  pageIndex: number;
  type: 'visual' | 'metric' | 'text' | 'control';
  title: string;
  visualId?: string;
  datasetId?: string;
  chartType?: string;
}

export interface DeltaContext {
  pages: { name: string; tileCount: number }[];
  tiles: DeltaTile[];
  datasets: PlanDataset[];
}

/** Named because it is the one op with optional fields, built up in steps. */
export interface ReplaceTileEncodingOp {
  op: 'replaceTileEncoding';
  cardId: string;
  /** Each present only when the model proposed a valid change to it. */
  chartType?: string;
  encoding?: VizEncoding;
  filters?: FilterStep[];
}

export type ValidatedDeltaOp =
  | {
      op: 'addTile';
      pageIndex: number;
      datasetId: string;
      name: string;
      chartType: string;
      encoding: VizEncoding;
      filters: FilterStep[];
    }
  | {
      op: 'addMetric';
      pageIndex: number;
      datasetId: string;
      column: string;
      aggregation: MetricAggregation;
      label: string;
    }
  | ReplaceTileEncodingOp
  | { op: 'removeTile'; cardId: string }
  | {
      op: 'moveTile';
      cardId: string;
      position: 'top' | 'bottom' | 'before' | 'after';
      /** Set for 'before'/'after', absent for 'top'/'bottom'. */
      anchorCardId?: string;
    }
  | {
      op: 'addControl';
      pageIndex: number;
      kind: ControlKind;
      datasetId: string;
      column: string;
      label: string;
    }
  | { op: 'renamePage'; pageIndex: number; name: string }
  | { op: 'addPage'; name: string }
  | { op: 'setTitle'; name: string };

export type DeltaDropKind =
  | 'op' | 'tile' | 'dataset' | 'chartType' | 'encoding' | 'filter'
  | 'control' | 'page' | 'position' | 'layout' | 'name';

export interface DeltaDrop {
  kind: DeltaDropKind;
  /** Where in the envelope it was, e.g. `ops[2]`. */
  where: string;
  /** Self-contained, user-facing. Shown verbatim. */
  message: string;
}

export interface ValidatedDelta {
  ops: ValidatedDeltaOp[];
  dropped: DeltaDrop[];
}

// ── Guards (identical to analysisPlan's, deliberately) ─────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function looksLikeObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ── Tile resolution ────────────────────────────────────────────────────────
//
// The model is shown TITLES, never card ids, so a reference has to be resolved
// approximately. A ladder, not a score: each rung is tried in full, and the
// first rung that produces EXACTLY ONE tile wins. Two matches on a rung is
// AMBIGUOUS and refused — editing the wrong tile is worse than editing none,
// and a "closest" tie-break is exactly the guess this module exists to avoid.
//
// This is deliberately NOT geoMatch.normalizeName: that one strips
// "city"/"town"/"county" to match place names, which would mangle a title like
// "Sales by City" into something that matches "Sales by Region".

/** Words a model habitually adds around a title that carry no identity. */
const STOPWORDS: ReadonlySet<string> = new Set(['the', 'a', 'an', 'chart', 'graph', 'tile', 'card', 'visual']);

function normalizeTitle(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export type TileMatch = { tile: DeltaTile } | { tile: null; reason: 'empty' | 'none' | 'ambiguous' };

/** Resolve a model-supplied tile reference to exactly one tile, or say why not. */
export function resolveTile(ctx: DeltaContext, query: unknown): TileMatch {
  const q = str(query);
  if (!q) return { tile: null, reason: 'empty' };
  const nq = normalizeTitle(q);
  const tokens = nq.split(' ').filter((t) => t && !STOPWORDS.has(t));
  const rungs: ((t: DeltaTile) => boolean)[] = [
    (t) => t.cardId === q,
    (t) => t.title === q,
    (t) => normalizeTitle(t.title) === nq,
    (t) => tokens.length > 0 && tokens.every((tok) => normalizeTitle(t.title).split(' ').includes(tok)),
  ];
  for (const rung of rungs) {
    const hits = ctx.tiles.filter(rung);
    if (hits.length === 1) return { tile: hits[0] };
    if (hits.length > 1) return { tile: null, reason: 'ambiguous' };
  }
  return { tile: null, reason: 'none' };
}

/** Turn a failed resolution into the one sentence the user sees. */
function tileDropMessage(at: string, ref: string, reason: 'empty' | 'none' | 'ambiguous'): string {
  if (reason === 'empty') return `${at} dropped: no tile named.`;
  if (reason === 'ambiguous') {
    return `${at} dropped: ${JSON.stringify(ref)} matches more than one tile — rename them or say which one.`;
  }
  return `${at} dropped: no tile called ${JSON.stringify(ref)}.`;
}

// ── Dataset / page / column helpers ────────────────────────────────────────

/** By id first, then by exact name — the model is given both. Mirrors
 *  analysisPlan.resolveDataset, which is private there. */
function resolveDataset(ctx: DeltaContext, raw: Record<string, unknown>): PlanDataset | null {
  const byId = str(raw.datasetId);
  if (byId) {
    const hit = ctx.datasets.find((d) => d.id === byId);
    if (hit) return hit;
  }
  const byName = str(raw.dataset) || str(raw.datasetName);
  if (byName) {
    const hit = ctx.datasets.find((d) => d.name === byName);
    if (hit) return hit;
  }
  return null;
}

function datasetRef(raw: Record<string, unknown>): string {
  return str(raw.dataset) || str(raw.datasetName) || str(raw.datasetId);
}

function columnTypes(ds: PlanDataset): Map<string, ParsedColumn['type']> {
  const m = new Map<string, ParsedColumn['type']>();
  for (const c of ds.columns) m.set(c.name, c.type);
  return m;
}

/**
 * A page reference, normalised to a 0-based index.
 *
 * Three spellings, because a model uses all three: `pageIndex` (0-based),
 * `page` (a 1-based NUMBER as a human counts pages, or a page NAME), and
 * `pageName`. Returns `null` when a page was named and could not be found —
 * the caller decides whether that drops the op or falls back to page 0.
 */
function resolvePageIndex(ctx: DeltaContext, o: Record<string, unknown>): number | null | undefined {
  if (typeof o.pageIndex === 'number' && Number.isFinite(o.pageIndex)) {
    return clampPage(ctx, Math.trunc(o.pageIndex));
  }
  if (typeof o.page === 'number' && Number.isFinite(o.page)) {
    return clampPage(ctx, Math.trunc(o.page) - 1); // 1-based as written
  }
  const name = str(o.pageName) || str(o.page);
  if (!name) return undefined; // not specified at all
  const at = ctx.pages.findIndex((p) => p.name === name);
  if (at >= 0) return at;
  const n = normalizeTitle(name);
  const hits = ctx.pages.map((p, i) => [normalizeTitle(p.name), i] as const).filter(([pn]) => pn === n);
  return hits.length === 1 ? hits[0][1] : null;
}

/** An INDEX is clamped (an off-by-one is a counting slip, not a wrong page);
 *  a NAME is never guessed. That asymmetry is the whole rule. */
function clampPage(ctx: DeltaContext, i: number): number {
  const last = Math.max(0, ctx.pages.length - 1);
  return i < 0 ? 0 : i > last ? last : i;
}

// ── Encoding validation, shared by addTile and replaceTileEncoding ─────────

/**
 * Check a SANITIZED encoding against one dataset's real columns. Returns an
 * error sentence, or null when it is drawable. Judged on the DECLARED type,
 * never inference: a '007' column is text and `sum` over it must stay a refusal,
 * not a wrong figure — the same call `validatePlan` makes.
 */
function encodingError(enc: VizEncoding, ds: PlanDataset, at: string): string | null {
  const types = columnTypes(ds);
  if (!enc.category) return `${at} dropped: no category (dimension) column.`;
  if (!types.has(enc.category)) {
    return `${at} dropped: ${JSON.stringify(enc.category)} is not a column of "${ds.name}".`;
  }
  if (enc.values.length === 0) return `${at} dropped: no measure.`;
  for (const m of enc.values) {
    if (!types.has(m.column)) {
      return `${at} dropped: ${JSON.stringify(m.column)} is not a column of "${ds.name}".`;
    }
    if (NUMERIC_AGGS.has(m.aggregation) && types.get(m.column) !== 'number') {
      return `${at} dropped: ${m.aggregation} of ${JSON.stringify(m.column)} needs a number column, but ${JSON.stringify(m.column)} is ${types.get(m.column)} in "${ds.name}".`;
    }
  }
  if (enc.series !== undefined && !types.has(enc.series)) {
    return `${at} dropped: split column ${JSON.stringify(enc.series)} is not a column of "${ds.name}".`;
  }
  return null;
}

/** Filters on columns that do not exist lose the FILTER, not the op — the same
 *  severity `validatePlan` gives them. */
function keepFilters(
  raw: unknown, ds: PlanDataset, where: string, at: string, dropped: DeltaDrop[],
): FilterStep[] {
  const out: FilterStep[] = [];
  const types = columnTypes(ds);
  for (const f of visuals.sanitizeFilters(raw)) {
    if (!types.has(f.column)) {
      dropped.push({
        kind: 'filter',
        where,
        message: `${at}: filter on ${JSON.stringify(f.column)} dropped — not a column of "${ds.name}".`,
      });
      continue;
    }
    out.push(f);
  }
  return out;
}

// ── The validator ──────────────────────────────────────────────────────────

const OP_KINDS: ReadonlySet<string> = new Set([
  'addTile', 'addMetric', 'replaceTileEncoding', 'removeTile', 'moveTile',
  'addControl', 'renamePage', 'addPage', 'setTitle',
]);

/**
 * The ONE decision procedure for edits. Pure, synchronous and total.
 *
 * Accepts `{ops: [...]}`, or a bare array of ops — a model produces both — and
 * anything else yields no ops and one reported drop.
 */
export function validateDelta(raw: unknown, ctx: DeltaContext): ValidatedDelta {
  const dropped: DeltaDrop[] = [];
  const ops: ValidatedDeltaOp[] = [];

  let rawOps: unknown[];
  if (Array.isArray(raw)) rawOps = raw;
  else if (looksLikeObject(raw) && Array.isArray(raw.ops)) rawOps = raw.ops;
  else {
    rawOps = [];
    dropped.push({ kind: 'op', where: 'ops', message: 'No edits: the reply carried no list of operations.' });
  }

  rawOps.forEach((rawOp, i) => {
    const where = `ops[${i}]`;
    const one = validateOp(rawOp, ctx, where, dropped);
    if (one) ops.push(one);
  });

  return { ops, dropped };
}

function validateOp(
  raw: unknown, ctx: DeltaContext, where: string, dropped: DeltaDrop[],
): ValidatedDeltaOp | null {
  if (!looksLikeObject(raw)) {
    dropped.push({ kind: 'op', where, message: 'Edit dropped: not an object.' });
    return null;
  }
  // `op`/`type` first and `kind` LAST: addControl carries its own `kind`
  // (dropdown/multi/date_range), and the two vocabularies are disjoint, so the
  // fallback cannot mistake one for the other.
  const kind = str(raw.op) || str(raw.type) || str(raw.kind);
  if (!OP_KINDS.has(kind)) {
    dropped.push({
      kind: 'op',
      where,
      message: `Edit dropped: ${JSON.stringify(kind)} is not one of Ordinate's ${OP_KINDS.size} edit operations.`,
    });
    return null;
  }
  const at = `Edit ${JSON.stringify(kind)}`;

  if (kind === 'addTile') return opAddTile(raw, ctx, where, at, dropped);
  if (kind === 'addMetric') return opAddMetric(raw, ctx, where, at, dropped);
  if (kind === 'replaceTileEncoding') return opReplaceEncoding(raw, ctx, where, at, dropped);
  if (kind === 'removeTile' || kind === 'moveTile') return opTileRef(kind, raw, ctx, where, at, dropped);
  if (kind === 'addControl') return opAddControl(raw, ctx, where, at, dropped);
  if (kind === 'addPage' || kind === 'setTitle') {
    const name = str(raw.name) || str(raw.title);
    if (!name) {
      dropped.push({ kind: 'name', where, message: `${at} dropped: no name given.` });
      return null;
    }
    return kind === 'addPage' ? { op: 'addPage', name } : { op: 'setTitle', name };
  }
  // renamePage
  const pageIndex = resolvePageIndex(ctx, raw);
  if (pageIndex === null || pageIndex === undefined) {
    dropped.push({
      kind: 'page',
      where,
      message: `${at} dropped: no page called ${JSON.stringify(str(raw.pageName) || str(raw.page))}.`,
    });
    return null;
  }
  const name = str(raw.name) || str(raw.newName);
  if (!name) {
    dropped.push({ kind: 'name', where, message: `${at} dropped: no new page name given.` });
    return null;
  }
  return { op: 'renamePage', pageIndex, name };
}

/**
 * A KPI tile.
 *
 * The delta vocabulary could add a chart, a control, a page and a title but had
 * NO way to add a KPI — so "add a KPI for average discount" was refused as "not
 * one of Ordinate's edit operations", while the very same tile could be created
 * by the plan builder. A dashboard the Assistant can build but cannot then
 * extend is the asymmetry this closes.
 *
 * Validated exactly as hard as a planned metric (analysisPlan.validateMetric):
 * sanitizeCard checks a metric card's SHAPE but never that the column exists or
 * is numeric, so without the declared-type check below `avg` of a text column
 * builds a tile that renders "—" forever.
 */
function opAddMetric(
  raw: Record<string, unknown>, ctx: DeltaContext, where: string, at: string, dropped: DeltaDrop[],
): ValidatedDeltaOp | null {
  const ds = resolveDataset(ctx, raw);
  if (!ds) {
    dropped.push({ kind: 'dataset', where, message: `${at} dropped: unknown dataset ${JSON.stringify(datasetRef(raw))}.` });
    return null;
  }
  const aggregation = str(raw.aggregation);
  if (!METRIC_AGGS.has(aggregation)) {
    dropped.push({ kind: 'encoding', where, message: `${at} dropped: ${JSON.stringify(aggregation)} is not a metric aggregation.` });
    return null;
  }
  const column = str(raw.column);
  const col = ds.columns.find((c) => c.name === column);
  if (!col) {
    dropped.push({ kind: 'encoding', where, message: `${at} dropped: "${column}" is not a column of "${ds.name}".` });
    return null;
  }
  if (NUMERIC_AGGS.has(aggregation) && col.type !== 'number') {
    dropped.push({
      kind: 'encoding',
      where,
      message: `${at} dropped: ${aggregation} needs a number column, but "${column}" is ${col.type} in "${ds.name}".`,
    });
    return null;
  }
  const pageIndex = resolvePageIndex(ctx, raw);
  if (pageIndex === null) {
    dropped.push({ kind: 'page', where, message: `${at} dropped: no page called ${JSON.stringify(str(raw.pageName) || str(raw.page))}.` });
    return null;
  }
  return {
    op: 'addMetric',
    pageIndex: pageIndex ?? 0,
    datasetId: ds.id,
    column,
    aggregation: aggregation as MetricAggregation,
    label: str(raw.label) || str(raw.name) || `${aggregation} of ${column}`,
  };
}

function opAddTile(
  raw: Record<string, unknown>, ctx: DeltaContext, where: string, at: string, dropped: DeltaDrop[],
): ValidatedDeltaOp | null {
  const ds = resolveDataset(ctx, raw);
  if (!ds) {
    dropped.push({ kind: 'dataset', where, message: `${at} dropped: unknown dataset ${JSON.stringify(datasetRef(raw))}.` });
    return null;
  }
  const chartType = str(raw.chartType);
  if (!CHART_TYPE_IDS.has(chartType)) {
    dropped.push({
      kind: 'chartType',
      where,
      message: `${at} dropped: chart type ${JSON.stringify(chartType)} is not one of Ordinate's ${CHART_TYPE_IDS.size} chart types.`,
    });
    return null;
  }
  const enc = visuals.sanitizeEncoding(raw.encoding);
  const err = encodingError(enc, ds, at);
  if (err) {
    dropped.push({ kind: 'encoding', where, message: err });
    return null;
  }
  const pageIndex = resolvePageIndex(ctx, raw);
  if (pageIndex === null) {
    dropped.push({ kind: 'page', where, message: `${at} dropped: no page called ${JSON.stringify(str(raw.pageName) || str(raw.page))}.` });
    return null;
  }
  return {
    op: 'addTile',
    pageIndex: pageIndex ?? 0,
    datasetId: ds.id,
    name: str(raw.name) || str(raw.title) || `${ds.name} chart`,
    chartType,
    encoding: enc,
    filters: keepFilters(raw.filters, ds, where, at, dropped),
  };
}

function opReplaceEncoding(
  raw: Record<string, unknown>, ctx: DeltaContext, where: string, at: string, dropped: DeltaDrop[],
): ValidatedDeltaOp | null {
  const ref = str(raw.tile) || str(raw.cardId) || str(raw.title) || str(raw.name);
  const m = resolveTile(ctx, ref);
  if (!m.tile) {
    dropped.push({ kind: 'tile', where, message: tileDropMessage(at, ref, m.reason) });
    return null;
  }
  const tile = m.tile;
  // Only a CHART has an encoding. A metric/text/control tile is a different
  // shape entirely, so this is a wrong-target refusal, not a bad-field one.
  if (tile.type !== 'visual') {
    dropped.push({
      kind: 'tile',
      where,
      message: `${at} dropped: "${tile.title}" is a ${tile.type} tile, not a chart — it has no encoding to replace.`,
    });
    return null;
  }
  const ds = ctx.datasets.find((d) => d.id === tile.datasetId);
  if (!ds) {
    dropped.push({
      kind: 'dataset',
      where,
      message: `${at} dropped: the dataset behind "${tile.title}" is not available.`,
    });
    return null;
  }

  const out: ReplaceTileEncodingOp = { op: 'replaceTileEncoding', cardId: tile.cardId };
  if (raw.chartType !== undefined) {
    const chartType = str(raw.chartType);
    if (!CHART_TYPE_IDS.has(chartType)) {
      dropped.push({
        kind: 'chartType',
        where,
        message: `${at} dropped: chart type ${JSON.stringify(chartType)} is not one of Ordinate's ${CHART_TYPE_IDS.size} chart types.`,
      });
      return null;
    }
    out.chartType = chartType;
  }
  if (raw.encoding !== undefined) {
    const enc = visuals.sanitizeEncoding(raw.encoding);
    const err = encodingError(enc, ds, at);
    if (err) {
      dropped.push({ kind: 'encoding', where, message: err });
      return null;
    }
    out.encoding = enc;
  }
  if (raw.filters !== undefined) out.filters = keepFilters(raw.filters, ds, where, at, dropped);
  if (out.chartType === undefined && out.encoding === undefined && out.filters === undefined) {
    dropped.push({
      kind: 'encoding',
      where,
      message: `${at} dropped: nothing to change on "${tile.title}" — no chart type, encoding or filters given.`,
    });
    return null;
  }
  return out;
}

/** removeTile and moveTile: both start from one resolved tile. */
function opTileRef(
  kind: 'removeTile' | 'moveTile',
  raw: Record<string, unknown>, ctx: DeltaContext, where: string, at: string, dropped: DeltaDrop[],
): ValidatedDeltaOp | null {
  const ref = str(raw.tile) || str(raw.cardId) || str(raw.title) || str(raw.name);
  const m = resolveTile(ctx, ref);
  if (!m.tile) {
    dropped.push({ kind: 'tile', where, message: tileDropMessage(at, ref, m.reason) });
    return null;
  }
  if (kind === 'removeTile') return { op: 'removeTile', cardId: m.tile.cardId };

  // GEOMETRY IS THE APP'S. A move says where in the ORDER, never where on the
  // grid; an op carrying coordinates is refused rather than stripped, because a
  // model that thinks it is placing pixels has misunderstood the whole contract.
  if (['x', 'y', 'w', 'h', 'layout'].some((k) => raw[k] !== undefined)) {
    dropped.push({
      kind: 'layout',
      where,
      message: `${at} dropped: a move may say top/bottom/before/after, never x, y, w or h — the app lays tiles out.`,
    });
    return null;
  }

  const pos = raw.position;
  if (pos === 'top' || pos === 'bottom') return { op: 'moveTile', cardId: m.tile.cardId, position: pos };
  const spec = looksLikeObject(pos) ? pos : raw;
  const before = str(spec.before);
  const after = str(spec.after);
  if (!before && !after) {
    dropped.push({
      kind: 'position',
      where,
      message: `${at} dropped: position ${JSON.stringify(str(pos))} is not "top", "bottom", {before: …} or {after: …}.`,
    });
    return null;
  }
  const anchorRef = before || after;
  const anchor = resolveTile(ctx, anchorRef);
  if (!anchor.tile) {
    dropped.push({
      kind: 'tile',
      where,
      message: tileDropMessage(`${at} anchor`, anchorRef, anchor.reason),
    });
    return null;
  }
  return {
    op: 'moveTile',
    cardId: m.tile.cardId,
    position: before ? 'before' : 'after',
    anchorCardId: anchor.tile.cardId,
  };
}

function opAddControl(
  raw: Record<string, unknown>, ctx: DeltaContext, where: string, at: string, dropped: DeltaDrop[],
): ValidatedDeltaOp | null {
  // `kind` is read second here for the mirror-image reason it is read last in
  // validateOp: on THIS op it means the control kind, and `controlKind` is the
  // unambiguous spelling a careful model uses.
  const ckind = str(raw.controlKind) || str(raw.kind);
  if (!CONTROL_KINDS.has(ckind)) {
    dropped.push({
      kind: 'control',
      where,
      message: `${at} dropped: control kind ${JSON.stringify(ckind)} is not "dropdown", "multi" or "date_range".`,
    });
    return null;
  }
  const ds = resolveDataset(ctx, raw);
  if (!ds) {
    dropped.push({ kind: 'dataset', where, message: `${at} dropped: unknown dataset ${JSON.stringify(datasetRef(raw))}.` });
    return null;
  }
  const column = str(raw.column);
  // dashboards.sanitizeCard DROPS a control card lacking kind/datasetId/column,
  // so an op that survives here must carry all three — a blank column would
  // otherwise reach the dashboard as a card that silently vanishes.
  if (!column || !ds.columns.some((c) => c.name === column)) {
    dropped.push({
      kind: 'control',
      where,
      message: `${at} dropped: ${JSON.stringify(column)} is not a column of "${ds.name}".`,
    });
    return null;
  }
  const pageIndex = resolvePageIndex(ctx, raw);
  if (pageIndex === null) {
    dropped.push({ kind: 'page', where, message: `${at} dropped: no page called ${JSON.stringify(str(raw.pageName) || str(raw.page))}.` });
    return null;
  }
  return {
    op: 'addControl',
    pageIndex: pageIndex ?? 0,
    kind: ckind as ControlKind,
    datasetId: ds.id,
    column,
    // A label is decorative: it defaults to the column name rather than
    // dropping the op, matching sanitizeCard's own treatment of it.
    label: str(raw.label) || column,
  };
}
