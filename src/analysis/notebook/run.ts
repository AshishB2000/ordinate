// NOTEBOOKS — running a cell. MAIN PROCESS.
//
// Nothing here decides validity or safety on its own: a SQL cell runs through
// the Query tab's own path (engine/sqlDatasets.runSql — the engine lock, the
// read-only gate, bound `[[params]]`, the subquery wrapper, the 500-row
// preview), a formula through the Prepare pipeline's calculated field
// (data/transforms — the app's own parser, no eval), and a chart through
// vizData.buildVizData, the bridge every Visuals chart goes through.
//
// ── HOW A CELL READS A CELL ──────────────────────────────────────────────────
// Per statement, never in the catalog — the Query tab's rule. A SQL cell that
// names `cell_2` gets cell 2's SQL (and whatever cell 2 itself reads, top to
// bottom) prepended as CTEs after the dataset CTEs. So nothing persists in the
// shared in-memory catalog, two notebooks cannot see each other's views, and a
// view is always exactly the SQL above it — never a result left over from a run
// the user has since edited. DuckDB re-plans the chain per run; the result cache
// below is what makes a re-run free.
//
// A formula or chart reads its input's WHOLE result (at the dataset cap, more is
// an error, like Save as dataset) — a formula over the 500 preview rows would
// be a different column, and a chart over them a wrong figure.
//
// ── THE CACHE ────────────────────────────────────────────────────────────────
// Keyed on ./graph.cellCacheKey — the resolved SQL with its bound values, the
// input cells' keys and each dataset's `updatedAt` — so an entry cannot outlive
// what it describes and needs no invalidation. Two LRUs: previews by count,
// whole tables by cells held.

import type { ParsedColumn } from '../../data/parse';
import type { Cell } from '../../data/transforms';
import { applyPipeline } from '../../data/transforms';
import * as datasets from '../../data/datasets';
import { ROW_LIMIT } from '../../connectors/connectionRun';
import * as sqlDatasets from '../../engine/sqlDatasets';
import type { CatalogEntry, SqlView } from '../../engine/sqlDatasets';
import { JobCancelled } from '../../app/jobs';
import { bindFormulaText } from '../params';
import type { ParamValues, SqlParam } from '../params';
import { buildVizData } from '../vizData';
import { analyzeNotebook, cellCacheKey, upstreamOf } from './graph';
import type { CellInfo, NotebookGraph } from './graph';
import type { NbCell, Notebook, ParamCell } from './model';

export interface Table { columns: ParsedColumn[]; rows: Cell[][] }

export interface CellResult {
  ok: true;
  cellId: string;
  kind: NbCell['kind'];
  columns: ParsedColumn[];
  /** At most PREVIEW_ROWS. */
  rows: Cell[][];
  /** Rows in the whole result — or, when `truncated`, in the preview. */
  rowCount: number;
  /** A SQL preview with more rows behind it (the count is then unknown, as in the Query tab). */
  truncated: boolean;
  elapsedMs: number;
  cached: boolean;
  /** The cache key — the result's identity. */
  key: string;
  /** The graph sig it was computed under: `stale` is `sig !== graph sig`. */
  sig: string;
  chart?: { chartType: string; data: unknown; warnings: string[] };
  warnings: string[];
  /** Datasets the result read. */
  deps: string[];
}
export type RunReply = CellResult | { ok: false; cellId: string; error: string; cancelled?: boolean };

const PREVIEW_ROWS = sqlDatasets.PREVIEW_ROWS;

// ── The caches ───────────────────────────────────────────────────────────────

type Stored = Omit<CellResult, 'elapsedMs' | 'cached' | 'sig'>;
const previews = new Map<string, Stored>();
const tables = new Map<string, Table & { deps: string[] }>();
const MAX_PREVIEWS = 200;
/** Cells (rows × columns) of whole tables kept — about 50 MB of JS values. ponytail: a count, not bytes. */
const MAX_TABLE_CELLS = 4_000_000;
let tableCells = 0;

