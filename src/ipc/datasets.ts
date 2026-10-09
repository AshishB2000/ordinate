import { ipcMain } from './bus';
// One parser and one byte ceiling, shared with the refresh service — see
// src/fileImport.ts for why they moved out of this file.
import * as importIpc from './datasetImport';
import * as importStage from '../data/importStage';
import { refreshAsJob } from '../data/refreshJob';
import { refreshDependents } from '../data/datasetDependents';
import * as datasets from '../data/datasets';
import * as transforms from '../data/transforms';
import * as compose from './datasetCompose';
import type { Cell } from '../data/transforms';
import { computeColumnSummary, findQualityIssues, ColumnSummary, QualityIssue } from '../data/datasetStats';
import {
  computeColumnSummariesResident,
  findQualityIssuesResident,
  sampleRowsResident,
  StatsSource,
} from '../engine/statsResident';
import {
  readPage,
  pageRowsJs,
  PageRequest,
  readDistinctPage,
  distinctValuesPageJs,
  MAX_DISTINCT,
} from '../engine/datasetPage';
import { medianOf } from '../data/columnProfile';
import { medianResident } from '../engine/medianResident';
// The visual-filter whitelist, reused verbatim: `dataset:page` now takes the
// same `FilterStep[]` a visual carries, and two sanitisers for one shape is how
// they drift apart.
import { sanitizeFilters } from '../analysis/visuals';
import { explainText, suggestSteps, suggestCalcField } from '../ai/analyze';
import { buildDatasetSummaryText } from '../ai/datasetPrompt';
import { withheldColumns } from '../app/sharePolicy';
import { compile } from '../formula/formula';
import * as trace from '../engine/residentTrace';
// The data-quality hook — never throws into the handler it rides in.
import { runQualityChecks } from '../analysis/qualityRun';
import * as versions from '../app/versions';
import { versionRecordOf } from '../data/inputTable/store';
import * as trash from '../app/trash';
import type { ParsedColumn } from '../data/parse';
import { redactOriginText } from '../data/datasetOrigin';
import { needsIncremental } from '../data/refreshCadence';
import { fastCadenceNeedsIncremental } from '../data/refreshMessages';
import { setFreshOnAsk } from '../data/freshOnAskRecord';
import { serverDataDir } from '../server/context';
import { filledPcts } from '../data/profileView';
import { refreshLive } from './liveDatasets';
import { isLive, isLiveDatasetError } from '../data/liveDataset';

/**
 * A dataset as a grid draws it: name, row count and typed columns — never the
 * rows, and never the origin (a file path, a URL that may hold a key, a SQL
 * statement). Every reply that names a dataset back to a renderer uses this.
 */
export function headerOf(ds: { id: string; name: string; rowCount: number; columns: ParsedColumn[] }) {
  return { id: ds.id, name: ds.name, rowCount: ds.rowCount, columns: ds.columns.map((c) => ({ name: c.name, type: c.type })) };
}
import { forClient } from './stepReply';

// Datasets (file-based data sources) IPC — pick+parse/paste/save/list/get/delete.
// All are ipcMain.handle (request/response). Native open dialog runs in MAIN;
// the renderer never touches fs. Every handler is wrapped so a thrown parse/read
// error becomes { ok:false, error } — the renderer never sees an unhandled
// rejection. No deps object (pure disk + dialog), matching projects.register().

// ponytail: MAX_ROWS is the real anti-freeze guard (parse.ts already caps at
// this while parsing). Re-applied defensively on save in case a renderer sends
// hand-built rows. The 500-row preview slice is display-only and lives in the
// renderer. A picked FILE is now parsed in a job and staged in main
// (./datasetImport.ts) so its rows never cross IPC; pasted text still returns
// the full capped ParseResult — it is small by construction.
// Mirrors parse.ts's MAX_ROWS, raised with it (2026-08). Note line 489 also
// uses this to bound a JOIN's OUTPUT during the build — a join is inherently
// m×n, so this is the guard that stops two large inputs producing an
// unbounded product. It is deliberately the same number: a join result is a
// dataset like any other and must obey the same ceiling.
const MAX_ROWS = 1_000_000;




