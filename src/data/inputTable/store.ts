// Input tables — create, load, check and SAVE. MAIN PROCESS ONLY.
//
// An input table is an ORDINARY dataset (`sourceKind: 'input'`, Parquet, the
// usual record) whose base table is typed in the app instead of imported. So
// relationships, metrics, joins, scorecard targets and alerts read it through
// exactly the paths they read any dataset through; nothing downstream knows.
//
// ── The base table, and the prepare pipeline ─────────────────────────────────
// The grid edits the BASE: the prepare SOURCE (`<id>.source.parquet`) when the
// dataset has a pipeline, else the table itself. Every save replaces the base
// and re-derives the output by folding the steps over it — what a refresh does
// to an imported dataset. The source stays immutable TO THE PIPELINE (no step
// ever writes it); the owner of the data is the one thing that may. A save
// keeps no data snapshot: an input table's history is its versions.
//
// ── One batch, one version ───────────────────────────────────────────────────
// The renderer sends the batches (./edits.ts) made since the last save, in one
// call. Each is replayed over the STORED base — never trusting the renderer's
// copy — then the whole table is validated (./validate.ts), written once, and
// one version is recorded per batch, in order, holding the table as it stood
// after that batch. So a paste is one undo step in the grid and one entry in
// History, and a batch that changed nothing is no version (versions.ts).
//
// Saves of one table run one at a time, in the order they were issued.

import * as datasets from '../datasets';
import type { Dataset } from '../datasets';
import * as transforms from '../transforms';
import type { TransformStep } from '../transforms';
import { saltForSteps } from '../../app/privacyStore';
import { loadStepRefs } from '../stepRefs';
import * as versions from '../../app/versions';
import { isValidId } from '../../app/ids';
import type { QualityRule } from '../../analysis/qualityRules';
import { applyBatch, cleanCell } from './edits';
import type { Cell } from './edits';
import { MAX_INPUT_ROWS, checkColumns, sanitizeColumns, withOverlay } from './columns';
import type { InputColumn } from './columns';
import { checkTable, normalizeRows } from './validate';
import type { CheckContext, Checked, Issue } from './validate';
import { refTableFor } from './lookup';

/** Batches one save may carry — far more than a person makes between two blurs. */
const MAX_BATCHES = 500;
const MAX_NAME = 120;

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

export interface CheckSummary {
  issues: Issue[];
  notes: string[];
  failCells: number;
  warnCells: number;
}

/** What the grid is given: the table as it shows it, and what is wrong with it. */
export interface TableView {
  ok: true;
  id: string;
  name: string;
  columns: InputColumn[];
  rows: Cell[][];
  cap: number;
  steps: number;
  updatedAt: string;
  lookupNames: Record<string, string>;
  rules: QualityRule[];
  check: CheckSummary;
  /** Versions a save recorded. */
  versions?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>();

function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) || Promise.resolve();
  const p = prev.then(run, run);
  const tail = p.catch(() => undefined);
  chains.set(id, tail);
  void tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return p;
}

/** The table the grid edits: its definitions, and its cells with refused text back in place. */
function baseOf(ds: Dataset): { columns: InputColumn[]; rows: Cell[][] } {
  const b = ds.source ?? { columns: ds.columns, rows: ds.rows };
  const columns = sanitizeColumns(b.columns);
  return { columns, rows: withOverlay(b.rows, ds.input, columns.length) };
}

/**
 * The record a version keeps. An input table's version is its TABLE as well as
 * its pipeline — for this dataset the data is the thing being authored.
 * Exported for the pipeline's own versions (ipc/datasets commitSteps).
 */
export function versionRecordOf(ds: Dataset): Record<string, unknown> {
  const rec: Record<string, unknown> = { id: ds.id, steps: ds.steps || [] };
  if (ds.sourceKind === 'input') rec.table = baseOf(ds);
  return rec;
}

function rowsOf(raw: unknown, width: number): Cell[][] | null {
  if (!Array.isArray(raw) || raw.length > MAX_INPUT_ROWS) return null;
  return raw.map((r) => {
    const row: Cell[] = new Array(width).fill(null);
    if (Array.isArray(r)) {
      for (let c = 0; c < width; c++) {
        const v = cleanCell(r[c]);
        row[c] = v === undefined ? null : v;
      }
    }
    return row;
  });
}

