import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as dashboards from '../analysis/dashboards';
import * as jobs from '../app/jobs';
import * as computePool from '../engine/computePool';
import * as trace from '../engine/residentTrace';
import { withAsOf } from '../data/asOf';
import { paramValues, resolveFilterParams } from '../analysis/params';
import type { FilterStep, TransformStep } from '../data/transforms';
import { sanitizeStatsSpec, vectorNeeds } from '../analysis/stats/spec';
import type { StatsSpec, VectorNeed } from '../analysis/stats/spec';
import type { PairScatter, StatsResult } from '../analysis/stats/run';
import { loadVectorsJs } from '../analysis/stats/vectorsJs';
import { finishStats, runStatsOnSource } from '../engine/statsJob';
import { presentStats, statsTitle } from '../analysis/stats/present';
import type { StatsTile } from '../analysis/stats/present';
import * as sharePolicy from '../app/sharePolicy';
import type { SharePath } from '../app/privacyStore';
import { predictedName, regressionFormula } from '../analysis/stats/regressionFormula';
import { statsFacts } from '../ai/statsFacts';
import type { StatsFactItem } from '../ai/statsFacts';
import type { CopilotFacts } from '../ai/copilot';
import { commitSteps } from './datasets';
import { randomUUID } from 'crypto';
import * as analysis from '../analysis/analysis';
import * as config from '../app/config';
import * as versions from '../app/versions';
import { DASHBOARD_STYLE_PRESETS } from '../analysis/dashboards';
import { pairLine, statsFigures } from '../analysis/stats/figures';

// Statistics workbench IPC — every figure the panel, a dashboard "stats" tile
// and the Assistant show is computed here, by src/analysis/stats, on vectors
// loaded resident-first (src/engine/statsVectors.ts, async bridge) with the
// hydrate-and-read reference as the fallback. A spec is untrusted renderer
// input and is whitelisted (sanitizeStatsSpec) before anything reads a file.
//
// LONG RUNS ARE JOBS. Over JOB_MIN_ROWS rows, or a regression with more than
// JOB_MIN_PREDICTORS predictors, the run is a 'compute' job (Jobs popover:
// progress, Cancel) and executes in a compute worker thread
// (computePool 'stats'), so neither the bridge nor the maths parks the main
// thread; smaller runs answer inline over the async bridge.

const JOB_MIN_ROWS = 200_000;
const JOB_MIN_PREDICTORS = 12;

type Computed<T> = { ok: true; value: T; datasetName: string } | { ok: false; error: string };

/**
 * Compute one spec (or, with `pair`, one correlation pair's scatter). The spec
 * must already be sanitized. A spec that cannot run on this dataset's columns
 * comes back as an ok:false RESULT (the panel's designed insufficient state),
 * not as an error.
 */
async function compute<T extends StatsResult | PairScatter>(
  projectId: string,
  spec: StatsSpec,
  opts: { filters?: FilterStep[]; pair?: [string, string]; asOf?: unknown } = {},
): Promise<Computed<T>> {
  const meta = await datasets.getDatasetMeta(projectId, spec.datasetId);
  if (!meta) return { ok: false, error: 'This dataset is no longer in the project.' };
  const filters = opts.filters || [];
  let needs: VectorNeed[];
  if (opts.pair) {
    const bad = opts.pair.find((c) => meta.columns.find((x) => x.name === c)?.type !== 'number');
    if (bad !== undefined) return { ok: false, error: `“${bad}” is not a number column.` };
    needs = opts.pair.map((column) => ({ column, as: 'number' as const }));
  } else {
    const need = vectorNeeds(spec, meta.columns);
    if ('error' in need) return { ok: true, value: { ok: false, kind: spec.kind, error: need.error } as T, datasetName: meta.name };
    needs = need.needs;
  }
  const big = meta.rowCount > JOB_MIN_ROWS || (spec.kind === 'regression' && (spec.predictors || []).length > JOB_MIN_PREDICTORS);
  const work = async (signal?: AbortSignal, progress?: (p: number, note?: string) => void): Promise<T> => {
    const src = await datasets.residentSource(projectId, spec.datasetId);
    if (src) {
      const args = { src, spec, needs, filters, pair: opts.pair };
      const out = big && computePool.available()
        ? await computePool.run<StatsResult | PairScatter | null>('stats', args, { signal, onProgress: progress })
        : await runStatsOnSource(args);
      trace.record('stats', out ? 'resident' : 'failed', out ? undefined : `${needs.length} column(s), filters=${filters.length}`);
      if (out) return out as T;
    } else {
      trace.record('stats', 'skipped');
    }
    if (progress) progress(0.2, 'Reading the table');
    const ds = await datasets.getDataset(projectId, spec.datasetId);
    if (!ds) throw new Error('This dataset is no longer in the project.');
    const v = loadVectorsJs(ds.columns, ds.rows, needs, filters);
    if (!v) throw new Error('A column this analysis needs is missing.');
    return finishStats(spec, v, opts.pair) as T;
  };
  if (!big) return { ok: true, value: await work(), datasetName: meta.name };
  const job = jobs.submit<T>({
    kind: 'compute',
    label: `Statistics · ${opts.pair ? `${opts.pair[0]} × ${opts.pair[1]}` : statsTitle(spec)} · ${meta.name}`,
    projectId,
    datasetId: spec.datasetId,
    // Re-entered inside the job: a queued job starts outside the request's
    // as-of scope, and must still read the same past.
    run: async (ctx) => {
      const go = (): Promise<T> => work(ctx.signal, (p, note) => ctx.progress(p, note));
      if (!opts.asOf) return go();
      const r = await withAsOf(projectId, opts.asOf, go);
      // A StatsResult failure carries its `kind`; an as-of refusal does not.
      if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false && !('kind' in r)) throw new Error(String((r as { error?: unknown }).error));
      return r as T;
    },
    resultOf: () => ({ message: `${meta.rowCount.toLocaleString('en-US')} rows analysed` }),
  });
  return { ok: true, value: await job.done, datasetName: meta.name };
}