// The compact FACTS block dataset:explain / suggestSteps / suggestCalcField
// send (ai/datasetPrompt.ts), built ONE way for all three. Fast path: resident
// stats plus a LIMIT-ed sample read, so a 1M-row dataset is not materialised to
// quote five rows of it — every piece must succeed or the whole thing falls
// back, a half-resident prompt is not worth the branch. Sample values of a
// column marked personal or financial are withheld. null = no such dataset.
const EXPLAIN_SAMPLE_ROWS = 5;
async function promptSummary(projectId: string, datasetId: string): Promise<string | null> {
  const withheld = await withheldColumns(projectId, datasetId);
  const fast = await residentPromptFacts(projectId, datasetId);
  if (fast) return buildDatasetSummaryText(fast.meta, fast.summaries, fast.issues, fast.sample, withheld);
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  const summaries = ds.columns.map((col, c) =>
    computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
  );
  const issues = findQualityIssues(ds.columns, ds.rows);
  return buildDatasetSummaryText(ds, summaries, issues, ds.rows.slice(0, EXPLAIN_SAMPLE_ROWS), withheld);
}


// ── Stats without hydrating the table ────────────────────────────────────────
//
// `dataset:stats` runs on EVERY Explore-tab open. It loaded the whole table into
// `Cell[][]` and then folded it once PER COLUMN — N passes over a materialised
// table on top of the hydration. `src/statsResident.ts` answers the same two
// questions in one query each, straight off the stored `.parquet`, reading no
// rows into JS. Measured THROUGH THIS HANDLER on a 6-column fixture:
//
//     rows          hydrate + N-pass fold        resident
//     100                  1.9 ms                 6.0 ms    0.3x
//     1,000                3.7 ms                 6.3 ms    0.6x
//     10,000              23.0 ms                 8.6 ms    2.7x
//     100,000            195.2 ms                27.8 ms    7.0x
//     1,000,000        2,226.7 ms                73.1 ms     30x
//
// There IS a crossover here, unlike the metric rewire: two bridge round trips
// cost a flat ~5 ms, so a table under ~5,000 rows is a few ms SLOWER. It is
// deliberately not gated on a row count — the regression is 4 ms on a one-shot
// panel open (a quarter of a frame), and the alternative is an extra metadata
// read plus a second code path to keep tested. If that trade ever stops being
// right, the gate is `getDatasetMeta(...).rowCount` here, not inside the module.
//
// A resident `null` ALWAYS means "fall back" and never "no data" — an all-empty
// column has a perfectly good summary — so `datasetStats` stays the reference
// implementation and any failure, missing Parquet or v2 record lands there
// unchanged. `scripts/test-statsResident.ts` asserts the two agree cell for
// cell, and spies on `datasets.getDataset` to prove the table was never read.
async function residentStats(
  projectId: string,
  datasetId: string,
): Promise<{ src: StatsSource; summaries: ColumnSummary[]; issues: QualityIssue[] } | null> {
  const src = await datasets.residentSource(projectId, datasetId);
  if (!src) {
    trace.record('datasetStats', 'skipped');
    return null;
  }
  const summaries = await computeColumnSummariesResident(src);
  if (!summaries) {
    trace.record('datasetStats', 'failed', `summaries, ${src.columns.length} cols`);
    return null;
  }
  const issues = await findQualityIssuesResident(src);
  if (!issues) {
    trace.record('datasetStats', 'failed', `quality issues, ${src.columns.length} cols`);
    return null;
  }
  trace.record('datasetStats', 'resident');
  return { src, summaries, issues };
}

// Everything the AI-suggestion prompts need, WITHOUT hydrating the table:
// metadata for the header line, app-computed summaries and quality issues, and a
// bounded row sample. Returns null when the dataset is not Parquet-backed or the
// bridge is down, and the caller falls back to the hydrating path.
async function residentPromptFacts(
  projectId: string,
  datasetId: string,
): Promise<{ meta: datasets.DatasetMeta; summaries: ColumnSummary[]; issues: QualityIssue[]; sample: (string | number | null)[][] } | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return null;
  const fast = await residentStats(projectId, datasetId);
  if (!fast) return null;
  const sample = await sampleRowsResident(fast.src, EXPLAIN_SAMPLE_ROWS);
  if (!sample) return null;
  return { meta, summaries: fast.summaries, issues: fast.issues, sample };
}

