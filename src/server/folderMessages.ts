import { t } from '../app/i18n';
// What a person reads about shared folders (docs/team-folders/00-design.md, "Refusals") — MAIN, through the
// catalog. Its own file so the i18n extractor scans only sentences. Fixed sentences: a refusal never names a
// folder, team or item, and the RPC route recognises a caught refusal by its sentence.

/** An item, or a figure on a dataset, in a folder the caller cannot open. */
export function folderClosedMessage(): string {
  return t('folderMessages.this_is_in_a_folder_you');
}

/** A reader beyond the figure doors on a dataset the caller only reaches through a dashboard. */
export function folderFiguresOnlyMessage(): string {
  return t('folderMessages.you_can_see_this_dataset_s');
}

/** A write in a folder the caller opens at view. */
export function folderEditMessage(): string {
  return t('folderMessages.you_can_view_this_folder_but');
}

/** Publish would start sharing a dataset the publisher cannot open (D16). */
export function folderPublishMessage(): string {
  return t('folderMessages.this_dashboard_now_shows_data_from');
}

/** A move whose warning no longer matches who can open the items. */
export function folderMoveChangedMessage(): string {
  return t('folderMessages.who_can_open_these_changed_since');
}

/** Deleting a folder that still holds items, Trash included. */
export function folderNotEmptyMessage(): string {
  return t('folderMessages.move_this_folder_s_items_out');
}
