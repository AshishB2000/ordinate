import { ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { parseCsv, parseJson, parsePaste, ParseResult } from '../parse';
import { parseXlsx } from '../parseXlsx';
import * as datasets from '../datasets';
import * as transforms from '../transforms';
import { computeColumnSummary, findQualityIssues, ColumnSummary, QualityIssue } from '../datasetStats';
import {
  computeColumnSummariesResident,
  findQualityIssuesResident,
  sampleRowsResident,
  StatsSource,
} from '../statsResident';
import {
  readPage,
  pageRowsJs,
  PageRequest,
  readDistinctPage,
  distinctValuesPageJs,
  MAX_DISTINCT,
} from '../datasetPage';
import { explainText, suggestSteps, suggestCalcField } from '../analyze';
import { compile } from '../formula';
import * as trace from '../residentTrace';

// Datasets (file-based data sources) IPC — pick+parse/paste/save/list/get/delete.
// All are ipcMain.handle (request/response). Native open dialog runs in MAIN;
// the renderer never touches fs. Every handler is wrapped so a thrown parse/read
// error becomes { ok:false, error } — the renderer never sees an unhandled
// rejection. No deps object (pure disk + dialog), matching projects.register().

// ponytail: MAX_ROWS is the real anti-freeze guard (parse.ts already caps at
// this while parsing). Re-applied defensively on save in case a renderer sends
// hand-built rows. The 500-row preview slice is display-only and lives in the
// renderer, so pickAndParse/parsePaste return the FULL capped ParseResult — one
// parse, one transfer.
// Mirrors parse.ts's MAX_ROWS, raised with it (2026-08). Note line 489 also
// uses this to bound a JOIN's OUTPUT during the build — a join is inherently
// m×n, so this is the guard that stops two large inputs producing an
// unbounded product. It is deliberately the same number: a join result is a
// dataset like any other and must obey the same ceiling.
const MAX_ROWS = 1_000_000;

// Byte ceiling enforced BEFORE any file is read into memory — the real anti-OOM
// guard (parse.ts's MAX_ROWS only trims the output after the whole file is
// already tokenized). A file over this is rejected with a clear error rather
// than freezing/crashing the main process.
const MAX_FILE_BYTES = 512 * 1024 * 1024; // 512 MB (raised with MAX_ROWS)

// Paths main handed out from the native open dialog. The re-parse (sheet-switch)
// branch of dataset:pickAndParse accepts a renderer-supplied filePath ONLY if it
// is in this set — otherwise a compromised/injected renderer could pass any
// absolute path (e.g. userData/config.json) and read back its contents, exfil-
// trating stored API keys / connection secrets. Bounds the read to files the
// user explicitly picked this session.
const pickedPaths = new Set<string>();

type SourceKind = 'csv' | 'json' | 'paste' | 'xlsx';

function sourceKindFor(ext: string): SourceKind | null {
  switch (ext) {
    case '.csv':
      return 'csv';
    case '.json':
      return 'json';
    case '.xlsx':
      return 'xlsx';
    default:
      return null;
  }
}

// Build a COMPACT, plain-text summary of a dataset for the AI explainer. Every
// number here is app-computed (datasetStats), embedded as a FACT — the model
// narrates from these and never recomputes. Kept small (column stats + up to 5
// sample rows) so it fits comfortably in a single prompt.
const EXPLAIN_SAMPLE_ROWS = 5;
// Takes METADATA, not a Dataset: it only ever read name/rowCount/columns plus a
// 5-row sample, so it never needed the table. `sample` is passed in so the
// caller can supply it from a bounded read (statsResident.sampleRowsResident)
// instead of hydrating the whole thing to quote five rows.
function buildDatasetSummaryText(
  ds: { name: string; rowCount: number; columns: datasets.Dataset['columns'] },
  summaries: ColumnSummary[],
  issues: QualityIssue[],
  sample: (string | number | null)[][],
): string {
  const lines: string[] = [];
  lines.push(`Dataset: "${ds.name}" (${ds.rowCount} rows, ${ds.columns.length} columns).`);
  lines.push('');
  lines.push('Columns and computed statistics:');
  summaries.forEach((s) => {
    if (s.type === 'number') {
      const parts: string[] = [];
      if (typeof s.min === 'number') parts.push(`min ${s.min}`);
      if (typeof s.max === 'number') parts.push(`max ${s.max}`);
      if (typeof s.mean === 'number') parts.push(`mean ${s.mean}`);
      parts.push(`${s.count ?? 0} numeric values`, `${s.nonEmpty} non-empty`);
      lines.push(`- ${s.name} (number): ${parts.join(', ')}`);
    } else {
      const parts: string[] = [`${s.distinct ?? 0} distinct`, `${s.nonEmpty} non-empty`];
      if (s.mostCommon) parts.push(`most common "${s.mostCommon.value}" (${s.mostCommon.count}x)`);
      lines.push(`- ${s.name} (${s.type}): ${parts.join(', ')}`);
    }
  });
  if (issues.length > 0) {
    lines.push('');
    lines.push('Data-quality notes:');
    issues.forEach((i) => lines.push(`- ${i.detail}`));
  }
  // `sample` is supplied by the caller — see the note on the signature.
  if (sample.length > 0) {
    lines.push('');
    lines.push(`Sample rows (first ${sample.length}):`);
    lines.push(ds.columns.map((c) => c.name).join(' | '));
    sample.forEach((row) => {
      lines.push(ds.columns.map((_, c) => (row && row[c] != null ? String(row[c]) : '')).join(' | '));
    });
  }
  return lines.join('\n');
}

async function parseFile(filePath: string, kind: SourceKind, sheetName?: string): Promise<ParseResult> {
  // Reject oversized files before loading them — prevents an OOM/freeze on a
  // multi-hundred-MB pick (covers csv/json readFile AND the xlsx reader below).
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    const mb = Math.round(stat.size / (1024 * 1024));
    throw new Error(`File is too large (${mb} MB). The import limit is ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  }
  if (kind === 'xlsx') return parseXlsx(filePath, sheetName);
  const text = await fs.promises.readFile(filePath, 'utf8');
  return kind === 'json' ? parseJson(text) : parseCsv(text);
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
  const summaries = computeColumnSummariesResident(src);
  if (!summaries) {
    trace.record('datasetStats', 'failed', `summaries, ${src.columns.length} cols`);
    return null;
  }
  const issues = findQualityIssuesResident(src);
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
  const sample = sampleRowsResident(fast.src, EXPLAIN_SAMPLE_ROWS);
  if (!sample) return null;
  return { meta, summaries: fast.summaries, issues: fast.issues, sample };
}

export function register() {
  // Open the native file picker (or, when given { filePath } from a prior pick,
  // skip the dialog and re-parse that file with a chosen sheetName). Returns the
  // parsed preview WITHOUT saving.
  // ponytail: dual behavior (dialog vs re-parse) keeps sheet switching stateless
  // — the renderer passes back the filePath it already received, no re-picking.
  ipcMain.handle('dataset:pickAndParse', async (_e, { sheetName, filePath }: any = {}) => {
    try {
      let chosenPath: string;
      if (typeof filePath === 'string' && filePath) {
        // Re-parse an already-picked file (e.g. sheet switch). Only honor a path
        // main previously returned from the dialog — never an arbitrary path.
        if (!pickedPaths.has(filePath)) return { ok: false, error: 'File was not picked in this session' };
        chosenPath = filePath;
      } else {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Import data file',
          properties: ['openFile'],
          filters: [
            { name: 'Data files', extensions: ['csv', 'json', 'xlsx'] },
            { name: 'CSV', extensions: ['csv'] },
            { name: 'JSON', extensions: ['json'] },
            { name: 'Excel', extensions: ['xlsx'] },
          ],
        });
        if (canceled || !filePaths?.length) return { ok: true, canceled: true };
        chosenPath = filePaths[0];
        pickedPaths.add(chosenPath); // allow later sheet-switch re-parses of this file
      }

      const ext = path.extname(chosenPath).toLowerCase();
      const kind = sourceKindFor(ext);
      if (!kind) return { ok: false, error: `Unsupported file type: ${ext || '(none)'}` };

      const preview = await parseFile(chosenPath, kind, typeof sheetName === 'string' ? sheetName : undefined);
      return {
        ok: true,
        filePath: chosenPath,
        fileName: path.basename(chosenPath),
        sourceKind: kind,
        preview,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to read or parse the file' };
    }
  });

  // Parse pasted text (JSON / CSV / TSV auto-detect). Returns preview, no disk
  // write. Non-string/empty text yields a warning-bearing empty result.
  // ponytail: untrusted renderer payload — any.
  ipcMain.handle('dataset:parsePaste', async (_e, { text }: any = {}) => {
    try {
      if (typeof text !== 'string' || text.trim() === '') {
        return { ok: true, preview: { columns: [], rows: [], rowCount: 0, warnings: ['Empty file'] } };
      }
      return { ok: true, preview: parsePaste(text) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to parse the pasted text' };
    }
  });

  // Persist a dataset under its project. The renderer sends the columns+rows it
  // is holding (the full capped ParseResult, not the display slice).
  ipcMain.handle('dataset:save', async (_e, { projectId, name, sourceKind, columns, rows }: any = {}) => {
    try {
      const capped: any[] = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
      const saved = await datasets.saveDataset(projectId, {
        name,
        sourceKind,
        columns: Array.isArray(columns) ? columns : [],
        rows: capped,
      });
      if (!saved) return { ok: false, error: 'Invalid project, or the project no longer exists' };
      return saved;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the dataset' };
    }
  });

  ipcMain.handle('dataset:list', async (_e, { projectId }: any = {}) => datasets.listDatasets(projectId));

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

  ipcMain.handle('dataset:delete', async (_e, { projectId, id }: any = {}) => ({
    ok: await datasets.deleteDataset(projectId, id),
  }));

  // Per-column summaries + quality issues for an opened dataset. Computed ONCE
  // when the renderer opens a dataset (not per keystroke — sort/filter/search are
  // client-side). Loads the dataset, builds each column's cell array from the
  // stored rows, and runs the PURE datasetStats helpers.
  ipcMain.handle('dataset:stats', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      // Fast path: both answers straight off the .parquet, no rows hydrated.
      const fast = await residentStats(projectId, datasetId);
      if (fast) return { ok: true, summaries: fast.summaries, issues: fast.issues };

      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { ok: false, error: 'Dataset not found' };
      const summaries = ds.columns.map((col, c) =>
        computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
      );
      const issues = findQualityIssues(ds.columns, ds.rows);
      return { ok: true, summaries, issues };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute dataset stats' };
    }
  });

  // ── One WINDOW of a dataset's rows, for the Explore grid ──────────────────
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
  ipcMain.handle('dataset:page', async (_e, { projectId, datasetId, offset, limit, search, sortColumn, sortDir }: any = {}) => {
    try {
      const req: PageRequest = { offset, limit, search, sortColumn, sortDir };

      const src = await datasets.residentSource(projectId, datasetId);
      if (src) {
        const fast = readPage(src, req);
        if (fast) {
          trace.record('datasetPage', 'resident');
          return { ok: true, rows: fast.rows, total: fast.total, offset: fast.offset };
        }
        trace.record('datasetPage', 'failed', `offset=${req.offset}, sorted=${!!req.sortColumn}, searched=${!!req.search}`);
      } else {
        trace.record('datasetPage', 'skipped');
      }

      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { ok: false, error: 'Dataset not found' };
      const page = pageRowsJs(ds.columns, ds.rows, req);
      return { ok: true, rows: page.rows, total: page.total, offset: page.offset };
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
        const fast = readDistinctPage(src, col, req);
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
    } catch {
      return { values: [], total: 0 };
    }
  });

  // Rename columns / correct types. Main re-coerces cells on a type change (via
  // datasets.updateDataset → parse.coerceValue). Returns the updated dataset.
  ipcMain.handle('dataset:update', async (_e, { projectId, datasetId, columns }: any = {}) => {
    try {
      const ds = await datasets.updateDataset(projectId, datasetId, {
        columns: Array.isArray(columns) ? columns : undefined,
      });
      return ds ? { ok: true, dataset: ds } : { ok: false, error: 'Could not update the dataset' };
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

      // Fast path: the same FACTS block, built from resident stats plus a
      // LIMIT-ed sample read, so a 1M-row dataset is not materialised to quote
      // five rows of it. Every piece must succeed or the whole thing falls back
      // — a half-resident prompt is not worth the branch.
      let summaryText: string | null = null;
      const fast = await residentPromptFacts(projectId, datasetId);
      if (fast) {
        summaryText = buildDatasetSummaryText(fast.meta, fast.summaries, fast.issues, fast.sample);
      }

      if (summaryText === null) {
        const ds = await datasets.getDataset(projectId, datasetId);
        if (!ds) return { ok: false, error: 'Dataset not found' };
        const summaries = ds.columns.map((col, c) =>
          computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
        );
        const issues = findQualityIssues(ds.columns, ds.rows);
        summaryText = buildDatasetSummaryText(ds, summaries, issues, ds.rows.slice(0, EXPLAIN_SAMPLE_ROWS));
      }

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

  // Shared: load the dataset's current (sanitized) steps, or [] for a pristine one.
  async function currentSteps(projectId: string, datasetId: string): Promise<transforms.TransformStep[] | null> {
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return null;
    return Array.isArray(ds.steps) ? ds.steps.slice() : [];
  }

  // Shared: persist a resolved steps array and shape the { ok, dataset, preview }
  // reply. A null result (invalid/missing dataset) → a uniform error.
  async function commitSteps(projectId: string, datasetId: string, steps: unknown) {
    const res = await datasets.updateSteps(projectId, datasetId, steps);
    if (!res) return { ok: false, error: 'Dataset not found' };
    const { dataset, output } = res;
    return {
      ok: true,
      dataset,
      preview: { columns: output.columns, rows: output.rows, rowCount: output.rowCount, warnings: output.warnings },
    };
  }

  ipcMain.handle('dataset:addStep', async (_e, { projectId, datasetId, step }: any = {}) => {
    try {
      const steps = await currentSteps(projectId, datasetId);
      if (!steps) return { ok: false, error: 'Dataset not found' };
      steps.push(step); // sanitized inside updateSteps (a bad step is dropped)
      return await commitSteps(projectId, datasetId, steps);
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
      return await commitSteps(projectId, datasetId, steps);
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
      return await commitSteps(projectId, datasetId, steps);
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
      return await commitSteps(projectId, datasetId, reordered);
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
      return await commitSteps(projectId, datasetId, steps);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to set the steps' };
    }
  });

  // Combine the PREPARED output of two datasets (append or left/inner join) into a
  // brand-new saved dataset (sourceKind 'combined', steps=[]). The pure combine
  // lives in transforms.combineTables; this orchestration loads both datasets'
  // derived columns/rows and passes them in — combineTables is never called inside
  // applyPipeline, keeping the pipeline core single-source.
  ipcMain.handle('dataset:combine', async (_e, { projectId, datasetId, otherDatasetId, mode, on }: any = {}) => {
    try {
      const left = await datasets.getDataset(projectId, datasetId);
      const right = await datasets.getDataset(projectId, otherDatasetId);
      if (!left || !right) return { ok: false, error: 'One or both datasets were not found' };
      if (mode !== 'append' && mode !== 'join') return { ok: false, error: 'Combine mode must be "append" or "join"' };
      const onPair = on && typeof on === 'object' && typeof on.left === 'string' && typeof on.right === 'string'
        ? { left: on.left, right: on.right }
        : undefined;
      const combined = transforms.combineTables(
        { columns: left.columns, rows: left.rows },
        { columns: right.columns, rows: right.rows },
        mode,
        onPair,
        MAX_ROWS, // bound the join OUTPUT during the build (append is inherently ≤ L+R)
      );
      const cappedRows = combined.rows.slice(0, MAX_ROWS);
      const saved = await datasets.saveDataset(projectId, {
        name: `${left.name} + ${right.name}`,
        sourceKind: 'combined',
        columns: combined.columns,
        rows: cappedRows,
      });
      if (!saved) return { ok: false, error: 'Invalid project, or the project no longer exists' };
      return { ok: true, dataset: saved, warnings: combined.warnings };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to combine the datasets' };
    }
  });

  // OPTIONAL AI step suggestions. Builds the SAME compact summary as dataset:explain
  // (app-computed stats as facts, sample rows), asks the model to propose STRUCTURE
  // ONLY (a JSON array of transform steps), sanitizes it, and returns it WITHOUT
  // applying — the renderer requires user confirmation, then calls dataset:setSteps.
  // No model configured → { ok:false, notReady:true } for a gentle hint.
  ipcMain.handle('dataset:suggestSteps', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      // Fast path: metadata + Parquet-side stats, no table hydrated.
      let summaryText: string;
      const fast = await residentPromptFacts(projectId, datasetId);
      if (fast) {
        summaryText = buildDatasetSummaryText(fast.meta, fast.summaries, fast.issues, fast.sample);
      } else {
        const ds = await datasets.getDataset(projectId, datasetId);
        if (!ds) return { ok: false, error: 'Dataset not found' };
        const summaries = ds.columns.map((col, c) =>
          computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
        );
        const issues = findQualityIssues(ds.columns, ds.rows);
        summaryText = buildDatasetSummaryText(ds, summaries, issues, ds.rows.slice(0, EXPLAIN_SAMPLE_ROWS));
      }
      const res = await suggestSteps(summaryText);
      if (res.ok) return { ok: true, steps: transforms.sanitizeSteps(res.steps) };
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
      // Fast path: metadata + Parquet-side stats, no table hydrated.
      let summaryText: string;
      const fast = await residentPromptFacts(projectId, datasetId);
      if (fast) {
        summaryText = buildDatasetSummaryText(fast.meta, fast.summaries, fast.issues, fast.sample);
      } else {
        const ds = await datasets.getDataset(projectId, datasetId);
        if (!ds) return { ok: false, error: 'Dataset not found' };
        const summaries = ds.columns.map((col, c) =>
          computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
        );
        const issues = findQualityIssues(ds.columns, ds.rows);
        summaryText = buildDatasetSummaryText(ds, summaries, issues, ds.rows.slice(0, EXPLAIN_SAMPLE_ROWS));
      }
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
