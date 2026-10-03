// Multi-currency in the two answers every tile is made of — a metric and a
// chart. MAIN PROCESS. No IPC handler lives here (that is ./fx.ts); these are
// the hooks `computeCardMetric` (./dashboards) and `vizDataFor` (./visuals) call
// before their ordinary paths.
//
// THE TARGET. A dashboard read may carry its own target (`currency` on the
// request); the handler runs inside `fxScope`, an AsyncLocalStorage scope like
// data/asOf.ts's, so every figure that request resolves — a formula's operands,
// a period overlay, a related read — converts to the same currency without a
// parameter threaded through every signature. Outside a scope: the project's
// target, else the workspace currency (Settings → Formats).
//
// ONLY DECLARED COLUMNS CONVERT. No declaration on a measure → these return
// null and nothing about the ordinary path changes, its cache keys included.
// A `count` is not money and never converts.
//
// Resident first (engine/fxResident, the compiled ASOF join), JS reference
// (analysis/fx.convertTable, then the ordinary pure aggregate) otherwise; both
// return the same `FxInfo` — the target, how many rows had no rate (excluded,
// never treated as 1), which pairs, and whether the sample rates answered.

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import * as datasets from '../data/datasets';
import * as fxStore from '../app/fxStore';
import * as fx from '../analysis/fx';
import type { FxInfo } from '../analysis/fx';
import { getFormatPrefs } from '../app/format';
import * as residentQuery from '../engine/residentQuery';
import * as trace from '../engine/residentTrace';
import { fxRelationSql, fxColumns, fxMetricOn, fxMissingResident } from '../engine/fxResident';
import type { FxRateSource } from '../engine/fxResident';
import { applyPipeline } from '../data/transforms';
import type { FilterStep, TableData } from '../data/transforms';
import { computeMetric } from '../analysis/metricValue';
import type { MetricAggregation } from '../analysis/metricValue';
import { buildVizData } from '../analysis/vizData';
import { buildFacetData } from '../analysis/facets';
import type { VizEncoding } from '../analysis/visuals';
import type { ParamValues } from '../analysis/params';
import { paramTable } from '../data/paramReplay';
import { isFaceted } from './visualsFacets';
import { residentVizData } from './visualsResident';
import type { VizDataReply } from './visuals';
import { orgKey } from '../server/context';

const als = new AsyncLocalStorage<string>();

/** Run a read with a dashboard's own target; anything but a valid code is no scope. */
export function fxScope<T>(currency: unknown, fn: () => Promise<T>): Promise<T> {
  return fx.isCurrencyCode(currency) ? als.run(currency, fn) : fn();
}

export async function fxTarget(projectId: string): Promise<string> {
  const scoped = als.getStore();
  if (scoped) return scoped;
  const s = await fxStore.getFx(projectId);
  return s.target || getFormatPrefs().currency;
}

type RateRef = { kind: 'sample' } | { kind: 'dataset'; datasetId: string; map: fx.FxSourceMap; updatedAt: string };

export interface FxCtx {
  target: string;
  wanted: string[];
  decls: Record<string, fx.CurrencyDecl>;
  rates: RateRef;
  /** Part of the answer-cache key: everything the converted answer depends on. */
  key: string;
}

/** The conversion for these measures of this dataset, or null when none applies. */
export async function fxContext(projectId: string, datasetId: string, wanted: string[], touched: string[] = []): Promise<FxCtx | null> {
  try {
    const s = await fxStore.getFx(projectId);
    const decls = s.columns[datasetId];
    if (!decls || !wanted.some((w) => Object.prototype.hasOwnProperty.call(decls, w))) return null;
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta) return null;
    // A filter or field from a RELATED dataset needs the join path, which does
    // not convert: decline, so that path answers (with the right rows) instead
    // of this one silently dropping the filter it cannot see.
    const own = new Set(meta.columns.map((c) => c.name));
    if (touched.some((c) => c && !own.has(c))) return null;
    const target = await fxTarget(projectId);
    const plan = fx.resolvePlan(meta.columns, decls, wanted, target);
    if (!plan) return null;
    let rates: RateRef = { kind: 'sample' };
    if (s.source) {
      const m = await datasets.getDatasetMeta(projectId, s.source.datasetId);
      const src = s.source;
      const has = (n: string): boolean => !!m && m.columns.some((c) => c.name === n);
      // A rate dataset that is gone or no longer has its columns: the sample answers, labelled.
      if (m && has(src.date) && has(src.from) && has(src.to) && has(src.rate)) {
        rates = { kind: 'dataset', datasetId: src.datasetId, map: src, updatedAt: m.updatedAt };
      }
    }
    const key = JSON.stringify({ t: target, c: plan.cols, d: wanted.map((w) => decls[w] || null), r: rates });
    return { target, wanted, decls, rates, key };
  } catch (_) {
    return null;
  }
}

