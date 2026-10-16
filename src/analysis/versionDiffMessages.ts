import { t } from '../app/i18n';
// What the version compare view says — MAIN, through the catalog
// (docs/version-diff/00-design.md). Its own file so the i18n extractor scans only
// sentences (as metricCheckMessages.ts). Names and labels arrive as the user wrote
// them; a figure never appears here — the compare view prints figures in their own
// row, formatted by the engine's formatter.

// ── The summary line ─────────────────────────────────────────────────────────

export function cardsChanged(n: number): string {
  return t('versionDiffMessages.changed', { n });
}

export function cardsAdded(n: number): string {
  return t('versionDiffMessages.added', { n });
}

export function cardsRemoved(n: number): string {
  return t('versionDiffMessages.removed', { n });
}

export function cardsMoved(n: number): string {
  return t('versionDiffMessages.moved', { n });
}

export function filtersChanged(n: number): string {
  return n === 1 ? t('versionDiffMessages.a_filter_changed') : t('versionDiffMessages.filters_changed', { n });
}

export function otherChanges(n: number): string {
  return t('versionDiffMessages.other', { n });
}

export function changesCount(n: number): string {
  return t('versionDiffMessages.made', { n });
}

export function noChanges(): string {
  return t('versionDiffMessages.no_changes_these_two_versions_are');
}

// ── The record itself ────────────────────────────────────────────────────────

export function titleChanged(from: string, to: string): string {
  return t('versionDiffMessages.title_changed_from_to', { from, to });
}

export function styleChanged(): string {
  return t('versionDiffMessages.the_dashboard_style_changed');
}

export function descriptionEdited(): string {
  return t('versionDiffMessages.description_edited');
}

// ── Sheets ───────────────────────────────────────────────────────────────────

export function sheetAdded(name: string): string {
  return t('versionDiffMessages.page_was_added', { name });
}

export function sheetRemoved(name: string): string {
  return t('versionDiffMessages.page_was_removed', { name });
}

export function sheetRenamed(from: string, to: string): string {
  return t('versionDiffMessages.page_was_renamed_to', { from, to });
}

export function sheetsReordered(): string {
  return t('versionDiffMessages.the_pages_were_reordered');
}

// ── Filters ──────────────────────────────────────────────────────────────────

export function filterAdded(filter: string): string {
  return t('versionDiffMessages.filter_was_added', { filter });
}

export function filterRemoved(filter: string): string {
  return t('versionDiffMessages.filter_was_removed', { filter });
}

export function filterChanged(from: string, to: string): string {
  return t('versionDiffMessages.filter_changed_from_to', { from, to });
}

// ── Cards ────────────────────────────────────────────────────────────────────

export function cardAdded(title: string, sheet: string): string {
  return t('versionDiffMessages.was_added_to', { title, sheet });
}

export function cardRemoved(title: string, sheet: string): string {
  return t('versionDiffMessages.was_removed_from', { title, sheet });
}

export function cardMovedSheet(title: string, from: string, to: string): string {
  return t('versionDiffMessages.moved_from_page_to_page', { title, from, to });
}

export function cardMovedRow(title: string, from: number, to: number): string {
  return t('versionDiffMessages.moved_from_row_to_row', { title, from, to });
}

export function cardMovedWithin(title: string, row: number): string {
  return t('versionDiffMessages.moved_along_row', { title, row });
}

export function cardResized(title: string, from: string, to: string): string {
  return t('versionDiffMessages.was_resized_from_to', { title, from, to });
}

export function cardTypeChanged(title: string): string {
  return t('versionDiffMessages.became_a_different_kind_of_card', { title });
}

export function cardRenamed(from: string, to: string): string {
  return t('versionDiffMessages.card_was_renamed_to', { from, to });
}

export function cardVisualSwapped(from: string, to: string): string {
  return t('versionDiffMessages.now_shows', { from, to });
}

export function cardChartType(title: string, from: string, to: string): string {
  return t('versionDiffMessages.chart_changed_from_to', { title, from, to });
}

export function cardEncoding(title: string): string {
  return t('versionDiffMessages.its_fields_changed', { title });
}

export function cardVisualFilters(title: string): string {
  return t('versionDiffMessages.its_own_filters_changed', { title });
}

export function cardActions(title: string): string {
  return t('versionDiffMessages.click_actions_changed', { title });
}

export function cardMeasure(title: string, from: string, to: string): string {
  return t('versionDiffMessages.measure_changed_from_to', { title, from, to });
}

export function cardSavedMetric(title: string): string {
  return t('versionDiffMessages.now_shows_a_different_saved_metric', { title });
}

export function cardDataset(title: string): string {
  return t('versionDiffMessages.now_reads_a_different_dataset', { title });
}

export function cardFormat(title: string): string {
  return t('versionDiffMessages.number_format_changed', { title });
}

export function cardCompare(title: string): string {
  return t('versionDiffMessages.comparison_period_changed', { title });
}

export function cardCalc(title: string): string {
  return t('versionDiffMessages.calculation_changed', { title });
}

export function cardScenario(title: string): string {
  return t('versionDiffMessages.what_if_scenario_changed', { title });
}

export function cardText(title: string): string {
  return t('versionDiffMessages.text_edited', { title });
}

export function cardControl(title: string): string {
  return t('versionDiffMessages.control_settings_changed', { title });
}

export function cardSettings(title: string): string {
  return t('versionDiffMessages.settings_changed', { title });
}

// ── Visuals, metrics, reports, pipelines ─────────────────────────────────────

export function chartChanged(from: string, to: string): string {
  return t('versionDiffMessages.chart_changed_from_to_2', { from, to });
}

