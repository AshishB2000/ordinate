// XLSX reader — MAIN PROCESS, read-only.
//
// Kept separate from parse.ts so parse.ts stays exceljs- and Electron-free (a
// plain-node self-check can require it directly). This module reads ONE sheet
// of a user-picked .xlsx into string cells, then hands header + body to
// parse.ts's shared finalizeTable so xlsx type-detection/coercion is identical
// to CSV/JSON. It always reports the whole workbook's sheetNames so the renderer
// can offer a sheet picker and re-parse.
//
// ponytail: exceljs is imported READ-ONLY here — only workbook.xlsx.readFile +
// worksheet iteration are used; the write/writeBuffer (archiver) path is never
// exercised. `npm audit` flags on exceljs come entirely from its write-side
// transitive deps (archiver/zip-stream/uuid), which this code path never loads.
// Input is a local file the user explicitly picked, not network data.

import type * as ExcelJSNamespace from 'exceljs';
import { finalizeTable, ParseResult } from './parse';

// Mirror of parse.ts's MAX_ROWS (not exported there). Only used to bound our own
// row materialization; finalizeTable re-applies the authoritative cap + warning.
const MAX_ROWS = 1_000_000; // mirror of parse.ts

// Convert a single exceljs cell to a lossless display string. cell.text renders
// numbers, dates (per the sheet's format), and formula results as the user sees
// them; finalizeTable then classifies the column from those strings.
function cellToString(cell: ExcelJSNamespace.Cell | undefined): string {
  if (!cell) return '';
  const v = cell.value;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10); // YYYY-MM-DD (looksLikeDate)
  // Rich text / hyperlink / formula objects expose a rendered .text via the cell.
  if (typeof v === 'object') {
    const t = cell.text;
    return typeof t === 'string' ? t : '';
  }
  return String(v);
}

// Read ONE sheet (by name, else the first) into the pinned ParseResult. Async
// because exceljs readFile is async. Returns sheetNames for the whole workbook.
export async function parseXlsx(filePath: string, sheetName?: string): Promise<ParseResult> {
  // Lazy require so parse.ts's pure test path never loads exceljs.
  const ExcelJS = require('exceljs') as typeof ExcelJSNamespace;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheetNames = workbook.worksheets.map((w) => w.name);
  if (sheetNames.length === 0) {
    return { columns: [], rows: [], rowCount: 0, sheetNames: [], warnings: ['Sheet is empty'] };
  }

  const ws =
    (sheetName && workbook.getWorksheet(sheetName)) || workbook.worksheets[0];
  if (!ws) {
    return { columns: [], rows: [], rowCount: 0, sheetNames, warnings: ['Sheet is empty'] };
  }

  const rowCount = ws.rowCount;
  const colCount = ws.columnCount;
  if (rowCount === 0 || colCount === 0) {
    return { columns: [], rows: [], rowCount: 0, sheetNames, warnings: ['Sheet is empty'] };
  }

  const readRow = (rowNumber: number): string[] => {
    const row = ws.getRow(rowNumber);
    const cells: string[] = [];
    for (let c = 1; c <= colCount; c += 1) cells.push(cellToString(row.getCell(c)));
    return cells;
  };

  const header = readRow(1);
  const body: string[][] = [];
  // Stop reading at the row cap instead of materializing the whole sheet first:
  // unlike CSV/JSON (bounded by the 100 MB byte ceiling), a compressed .xlsx
  // decompresses many-fold and rowCount can reach ~1M — reading all of it into
  // `body` only to have finalizeTable trim to MAX_ROWS is a needless memory spike.
  // Header is row 1, so read one extra body row past the cap (rows 2..MAX_ROWS+2)
  // so finalizeTable still sees > MAX_ROWS and emits its "row cap reached" warning.
  const lastRow = Math.min(rowCount, MAX_ROWS + 2);
  for (let r = 2; r <= lastRow; r += 1) body.push(readRow(r));

  const res = finalizeTable(header, body);
  res.sheetNames = sheetNames;
  return res;
}