/** The reply shape of `dataset:page`, shared with the drill-down panel. */
export type PageReply =
  | { ok: true; rows: Cell[][]; total: number; offset: number }
  | { ok: false; error: string };

/**
 * ONE window of a dataset's rows — the resident read off the stored Parquet, or
 * the JS reference over a hydrated table when that is not available.
 *
 * Extracted from the `dataset:page` handler so `visual:rows` (the drill-down
 * panel, src/ipc/visuals.ts) reaches the rows through the IDENTICAL decision
 * with the identical request. That is not tidiness: the panel's job is to show
 * the rows behind a figure, so a second copy of this decision is a second place
 * for the rows and the figure to stop agreeing.
 *
 * `readPage` returning null ALWAYS means "fall back", never "no rows", so a v2
 * (rows-inline) record, a missing .parquet or an unavailable bridge lands on
 * `pageRowsJs` — the SAME reference implementation `readPage` is asserted
 * against. One definition of the window, two ways of getting there.
 *
 * `op` names the call site for `residentTrace`, so a fast path that silently
 * stops firing is visible per feature rather than pooled.
 */
export async function pageFor(
  projectId: string,
  datasetId: string,
  req: PageRequest,
  op: string,
): Promise<PageReply> {
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    const fast = await readPage(src, req);
    if (fast) {
      trace.record(op, 'resident');
      return { ok: true, rows: fast.rows, total: fast.total, offset: fast.offset };
    }
    trace.record(
      op,
      'failed',
      `offset=${req.offset}, sorted=${!!req.sortColumn}, searched=${!!req.search}, filters=${(req.filters || []).length}`,
    );
  } else {
    trace.record(op, 'skipped');
  }

  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return { ok: false, error: 'Dataset not found' };
  const page = pageRowsJs(ds.columns, ds.rows, req);
  return { ok: true, rows: page.rows, total: page.total, offset: page.offset };
}

// Shared: load the dataset's current (sanitized) steps, or [] for a pristine one.
async function currentSteps(projectId: string, datasetId: string): Promise<transforms.TransformStep[] | null> {
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  return Array.isArray(ds.steps) ? ds.steps.slice() : [];
}

// Shared: persist a resolved steps array and shape the { ok, dataset, preview }
// reply. A null result (invalid/missing dataset) → a uniform error.
// Exposed to datasetCompose.ts so the composer's initial field mapping lands
// through the SAME path a later edit does — one commit primitive, one cache
// invalidation, not two — and exported for the Assistant's plan runner
// (src/ai/planExec.ts), whose prepare steps land through it too.
export async function commitSteps(projectId: string, datasetId: string, steps: unknown) {
  const prior = await datasets.getDatasetMeta(projectId, datasetId);
  const res = await datasets.updateSteps(projectId, datasetId, steps);
  if (!res) return { ok: false as const, error: 'Dataset not found' };
  await runQualityChecks(projectId, datasetId);
  void refreshDependents(projectId, datasetId); // the rows SQL datasets read just changed
  const { dataset, output } = res;
  // A pipeline edit is a version of the dataset (src/app/versions.ts).
  await versions.record(projectId, 'dataset', versionRecordOf(dataset),
    { before: prior ? { id: datasetId, steps: prior.steps || [], updatedAt: prior.updatedAt } : undefined });
  return {
    ok: true as const,
    dataset,
    preview: { columns: output.columns, rows: output.rows, rowCount: output.rowCount, warnings: output.warnings, stepCounts: output.stepCounts },
  };
}

/**
 * What follows every data replace the user asked for — a refresh, and a
 * snapshot restore (src/ipc/snapshots.ts), which goes through the same path.
 *
 * Alert rules are evaluated after EVERY refresh of this dataset, and the
 * handlers are the manual entry points — both the Data row's ↻ and the
 * dashboard card's come through `dataset:refresh`, so the hook belongs at the
 * join rather than duplicated at each button. Awaited so the renderer's bell
 * is already right by the time the refresh reports done; a failure inside is
 * swallowed by the evaluator and can never fail the refresh.
 */
