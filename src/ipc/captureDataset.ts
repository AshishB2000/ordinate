import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as captureDataset from '../data/captureDataset';
import * as history from '../app/history';
import type { ParsedColumn } from '../data/parse';

// Capture → dataset IPC — turns a capture's `extractedTable` into a saved,
// reusable dataset (sourceKind 'capture') and supports recapture (replace/append).
// New module per the "one src/ipc file per area, register()" convention. Every
// handler is ipcMain.handle, wrapped so a throw becomes { ok:false, error } — the
// renderer never sees an unhandled rejection. The heavy lifting is the PURE bridge
// in src/captureDataset.ts; this layer only orchestrates disk I/O via datasets.ts.
//
// register(deps) optionally takes { resolveCropPath(entryId) } so main.ts can hand
// the crop path from its per-entry state (never trusting a renderer-sent path). If
// no resolver is wired, the screenshotRef in the payload is used as-is (a stored
// path/link, not read from disk here — only persisted for a file:// thumbnail).

const MAX_ROWS = 50_000; // matches src/ipc/datasets.ts — defensive cap on a save.

interface CaptureDeps {
  resolveCropPath?: (entryId: string) => string | null;
}

// Normalize a screenshotRef payload (+ optional resolver) into the stored capture
// link shape. When a resolver is wired and an entryId is present, the resolved
// path WINS (trusted main-process state over a renderer string).
function resolveCapture(
  deps: CaptureDeps,
  screenshotRef: any,
): { entryId: string | null; cropPath: string | null } {
  const ref = screenshotRef && typeof screenshotRef === 'object' ? screenshotRef : {};
  const entryId = typeof ref.entryId === 'string' && ref.entryId ? ref.entryId : null;
  let cropPath = typeof ref.cropPath === 'string' && ref.cropPath
    ? ref.cropPath
    : (typeof screenshotRef === 'string' && screenshotRef ? screenshotRef : null);
  if (entryId && typeof deps.resolveCropPath === 'function') {
    const resolved = deps.resolveCropPath(entryId);
    if (resolved) cropPath = resolved;
  }
  return { entryId, cropPath };
}

// Coerce untrusted renderer-sent columns into ParsedColumn[] (name + one of the
// three known types; anything else → text). The user's type CHOICE from the review
// grid is honored downstream by coerceFinal/alignForAppend (no re-detection).
function sanitizeColumns(raw: any): ParsedColumn[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    name: c && typeof c.name === 'string' ? c.name : '',
    type: (c && (c.type === 'number' || c.type === 'date')) ? c.type : 'text',
  }));
}

// Coerce untrusted renderer-sent body into a rectangular string[][] (every cell a
// string; the pure bridge re-coerces to the chosen column type).
function sanitizeBody(raw: any): string[][] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => (Array.isArray(r) ? r.map((v) => (v == null ? '' : String(v))) : []));
}

export function register(deps: CaptureDeps = {}) {
  // ── Review-grid seed ────────────────────────────────────────────────────────
  // The renderer's review-and-correct modal opens on this: it turns the capture's
  // object-keyed extractedTable into a rectangular, strictly-typed draft (same
  // finalize path as every file parser) that the user then edits before saving.
  ipcMain.handle('captureDataset:draft', async (_e, { extractedTable }: any = {}) => {
    try {
      const draft = captureDataset.buildDraft(extractedTable);
      return { ok: true, columns: draft.columns, rows: draft.rows, warnings: draft.warnings };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read the extracted table' };
    }
  });

  // ── Confirmed save (create / replace / append) ────────────────────────────────
  // Called from the review modal on confirm with the user's edited columns/rows and
  // an optional recapture target. The cropPath is resolved from trusted main state
  // (never a renderer-sent path). This is the single-shot path the renderer uses;
  // the draft/save split keeps all cell edits in renderer memory in between.
  ipcMain.handle('captureDataset:save', async (_e, { projectId, name, entryId, columns, rows, target }: any = {}) => {
    try {
      const cols = sanitizeColumns(columns);
      const body = sanitizeBody(rows);
      if (cols.length === 0) return { ok: false, error: 'No columns to save' };
      const capture = resolveCapture(deps, { entryId, cropPath: null });

      const mode = target && typeof target === 'object' ? target.mode : null;
      if (mode === 'replace' || mode === 'append') {
        const datasetId = target.datasetId;
        const targetDs = await datasets.getDataset(projectId, datasetId);
        if (!targetDs) return { ok: false, error: 'Dataset not found' };
        if (targetDs.sourceKind !== 'capture') return { ok: false, error: 'Only capture datasets can be recaptured' };

        if (mode === 'replace') {
          const { rows: coerced, warnings } = captureDataset.coerceFinal(cols, body);
          const updated = await datasets.updateDatasetData(
            projectId, datasetId, { columns: cols, rows: coerced.slice(0, MAX_ROWS) }, capture,
          );
          if (!updated) return { ok: false, error: 'Could not update the dataset' };
          return { ok: true, dataset: updated, warnings };
        }
        // APPEND — align incoming to the existing columns by name, concatenate.
        // Append onto the raw SOURCE when the target carries a Prepare pipeline
        // (else onto columns/rows directly). Appending onto the DERIVED output
        // would make updateDatasetData treat already-transformed rows as a new
        // source and re-run the pipeline a second time, corrupting the data and
        // discarding the original source. Aligning to the source columns keeps
        // the append consistent with what the pipeline was built on.
        const base = targetDs.source ?? { columns: targetDs.columns, rows: targetDs.rows };
        const aligned = captureDataset.alignForAppend(base.columns, cols, body);
        const updated = await datasets.updateDatasetData(
          projectId, datasetId,
          { columns: base.columns, rows: base.rows.concat(aligned.rows).slice(0, MAX_ROWS) },
          capture,
        );
        if (!updated) return { ok: false, error: 'Could not update the dataset' };
        return { ok: true, dataset: updated, warnings: aligned.warnings };
      }

      // CREATE new.
      const { rows: coerced, warnings } = captureDataset.coerceFinal(cols, body);
      const saved = await datasets.saveDataset(projectId, {
        name: typeof name === 'string' ? name : '',
        sourceKind: 'capture',
        columns: cols,
        rows: coerced.slice(0, MAX_ROWS),
        capture,
      });
      if (!saved) return { ok: false, error: 'Invalid project, or the project no longer exists' };
      // Link the capture back to the dataset it produced, so the Captures grid
      // can badge it "Dataset" and the capture page can enable "New visual".
      // Best-effort: the dataset is already on disk, and a missing badge must
      // never fail a save that worked.
      if (capture.entryId) {
        await history.setDatasetId(capture.entryId, saved.id)
          .catch((e: any) => console.error('[history] setDatasetId failed:', e.message));
      }
      return { ok: true, dataset: saved, warnings };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the capture as a dataset' };
    }
  });
}