function touch<V>(m: Map<string, V>, k: string): V | undefined {
  const v = m.get(k);
  if (v !== undefined) { m.delete(k); m.set(k, v); }
  return v;
}
function putPreview(k: string, v: Stored): void {
  previews.delete(k);
  previews.set(k, v);
  while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value as string);
}
const weight = (t: Table): number => t.rows.length * Math.max(1, t.columns.length);
function putTable(k: string, t: Table & { deps: string[] }): void {
  if (weight(t) > MAX_TABLE_CELLS / 2) return; // one huge result would evict everything else
  const old = tables.get(k);
  if (old) { tableCells -= weight(old); tables.delete(k); }
  tables.set(k, t);
  tableCells += weight(t);
  while (tableCells > MAX_TABLE_CELLS) {
    const oldest = tables.keys().next().value as string;
    tableCells -= weight(tables.get(oldest) as Table);
    tables.delete(oldest);
  }
}

/** Test hook. */
export function clearCache(): void {
  previews.clear();
  tables.clear();
  tableCells = 0;
}

// ── One run's context ────────────────────────────────────────────────────────

interface Ctx {
  projectId: string;
  nb: Notebook;
  graph: NotebookGraph;
  info: Map<string, CellInfo>;
  cells: Map<string, NbCell>;
  cat: CatalogEntry[];
  versions: Map<string, string>;
  keys: Map<string, string>;
  signal?: AbortSignal;
}

async function context(projectId: string, nb: Notebook, signal?: AbortSignal): Promise<Ctx> {
  const cat = await sqlDatasets.projectCatalog(projectId);
  const reserved = cat.flatMap((e) => (e.alias ? [e.alias, e.slug] : [e.slug]));
  const graph = analyzeNotebook(nb.cells, reserved);
  const versions = new Map((await datasets.listDatasets(projectId)).map((d) => [d.id, d.updatedAt] as [string, string]));
  return {
    projectId, nb, graph, cat, versions, signal,
    info: new Map(graph.cells.map((c) => [c.id, c])),
    cells: new Map(nb.cells.map((c) => [c.id, c])),
    keys: new Map(),
  };
}

const fail = (cellId: string, error: string): RunReply => ({ ok: false, cellId, error });

class CellError extends Error {}

function checkAbort(ctx: Ctx): void {
  if (ctx.signal && ctx.signal.aborted) throw new JobCancelled();
}

/**
 * A promise that rejects as soon as the signal aborts. DuckDB has no interrupt
 * through this binding, so a cancelled statement runs to the end in the worker
 * and its rows are dropped. ponytail: the engine is not freed early; an
 * interrupt needs the sidecar (docs/phase-3c) or a binding that exposes one.
 */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new JobCancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new JobCancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function label(info: CellInfo | undefined): string {
  return info ? info.view || `Cell ${info.position}` : 'A cell';
}

/** Why `id` cannot run: its own problem, or the first problem above it. */
function blocked(ctx: Ctx, id: string): string | null {
  const own = ctx.info.get(id);
  if (own && own.error) return own.error;
  for (const up of upstreamOf(ctx.graph, id)) {
    const u = ctx.info.get(up);
    if (u && u.error) return `${label(u)} has a problem — ${u.error}`;
    const c = ctx.cells.get(up);
    if (c && c.kind === 'param' && c.value === null) return `[[${c.name}]] has no value yet — set it in its parameter cell.`;
  }
  return null;
}

/** The parameter cells `id` reads, transitively. */
function paramsOf(ctx: Ctx, id: string): ParamCell[] {
  return upstreamOf(ctx.graph, id).map((u) => ctx.cells.get(u)).filter((c): c is ParamCell => !!c && c.kind === 'param');
}

const paramRecord = (ps: ParamCell[]): Record<string, unknown> => Object.fromEntries(ps.map((p) => [p.name, [p.type, p.value]]));

interface SqlPlan { sql: string; views: SqlView[]; params: SqlParam[]; deps: string[]; key: string }

function sqlPlan(ctx: Ctx, id: string): SqlPlan {
  const cell = ctx.cells.get(id) as Extract<NbCell, { kind: 'sql' }>;
  const views: SqlView[] = upstreamOf(ctx.graph, id)
    .filter((u) => ctx.cells.get(u)?.kind === 'sql')
    .map((u) => ({ name: ctx.info.get(u)!.view as string, sql: (ctx.cells.get(u) as Extract<NbCell, { kind: 'sql' }>).sql }));
  const ps = paramsOf(ctx, id);
  const params: SqlParam[] = ps.map((p) => ({ name: p.name, kind: p.type, value: p.value }));
  const deps = [...new Set([...views.map((v) => v.sql), cell.sql].flatMap((s) => sqlDatasets.extractDeps(s, ctx.cat)))];
  const key = cellCacheKey({
    kind: 'sql',
    text: [...views.map((v) => [v.name, v.sql]), cell.sql],
    params: paramRecord(ps),
    datasets: deps.map((d) => ({ id: d, updatedAt: ctx.versions.get(d) || '' })),
  });
  return { sql: cell.sql, views, params, deps, key };
}

