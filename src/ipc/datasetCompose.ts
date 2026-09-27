// The dataset composer's IPC: preview a chain, and save one. MAIN PROCESS.
//
// Its own file per CLAUDE.md's one-file-per-area rule — and because adding it to
// ipc/datasets.ts pushed that file past the 800-line cap
// (.claude/rules/file-size.md).
//
// Both handlers stand on ONE engine, combine.composeTables. The renderer sends a
// chain and paints what comes back; it never computes a joined row.

import { ipcMain } from 'electron';
import * as datasets from '../data/datasets';
import * as combine from '../data/combine';
import * as history from '../app/history';
import { runQualityChecks } from '../analysis/qualityRun';
import * as importStage from '../data/importStage';
import * as jobs from '../app/jobs';
import { detectSensitive } from '../data/sensitivity';
import { scanDataset } from '../app/privacyStore';
import type { Cell, TableData } from '../data/transforms';

const MAX_ROWS = 1_000_000;

/**
 * How many rows of EACH parent the preview folds. A preview runs on every
 * keystroke in the join editor, and a full 1M-row fold per keystroke is not a
 * preview, it is a freeze. Full fidelity happens once, on save.
 */
const PREVIEW_PARENT_ROWS = 50_000;
/** Rows returned to the renderer per preview page. */
const PREVIEW_PAGE_ROWS = 100;

/**
 * The composer's renames/retypes/drops are ORDINARY prepare steps, committed
 * through the same function a later edit uses. ipc/datasets.ts owns that
 * function (and the resident-cache invalidation around it), so it hands it over
 * at registration rather than either file importing the other.
 */
type CommitSteps = (projectId: string, datasetId: string, steps: unknown) => Promise<any>;
let commitSteps: CommitSteps | null = null;
export function setCommitSteps(fn: CommitSteps): void {
  commitSteps = fn;
}

type TableRef = { datasetId?: unknown; inline?: unknown };
type Resolved = { table: TableData; name: string; id: string | null; truncated: boolean };

/**
 * Resolve one link of the chain to a real table.
 *
 * A ref is EITHER a saved dataset id OR an inline parsed table — the file the
 * user just picked, which is not saved yet. That inline case is the whole reason
 * the composer can BE the import flow rather than a step after it.
 */
async function resolveRef(projectId: string, ref: TableRef, sample: number | null): Promise<Resolved | null> {
  if (ref && typeof ref.datasetId === 'string') {
    const ds = await datasets.getDataset(projectId, ref.datasetId);
    if (!ds) return null;
    const truncated = sample !== null && ds.rows.length > sample;
    return {
      table: { columns: ds.columns, rows: truncated ? ds.rows.slice(0, sample as number) : ds.rows },
      name: ds.name,
      id: ds.id,
      truncated,
    };
  }
  const inline = ref && (ref.inline as any);
  // A staged file import (./datasetImport.ts): the full table is already in
  // main; the renderer only holds its display slice and this id.
  const stagedTable = inline ? importStage.get(inline.stagedId) : null;
  if (stagedTable) {
    const truncated = sample !== null && stagedTable.rows.length > sample;
    return {
      table: { columns: stagedTable.columns, rows: truncated ? stagedTable.rows.slice(0, sample as number) : stagedTable.rows },
      name: typeof inline.name === 'string' && inline.name ? inline.name : 'This import',
      id: null,
      truncated,
    };
  }
  if (!inline || !Array.isArray(inline.columns) || !Array.isArray(inline.rows)) return null;
  // Untrusted: keep only well-formed {name,type} columns and array rows. A bad
  // payload becomes an empty table, never a throw.
  const columns = inline.columns
    .filter((c: any) => c && typeof c.name === 'string')
    .map((c: any) => ({ name: c.name, type: c.type === 'number' || c.type === 'date' ? c.type : 'text' }));
  const allRows = inline.rows.filter((r: any) => Array.isArray(r)) as Cell[][];
  const truncated = sample !== null && allRows.length > sample;
  return {
    table: { columns, rows: truncated ? allRows.slice(0, sample as number) : allRows },
    name: typeof inline.name === 'string' && inline.name ? inline.name : 'This import',
    id: null,
    truncated,
  };
}