/** Dashboard filters + parameters → the filter steps both read paths apply. */
function tileFilters(filters: unknown, params: unknown): FilterStep[] {
  return resolveFilterParams(dashboards.sanitizeDashboardFilters(filters), paramValues(params)).steps;
}

/** A spec's result, computed; exported for the Assistant and the published site. */
export async function computeStats(projectId: string, raw: unknown, filters: FilterStep[] = []): Promise<Computed<StatsResult>> {
  const spec = sanitizeStatsSpec(raw);
  if (!spec) return { ok: false, error: 'That analysis is not valid.' };
  return compute<StatsResult>(projectId, spec, { filters });
}

/** Every column a spec reads. */
function involved(spec: StatsSpec): string[] {
  return [...spec.columns, spec.target, ...(spec.predictors || []), spec.group, spec.outcome].filter((c): c is string => typeof c === 'string');
}

type TileData = StatsTile['chart']['data'];

/**
 * A tile's labels and series on their way OUT of the app (an export or a
 * published site) — through the SAME share-policy call a visual's chart takes
 * (sharePolicy.applyToChart). Labels that are a column's VALUES are declared
 * as the category (groups: the group; regression: each categorical
 * predictor, one call each, so any sensitive one masks the term names) and
 * every column read is declared as a value, so a 'drop' policy hides the tile.
 */
async function shareTile(projectId: string, spec: StatsSpec, data: TileData, sharePath: SharePath): Promise<TileData | null> {
  const meta = await datasets.getDatasetMeta(projectId, spec.datasetId);
  const type = (c: string): string | undefined => meta?.columns.find((x) => x.name === c)?.type;
  const values = involved(spec).map((column) => ({ column, aggregation: 'none' as const }));
  const labelCols = spec.kind === 'groups' ? [spec.group as string]
    : spec.kind === 'regression' ? (spec.predictors || []).filter((p) => type(p) !== 'number') : [''];
  const series = spec.kind === 'groups' && spec.outcome && type(spec.outcome) !== 'number' ? spec.outcome : undefined;
  let d: TileData = data;
  for (const category of labelCols.length ? labelCols : ['']) {
    const r = await sharePolicy.applyToChart(projectId, spec.datasetId, { category, series, values }, { ok: true, data: d }, sharePath);
    if (!r.ok || !r.data) return null;
    d = r.data as TileData;
  }
  return d;
}

/** A "stats" tile's presentation, for dashboards, exports and publishing. */
export async function computeStatsTile(projectId: string, raw: unknown, filters: FilterStep[] = [], sharePath?: SharePath) {
  const spec = sanitizeStatsSpec(raw);
  if (!spec) return { ok: false as const, error: 'That analysis is not valid.' };
  const out = await compute<StatsResult>(projectId, spec, { filters });
  if (!out.ok) return out;
  if (!out.value.ok) return { ok: false as const, error: out.value.error };
  const tile = presentStats(spec, out.value);
  if (sharePath) {
    const numeric = await shareTile(projectId, spec, tile.numeric, sharePath);
    const chart = await shareTile(projectId, spec, tile.chart.data, sharePath);
    if (!numeric || !chart) return { ok: false as const, error: sharePolicy.HIDDEN_BY_POLICY, hiddenByPolicy: true };
    // The display strings name the same labels, unmasked — they never leave the app.
    return { ok: true as const, view: spec.view || 'table', tile: { ...tile, table: { head: [], rows: [] }, numeric, chart: { ...tile.chart, data: chart } }, datasetName: out.datasetName };
  }
  return { ok: true as const, view: spec.view || 'table', tile, datasetName: out.datasetName };
}