/** A cell's result key, memoised per run. */
function keyOf(ctx: Ctx, id: string): string {
  const hit = ctx.keys.get(id);
  if (hit) return hit;
  const cell = ctx.cells.get(id) as NbCell;
  const info = ctx.info.get(id) as CellInfo;
  let key: string;
  if (cell.kind === 'sql') key = sqlPlan(ctx, id).key;
  else if (cell.kind === 'formula') {
    key = cellCacheKey({
      kind: 'formula', text: [cell.expression, cell.column], params: paramRecord(paramsOf(ctx, id)),
      inputs: [keyOf(ctx, info.deps[0])],
    });
  } else if (cell.kind === 'chart') {
    key = cellCacheKey({ kind: 'chart', text: { type: cell.chartType, encoding: cell.encoding }, inputs: [keyOf(ctx, cell.sourceCellId)] });
  } else key = cellCacheKey({ kind: cell.kind, text: info.sig });
  ctx.keys.set(id, key);
  return key;
}

/** A SQL or formula cell's WHOLE result — what a formula, a chart and Save as dataset read. */
async function wholeTable(ctx: Ctx, id: string): Promise<Table & { deps: string[] }> {
  checkAbort(ctx);
  const why = blocked(ctx, id);
  if (why) throw new CellError(why);
  const key = keyOf(ctx, id);
  const hit = touch(tables, key);
  if (hit) return hit;
  const cell = ctx.cells.get(id) as NbCell;
  let out: Table & { deps: string[] };
  if (cell.kind === 'sql') {
    const plan = sqlPlan(ctx, id);
    const res = await abortable(sqlDatasets.runSql(ctx.projectId, plan.sql, plan.params, ROW_LIMIT, plan.views), ctx.signal);
    if (!res.ok) throw new CellError(res.error);
    if (res.truncated) {
      throw new CellError(`${label(ctx.info.get(id))} returns more than ${ROW_LIMIT.toLocaleString('en-US')} rows — the most one result can hold. Filter or aggregate it.`);
    }
    out = { columns: res.columns, rows: res.rows, deps: res.deps };
  } else if (cell.kind === 'formula') {
    const input = await wholeTable(ctx, (ctx.info.get(id) as CellInfo).deps[0]);
    checkAbort(ctx);
    out = { ...applyFormula(cell, input, paramsOf(ctx, id)), deps: input.deps };
  } else {
    throw new CellError('Only a SQL or formula cell has a table.');
  }
  putTable(key, out);
  return out;
}

