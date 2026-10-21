// A staged import's cells, stored EXACTLY (docs/any-pod/00-design.md §3.4).
//
// A staged table is not yet a dataset: the composer previews, joins and maps it
// from its in-memory values, so it must come back from Parquet as the very same
// JS values. The dataset contract (parquetStore: VARCHAR + the declared type)
// is not enough — `String(-0)` is "0". So each cell is one VARCHAR with a tag:
//
//   null                      SQL NULL
//   a number                  'n' + its shortest round-tripping decimal ('-0' kept)
//   a string, well-formed
//   UTF-16 and NUL-free       's' + the string
//   any other string          'j' + JSON.stringify(it): a lone surrogate or U+0000
//                             becomes a \u escape, so the stored text is well-formed
//                             and NUL-free (other non-ASCII stays as itself)
//   anything else             a TypeError: a writer broke the stage contract
//
// No stored value starts with U+FEFF (a tag comes first), so the bridge's
// leading-BOM loss never applies, and no value can make read_json fail.

import type { Cell } from './transforms';

type Wellformed = { isWellFormed?: () => boolean };
const wellFormed = (s: string): boolean =>
  typeof (s as unknown as Wellformed).isWellFormed === 'function'
    ? (s as unknown as Required<Wellformed>).isWellFormed()
    : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

export function encodeCell(v: Cell): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return 'n' + (Object.is(v, -0) ? '-0' : String(v));
  if (typeof v === 'string') return wellFormed(v) && !v.includes('\u0000') ? 's' + v : 'j' + JSON.stringify(v);
  throw new TypeError('importStage: a staged cell must be a string, a number or null');
}

export function decodeCell(s: Cell): Cell {
  if (s === null || s === undefined) return null;
  const raw = String(s);
  const body = raw.slice(1);
  switch (raw.charAt(0)) {
    case 'n': return Number(body);
    case 's': return body;
    case 'j': return JSON.parse(body) as string;
    default: throw new TypeError('importStage: not a staged cell');
  }
}

/** Throws unless every cell is a string, a number or null — before anything is written. */
export function checkCells(rows: readonly Cell[][]): void {
  for (const row of rows) {
    for (const v of row) {
      if (v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') {
        throw new TypeError('importStage: a staged cell must be a string, a number or null');
      }
    }
  }
}

/** Decodes every cell IN PLACE (a 1M-row read is never copied a second time). */
export function decodeRows(rows: Cell[][]): Cell[][] {
  for (const row of rows) for (let c = 0; c < row.length; c++) row[c] = decodeCell(row[c]);
  return rows;
}
