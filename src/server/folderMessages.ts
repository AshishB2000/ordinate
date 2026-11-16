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

// ── The folder channels (E7): what they answer besides a refusal ────────────

/** ORDINATE_FOLDERS is off: making, sharing and moving folders waits until every pod has the folder readers (D22). */
export function folderOffMessage(): string {
  return t('folderMessages.folders_are_off_on_this_server');
}

/** Without Postgres there are no teams and no folders. */
export function folderNeedsDatabaseMessage(): string {
  return t('folderMessages.folders_need_a_database_database_url');
}

/** A top-level folder is made, renamed or deleted by a project admin (D6). */
export function folderTopLevelAdminMessage(): string {
  return t('folderMessages.only_a_project_admin_can_make');
}

/** Names are unique among siblings, regardless of case. */
export function folderNameTakenMessage(): string {
  return t('folderMessages.a_folder_with_that_name_is');
}

/** Depth at most 5 below Everyone or a top-level folder (D4). */
export function folderTooDeepMessage(): string {
  return t('folderMessages.folders_go_at_most_5_levels');
}

/** At most 1,000 folders per project (D4). */
export function folderTooManyMessage(): string {
  return t('folderMessages.a_project_can_have_at_most');
}

/** Grants and the reach switch are a top-level folder's; its subfolders follow it (D4). */
export function folderTopLevelOnlyMessage(): string {
  return t('folderMessages.only_a_top_level_folder_is');
}

/** A team that is gone (or of another org). */
export function folderUnknownTeamMessage(): string {
  return t('folderMessages.that_team_no_longer_exists');
}

/** Everyone is not a folder one renames, deletes or shares. */
export function folderEveryoneFixedMessage(): string {
  return t('folderMessages.everyone_in_the_project_is_not');
}

/** *Move everything to Everyone* is a project admin's (it is what makes a rollback safe). */
export function folderEverythingAdminMessage(): string {
  return t('folderMessages.only_a_project_admin_can_move');
}