/** One calculated column over `input`, by the Prepare pipeline's own step. */
// R7 HOOK: lod — a formula cell IS a calculated_field step, so whatever that step learns (LOD) a cell gets.
export function applyFormula(
  cell: Extract<NbCell, { kind: 'formula' }>,
  input: Table,
  params: ParamCell[],
): Table & { warnings: string[] } {
  const values: ParamValues = new Map(params.map((p) => [p.name.toLowerCase(), { name: p.name, kind: p.type, value: p.value }]));
  const bound = bindFormulaText(cell.expression, values);
  if (bound.errors.length) throw new CellError(bound.errors[0]);
  const res = applyPipeline(input, [{ type: 'calculated_field', name: cell.column, expression: bound.text }]);
  if (res.columns.length === input.columns.length) {
    throw new CellError((res.warnings[0] || 'The formula did not produce a column.').replace(/^Calculated field "[^"]*" skipped: /, ''));
  }
  const unknown = res.warnings.find((w) => /references unknown column/.test(w));
  if (unknown) throw new CellError(unknown.replace(/^Calculated field "[^"]*" /, 'The formula ').replace('(s)', 's'));
  return { columns: res.columns, rows: res.rows, warnings: res.warnings };
}

// ── Public entry points ──────────────────────────────────────────────────────

/** Run one cell for the notebook page: a preview, from the cache when its inputs have not moved. */
export async function runCell(projectId: string, nb: Notebook, cellId: string, signal?: AbortSignal): Promise<RunReply> {
  const t0 = Date.now();
  try {
    const ctx = await context(projectId, nb, signal);
    const info = ctx.info.get(cellId);
    const cell = ctx.cells.get(cellId);
    if (!info || !cell) return fail(cellId, 'That cell is no longer in the notebook.');
    if (cell.kind === 'markdown' || cell.kind === 'param') return fail(cellId, 'Nothing to run in this cell.');
    const why = blocked(ctx, cellId);
    if (why) return fail(cellId, why);
    const key = keyOf(ctx, cellId);
    const hit = touch(previews, key);
    if (hit) return { ...hit, sig: info.sig, cached: true, elapsedMs: Date.now() - t0 };

    let stored: Stored;
    if (cell.kind === 'sql') {
      const plan = sqlPlan(ctx, cellId);
      const res = await abortable(sqlDatasets.runSql(projectId, plan.sql, plan.params, PREVIEW_ROWS, plan.views), signal);
      if (!res.ok) return fail(cellId, res.error);
      stored = {
        ok: true, cellId, kind: 'sql', columns: res.columns, rows: res.rows, rowCount: res.rowCount,
        truncated: res.truncated, key, warnings: [], deps: res.deps,
      };
    } else if (cell.kind === 'formula') {
      const input = await wholeTable(ctx, info.deps[0]);
      const out = applyFormula(cell, input, paramsOf(ctx, cellId));
      putTable(key, { columns: out.columns, rows: out.rows, deps: input.deps });
      stored = {
        ok: true, cellId, kind: 'formula', columns: out.columns, rows: out.rows.slice(0, PREVIEW_ROWS),
        rowCount: out.rows.length, truncated: false, key, warnings: out.warnings, deps: input.deps,
      };
    } else {
      const src = await wholeTable(ctx, cell.sourceCellId);
      checkAbort(ctx);
      const viz = buildVizData(src.columns, src.rows, cell.encoding);
      stored = {
        ok: true, cellId, kind: 'chart', columns: [], rows: [], rowCount: src.rows.length, truncated: false, key,
        chart: { chartType: cell.chartType, data: viz.data, warnings: viz.warnings }, warnings: viz.warnings, deps: src.deps,
      };
    }
    putPreview(key, stored);
    return { ...stored, sig: info.sig, cached: false, elapsedMs: Date.now() - t0 };
  } catch (err) {
    if (err instanceof JobCancelled) return { ok: false, cellId, error: 'Cancelled.', cancelled: true };
    if (err instanceof CellError) return fail(cellId, err.message);
    return fail(cellId, err instanceof Error ? err.message : 'The cell could not run.');
  }
}

export type TableReply = { ok: true; columns: ParsedColumn[]; rows: Cell[][]; deps: string[] } | { ok: false; error: string; cancelled?: boolean };

/** A SQL or formula cell's whole result — Save as dataset, a pinned chart's dataset, and their refresh. */
export async function cellTable(projectId: string, nb: Notebook, cellId: string, signal?: AbortSignal): Promise<TableReply> {
  try {
    const ctx = await context(projectId, nb, signal);
    const cell = ctx.cells.get(cellId);
    if (!cell) return { ok: false, error: `The cell this was saved from is no longer in "${nb.name}".` };
    if (cell.kind !== 'sql' && cell.kind !== 'formula') return { ok: false, error: 'Only a SQL or formula cell can be saved as a dataset.' };
    const t = await wholeTable(ctx, cellId);
    return { ok: true, columns: t.columns, rows: t.rows, deps: t.deps };
  } catch (err) {
    if (err instanceof JobCancelled) return { ok: false, error: 'Cancelled.', cancelled: true };
    return { ok: false, error: err instanceof Error ? err.message : 'The cell could not run.' };
  }
}

/** The graph as the page sees it — view names against this project's datasets. */
export async function graphFor(projectId: string, nb: Notebook): Promise<NotebookGraph> {
  const cat = await sqlDatasets.projectCatalog(projectId);
  return analyzeNotebook(nb.cells, cat.flatMap((e) => (e.alias ? [e.alias, e.slug] : [e.slug])));
}
