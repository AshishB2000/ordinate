import { t } from '../app/i18n';
// What a user sees when a step, a formula or an Excel import would do more work
// than one request may (NV-42, NV-48, NV-49, NV-51, NV-52) — MAIN, through the
// catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts
// MAIN_FILES) scans these sentences and nothing else. Figures arrive formatted.

/** A formula that ran past its work budget (src/formula/formulaBudget.ts). */
export function formulaTooMuchWork(): string {
  return t('workBudgetMessages.this_formula_does_more_work_than');
}

/** An unpivot whose output would pass the cell budget (src/data/stepsReshape.ts). */
export function unpivotTooLarge(cells: string, limit: string): string {
  return t('workBudgetMessages.unpivot_skipped_it_would_make_cells', { cells, limit });
}

/** An .xlsx refused before it is unpacked (src/data/xlsxGuard.ts). */
export function xlsxRefused(limitMb: string): string {
  return t('workBudgetMessages.this_excel_file_cannot_be_imported', { limitMb });
}

/** A sheet whose used range is too large to read (src/data/parseXlsx.ts). */
export function xlsxTooManyCells(rows: string, columns: string, limit: string): string {
  return t('workBudgetMessages.this_sheet_spans_rows_by_columns', { rows, columns, limit });
}

/** Merges, data validation or column ranges exceljs would expand cell by cell (src/data/xlsxGuard.ts). */
export function xlsxRangesTooLarge(limit: string): string {
  return t('workBudgetMessages.this_excel_file_cannot_be_imported_2', { limit });
}

/** A step list growing past the cap (src/data/datasets.ts updateSteps). */
export function tooManySteps(limit: string): string {
  return t('workBudgetMessages.a_dataset_holds_at_most_prepare', { limit });
}
