import { t } from '../app/i18n';
// What the status channels say when they refuse (semantic layer part 4) — MAIN, through the catalog. Its own file so
// the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. A name here is an
// item's own name, shown to the admin who picked it; no sentence names a team, a user or a value.

/** `model:certify` with a base that is not the item's pin now (409 record_changed). */
export function statusChanged(): string {
  return t('statusMessages.this_changed_since_you_reviewed_it');
}

export function replacementKind(): string {
  return t('statusMessages.pick_a_replacement_of_the_same');
}

export function replacementSelf(): string {
  return t('statusMessages.an_item_cannot_replace_itself_pick');
}

export function replacementRetired(name: string): string {
  return t('statusMessages.is_retired_too_pick_a_replacement', { name });
}

export function replacementMissing(): string {
  return t('statusMessages.that_replacement_is_gone_pick_another');
}

/** Retiring an item that another retired item points to would make a chain. */
export function wouldChain(name: string): string {
  return t('statusMessages.is_the_replacement_for_another_item', { name });
}

export function notFound(): string {
  return t('statusMessages.this_item_is_gone_it_may');
}