async function contextFor(projectId: string, columns: InputColumn[], rules: QualityRule[]): Promise<CheckContext> {
  const ctx: CheckContext = { lookups: new Map(), lookupNames: new Map(), rules, refs: new Map() };
  for (let c = 0; c < columns.length; c++) {
    const l = columns[c].lookup;
    if (!l) continue;
    ctx.lookups.set(c, await refTableFor(projectId, l.datasetId, l.column));
    if (!ctx.lookupNames.has(l.datasetId)) {
      const meta = await datasets.getDatasetMeta(projectId, l.datasetId);
      if (meta) ctx.lookupNames.set(l.datasetId, meta.name);
    }
  }
  for (const r of rules) {
    const id = r.kind === 'references' ? r.args.datasetId : undefined;
    if (id && !ctx.refs.has(id)) ctx.refs.set(id, await refTableFor(projectId, id, r.args.column || ''));
  }
  return ctx;
}

/** A lookup must name another dataset's existing column, of a matching kind. */
async function checkLookups(projectId: string, selfId: string | null, columns: InputColumn[]): Promise<string | null> {
  for (const col of columns) {
    const l = col.lookup;
    if (!l) continue;
    if (l.datasetId === selfId) return `${col.name} cannot look up its own table`;
    const meta = await datasets.getDatasetMeta(projectId, l.datasetId);
    if (!meta) return `The dataset ${col.name} looks up no longer exists`;
    const key = meta.columns.find((k) => k.name === l.column);
    if (!key) return `Pick the key column for ${col.name} again — "${l.column}" is not in ${meta.name}`;
    if ((key.type === 'number') !== (col.type === 'number')) {
      return `${col.name} must be a ${key.type === 'number' ? 'number' : 'text'} column to look up ${meta.name} · ${key.name}`;
    }
  }
  return null;
}

function summaryOf(c: Checked): CheckSummary {
  return { issues: c.issues, notes: c.notes, failCells: c.failCells, warnCells: c.warnCells };
}

function viewOf(ds: Dataset, checked: Checked, ctx: CheckContext): TableView {
  const b = baseOf(ds);
  return {
    ok: true,
    id: ds.id,
    name: ds.name,
    columns: b.columns,
    rows: b.rows,
    cap: MAX_INPUT_ROWS,
    steps: (ds.steps || []).length,
    updatedAt: ds.updatedAt,
    lookupNames: Object.fromEntries(ctx.lookupNames),
    rules: ctx.rules,
    check: summaryOf(checked),
  };
}

/**
 * Validate `rows`, then replace the base with them and re-derive the output.
 * `steps` replaces the pipeline too (a version restore); omitted, it is kept.
 */
async function writeBase(
  projectId: string,
  existing: Dataset,
  columns: InputColumn[],
  rows: Cell[][],
  steps?: TransformStep[],
): Promise<{ dataset: Dataset; checked: Checked; ctx: CheckContext }> {
  const ctx = await contextFor(projectId, columns, existing.quality ? existing.quality.rules : []);
  const checked = checkTable(columns, rows, ctx);
  const nextSteps = steps ?? existing.steps ?? [];
  const now = new Date().toISOString();
  let updated: Dataset;
  if (existing.source !== undefined || nextSteps.length) {
    const source = { columns, rows: checked.stored };
    const salt = await saltForSteps(projectId, nextSteps);
    const output = transforms.applyPipeline(source, nextSteps, { salt, ...(await loadStepRefs(projectId, existing.id, nextSteps)) });
    updated = {
      ...existing, schemaVersion: 2, source, steps: nextSteps, columns: output.columns, rows: output.rows,
      rowCount: output.rowCount, stepCounts: output.stepCounts, updatedAt: now,
    };
  } else {
    updated = { ...existing, columns, rows: checked.stored, rowCount: checked.stored.length, updatedAt: now };
  }
  if (checked.block) updated.input = checked.block;
  else delete updated.input;
  await datasets.persist(projectId, updated);
  return { dataset: updated, checked, ctx };
}

async function inputDataset(projectId: string, id: string): Promise<Dataset | Fail> {
  const ds = await datasets.getDataset(projectId, id);
  if (!ds) return fail('That table could not be found — it may have been deleted');
  if (ds.sourceKind !== 'input') return fail('Only an input table can be edited here');
  return ds;
}

// ── The API ──────────────────────────────────────────────────────────────────

/** New dataset → Input table: the definitions, no rows yet, and its first version. */
export async function createInputTable(projectId: string, raw: unknown): Promise<{ ok: true; id: string } | Fail> {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const check = checkColumns(o.columns);
  if (!check.ok) return check;
  const bad = await checkLookups(projectId, null, check.columns);
  if (bad) return fail(bad);
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, MAX_NAME) : 'Input table';
  const ds = await datasets.saveDataset(projectId, { name, sourceKind: 'input', columns: check.columns, rows: [] });
  if (!ds) return fail('The project could not be found');
  await versions.record(projectId, 'dataset', versionRecordOf(ds));
  return { ok: true, id: ds.id };
}

