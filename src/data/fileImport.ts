// Reading a data file off disk into a ParseResult — MAIN PROCESS ONLY.
//
// Extracted from src/ipc/datasets.ts verbatim (no behaviour change) because a
// dataset REFRESH has to re-read exactly the file the import read, through
// exactly the same parser and the same byte ceiling. Two copies of this would be
// two answers to "what does this file contain", and the refresh copy would be
// the one nobody notices drifting.
//
// It lives here rather than in datasetRefresh.ts so that neither the IPC layer
// nor the refresh service imports the other: ipc/datasets owns the handler and
// calls the service, and both read files through this.

import * as fs from 'fs';
import * as path from 'path';
import { parseCsv, parseJson, ParseResult } from './parse';
import { parseXlsx } from './parseXlsx';

export type FileSourceKind = 'csv' | 'tsv' | 'json' | 'xlsx' | 'parquet';

// Byte ceiling enforced BEFORE any file is read into memory — the real anti-OOM
// guard (parse.ts's MAX_ROWS only trims the output after the whole file is
// already tokenized). A file over this is rejected with a clear error rather
// than freezing/crashing the main process.
export const MAX_FILE_BYTES = 512 * 1024 * 1024; // 512 MB (raised with MAX_ROWS)

export function sourceKindFor(ext: string): FileSourceKind | null {
  switch (ext) {
    case '.csv':
      return 'csv';
    case '.tsv':
      return 'tsv';
    case '.parquet':
      return 'parquet';
    case '.json':
      return 'json';
    case '.xlsx':
      return 'xlsx';
    default:
      return null;
  }
}

/** The dataset sourceKind a file kind is stored as: tab-separated text is 'csv' (there is no 'tsv' kind). */
export function storedKind(kind: FileSourceKind): 'csv' | 'json' | 'xlsx' | 'parquet' {
  return kind === 'tsv' ? 'csv' : kind;
}

/** The kind implied by a path's extension, or null for anything unsupported. */
export function sourceKindForPath(filePath: string): FileSourceKind | null {
  return sourceKindFor(path.extname(filePath).toLowerCase());
}

export async function parseFile(
  filePath: string,
  kind: FileSourceKind,
  sheetName?: string,
): Promise<ParseResult> {
  // Reject oversized files before loading them — prevents an OOM/freeze on a
  // multi-hundred-MB pick (covers csv/json readFile AND the xlsx reader below).
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    const mb = Math.round(stat.size / (1024 * 1024));
    throw new Error(`File is too large (${mb} MB). The import limit is ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  }
  if (kind === 'xlsx') return parseXlsx(filePath, sheetName);
  // Parquet is read by DuckDB in the main process (./parquetImport.ts), never here: this module
  // also runs in the compute worker, whose import graph must stay free of DuckDB.
  if (kind === 'parquet') throw new Error('Parquet files are read through parquetImport.parseAnyFile');
  const text = await fs.promises.readFile(filePath, 'utf8');
  return kind === 'json' ? parseJson(text) : parseCsv(text, kind === 'tsv' ? '\t' : ',');
}