export function categoryChanged(from: string, to: string): string {
  return t('versionDiffMessages.category_changed_from_to', { from, to });
}

export function splitChanged(from: string, to: string): string {
  return t('versionDiffMessages.split_changed_from_to', { from, to });
}

export function measureAdded(measure: string): string {
  return t('versionDiffMessages.measure_was_added', { measure });
}

export function measureRemoved(measure: string): string {
  return t('versionDiffMessages.measure_was_removed', { measure });
}

export function grainChanged(): string {
  return t('versionDiffMessages.the_date_grain_changed');
}

export function binsChanged(): string {
  return t('versionDiffMessages.the_bins_changed');
}

export function mapLevelChanged(): string {
  return t('versionDiffMessages.the_map_level_changed');
}

export function pivotChanged(): string {
  return t('versionDiffMessages.the_pivot_layout_changed');
}

export function stylingChanged(): string {
  return t('versionDiffMessages.the_styling_changed');
}

export function definitionChanged(from: string, to: string): string {
  return t('versionDiffMessages.definition_changed_from_to', { from, to });
}

export function metricFormatChanged(): string {
  return t('versionDiffMessages.the_number_format_changed');
}

export function directionChanged(): string {
  return t('versionDiffMessages.which_way_is_good_changed');
}

export function reportDashboard(): string {
  return t('versionDiffMessages.the_report_now_prints_another_dashboard');
}

export function reportFormat(from: string, to: string): string {
  return t('versionDiffMessages.format_changed_from_to', { from, to });
}

export function pagesAdded(n: number): string {
  return t('versionDiffMessages.added_2', { n });
}

export function pagesRemoved(n: number): string {
  return t('versionDiffMessages.removed_2', { n });
}

export function pagesIncluded(n: number): string {
  return t('versionDiffMessages.put_back_in', { n });
}

export function pagesExcluded(n: number): string {
  return t('versionDiffMessages.left_out', { n });
}

export function pagesEdited(n: number): string {
  return t('versionDiffMessages.edited', { n });
}

export function pagesReordered(): string {
  return t('versionDiffMessages.the_report_pages_were_reordered');
}

export function coverEdited(): string {
  return t('versionDiffMessages.the_cover_was_edited');
}

export function paperChanged(): string {
  return t('versionDiffMessages.the_paper_size_changed');
}

export function scheduleChanged(): string {
  return t('versionDiffMessages.the_schedule_changed');
}

export function includeFiltersChanged(): string {
  return t('versionDiffMessages.printing_the_filters_was_switched');
}

export function narrativeChanged(): string {
  return t('versionDiffMessages.the_narrative_page_was_switched');
}

export function stepAdded(step: string): string {
  return t('versionDiffMessages.prepare_step_added', { step });
}

export function stepRemoved(step: string): string {
  return t('versionDiffMessages.prepare_step_removed', { step });
}

export function stepsReordered(): string {
  return t('versionDiffMessages.the_prepare_steps_were_reordered');
}

export function tableColumnsChanged(): string {
  return t('versionDiffMessages.the_table_columns_changed');
}

export function rowsAdded(n: number): string {
  return t('versionDiffMessages.added_3', { n });
}

export function rowsRemoved(n: number): string {
  return t('versionDiffMessages.removed_3', { n });
}

export function cellsEdited(n: number): string {
  return t('versionDiffMessages.edited_2', { n });
}

// ── Figures ──────────────────────────────────────────────────────────────────

export function reasonMeasure(): string {
  return t('versionDiffMessages.measure_changed');
}

export function reasonFilters(): string {
  return t('versionDiffMessages.filters_changed_2');
}

export function reasonAdded(): string {
  return t('versionDiffMessages.card_added');
}

export function reasonRemoved(): string {
  return t('versionDiffMessages.card_removed');
}

export function reasonDefinition(): string {
  return t('versionDiffMessages.definition_changed');
}

export function figureGone(): string {
  return t('versionDiffMessages.its_dataset_is_no_longer_there');
}

export function untitledCard(type: string): string {
  return t('versionDiffMessages.untitled_card', { type });
}

export function deletedVisual(): string {
  return t('versionDiffMessages.a_deleted_visual');
}

export function columnChart(): string {
  return t('versionDiffMessages.column');
}

export function versionGone(): string {
  return t('versionDiffMessages.one_of_these_versions_is_gone');
}

export function figureFailed(): string {
  return t('versionDiffMessages.this_figure_could_not_be_worked');
}

// ── Metric trees (docs/metric-tree) ──────────────────────────────────────────

export function treeCardTitle(metric: string): string {
  return `${metric} tree`;
}

export function treeCardDeleted(): string {
  return t('versionDiffMessages.metric_tree_its_metric_was_deleted');
}

export function cardTreeRoot(from: string, to: string): string {
  return t('versionDiffMessages.metric_tree_root_changed_from_to', { from, to });
}

/** A metric's own tree, before and after: `shape` words below. */
export function metricTreeChanged(from: string, to: string): string {
  return t('versionDiffMessages.tree_changed_from_to', { from, to });
}

export function treeNone(): string {
  return t('versionDiffMessages.no_breakdown');
}

export function treeSplit(column: string): string {
  return t('versionDiffMessages.a_split_by', { column });
}

export function treeSum(count: number): string {
  return t('versionDiffMessages.a_sum_of_metrics', { count });
}

export function treeProduct(count: number): string {
  return t('versionDiffMessages.a_product_of_metrics', { count });
}

export function treeRatio(): string {
  return t('versionDiffMessages.a_ratio_of_two_metrics');
}

export function treeDeeper(shape: string, count: number): string {
  return t('versionDiffMessages.broken_down_further', { shape, count });
}