export async function loadInputTable(projectId: string, id: string): Promise<TableView | Fail> {
  const ds = await inputDataset(projectId, id);
  if ('ok' in ds) return ds;
  const base = baseOf(ds);
  const ctx = await contextFor(projectId, base.columns, ds.quality ? ds.quality.rules : []);
  return viewOf(ds, checkTable(base.columns, base.rows, ctx), ctx);
}

/**
 * The grid's live check of what it is showing — nothing is written. The
 * definitions and rules come from the record, never from the renderer.
 */
export async function validateInput(projectId: string, id: string, rawRows: unknown): Promise<({ ok: true } & CheckSummary) | Fail> {
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta || meta.sourceKind !== 'input') return fail('That table could not be found');
  const columns = sanitizeColumns(meta.sourceColumns ?? meta.columns);
  const rows = rowsOf(rawRows, columns.length);
  if (!rows) return fail(`An input table holds up to ${MAX_INPUT_ROWS.toLocaleString('en-US')} rows`);
  const ctx = await contextFor(projectId, columns, meta.quality ? meta.quality.rules : []);
  return { ok: true, ...summaryOf(checkTable(columns, rows, ctx)) };
}

/** Save the batches made since the last save: replay, validate, write once, one version each. */
export function saveInputBatches(projectId: string, id: string, batches: unknown): Promise<TableView | Fail> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(fail('That table could not be found'));
  return serial(id, async () => {
    if (!Array.isArray(batches) || batches.length === 0) return fail('Nothing to save');
    if (batches.length > MAX_BATCHES) return fail('Too many edits in one save — reload the table');
    const existing = await inputDataset(projectId, id);
    if ('ok' in existing) return existing;
    const base = baseOf(existing);
    let rows = base.rows;
    const states: Cell[][][] = [];
    for (const b of batches) {
      const res = applyBatch(rows, b, base.columns.length, MAX_INPUT_ROWS);
      if (!res) return fail('An edit could not be applied to the saved table — reload it to see what is stored');
      rows = res.rows;
      states.push(rows);
    }
    const { dataset, checked, ctx } = await writeBase(projectId, existing, base.columns, rows);
    let recorded = 0;
    // ponytail: a version holds the whole table (≤10,000 rows × the 50-version
    // cap); store a per-batch diff instead if history files get large.
    for (const st of states) {
      const table = { columns: base.columns, rows: normalizeRows(base.columns, st) };
      if (await versions.record(projectId, 'dataset', { id, steps: dataset.steps || [], table })) recorded++;
    }
    return { ...viewOf(dataset, checked, ctx), versions: recorded };
  });
}

/**
 * Edit columns: new definitions, and for each one the index of the column it
 * came from (-1 = new). Cells move with their column; a retyped column keeps
 * what was typed and re-checks it, so text in a column made numeric is flagged,
 * never silently lost.
 */
export function setInputColumns(projectId: string, id: string, rawColumns: unknown, from: unknown): Promise<TableView | Fail> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(fail('That table could not be found'));
  return serial(id, async () => {
    const check = checkColumns(rawColumns);
    if (!check.ok) return check;
    const existing = await inputDataset(projectId, id);
    if ('ok' in existing) return existing;
    const base = baseOf(existing);
    const map = Array.isArray(from) ? from : [];
    const used = new Set<number>();
    if (map.length !== check.columns.length) return fail('The column list changed while it was being edited — reopen Edit columns');
    for (const f of map) {
      if (!Number.isInteger(f) || f < -1 || f >= base.columns.length || (f >= 0 && used.has(f))) return fail('The column list changed while it was being edited — reopen Edit columns');
      if (f >= 0) used.add(f);
    }
    const bad = await checkLookups(projectId, id, check.columns);
    if (bad) return fail(bad);
    const rows = base.rows.map((row) => (map as number[]).map((f) => (f >= 0 ? row[f] ?? null : null)));
    const { dataset, checked, ctx } = await writeBase(projectId, existing, check.columns, rows);
    const v = await versions.record(projectId, 'dataset', versionRecordOf(dataset));
    return { ...viewOf(dataset, checked, ctx), versions: v ? 1 : 0 };
  });
}

/** Version history's Restore: the table and pipeline as a version kept them. */
export function replaceInputTable(projectId: string, id: string, table: unknown, rawSteps: unknown): Promise<Dataset | null> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(null);
  return serial(id, async () => {
    const existing = await inputDataset(projectId, id);
    if ('ok' in existing) return null;
    const t = table && typeof table === 'object' ? (table as Record<string, unknown>) : {};
    const columns = sanitizeColumns(t.columns);
    const rows = columns.length ? rowsOf(t.rows, columns.length) : null;
    if (!rows) return null;
    const { dataset } = await writeBase(projectId, existing, columns, rows, transforms.sanitizeSteps(rawSteps));
    return dataset;
  });
}
