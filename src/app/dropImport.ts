// Files dropped on the hub window — what each one is and what happens to it.
// MAIN PROCESS ONLY.
//
// The renderer hands over PATHS (taken from real File objects in the preload,
// preload/hubDropPreload.ts) and nothing else: main reads each file's bytes and
// decides by content (src/data/sniff.ts), never by extension, then routes it:
//
//   csv / tsv / json / xlsx / parquet → one import JOB per file, saved as a dataset
//   .ordinate bundle (manifest checked) → a new project, through the projects import
//   GeoJSON                             → the project's boundaries
//   template                            → refused: templates are built in, there is no store
//   anything else                       → refused, with the reason
//
// Every data file goes through the importer's own parsers and caps
// (fileImport.MAX_FILE_BYTES, parse.ts's 1,000,000-row cap).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from './paths';
import * as jobs from './jobs';
import * as bundle from './bundle';
import * as datasets from '../data/datasets';
import * as computePool from '../engine/computePool';
import * as duck from '../engine/duckdb';
import { importBoundaryFile } from './projectBoundaries';
import { parseCsv, finalizeTable } from '../data/parse';
import type { ParseResult } from '../data/parse';
import { parseFile, sourceKindForPath, MAX_FILE_BYTES } from '../data/fileImport';
import { sniffBytes, classifyZip, classifyJson, HEAD_BYTES, TAIL_BYTES } from '../data/sniff';
import { MAX_BOUNDARY_BYTES } from '../analysis/geojsonCheck';

export type DropKind = 'csv' | 'json' | 'xlsx' | 'parquet' | 'bundle' | 'template' | 'geojson';
export type Classified = { ok: true; kind: DropKind; delimiter?: string } | { ok: false; reason: string };

export const MAX_DROP_FILES = 20;
/** JSON up to this size is parsed to classify it; past it, it can only be records. */
const JSON_CLASSIFY_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 1_000_000;

/** Read a file's head and tail and say what it is. */
export async function classifyFile(file: string): Promise<Classified> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: 'is not a file' };
    const head = Buffer.alloc(Math.min(st.size, HEAD_BYTES));
    await fh.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(st.size, TAIL_BYTES));
    await fh.read(tail, 0, tail.length, st.size - tail.length);
    const s = sniffBytes(head, tail, st.size);
    if (!s.ok) return s;
    if (s.kind === 'zip') {
      const z = classifyZip(s.names);
      if (z === 'xlsx') return { ok: true, kind: 'xlsx' };
      // The bundle reader's own manifest check, not just the entry names.
      if (await bundle.peekManifest(file)) return { ok: true, kind: 'bundle' };
      return { ok: false, reason: 'is a ZIP archive, not a workbook or an Ordinate project' };
    }
    if (s.kind === 'json') {
      if (st.size > JSON_CLASSIFY_BYTES) return head.toString('utf8').trimStart().replace(/^﻿/, '').startsWith('[')
        ? { ok: true, kind: 'json' }
        : { ok: false, reason: 'is too large a JSON object to read as records' };
      const c = classifyJson(await fs.promises.readFile(file, 'utf8'));
      return c.ok ? { ok: true, kind: c.kind } : c;
    }
    if (s.kind === 'csv') return { ok: true, kind: 'csv', delimiter: s.delimiter };
    return { ok: true, kind: 'parquet' };
  } catch (_) {
    return { ok: false, reason: 'could not be read' };
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

/**
 * A dropped Parquet file as a ParseResult. DuckDB's connection is locked to
 * userData (src/connectors/local.ts §1), so the file is COPIED into
 * userData/drop-stage first and read there — every column cast to VARCHAR and
 * typed by the importer's own rules, in file order, capped at the row limit.
 */
async function readParquet(file: string): Promise<ParseResult> {
  const stage = path.join(appPaths.userData(), 'drop-stage');
  await fs.promises.mkdir(stage, { recursive: true });
  const copy = path.join(stage, randomUUID() + '.parquet');
  await fs.promises.copyFile(file, copy);
  try {
    const rel = `read_parquet('${copy.replace(/'/g, "''")}', file_row_number=true)`;
    const cols = (await duck.queryAsync(`DESCRIBE SELECT * FROM ${rel};`))
      .map((r) => String(r.column_name ?? ''))
      .filter((c) => c !== 'file_row_number');
    if (!cols.length) throw new Error('That Parquet file has no columns.');
    const proj = cols.map((c, i) => `CAST("${c.replace(/"/g, '""')}" AS VARCHAR) AS c${i}`).join(', ');
    const out = await duck.queryAsync(`SELECT ${proj} FROM ${rel} ORDER BY file_row_number LIMIT ${MAX_ROWS + 1};`);
    return finalizeTable(cols, out.map((r) => cols.map((_c, i) => (r['c' + i] == null ? '' : String(r['c' + i])))));
  } finally {
    await fs.promises.rm(copy, { force: true }).catch(() => undefined);
  }
}

async function parseDropped(file: string, c: { kind: DropKind; delimiter?: string }, ctx: jobs.JobContext): Promise<ParseResult> {
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`It is too large (${Math.round(stat.size / 1048576)} MB). The import limit is ${MAX_FILE_BYTES / 1048576} MB.`);
  if (c.kind === 'parquet') return readParquet(file);
  if (c.kind === 'csv' && c.delimiter && c.delimiter !== ',') return parseCsv(await fs.promises.readFile(file, 'utf8'), c.delimiter);
  const kind = c.kind === 'xlsx' ? 'xlsx' : c.kind === 'json' ? 'json' : 'csv';
  if (computePool.available()) return computePool.run<ParseResult>('parse', { filePath: file, kind }, { onProgress: ctx.progress, signal: ctx.signal });
  return parseFile(file, kind);
}

