// Every sentence @mentions show or send (docs/notifications/00-design.md) —
// MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.
// Names and item names arrive as they are shown.

import { t } from '../app/i18n';

/** A write that names someone who cannot read the project — the same words whoever it was, so it confirms nothing. */
export function notAReader(): string {
  return t('mentionMessages.you_can_only_mention_people_who');
}

/** A write naming more people than one comment may. */
export function tooManyMentions(max: number): string {
  return t('mentionMessages.a_comment_or_reply_can_mention', { max });
}

/** What a mention of someone who can no longer read the project reads as, after the "@". */
export function formerMember(): string {
  return t('mentionMessages.former_member');
}

/** Saving the setting on a server with no user directory. */
export function mentionsOff(): string {
  return t('mentionMessages.mentions_need_the_user_directory_which');
}

/** The record a comment is on, when it is gone. */
export function aDeletedRecord(): string {
  return t('mentionMessages.a_deleted_record');
}

/** The mention email's title. */
export function mentionedYouOn(by: string, on: string): string {
  return t('mentionMessages.mentioned_you_on', { by, on });
}

/** Why the reader has the email, under it. */
export function mentionEmailReason(by: string): string {
  return t('mentionMessages.you_get_this_email_because_mentioned', { by });
}
