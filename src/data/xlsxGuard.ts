// An uploaded .xlsx, checked BEFORE exceljs opens it (NV-48). exceljs hands the
// file to JSZip, which inflates EVERY entry whole into memory and compares the
// declared size only after the stream ends — so a few-MB upload carrying one
// entry of zeros became gigabytes in a shared compute worker. Here the same
// container checks as a bundle import (src/app/zipReader.ts) run first: a cap
// on entries and on everything they declare, deflate's worst-case ratio, then
// every entry streamed through a counter that stops the moment it passes its
// declared size. JSZip then reads exactly the bytes that were counted.

import * as fs from 'fs';
import { openZip, ZipRefused } from '../app/zipReader';
import type { ZipPolicy } from '../app/zipReader';
import { formatNumber } from '../app/format';
import { xlsxRefused } from './workBudgetMessages';

/**
 * What a workbook may unpack to, every entry together. exceljs needs about ten
 * times its unpacked size in memory (100,000 rows × 10 columns: 39 MB unpacked,
 * 412 MB peak), so a workbook past this would exhaust the pod anyway; it is
 * still ~13 million cells of sheet XML, so the 1,000,000-row cap is unchanged.
 */
export const MAX_XLSX_UNPACKED = 512 * 1024 * 1024;

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

/** Throws the catalog's sentence unless `filePath` is a zip exceljs may open without unbounded memory. */
export async function checkXlsx(filePath: string): Promise<void> {
  const refused = (): Error => new Error(xlsxRefused(formatNumber(MAX_XLSX_UNPACKED / (1024 * 1024))));
  if (!(await oneEndRecord(filePath))) throw refused();
  let zip: Awaited<ReturnType<typeof openZip>> | null = null;
  try {
    zip = await openZip({ file: filePath }, POLICY);
    for (const e of zip.entries) await zip.verify(e);
  } catch (err) {
    if (err instanceof ZipRefused) throw refused();
    throw err;
  } finally {
    if (zip) await zip.close();
  }
}