// ── Rates ────────────────────────────────────────────────────────────────────

// ponytail: last few rate tables by dataset version; an FX table is small.
const rateCache = new Map<string, fx.RateTable>();

async function jsRates(projectId: string, ctx: FxCtx): Promise<{ table: fx.RateTable; sample: boolean }> {
  if (ctx.rates.kind === 'dataset') {
    const k = orgKey(projectId) + '/' + ctx.rates.datasetId + '@' + ctx.rates.updatedAt + JSON.stringify(ctx.rates.map);
    const hit = rateCache.get(k);
    if (hit) return { table: hit, sample: false };
    const ds = await datasets.getDataset(projectId, ctx.rates.datasetId);
    if (ds) {
      const table = fx.buildRates(fx.rateRowsFromTable(ds, ctx.rates.map));
      if (rateCache.size > 8) rateCache.clear();
      rateCache.set(k, table);
      return { table, sample: false };
    }
  }
  return { table: fxStore.sampleRates().table, sample: true };
}

async function residentRates(projectId: string, ctx: FxCtx): Promise<FxRateSource | null> {
  if (ctx.rates.kind === 'sample') return { kind: 'sample', rows: fxStore.sampleRates().rows };
  const src = await datasets.residentSource(projectId, ctx.rates.datasetId);
  return src ? { kind: 'dataset', parquetPath: src.parquetPath, columns: src.columns, map: ctx.rates.map } : null;
}

/**
 * The converted relation, registered for the duration of `run`. Null (with a
 * trace) when the resident path is unavailable or declines.
 */
async function withConverted<T>(
  op: string,
  projectId: string,
  datasetId: string,
  ctx: FxCtx,
  run: (fxSrc: residentQuery.ResidentSource, sample: boolean) => Promise<T | null>,
): Promise<T | null> {
  if (!residentQuery.isResident()) { trace.record(op, 'skipped'); return null; }
  const src = await datasets.residentSource(projectId, datasetId);
  const rates = src ? await residentRates(projectId, ctx) : null;
  const plan = src ? fx.resolvePlan(src.columns, ctx.decls, ctx.wanted, ctx.target) : null;
  if (!src || !rates || !plan) { trace.record(op, 'skipped'); return null; }
  let rel: string | null = null;
  try { rel = fxRelationSql(src, rates, plan); } catch (_) { rel = null; }
  if (!rel) { trace.record(op, 'skipped', 'a date the SQL grammar does not read'); return null; }
  const key = 'fx:' + randomUUID();
  const fxSrc = { parquetPath: key, columns: fxColumns(src.columns) };
  const out = await residentQuery.withRelationAsync(key, rel, () => run(fxSrc, rates.kind === 'sample'));
  trace.record(op, out ? 'resident' : 'failed', out ? undefined : `converted columns=${plan.cols.length}`);
  return out;
}

/** The JS reference's converted table — or null when the dataset is gone. */
async function convertedJs(projectId: string, ctx: FxCtx, base: TableData): Promise<{ table: TableData; sample: boolean }> {
  const rates = await jsRates(projectId, ctx);
  const plan = fx.resolvePlan(base.columns, ctx.decls, ctx.wanted, ctx.target);
  if (!plan) return { table: base, sample: rates.sample };
  return { table: fx.convertTable(base, plan, rates.table), sample: rates.sample };
}

// ── A metric ─────────────────────────────────────────────────────────────────

export async function fxCardMetric(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
  params: ParamValues | undefined,
  ctx: FxCtx,
): Promise<{ ok: boolean; value: number | null; fx?: FxInfo }> {
  const replay = await paramTable(projectId, datasetId, params);
  if (!replay) {
    const fast = await withConverted('fxMetric', projectId, datasetId, ctx, async (fxSrc, sample) => {
      const r = fxMetricOn(fxSrc, spec, filters);
      return r ? { ok: true, value: r.value, fx: fx.fxInfo(ctx.target, r, sample) } : null;
    });
    if (fast) return fast;
  }
  const base = replay ?? await datasets.getDataset(projectId, datasetId);
  if (!base) return { ok: false, value: null };
  const conv = await convertedJs(projectId, ctx, { columns: base.columns, rows: base.rows });
  const table = filters.length ? applyPipeline(conv.table, filters) : conv.table;
  const miss = fx.missingOf(table);
  return { ok: true, value: computeMetric(table.columns, table.rows, spec), fx: fx.fxInfo(ctx.target, miss, conv.sample) };
}