/** Resolve base + joins together, so one missing link fails the whole chain by name. */
async function resolveChain(projectId: string, base: TableRef, joins: any[], sample: number | null) {
  const list = Array.isArray(joins) ? joins : [];
  const baseRes = await resolveRef(projectId, base || {}, sample);
  if (!baseRes) return { error: 'The base table could not be loaded.' } as const;
  const parts: Resolved[] = [baseRes];
  for (let i = 0; i < list.length; i += 1) {
    const r = await resolveRef(projectId, list[i] || {}, sample);
    if (!r) return { error: `Joined table ${i + 1} could not be loaded.` } as const;
    parts.push(r);
  }
  const chain = list.map((j: any, i: number) => ({
    table: parts[i + 1].table,
    mode: j && j.mode,
    on: j && j.on && typeof j.on === 'object' && typeof j.on.left === 'string' && typeof j.on.right === 'string'
      ? { left: j.on.left, right: j.on.right }
      : undefined,
  }));
  return { baseRes, parts, chain } as const;
}

// Fold the chain over a SAMPLE of each parent and return one page of the result.
// Debounced by the renderer; cheap by construction.
async function composePreview({ projectId, base, joins, page }: any = {}) {
  try {
    const r = await resolveChain(projectId, base, joins, PREVIEW_PARENT_ROWS);
    if ('error' in r) return { ok: false, error: r.error };
    const res = combine.composeTables(r.baseRes.table, r.chain, MAX_ROWS);
    const warnings = res.warnings.slice();
    // Say so when the number on screen is computed from a sample. A row count
    // that silently means "of the first 50k" is worse than no row count.
    if (r.parts.some((p) => p.truncated)) {
      warnings.push(`Preview — computed from the first ${PREVIEW_PARENT_ROWS.toLocaleString()} rows per table`);
    }
    const offset = Math.max(0, Number(page) || 0) * PREVIEW_PAGE_ROWS;
    return {
      ok: true,
      columns: res.columns,
      rows: res.rows.slice(offset, offset + PREVIEW_PAGE_ROWS),
      total: res.rowCount,
      pageRows: PREVIEW_PAGE_ROWS,
      sampled: r.parts.some((p) => p.truncated),
      warnings,
      // Proposals only — the composer shows each as a chip the user accepts or
      // dismisses; nothing is marked until they do (data/sensitivity.ts).
      sensitivity: detectSensitive(res.columns, res.rows),
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Could not build the preview' };
  }
}

/**
 * Turn `origin: { kind:'capture', captureId }` into the stored screenshot link.
 *
 * The dataset record's `capture` field is what renders the thumbnail in the
 * saved list and on the dataset page, and it holds a filesystem path — so the
 * path comes from main's own history record, never from the payload. Returns
 * null for every other origin, which is every other caller unchanged.
 */
async function resolveCaptureLink(
  origin: any,
): Promise<{ entryId: string | null; cropPath: string | null } | null> {
  if (!origin || origin.kind !== 'capture' || !origin.captureId) return null;
  const thread = await history.loadThread(origin.captureId).catch(() => null);
  return { entryId: String(origin.captureId), cropPath: (thread && thread.cropPath) || null };
}

/**
 * Save a chain as a new dataset, at FULL fidelity (no sampling), with the
 * composer's field mapping as real prepare steps.
 *
 * The origin question, which the shape of `composed` decides: it references its
 * parents by UUID, so a chain whose base is an unsaved import cannot be
 * expressed until that import IS a dataset. Rather than save a composed dataset
 * that could never refresh, an inline base WITH joins is saved first, on its own,
 * with its own origin — and the composed record points at it. With NO joins there
 * is no chain at all and the base is simply saved, which is the plain-CSV path
 * and stays exactly as fast as it was before the composer existed.
 */
export async function composeSave(
  { projectId, name, base, joins, steps, sourceKind, origin, retype }: any = {},
  ctx: { progress?: (fraction: number, note?: string) => void; checkCancelled?: () => void } = {},
) {
  try {
    const list = Array.isArray(joins) ? joins : [];
    const progress = ctx.progress || (() => { /* not a job */ });
    progress(0.02, 'Reading the tables');
    const r = await resolveChain(projectId, base, list, null);
    if ('error' in r) return { ok: false, error: r.error };
    // The Parquet write is the bulk of a save: 5–85% of the bar.
    const writing = { checkCancelled: ctx.checkCancelled, onProgress: (f: number, note?: string) => progress(0.05 + 0.8 * f, note) };

    const finalName = (typeof name === 'string' && name.trim()) || r.baseRes.name || 'Dataset';

    // A capture saved through the composer (the ordinary path — same surface as
    // Paste and Import) carries `origin: { kind:'capture', captureId }`. The
    // screenshot LINK is resolved here, from main's own history record, because
    // a renderer-sent crop path is a renderer-sent filesystem path.
    const captureLink = await resolveCaptureLink(origin);

    // No joins: an ordinary save. Same rows, same origin, same speed as before.
    if (!list.length) {
      const saved = await datasets.saveDataset(projectId, {
        name: finalName,
        sourceKind: sourceKind || (r.baseRes.id ? 'combined' : 'csv'),
        columns: r.baseRes.table.columns,
        rows: r.baseRes.table.rows.slice(0, MAX_ROWS),
        origin,
        capture: captureLink ?? undefined,
      }, writing);
      if (!saved) return { ok: false, error: 'Invalid project, or the project no longer exists' };
      importStage.drop(base && base.inline && base.inline.stagedId);
      progress(0.88, 'Applying the column mapping');
      const withSteps = await applyInitialSteps(projectId, saved.id, steps);
      const retyped = await applyRetype(projectId, saved.id, retype);
      if (captureLink && captureLink.entryId) {
        await history.setDatasetId(captureLink.entryId, saved.id)
          .catch((e: any) => console.error('[history] setDatasetId failed:', e.message));
      }
      progress(0.95, 'Checking data quality');
      await runQualityChecks(projectId, saved.id); // the data-quality hook; never throws
      await scanDataset(projectId, retyped || withSteps || saved); // sensitivity proposals; never throws
      return { ok: true, dataset: slim(retyped || withSteps || saved), warnings: [] };
    }

    // The chain's base must be a saved dataset for `composed` to be able to name it.
    let baseId = r.baseRes.id;
    let alsoSaved: string | null = null;
    if (!baseId) {
      const savedBase = await datasets.saveDataset(projectId, {
        name: r.baseRes.name,
        sourceKind: sourceKind || 'csv',
        columns: r.baseRes.table.columns,
        rows: r.baseRes.table.rows.slice(0, MAX_ROWS),
        origin,
      });
      if (!savedBase) return { ok: false, error: 'Invalid project, or the project no longer exists' };
      importStage.drop(base && base.inline && base.inline.stagedId);
      baseId = savedBase.id;
      alsoSaved = savedBase.name;
    }

    const res = combine.composeTables(r.baseRes.table, r.chain, MAX_ROWS);
    if (!res.columns.length) return { ok: false, error: 'That combination produced no columns.' };

    const warnings = res.warnings.slice();
    let rows = res.rows;
    if (rows.length > MAX_ROWS) {
      warnings.push(`Kept the first ${MAX_ROWS.toLocaleString()} rows.`);
      rows = rows.slice(0, MAX_ROWS);
    }

    const saved = await datasets.saveDataset(projectId, {
      name: finalName,
      sourceKind: 'combined',
      columns: res.columns,
      rows,
      // Ids come from main's own loaded records, never from the payload.
      origin: {
        kind: 'composed',
        baseId,
        joins: r.chain.map((c, i) => ({
          datasetId: r.parts[i + 1].id,
          mode: combine.normalizeCombineMode(c.mode),
          on: c.on,
        })),
      },
    }, writing);
    if (!saved) return { ok: false, error: 'Invalid project, or the project no longer exists' };
    if (alsoSaved) warnings.push(`"${alsoSaved}" was saved too, so this dataset can be refreshed.`);
    progress(0.88, 'Applying the column mapping');
    const withSteps = await applyInitialSteps(projectId, saved.id, steps);
    const retyped = await applyRetype(projectId, saved.id, retype);
    progress(0.95, 'Checking data quality');
    await runQualityChecks(projectId, saved.id); // the data-quality hook; never throws
    await scanDataset(projectId, retyped || withSteps || saved); // sensitivity proposals; never throws
    return { ok: true, dataset: slim(retyped || withSteps || saved), warnings };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Could not save the dataset' };
  }
}

// The composer's renames/retypes/drops are ORDINARY prepare steps, so the saved
// dataset opens in the explorer with its pipeline visible and every mapping
// reversible — the same steps a user would add later, not a parallel mechanism.
async function applyInitialSteps(projectId: string, datasetId: string, steps: unknown) {
  if (!Array.isArray(steps) || !steps.length) return null;
  if (!commitSteps) return null; // register() has not run — impossible in the app
  const res: any = await commitSteps(projectId, datasetId, steps);
  return res && res.ok && res.dataset ? res.dataset : null;
}

/**
 * The composer's column RETYPES, applied inside the save job through the same
 * column update the explorer's header menu makes (the renderer used to send
 * them as a second, unjobbed round trip after Save). Null when there are none.
 */
async function applyRetype(projectId: string, datasetId: string, retype: unknown) {
  if (!Array.isArray(retype) || !retype.length) return null;
  try {
    return await datasets.updateDataset(projectId, datasetId, { columns: retype });
  } catch (_) {
    return null; // the rows are saved; a failed retype leaves the parsed types
  }
}

/** The saved dataset WITHOUT its tables — the renderer only reads the id and name. */
function slim(ds: any): any {
  if (!ds) return ds;
  const { rows: _rows, source: _source, ...rest } = ds;
  return rest;
}

export function register(): void {
  ipcMain.handle('dataset:composePreview', (_e, payload: any = {}) => composePreview(payload));
  // Save is a JOB (src/app/jobs.ts): progress in the Jobs popover, Cancel
  // between chunks of the Parquet write, and the main thread free throughout.
  ipcMain.handle('dataset:composeSave', async (_e, payload: any = {}) => {
    const name = (payload && typeof payload.name === 'string' && payload.name.trim()) || 'dataset';
    const sql = payload && payload.origin && payload.origin.kind === 'sql';
    const job = jobs.submit({
      kind: sql ? 'sql-save' : 'import',
      label: sql ? `Save query as ${name}` : `Import ${name}`,
      projectId: typeof payload?.projectId === 'string' ? payload.projectId : undefined,
      run: async (ctx) => {
        const res: any = await composeSave(payload, { progress: ctx.progress, checkCancelled: ctx.checkCancelled });
        if (!res || !res.ok) throw new Error((res && res.error) || 'Could not save the dataset');
        return res;
      },
      resultOf: (res: any) => ({
        message: res.dataset ? `${Number(res.dataset.rowCount || 0).toLocaleString('en-US')} rows saved` : undefined,
      }),
    });
    try {
      return await job.done;
    } catch (err: any) {
      if (err instanceof jobs.JobCancelled || (err && err.name === 'JobCancelled')) return { ok: false, canceled: true, error: 'Cancelled.' };
      return { ok: false, error: err?.message || 'Could not save the dataset' };
    }
  });
}
