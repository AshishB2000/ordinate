import { t } from '../app/i18n';
// What the rebuild-from-a-screenshot check screen says about a tile, and what
// its two channels say when they cannot go on — MAIN, through the catalog. Its
// own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans
// these sentences and nothing else.

/** A field the screenshot names, with no column of the dataset close to it. */
export function noColumnLike(said: string): string {
  return t('rebuildMessages.no_column_like_in_this_dataset', { said });
}

/** The closest column by name is the wrong type for a sum, average, min or max. */
export function needsNumber(aggregation: string, column: string, type: string): string {
  return t('rebuildMessages.needs_a_number_column_but_is', { aggregation, column, type });
}

/** The closest column by name is not a date, for a date range filter. */
export function needsDate(column: string, type: string): string {
  return t('rebuildMessages.a_date_range_needs_a_date', { column, type });
}

/** The screenshot names no field for a part the tile cannot do without. */
export function pickCategory(): string {
  return t('rebuildMessages.the_screenshot_names_no_category_for');
}

export function pickValue(): string {
  return t('rebuildMessages.the_screenshot_names_no_measure_for');
}

export function pickFilter(): string {
  return t('rebuildMessages.the_screenshot_names_no_field_for');
}

/** A chart word Ordinate has no chart for. */
export function unknownChart(word: string): string {
  return t('rebuildMessages.ordinate_has_no_chart_pick_a', { word });
}

export function noChartType(): string {
  return t('rebuildMessages.the_model_could_not_tell_what');
}

/** A heading or note tile with nothing left to say. */
export function noHeading(): string {
  return t('rebuildMessages.this_note_has_no_heading_to');
}

/** A heading tile that repeats the dashboard's title: left out, as the dashboard's name says it. */
export function namesTheDashboard(): string {
  return t('rebuildMessages.this_is_the_dashboard_s_own');
}

/** A split (legend) field with no column like it: the chart is built without the split. */
export function splitLeftOut(said: string): string {
  return t('rebuildMessages.no_column_like_so_the_chart', { said });
}

/** The one sheet a rebuilt dashboard has. */
export function sheetName(): string {
  return t('rebuildMessages.overview');
}

/** The rebuilt dashboard's name when the screenshot shows none. */
export function defaultName(): string {
  return t('rebuildMessages.rebuilt_dashboard');
}

/** The plan's rationale: app-written, so it carries no figure. `tool` is a product name. */
export function rationale(tool: string): string {
  return t('rebuildMessages.rebuilt_from_a_screenshot_of_a', { tool });
}

export function rationaleAnyTool(): string {
  return t('rebuildMessages.rebuilt_from_a_screenshot_of_a_2');
}

/** rebuild:read refusals. */
export function notPng(): string {
  return t('rebuildMessages.that_file_is_not_a_png');
}

export function tooLarge(): string {
  return t('rebuildMessages.that_image_is_too_large_to');
}

export function noTiles(): string {
  return t('rebuildMessages.the_model_found_no_dashboard_tiles');
}

export function unreadable(): string {
  return t('rebuildMessages.the_screenshot_could_not_be_read');
}

export function modelUnreadable(): string {
  return t('rebuildMessages.the_model_replied_with_something_that');
}

/** rebuild:match on a dataset that is gone. */
export function datasetGone(): string {
  return t('rebuildMessages.that_dataset_could_not_be_read');
}