// ── A chart ──────────────────────────────────────────────────────────────────

/** The money measures of a chart: a count is not money and never converts. */
function measuresOf(e: VizEncoding): string[] {
  const out = (Array.isArray(e.values) ? e.values : []).filter((v) => v && !v.datasetId && v.aggregation !== 'count').map((v) => v.column);
  const pv = e.pivot && Array.isArray(e.pivot.values) ? e.pivot.values : [];
  for (const v of pv) if (v && typeof v.column === 'string') out.push(v.column);
  return out;
}

/** A chart's conversion, or null: the engines and a RELATED dataset's fields are not converted. */
export function fxVizContext(
  projectId: string, datasetId: string, encoding: VizEncoding | null | undefined, filters: FilterStep[] = [],
): Promise<FxCtx | null> {
  if (!encoding || encoding.drivers || encoding.cohort || encoding.eventFunnel) return Promise.resolve(null);
  // Maps carry a geo payload only their own paths build (vizExtras); not converted.
  if (encoding.geo || encoding.categoryDatasetId || encoding.seriesDatasetId) return Promise.resolve(null);
  const values = Array.isArray(encoding.values) ? encoding.values : [];
  if (values.some((v) => v && v.datasetId)) return Promise.resolve(null);
  const touched = [encoding.category, encoding.series || '', ...values.map((v) => (v ? v.column : '')), ...filters.map((f) => (f ? f.column : ''))];
  return fxContext(projectId, datasetId, measuresOf(encoding), touched.filter((c) => typeof c === 'string' && c !== ''));
}

/** The lines a converted chart adds to its warnings. */
export function fxNotes(info: FxInfo): string[] {
  const out: string[] = [];
  const w = fx.fxWarning(info);
  if (w) out.push(w);
  if (info.sample) out.push(`Converted to ${info.target} with ${fx.SAMPLE_LABEL.toLowerCase()}.`);
  return out;
}

/**
 * `visual:data` over declared money measures, converted — or null when nothing
 * on this encoding converts (the ordinary path answers). The engines (drivers,
 * cohort, funnel) and a measure from a RELATED dataset are not converted.
 */
export async function fxVizData(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  opts: { maxHydrateRows?: number; params?: ParamValues } = {},
): Promise<(VizDataReply & { fx?: FxInfo }) | null> {
  const ctx = await fxVizContext(projectId, datasetId, encoding, filters);
  if (!ctx) return null;
  const replay = await paramTable(projectId, datasetId, opts.params);
  if (!replay && !isFaceted(encoding)) {
    const fast = await withConverted('fxViz', projectId, datasetId, ctx, async (fxSrc, sample) => {
      const viz = await residentVizData(projectId, datasetId, encoding, filters, fxSrc);
      const miss = viz ? fxMissingResident(fxSrc, filters) : null;
      if (!viz || !miss) return null;
      const info: FxInfo = fx.fxInfo(ctx.target, miss, sample);
      return { ok: true as const, data: viz.data, recommendedShape: viz.recommendedShape, warnings: viz.warnings.concat(fxNotes(info)), category: viz.category, fx: info };
    });
    if (fast) return fast;
  }
  if (!replay && typeof opts.maxHydrateRows === 'number') {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (meta && meta.rowCount > opts.maxHydrateRows) return { ok: false, error: 'Too large to preview without the DuckDB bridge', tooLarge: true };
  }
  const base = replay ?? await datasets.getDataset(projectId, datasetId);
  if (!base) return { ok: false, error: 'Dataset not found' };
  const conv = await convertedJs(projectId, ctx, { columns: base.columns, rows: base.rows });
  const r = (isFaceted(encoding) ? buildFacetData : buildVizData)(conv.table.columns, conv.table.rows, encoding, filters);
  const miss = fx.missingOf(filters.length ? applyPipeline(conv.table, filters) : conv.table);
  const info: FxInfo = fx.fxInfo(ctx.target, miss, conv.sample);
  return {
    ok: true, data: r.data, recommendedShape: r.recommendedShape,
    warnings: r.warnings.concat(replay ? replay.errors : [], fxNotes(info)), category: r.category, fx: info,
  };
}