/** One data file → one import job → one dataset. Resolves with the saved dataset's id and size. */
export function importDataFile(projectId: string, file: string, c: { kind: DropKind; delimiter?: string }): Promise<{ id: string; name: string; rowCount: number }> {
  const name = path.basename(file).replace(/\.[^.]+$/, '') || 'Dropped data';
  // Only a file whose extension names what it really is can be re-read by a
  // refresh (datasetRefresh reads by extension), so only that one gets an origin.
  const refreshable = sourceKindForPath(file) === c.kind && (!c.delimiter || c.delimiter === ',');
  const job = jobs.submit({
    kind: 'import',
    label: `Import ${path.basename(file)}`,
    projectId,
    run: async (ctx) => {
      const table = await parseDropped(file, c, ctx);
      if (!table.columns.length) throw new Error(table.warnings[0] || 'No columns found.');
      ctx.checkCancelled();
      const saved = await datasets.saveDataset(projectId, {
        name,
        sourceKind: c.kind === 'parquet' ? 'parquet' : c.kind === 'xlsx' ? 'xlsx' : c.kind === 'json' ? 'json' : 'csv',
        columns: table.columns,
        rows: table.rows,
        origin: refreshable ? { kind: 'file', path: file } : undefined,
      });
      if (!saved) throw new Error('The project is no longer there.');
      return { id: saved.id, name: saved.name, rowCount: saved.rowCount };
    },
    resultOf: (r) => ({ message: `${r.rowCount.toLocaleString('en-US')} rows` }),
  });
  return job.done;
}

export interface DropResult {
  name: string;
  kind?: DropKind;
  ok: boolean;
  error?: string;
  datasetId?: string;
  rowCount?: number;
  project?: { id: string; name: string };
  counts?: Record<string, number>;
  boundary?: { id: string; name: string; featureCount: number };
}

/** Route every dropped path. Data files run as parallel jobs; the rest in order. */
export async function handleDrop(
  projectId: string | null,
  paths: string[],
  importBundle: (file: string) => Promise<any>,
): Promise<DropResult[]> {
  const userData = path.resolve(appPaths.userData());
  return Promise.all(paths.slice(0, MAX_DROP_FILES).map(async (file): Promise<DropResult> => {
    const name = path.basename(file);
    // The app's own store is never a drop source — config.json holds secrets.
    const real = await fs.promises.realpath(file).catch(() => '');
    if (!real || !path.isAbsolute(file)) return { name, ok: false, error: `${name} could not be read.` };
    if (real === userData || real.startsWith(userData + path.sep)) return { name, ok: false, error: `${name} is inside Ordinate's own data folder.` };
    const c = await classifyFile(real);
    if (!c.ok) return { name, ok: false, error: `${name} ${c.reason}.` };
    try {
      if (c.kind === 'template') return { name, kind: c.kind, ok: false, error: `${name} is a template — this version's dashboard templates are built in, so there is no library to add it to.` };
      if (c.kind === 'bundle') {
        const res = await importBundle(real);
        return res && res.ok && res.project
          ? { name, kind: c.kind, ok: true, project: { id: res.project.id, name: res.project.name }, counts: res.counts }
          : { name, kind: c.kind, ok: false, error: (res && res.error) || `${name} could not be imported.` };
      }
      if (!projectId) return { name, kind: c.kind, ok: false, error: `Open a project to import ${name}.` };
      if (c.kind === 'geojson') {
        const st = await fs.promises.stat(real);
        if (st.size > MAX_BOUNDARY_BYTES) return { name, kind: c.kind, ok: false, error: `${name} is over the 15 MB boundary limit.` };
        const b = await importBoundaryFile(projectId, real);
        return 'error' in b
          ? { name, kind: c.kind, ok: false, error: `${name}: ${b.error}` }
          : { name, kind: c.kind, ok: true, boundary: { id: b.id, name: b.name, featureCount: b.featureCount } };
      }
      const saved = await importDataFile(projectId, real, c);
      return { name, kind: c.kind, ok: true, datasetId: saved.id, rowCount: saved.rowCount };
    } catch (err: any) {
      if (err instanceof jobs.JobCancelled || (err && err.name === 'JobCancelled')) return { name, kind: c.kind, ok: false, error: `Import of ${name} cancelled.` };
      return { name, kind: c.kind, ok: false, error: `${name}: ${(err && err.message) || 'import failed.'}` };
    }
  }));
}
