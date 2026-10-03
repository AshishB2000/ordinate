// Parquet → ParseResult, and the one entry point that reads ANY importable
// file — MAIN PROCESS / SERVER only. Split from ./fileImport.ts, which the
// compute worker also loads (its graph must not reach Electron or DuckDB).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { finalizeTable, type ParseResult } from './parse';
import { parseFile, type FileSourceKind } from './fileImport';
import * as appPaths from '../app/paths';
import * as duck from '../engine/duckdb';

/** parse.ts's output cap, applied to a Parquet read in SQL. */
const MAX_ROWS = 1_000_000;

/** parseFile for every kind, Parquet included (an import, a refresh, the CLI). */
export function parseAnyFile(filePath: string, kind: FileSourceKind, sheetName?: string): Promise<ParseResult> {
  return kind === 'parquet' ? readParquet(filePath) : parseFile(filePath, kind, sheetName);
}

/**
 * A Parquet file as a ParseResult, through DuckDB (async — the server forbids
 * a sync call on its main thread). DuckDB's connection is locked to userData
 * on the desktop (src/connectors/local.ts §1) and to the org's own directory
 * on the server (src/engine/duckdbPool.ts), so the file is COPIED into
 * userData/drop-stage first and read there — every column cast to VARCHAR and
 * typed by the importer's own rules, in file order, capped at the row limit.
 * (Moved here from src/app/dropImport.ts so the import dialog, a refresh and a
 * drop all read Parquet the same way.)
 */
export async function readParquet(file: string): Promise<ParseResult> {
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
