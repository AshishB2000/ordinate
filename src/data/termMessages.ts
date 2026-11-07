import { t } from '../app/i18n';
// What a person reads when a glossary term cannot be applied (semantic layer, PR 05a) — MAIN,
// through the catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES)
// scans these sentences and nothing else.

/** A filter step this pod cannot read, kept as it was (a newer release wrote it). */
export function termUnreadable(): string {
  return t('termMessages.this_figure_uses_a_filter_from');
}

/** A term step that reached an engine no door had expanded. */
export function termNotExpanded(): string {
  return t('termMessages.a_glossary_term_reached_the_engine');
}

// ── The term record (05b) ────────────────────────────────────────────────────

/** A name or "Also called" name a metric or another term already answers to. */
export function termNameTaken(name: string, takenBy: string): string {
  return t('termMessages.is_already_taken_by_pick_a', { name, takenBy });
}

export function termNoFilters(): string {
  return t('termMessages.a_glossary_term_needs_at_least');
}

export function termInTerm(): string {
  return t('termMessages.a_glossary_term_cannot_use_another');
}

export function termColumnMissing(column: string, dataset: string): string {
  return t('termMessages.has_no_column_pick_one_of', { dataset, column });
}

export function termDatasetGone(): string {
  return t('termMessages.the_dataset_this_term_filters_no');
}

// ── Expanding a term at a door (05b) ─────────────────────────────────────────

/** A term in the Trash. */
export function termDeleted(name: string): string {
  return t('termMessages.was_deleted_remove_it_from_this', { name });
}

/** A term gone for good: its name is gone with it. */
export function termPurged(): string {
  return t('termMessages.a_glossary_term_this_filter_uses');
}

export function termUnreachable(name: string, termDataset: string, dataset: string): string {
  return t('termMessages.filters_which_is_not_related_to', { name, termDataset, dataset });
}

export function termColumnGone(name: string, column: string, termDataset: string): string {
  return t('termMessages.filters_the_column_which_no_longer', { name, column, termDataset });
}

/** A dashboard-wide term a tile cannot use: a note on the tile, never a refusal. */
export function termNotApplied(name: string, dataset: string): string {
  return t('termMessages.the_term_does_not_apply_to', { name, dataset });
}

/** A term on a related dataset, on a figure that cannot join (a pivot, cohort, funnel, LOD, facets, a replayed or converted figure). */
export function termNoJoinHere(): string {
  return t('termMessages.this_figure_cannot_use_a_glossary');
}

/** A what-if driver aimed through a term: its target is one filter step. */
export function termNotHere(): string {
  return t('termMessages.a_what_if_driver_cannot_be');
}

/** The Assistant asked for a term on another dataset (it never joins). */
export function termOtherDataset(name: string, termDataset: string, dataset: string): string {
  return t('termMessages.filters_not_ask_about_or_use', { name, termDataset, dataset });
}

// ── The term handlers (ipc/terms) ────────────────────────────────────────────

export function termNotSaved(): string {
  return t('termMessages.could_not_save_the_term_check');
}

export function termNotFound(): string {
  return t('termMessages.glossary_term_not_found');
}

export function termNotUpdated(): string {
  return t('termMessages.failed_to_update_the_term');
}

export function termNotDeleted(): string {
  return t('termMessages.could_not_delete_the_term');
}