export async function afterRefresh(projectId: string, id: string): Promise<void> {
  // The data is already written: a failing alert evaluator must not fail the
  // save.
  try {
    await require('./alerts').evaluateAndDeliver(projectId, id);
  } catch (err) {
    console.error('[alerts] not evaluated:', err instanceof Error ? err.message : String(err));
  }
  await runQualityChecks(projectId, id);
  // A site published with "Re-publish after data refreshes" that reads this
  // dataset is rebuilt at its link (server; T2.9). Scheduled, never awaited.
  (require('../publish/hosted') as typeof import('../publish/hosted')).scheduleRepublish(projectId, id);
  // SQL datasets built on this one re-run. Not awaited: never rejects, and
  // the refresh the user asked for is done.
  void refreshDependents(projectId, id);
}

export function register() {
  compose.setCommitSteps((p, d, st) => commitSteps(p, d, st));

  // Pick + parse a file (a job, parsed in a compute worker, staged in main) and
  // parse pasted text — ./datasetImport.ts, split out at this file's cap.
  importIpc.register();

  // Persist a dataset under its project. The renderer sends the columns+rows it
  // is holding (the full capped ParseResult, not the display slice).
  // `origin` is untrusted renderer input and is whitelisted by
  // datasets.sanitizeOrigin before it is stored — an unrecognised one is simply
  // dropped, leaving a normal (non-refreshable) snapshot.
  ipcMain.handle('dataset:save', async (_e, { projectId, name, sourceKind, columns, rows, origin, stagedId }: any = {}) => {
    try {
      // A staged import (./datasetImport.ts) saves the rows main already holds;
      // the renderer only ever had the display slice.
      const stagedTable = importStage.get(stagedId);
      // A named staged table that is gone (expired, saved, or not the caller's —
      // importStage is per org + user) is refused, never saved from the slice.
      if (stagedId !== undefined && stagedId !== null && !stagedTable) return { ok: false, error: importStage.GONE };
      const capped: any[] = stagedTable ? stagedTable.rows.slice(0, MAX_ROWS) : Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
      const saved = await datasets.saveDataset(projectId, {
        name,
        sourceKind,
        columns: stagedTable ? stagedTable.columns : Array.isArray(columns) ? columns : [],
        rows: capped,
        origin,
      });
      if (saved && stagedTable) importStage.drop(stagedId);
      if (!saved) return { ok: false, error: 'Invalid project, or the project no longer exists' };
      return saved;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the dataset' };
    }
  });

  // On the server a capture summary carries `hasImage`, never its crop path (datasetSummary.ts).
  ipcMain.handle('dataset:list', async (_e, { projectId }: any = {}) => {
    return datasets.listDatasets(projectId);
  });

  ipcMain.handle('dataset:get', async (_e, { projectId, id }: any = {}) => datasets.getDataset(projectId, id));

  // Rows-free open. `dataset:get` structured-clones the ENTIRE table to the
  // renderer — 4,083 ms at 1M rows — and that one-time clone is what still
  // capped datasets after the Explore grid moved to paging. The grid now asks
  // for the window it draws via `dataset:page`, so opening a dataset needs only
  // its metadata. No fallback buffer is needed in the renderer either: for a v2
  // (rows-inline) record `dataset:page` already falls back to hydrate-and-page
  // in main, where the memory is bounded by the page size.
  ipcMain.handle('dataset:meta', async (_e, { projectId, id }: any = {}) =>
    datasets.getDatasetMeta(projectId, id));

  // The data grid's header (web/src/ui/DataGrid): `dataset:meta` minus every
  // field that says where the rows came from — an origin can hold a file path,
  // a URL with a key in it or a SQL statement, none of which a grid draws.
  ipcMain.handle('dataset:columns', async (_e, { projectId, id }: any = {}) => {
    const meta = await datasets.getDatasetMeta(projectId, id);
    // `mode: 'live'` so a screen knows before it asks for rows a Live dataset does not keep (L2.1).
    return meta ? { ...headerOf(meta), ...(isLive(meta) ? { mode: 'live' as const } : {}) } : null;
  });

  // A delete is a move to the Trash (src/app/trash.ts), taking the dataset's
  // visuals with it; `cascaded` says how many, for the toast.
  ipcMain.handle('dataset:delete', async (_e, { projectId, id }: any = {}) =>
    trash.trashRecord(projectId, 'dataset', id));

  // Re-fetch a dataset from wherever it came from. One channel for every source
  // kind; the service decides how, and a failure leaves the stored table alone.
  // `warningCount` is returned alongside the list so the renderer can say "6 of
  // 7 · 1 failed" without re-deriving it.
  // A JOB (src/app/jobs.ts), one at a time per dataset: the fetch is async and
  // the write goes through the async Parquet path, reporting to the job.
  ipcMain.handle('dataset:refresh', async (_e, { projectId, id }: any = {}) => {
    try {
      const live = await refreshLive(projectId, id); // Live: reset the cache (epoch), fetch nothing
      if (live) return live;
      const res = await refreshAsJob(projectId, id);
      if (!res.ok) {
        // The reason can quote the URL or the server path it failed on.
        if (!serverDataDir()) return res;
        const meta = await datasets.getDatasetMeta(projectId, id);
        return { ...res, error: redactOriginText(res.error, meta?.origin) };
      }
      await afterRefresh(projectId, id);
      // The header only — no caller reads the rows (a 1M-row clone is seconds
      // of work for nothing), and the origin may hold a key.
      return {
        ok: true,
        dataset: headerOf(res.dataset),
        warnings: res.warnings,
        warningCount: res.warnings.length,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to refresh the dataset' };
    }
  });

  // Per-column summaries + quality issues for an opened dataset. Computed ONCE
  // when the renderer opens a dataset (not per keystroke — sort/filter/search are
  // client-side). Loads the dataset, builds each column's cell array from the
  // stored rows, and runs the PURE datasetStats helpers.
  ipcMain.handle('dataset:stats', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      // Fast path: both answers straight off the .parquet, no rows hydrated.
      // `filledPct`: each column's filled share as the completeness table shows
      // it — the server rounds it, the browser only draws it (src/data/profileView.ts).
      const fast = await residentStats(projectId, datasetId);
      if (fast) {
        const meta = await datasets.getDatasetMeta(projectId, datasetId);
        return { ok: true, summaries: fast.summaries, issues: fast.issues, filledPct: filledPcts(fast.summaries, meta ? meta.rowCount : 0) };
      }

      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { ok: false, error: 'Dataset not found' };
      const summaries = ds.columns.map((col, c) =>
        computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
      );
      const issues = findQualityIssues(ds.columns, ds.rows);
      return { ok: true, summaries, issues, filledPct: filledPcts(summaries, ds.rowCount) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute dataset stats' };
    }
  });

  // ── One WINDOW of a dataset's rows, for the Explore grid ──────────────────
  //
  // The two-path decision itself lives in `pageFor` below, because the
  // drill-down panel (`visual:rows`) asks the same question about the same
  // dataset and must not answer it a second, subtly different way.
  //
  // The grid used to receive the WHOLE table (`dataset:get` → `expRows = ds.rows`)
  // and then re-copy it in the renderer on every keystroke and header click. That
  // is the last consumer that materialises everything, and it is what forced the
  // 50,000-row import cap. This handler answers "the 100 rows you are about to
  // draw, and how many there are in total" — search, sort and slice all run in
  // DuckDB against the stored .parquet, and only the window crosses the bridge.
  //
  // `readPage` returning null ALWAYS means "fall back", never "no rows", so a v2
  // (rows-inline) record, a missing .parquet or an unavailable bridge lands on
  // `pageRowsJs` — the SAME reference implementation `readPage` is asserted
  // against, applied to the hydrated table. One definition of what the grid
  // shows, two ways of getting there.
  ipcMain.handle('dataset:page', async (_e, { projectId, datasetId, offset, limit, search, sortColumn, sortDir, filters }: any = {}) => {
    try {
      // Filters are untrusted renderer input and go through the SAME whitelist a
      // saved visual's filters do — `transforms.sanitizeSteps` keeping only
      // 'filter' steps. An unknown column or operator survives sanitisation and
      // is then SKIPPED by both paging paths (never thrown), because one
      // dashboard-wide filter has to be able to span heterogeneous datasets.
      const req: PageRequest = { offset, limit, search, sortColumn, sortDir, filters: sanitizeFilters(filters) };
      return await pageFor(projectId, datasetId, req, 'datasetPage');
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to read the dataset page' };
    }
  });

  // Distinct values of one column, for the dashboard filter-value picker. Same
  // two-path shape as `dataset:page`: straight off the Parquet when the bridge is
  // up, otherwise `distinctValuesJs` — the SAME reference `readDistinct` is
  // asserted against — over the hydrated table.
  //
  // This exists so the renderer stops hydrating a whole table to collect at most
  // 200 options. Never throws; an unreadable dataset yields no values, which the
  // caller already renders as "no values to filter on".
  ipcMain.handle('dataset:distinct', async (_e, { projectId, datasetId, column, limit, search }: any = {}) => {
    try {
      const col = typeof column === 'string' ? column : '';
      const cap = typeof limit === 'number' && limit > 0 ? limit : MAX_DISTINCT;
      // The search runs IN SQL, not in the caller. Fetching every distinct value
      // and filtering in the renderer is the pattern that capped datasets at 50k
      // before this module existed. `total` comes back with it so the picker can
      // say "showing the first 200 of 4,812" instead of implying 200 is all.
      const req = { limit: cap, search: typeof search === 'string' ? search : '' };
      if (!col) return { values: [], total: 0 };

      const src = await datasets.residentSource(projectId, datasetId);
      if (src) {
        const fast = await readDistinctPage(src, col, req);
        if (fast) {
          trace.record('datasetDistinct', 'resident');
          return fast;
        }
        trace.record('datasetDistinct', 'failed', `limit=${cap}`);
      } else {
        trace.record('datasetDistinct', 'skipped');
      }

      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { values: [], total: 0 };
      return distinctValuesPageJs(ds.columns, ds.rows, col, req);
    } catch (err) {
      if (isLiveDatasetError(err)) throw err; // D6: "no values" would be a silent answer for a Live dataset
      return { values: [], total: 0 };
    }
  });

  // ── One column's median, for the column-profile panel ─────────────────────
  //
  // The ONE figure that panel needs and nothing else in the app computes; see
  // the header of src/data/columnProfile.ts for what serves the rest of it and
  // why a median is not folded into `dataset:stats` (it would pay for a
  // quantile over every numeric column on every dataset open, to serve a panel
  // opened by a click).
  //
  // Two-path shape, same as `dataset:distinct`. `{ ok: true, median: null }` is
  // a REAL answer — a column with no finite numeric cells, and the only thing a
  // non-number column ever gets. Never throws.
  ipcMain.handle('dataset:median', async (_e, { projectId, datasetId, column }: any = {}) => {
    try {
      const col = typeof column === 'string' ? column : '';
      if (!col) return { ok: true, median: null };

      const src = await datasets.residentSource(projectId, datasetId);
      if (src) {
        // A column DECLARED anything but `number` has no median, and that is
        // settled by the record's schema alone — no query and, crucially, no
        // hydrate. Without this, clicking a text header would fall through to
        // the JS reference and pull the whole table into main just to reach the
        // same `null`, which is the exact cost this panel is built to avoid.
        // It is also not a resident FAILURE, so it is not traced as one.
        const declared = src.columns.find((c) => c && c.name === col);
        if (declared && declared.type !== 'number') return { ok: true, median: null };

        // `{ value: null }` is "no finite cells" and ends the call; only a bare
        // `null` is "fall back". Conflating them would hydrate a million rows
        // for the JS reference to reach the same answer.
        const fast = await medianResident(src, col);
        if (fast) {
          trace.record('datasetMedian', 'resident');
          return { ok: true, median: fast.value };
        }
        trace.record('datasetMedian', 'failed', col);
      } else {
        trace.record('datasetMedian', 'skipped');
      }

      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { ok: true, median: null };
      return { ok: true, median: medianOf(ds.columns, ds.rows, col) };
    } catch {
      return { ok: true, median: null };
    }
  });

  // Rename columns / correct types, and set the auto-refresh schedule. Main
  // re-coerces cells on a type change (via datasets.updateDataset →
  // parse.coerceValue). Returns the updated dataset.
  //
  // The schedule rides on THIS channel rather than getting one of its own: it is
  // a field of the same record, and a second channel would be a second place to
  // validate a projectId and a datasetId.
  ipcMain.handle('dataset:update', async (_e, { projectId, datasetId, columns, autoRefresh, watch, freshOnAsk }: any = {}) => {
    try {
      // Fresh on ask (L3.1): only with incremental refresh on — refused with the catalog's reason.
      if (freshOnAsk !== undefined) {
        const res = await setFreshOnAsk(projectId, datasetId, freshOnAsk);
        if (!res.ok) return res;
      }
      // `undefined` means "not part of this patch"; `null` means "turn it off".
      if (autoRefresh !== undefined) {
        const every = autoRefresh === null || autoRefresh === 'off' ? null : String(autoRefresh);
        // Every 5 or 15 minutes only with incremental refresh on (setAutoRefresh refuses it too, wordlessly).
        if (needsIncremental(every) && (await datasets.getDatasetMeta(projectId, datasetId))?.incremental?.enabled !== true) {
          return { ok: false, error: fastCadenceNeedsIncremental() };
        }
        const res = await datasets.setAutoRefresh(projectId, datasetId, { every: every as any });
        if (res === false) return { ok: false, error: 'Could not set the schedule' };
      }
      if (watch !== undefined) {
        // Watch only means anything alongside a schedule; setAutoRefresh keeps
        // the existing `every` when the patch omits it, and refuses outright if
        // there is none.
        const res = await datasets.setAutoRefresh(projectId, datasetId, { watch: Boolean(watch) });
        if (res === false) return { ok: false, error: 'Set a schedule before watching for anomalies.' };
      }
      const ds = await datasets.updateDataset(projectId, datasetId, {
        columns: Array.isArray(columns) ? columns : undefined,
      });
      if (ds) await runQualityChecks(projectId, datasetId); // a rename/retype can break or fix a rule
      if (ds && Array.isArray(columns)) void refreshDependents(projectId, datasetId); // a retype changes what SQL sees
      return ds ? { ok: true, dataset: headerOf(ds) } : { ok: false, error: 'Could not update the dataset' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update the dataset' };
    }
  });

  // OPTIONAL AI narration of an opened dataset. Main computes the numbers (via the
  // PURE datasetStats helpers), embeds them as facts in a compact prompt, and asks
  // the model (through the EXISTING execution path) only to narrate. If no model is
  // configured, returns { ok:false, notReady:true } so the renderer shows a gentle
  // hint — never an error dialog. The model never writes the computed figures.
  ipcMain.handle('dataset:explain', async (_e, { payload }: any = {}) => {
    try {
      const { projectId, datasetId } = payload || {};
      const summaryText = await promptSummary(projectId, datasetId);
      if (summaryText === null) return { ok: false, error: 'Dataset not found' };
      const res = await explainText(summaryText);
      if (res.ok) return { ok: true, text: res.text };
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not explain the dataset' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to explain the dataset' };
    }
  });

  // ── Week 6: reversible transform pipeline ─────────────────────────────────
  // add/update/remove/reorder/set all resolve to a fresh `steps` array which
  // datasets.updateSteps sanitizes, recomputes from the immutable source, and
  // persists. Each returns { ok, dataset, preview } where preview is the derived
  // ApplyResult (the live view of the prepared output, incl. `warnings`). Step
  // addressing is by array INDEX (no per-step id) — the renderer uses list order.

  ipcMain.handle('dataset:addStep', async (_e, { projectId, datasetId, step }: any = {}) => {
    try {
      const steps = await currentSteps(projectId, datasetId);
      if (!steps) return { ok: false, error: 'Dataset not found' };
      steps.push(step); // sanitized inside updateSteps (a bad step is dropped)
      return forClient(await commitSteps(projectId, datasetId, steps));
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to add the step' };
    }
  });

  ipcMain.handle('dataset:updateStep', async (_e, { projectId, datasetId, index, step }: any = {}) => {
    try {
      const steps = await currentSteps(projectId, datasetId);
      if (!steps) return { ok: false, error: 'Dataset not found' };
      if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
        return { ok: false, error: 'Step index out of range' };
      }
      steps[index] = step;
      return forClient(await commitSteps(projectId, datasetId, steps));
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update the step' };
    }
  });

  ipcMain.handle('dataset:removeStep', async (_e, { projectId, datasetId, index }: any = {}) => {
    try {
      const steps = await currentSteps(projectId, datasetId);
      if (!steps) return { ok: false, error: 'Dataset not found' };
      if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
        return { ok: false, error: 'Step index out of range' };
      }
      steps.splice(index, 1);
      return forClient(await commitSteps(projectId, datasetId, steps));
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to remove the step' };
    }
  });

  ipcMain.handle('dataset:reorderSteps', async (_e, { projectId, datasetId, order }: any = {}) => {
    try {
      const steps = await currentSteps(projectId, datasetId);
      if (!steps) return { ok: false, error: 'Dataset not found' };
      // `order` must be a permutation of [0..n): same length, each index once.
      if (!Array.isArray(order) || order.length !== steps.length) {
        return { ok: false, error: 'Invalid reorder request' };
      }
      const seen = new Set<number>();
      for (const i of order) {
        if (!Number.isInteger(i) || i < 0 || i >= steps.length || seen.has(i)) {
          return { ok: false, error: 'Invalid reorder request' };
        }
        seen.add(i);
      }
      const reordered = order.map((i: number) => steps[i]);
      return forClient(await commitSteps(projectId, datasetId, reordered));
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to reorder the steps' };
    }
  });

  ipcMain.handle('dataset:setSteps', async (_e, { projectId, datasetId, steps }: any = {}) => {
    try {
      // Confirm the dataset exists so a missing one gives a clean error, then commit
      // the whole (untrusted) array — updateSteps sanitizes it.
      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { ok: false, error: 'Dataset not found' };
      return forClient(await commitSteps(projectId, datasetId, steps));
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to set the steps' };
    }
  });

  // Combine two datasets. Kept as a thin delegate to dataset:composeSave — the
  // two-table combine IS a one-join chain, and two orchestrations for one
  // operation is how they drift apart. No UI calls this any more (the composer
  // replaced the combine dialog); it stays for any caller still on the old name.
  ipcMain.handle('dataset:combine', async (_e, { projectId, datasetId, otherDatasetId, mode, on }: any = {}) => {
    const left = await datasets.getDataset(projectId, datasetId).catch(() => null);
    const right = await datasets.getDataset(projectId, otherDatasetId).catch(() => null);
    if (!left || !right) return { ok: false, error: 'One or both datasets were not found' };
    return compose.composeSave({
      projectId,
      name: `${left.name} + ${right.name}`,
      base: { datasetId },
      joins: [{ datasetId: otherDatasetId, mode, on }],
    });
  });



  // OPTIONAL AI step suggestions. Builds the SAME compact summary as dataset:explain
  // (app-computed stats as facts, sample rows), asks the model to propose STRUCTURE
  // ONLY (a JSON array of transform steps), sanitizes it, and returns it WITHOUT
  // applying — the renderer requires user confirmation, then calls dataset:setSteps.
  // No model configured → { ok:false, notReady:true } for a gentle hint.
  ipcMain.handle('dataset:suggestSteps', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const summaryText = await promptSummary(projectId, datasetId);
      if (summaryText === null) return { ok: false, error: 'Dataset not found' };
      const res = await suggestSteps(summaryText);
      if (res.ok) return { ok: true, steps: transforms.sanitizeSteps(res.steps).filter((st) => st.type !== 'segment') }; // a fitted model is the app's, never a model's
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not suggest steps' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to suggest steps' };
    }
  });

  // Week 12 — OPTIONAL AI-suggested calculated field. Builds the SAME compact
  // summary as dataset:explain/suggestSteps (app-computed stats as facts), asks the
  // model to propose STRUCTURE ONLY (a { name, expression } object — never a value),
  // and returns it WITHOUT applying. The formula is compile-checked here only to
  // attach a soft `warning`; a bad expression still returns (the renderer's step
  // editor + dataset:addStep/updateSteps re-validate on Save). No model configured
  // → { ok:false, notReady:true } for a gentle hint.
  ipcMain.handle('dataset:suggestCalcField', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const summaryText = await promptSummary(projectId, datasetId);
      if (summaryText === null) return { ok: false, error: 'Dataset not found' };
      const res = await suggestCalcField(summaryText);
      if (!res.ok) {
        if (res.errorType === 'not_ready') return { ok: false, notReady: true };
        return { ok: false, error: res.message || 'Could not suggest a calculated field' };
      }
      const name = String(res.name || '').trim();
      const expression = String(res.expression || '').trim();
      const out: { ok: true; name: string; expression: string; warning?: string } = { ok: true, name, expression };
      const compiled = compile(expression);
      if (!compiled.ok) out.warning = `The suggested formula may not compile: ${compiled.error}`;
      return out;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to suggest a calculated field' };
    }
  });
}
