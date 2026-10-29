// What a user sees when a step, a formula or an Excel import would do more work
// than one request may (NV-42, NV-48, NV-49, NV-51, NV-52) — MAIN, through the
// catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts
// MAIN_FILES) scans these sentences and nothing else. Figures arrive formatted.

/** A formula that ran past its work budget (src/formula/formulaBudget.ts). */
export function formulaTooMuchWork(): string {
  return 'This formula does more work than one calculation may on this table. Simplify it, or filter the rows first.';
}

/** An unpivot whose output would pass the cell budget (src/data/stepsReshape.ts). */
export function unpivotTooLarge(cells: string, limit: string): string {
  return `Unpivot skipped: it would make ${cells} cells; the limit is ${limit}`;
}

/** An .xlsx refused before it is unpacked (src/data/xlsxGuard.ts). */
export function xlsxRefused(limitMb: string): string {
  return `This Excel file cannot be imported: it is damaged, or it unpacks to more than ${limitMb} MB. Save it again from Excel, or export the sheet as CSV.`;
}

/** A sheet whose used range is too large to read (src/data/parseXlsx.ts). */
export function xlsxTooManyCells(rows: string, columns: string, limit: string): string {
  return `This sheet spans ${rows} rows by ${columns} columns, more than the ${limit} cells an Excel import reads. Delete the unused rows and columns, or export the sheet as CSV.`;
}

/** A step list growing past the cap (src/data/datasets.ts updateSteps). */
export function tooManySteps(limit: string): string {
  return `A dataset holds at most ${limit} prepare steps. Remove one before adding another.`;
}
