import { t } from '../app/i18n';
// What the Assistant instructions' channels say when they refuse — MAIN, through the catalog. Its own file so the
// i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** An add or an edit whose text is empty once it is one line. */
export function instructionEmpty(): string {
  return t('instructionMessages.write_the_instruction_first');
}

/** An add to a full list (./instructions MAX_INSTRUCTIONS). */
export function instructionTooMany(max: number): string {
  const count = String(max);
  return t('instructionMessages.a_project_can_have_at_most', { count });
}

/** Text that could close the guidance block's fence or speak as its marker (./instructions FENCE_RE). */
export function instructionFence(): string {
  return t('instructionMessages.an_instruction_cannot_contain_or_the');
}

/** An edit or a remove of an id the list no longer holds. */
export function instructionGone(): string {
  return t('instructionMessages.that_instruction_was_removed_by_someone');
}

/** `catalog:instructions` could not read the catalog. */
export function instructionsNotRead(): string {
  return t('instructionMessages.could_not_read_the_instructions');
}

/** `catalog:setInstructions` failed before the change was stored. */
export function instructionNotSaved(): string {
  return t('instructionMessages.could_not_save_the_instruction');
}
