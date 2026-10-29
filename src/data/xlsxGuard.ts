// An uploaded .xlsx, checked BEFORE exceljs opens it (NV-48). exceljs hands the
// file to JSZip, which inflates EVERY entry whole into memory and compares the
// declared size only after the stream ends — so a few-MB upload carrying one
// entry of zeros became gigabytes in a shared compute worker. Here the same
// container checks as a bundle import (src/app/zipReader.ts) run first: a cap
// on entries and on everything they declare, deflate's worst-case ratio, then
// every entry streamed through a counter that stops the moment it passes its
// declared size. JSZip then reads exactly the bytes that were counted.
//
// The same pass reads each worksheet's ranges that exceljs EXPANDS while it
// loads, one object per cell: a merge (`<mergeCell ref>`), a data validation
// (`sqref`) and a column run (`<col max>`). One `A1:XFD1048576` in a 2 KB file
// is 17 billion cells (NV-49); their sum is held to the sheet's cell budget.

import * as fs from 'fs';
import { openZip, ZipRefused } from '../app/zipReader';
import type { ZipPolicy } from '../app/zipReader';
import { formatNumber } from '../app/format';
import { xlsxRangesTooLarge, xlsxRefused } from './workBudgetMessages';

/**
 * What a workbook may unpack to, every entry together. exceljs needs about ten
 * times its unpacked size in memory (100,000 rows × 10 columns: 39 MB unpacked,
 * 412 MB peak), so a workbook past this would exhaust the pod anyway; it is
 * still ~13 million cells of sheet XML, so the 1,000,000-row cap is unchanged.
 */
export const MAX_XLSX_UNPACKED = 512 * 1024 * 1024;

/**
 * Cells of a sheet's used range read into the table (./parseXlsx.ts), and of
 * the ranges exceljs expands while it loads — a million rows of twenty columns.
 * The used range runs to the farthest cell present, so ONE cell at XFD2000 in a
 * few-KB file is 33 million cells (NV-49).
 */
export const MAX_XLSX_CELLS = 20_000_000;

const POLICY: ZipPolicy = {
  refuseName: () => null,
  capOf: () => MAX_XLSX_UNPACKED,
  maxEntries: 10_000,
  maxTotal: MAX_XLSX_UNPACKED,
  dataDescriptors: true, // Go's archive/zip, Apache POI and other streaming writers use them
};

const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * JSZip takes the LAST end-of-directory signature in the file; zipReader takes
 * the last one whose comment ends the file. When they differ the two would read
 * different directories, so the last signature must be the one zipReader takes.
 */
async function oneEndRecord(filePath: string): Promise<boolean> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(len);
    await fh.read(tail, 0, len, size - len);
    const at = tail.lastIndexOf(EOCD);
    return at >= 0 && at + 22 <= len && at + 22 + tail.readUInt16LE(at + 20) === len;
  } finally {
    await fh.close();
  }
}

// exceljs's own sheet-entry match (lib/xlsx/xlsx.js), unanchored as it is.
const SHEET_RE = /xl\/worksheets\/sheet\d+[.]xml/;
const MAX_TAG = 16 * 1024 * 1024;

class RangesRefused extends ZipRefused {}

/** exceljs colCache.decodeAddress, ported: capitals then digits, anything else skipped until both are seen. */
function cellOf(s: string): { row: number; col: number } | null {
  let col = 0;
  let row = 0;
  let hasCol = false;
  let hasRow = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (!hasRow && c >= 65 && c <= 90) { hasCol = true; col = col * 26 + c - 64; } else if (c >= 48 && c <= 57) { hasRow = true; row = row * 10 + c - 48; } else if (hasRow && hasCol && c !== 36) break;
  }
  return hasCol && hasRow ? { row, col } : null; // a missing half is NaN bounds there: no cells
}

/** The cells exceljs creates for one range token (colCache.decode). */
function areaOf(ref: string): number {
  const parts = ref.split(':');
  if (parts.length !== 2) return 1;
  const a = cellOf(parts[0]);
  const b = cellOf(parts[1]);
  return a && b ? (Math.abs(a.row - b.row) + 1) * (Math.abs(a.col - b.col) + 1) : 0;
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[1] ?? m[2]) : null;
};

/** Sums the cells a workbook's merges, validations and column runs expand to, chunk by chunk. */
function rangeScanner(): { feed: (chunk: Buffer) => void; end: () => void } {
  let cells = 0;
  let colMax = 0; // Column.fromModel fills 1..max, once per sheet
  let pending = '';
  const over = (): void => {
    if (cells + colMax > MAX_XLSX_CELLS) throw new RangesRefused('');
  };
  const tally = (text: string): void => {
    for (const m of text.matchAll(/<(mergeCell|dataValidation|col)\b([^>]*)>/g)) {
      const raw = attr(m[2], m[1] === 'mergeCell' ? 'ref' : m[1] === 'col' ? 'max' : 'sqref');
      if (raw === null) continue;
      if (raw.includes('&')) throw new RangesRefused(''); // an entity there is no writer's: never decoded twice
      if (m[1] === 'col') colMax = Math.max(colMax, parseInt(raw, 10) || 0);
      // a sqref is a list, each token past an optional `Sheet!` (colCache.decodeEx)
      else if (m[1] === 'dataValidation') for (const tok of raw.split(/\s+/)) cells += areaOf(/^(?:'(?:[^']|'')*'|[^'^ !]*)!(.*)/.exec(tok)?.[1] ?? tok);
      else cells += areaOf(raw);
      over();
    }
  };
  return {
    feed(chunk) {
      const text = chunk.toString('latin1');
      const end = text.lastIndexOf('>');
      if (end >= 0) {
        tally(pending + text.slice(0, end + 1));
        pending = text.slice(end + 1);
      } else {
        pending += text;
      }
      if (pending.length > MAX_TAG) {
        const lt = pending.lastIndexOf('<'); // a text run is dropped; an open tag is kept whole
        pending = lt < 0 ? '' : pending.slice(lt);
        if (pending.length > MAX_TAG) throw new RangesRefused('');
      }
    },
    end() {
      cells += colMax;
      colMax = 0;
      pending = '';
    },
  };
}

/** Throws the catalog's sentence unless `filePath` is a zip exceljs may open without unbounded memory. */
export async function checkXlsx(filePath: string): Promise<void> {
  const refused = (): Error => new Error(xlsxRefused(formatNumber(MAX_XLSX_UNPACKED / (1024 * 1024))));
  if (!(await oneEndRecord(filePath))) throw refused();
  let zip: Awaited<ReturnType<typeof openZip>> | null = null;
  const ranges = rangeScanner();
  try {
    zip = await openZip({ file: filePath }, POLICY);
    for (const e of zip.entries) {
      await zip.verify(e, undefined, SHEET_RE.test(e.name) ? ranges.feed : undefined);
      ranges.end();
    }
  } catch (err) {
    if (err instanceof RangesRefused) throw new Error(xlsxRangesTooLarge(formatNumber(MAX_XLSX_CELLS)));
    if (err instanceof ZipRefused) throw refused();
    throw err;
  } finally {
    if (zip) await zip.close();
  }
}
