// The builder's preview sample, selected IN PLACE off the stored Parquet —
// MAIN PROCESS, on the ASYNC bridge (the builder is interactive; a blocking
// scan here would freeze every window on each edit).
//
// Selects exactly the rows `analysis/sampling.stratifiedIndexes` selects —
// same strata (the category cell's text, NULL its own stratum), same file
// order (`file_row_number`), same integer keep rule — so the JS reference and
// this agree row for row (scripts/test-sampling.ts). Returns null on any
// failure; the caller then hydrates and samples in JS.

import * as duck from './duckdb';
import * as parquetStore from './parquetStore';
import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import { MAX_STRATA, SAMPLE_TARGET } from '../analysis/sampling';

export interface SampleSource {
  parquetPath: string;
  columns: ParsedColumn[];
}

function toCell(raw: unknown, type: ParsedColumn['type']): Cell {
  if (raw === null || raw === undefined) return null;
  if (type !== 'number') return typeof raw === 'string' ? raw : String(raw);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function sampleRowsResident(
  src: SampleSource,
  catIndex: number,
  target = SAMPLE_TARGET,
): Promise<{ rows: Cell[][]; total: number } | null> {
  try {
    const rel = parquetStore.relationSql(src.parquetPath, { fileRowNumber: true });
    const totalRow = await duck.queryAsync(`SELECT count(*) AS n FROM ${rel};`);
    const total = Number(totalRow[0]?.n ?? 0);
    const width = src.columns.length;
    const cols = Array.from({ length: width }, (_, i) => `"c${i}"`);
    const cat = catIndex >= 0 && catIndex < width ? `"c${catIndex}"` : null;
    let guaranteeFirst = false;
    if (cat) {
      const d = await duck.queryAsync(`SELECT count(DISTINCT ${cat}) + max(CASE WHEN ${cat} IS NULL THEN 1 ELSE 0 END) AS d FROM ${rel};`);
      guaranteeFirst = Number(d[0]?.d ?? 0) <= MAX_STRATA;
    }
    const T = Math.max(1, Math.floor(target));
    const N = Math.max(1, total);
    const keep = total <= T
      ? 'TRUE'
      : `${guaranteeFirst ? 'i = 1 OR ' : ''}(i * ${T}) // ${N} > ((i - 1) * ${T}) // ${N}`;
    const partition = cat ? `PARTITION BY ${cat} ` : '';
    const sql =
      `SELECT ${cols.join(', ')} FROM (` +
      `SELECT ${cols.join(', ')}, file_row_number AS o, ` +
      `row_number() OVER (${partition}ORDER BY file_row_number) AS i FROM ${rel}` +
      `) WHERE ${keep} ORDER BY o;`;
    const out = await duck.queryAsync(sql);
    const rows: Cell[][] = out.map((r) => {
      const cells: Cell[] = new Array(width);
      for (let c = 0; c < width; c++) cells[c] = toCell(r[`c${c}`], src.columns[c].type);
      return cells;
    });
    return { rows, total };
  } catch {
    return null;
  }
}