/** A spec over a column marked sensitive is withheld from the Assistant, whole. */
async function withheld(projectId: string, spec: StatsSpec): Promise<string | null> {
  const cols = await sharePolicy.withheldColumns(projectId, spec.datasetId);
  return involved(spec).find((c) => cols.has(c)) ?? null;
}

function withheldFacts(spec: StatsSpec, column: string, datasetName: string): CopilotFacts {
  return {
    text: `Analysis: ${statsTitle(spec)} on "${datasetName}". It reads "${column}", a column marked sensitive, so its figures are withheld from the Assistant. Say so rather than guessing.`,
    ledger: [],
    provenance: { kind: 'dataset', name: datasetName, note: 'statistics withheld (sensitive column)' },
  };
}

/** The Assistant's facts for the open Statistics panel (the spec rides on the ask's context). */
export async function statsPanelFacts(projectId: string, raw: unknown): Promise<CopilotFacts | null> {
  const spec = sanitizeStatsSpec(raw);
  if (!spec) return null;
  const meta = await datasets.getDatasetMeta(projectId, spec.datasetId);
  if (!meta) return null;
  const hidden = await withheld(projectId, spec);
  if (hidden) return withheldFacts(spec, hidden, meta.name);
  const out = await compute<StatsResult>(projectId, spec);
  if (!out.ok) return null;
  return statsFacts([{ spec, result: out.value }], out.datasetName);
}

/** Append the facts of every "stats" tile on a dashboard's sheets to its facts. */
export async function withStatsTiles(projectId: string, pages: dashboards.Page[], base: CopilotFacts): Promise<CopilotFacts> {
  const items: StatsFactItem[] = [];
  let name = '';
  for (const page of pages || []) {
    for (const card of page.cards || []) {
      if (card.type !== 'stats' || !card.stats) continue;
      if (await withheld(projectId, card.stats)) continue;
      const out = await compute<StatsResult>(projectId, card.stats).catch(() => null);
      if (out && out.ok) { items.push({ spec: card.stats, result: out.value }); name = name || out.datasetName; }
    }
  }
  if (!items.length) return base;
  const extra = statsFacts(items, name);
  return { ...base, text: base.text + '\n\nStatistics tiles on this dashboard:\n' + extra.text, ledger: [...base.ledger, ...extra.ledger] };
}

/** Append a "stats" card (6×6) under everything on the last sheet of a dashboard, or of a new one. */
async function addStatsCard(projectId: string, spec: StatsSpec, analysisId: string, name: string) {
  let a = analysisId ? await analysis.getAnalysis(projectId, analysisId) : null;
  if (!analysisId) {
    const preset = DASHBOARD_STYLE_PRESETS[config.get().branding.dashboardStyle];
    a = await analysis.saveAnalysis(projectId, { name: name.trim().slice(0, 200) || 'Untitled dashboard', style: preset });
    if (a) await versions.record(projectId, 'dashboard', a);
  }
  if (!a) return { ok: false, error: 'That dashboard could not be opened.' };
  const sheets = a.sheets.map((p) => ({ ...p, cards: [...(p.cards || [])] }));
  const last = sheets[sheets.length - 1];
  const y = last.cards.reduce((m, c) => Math.max(m, (c.layout?.y ?? 0) + (c.layout?.h ?? 0)), 0);
  last.cards.push({ id: randomUUID(), type: 'stats', stats: spec, layout: { x: 0, y, w: 6, h: 6 } } as (typeof last.cards)[number]);
  const before = analysisId ? a : undefined;
  const saved = await analysis.updateAnalysis(projectId, a.id, { sheets });
  if (!saved) return { ok: false, error: 'Could not add it to that dashboard.' };
  await versions.record(projectId, 'dashboard', saved, before ? { before } : undefined);
  return { ok: true, analysisId: saved.id, name: saved.name };
}

const fail = (err: unknown, fallback: string) => ({ ok: false, error: err instanceof Error && err.message ? err.message : fallback });

export function register(): void {
  // One analysis for the panel. `filters`/`params` only when a dashboard asks.
  ipcMain.handle('stats:run', async (_e, { projectId, spec, filters, params, asOf }: any = {}) => withAsOf(projectId, asOf, async () => {
    try {
      const s = sanitizeStatsSpec(spec);
      if (!s) return { ok: false, error: 'That analysis is not valid.' };
      const out = await compute<StatsResult>(projectId, s, { filters: tileFilters(filters, params), asOf });
      // `figures`: the few derived numbers a view shows (stats/figures.ts) — the web never adds them up itself.
      return out.ok ? { ok: true, result: out.value, datasetName: out.datasetName, figures: statsFigures(out.value) } : out;
    } catch (err) {
      return fail(err, 'Could not run the analysis.');
    }
  }));

  // One correlation pair's scatter with its fit line (a heatmap cell's click).
  ipcMain.handle('stats:pair', async (_e, { projectId, spec, x, y }: any = {}) => {
    try {
      const s = sanitizeStatsSpec(spec);
      if (!s || typeof x !== 'string' || typeof y !== 'string') return { ok: false, error: 'That pair is not valid.' };
      const out = await compute<PairScatter>(projectId, s, { pair: [x, y] });
      return out.ok ? { ok: true, pair: out.value, line: pairLine(out.value) } : out;
    } catch (err) {
      return fail(err, 'Could not draw that pair.');
    }
  });

  // A dashboard tile: the result as a table, a numeric grid and a chart.
  // `share: 'export'` is an export asking — the share policy applies.
  ipcMain.handle('stats:tile', async (_e, { projectId, spec, filters, params, asOf, share }: any = {}) => withAsOf(projectId, asOf, async () => {
    try {
      return await computeStatsTile(projectId, spec, tileFilters(filters, params), share === 'export' ? 'export' : undefined);
    } catch (err) {
      return fail(err, 'Could not compute this tile.');
    }
  }));

  // Server only (web): the dashboards "Add to dashboard" can put a card on —
  // ids and names, nothing else of the records.
  ipcMain.handle('stats:dashboards', async (_e, { projectId }: any = {}) =>
    (await analysis.listAnalyses(projectId)).map((a) => ({ id: a.id, name: a.name })));

  // "Add to dashboard", server side (web): the spec becomes a "stats" card at
  // the foot of the dashboard's last sheet — an existing one, or a new one
  // named `name`. The card stores only the spec; every render recomputes it.
  ipcMain.handle('stats:addToDashboard', async (_e, { projectId, spec, view, analysisId, name }: any = {}) => {
    try {
      const s = sanitizeStatsSpec({ ...(spec && typeof spec === 'object' ? spec : {}), view: view === 'chart' ? 'chart' : 'table' });
      if (!s) return { ok: false, error: 'That analysis is not valid.' };
      if (!(await datasets.getDatasetMeta(projectId, s.datasetId))) return { ok: false, error: 'This dataset is no longer in the project.' };
      return await addStatsCard(projectId, s, typeof analysisId === 'string' ? analysisId : '', typeof name === 'string' ? name : '');
    } catch (err) {
      return fail(err, 'Could not add it to that dashboard.');
    }
  });

  // "Save as calculated field": the regression, refit here, as predicted_<target>.
  ipcMain.handle('stats:saveFormula', async (_e, { projectId, spec }: any = {}) => {
    try {
      const s = sanitizeStatsSpec(spec);
      if (!s || s.kind !== 'regression' || !s.target) return { ok: false, error: 'Run a regression first.' };
      const out = await compute<StatsResult>(projectId, s);
      if (!out.ok) return out;
      if (!out.value.ok || out.value.kind !== 'regression') return { ok: false, error: out.value.ok ? 'Run a regression first.' : out.value.error };
      const formula = regressionFormula(out.value.fit);
      if (!formula.ok) return formula;
      const name = predictedName(s.target);
      const meta = await datasets.getDatasetMeta(projectId, s.datasetId);
      if (!meta) return { ok: false, error: 'This dataset is no longer in the project.' };
      const steps: TransformStep[] = Array.isArray(meta.steps) ? meta.steps.slice() : [];
      const step: TransformStep = { type: 'calculated_field', name, expression: formula.expression };
      const at = steps.findIndex((x) => x.type === 'calculated_field' && x.name === name);
      if (at >= 0) steps[at] = step;
      else if (meta.columns.some((c) => c.name === name)) return { ok: false, error: `A column named “${name}” already exists.` };
      else steps.push(step);
      const res = await commitSteps(projectId, s.datasetId, steps);
      if (!res.ok) return res;
      return { ok: true, name, expression: formula.expression, replaced: at >= 0 };
    } catch (err) {
      return fail(err, 'Could not save the calculated field.');
    }
  });
}
