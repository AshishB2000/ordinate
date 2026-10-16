import { t } from '../app/i18n';
// What an embed says when it cannot be shown, and Admin → Embedding's
// refusals (docs/embed/00-design.md) — MAIN, through the catalog. Its own file
// so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these
// sentences and nothing else.

/** The heading of every refusal page. */
export function embedRefusedTitle(): string {
  return t('embedMessages.this_dashboard_cannot_be_shown_here');
}

/** A malformed token, a bad signature, an algorithm other than HS256, an unknown claim. */
export function embedInvalid(): string {
  return t('embedMessages.this_embed_link_is_not_valid');
}

export function embedExpired(): string {
  return t('embedMessages.this_embed_link_has_expired_reload');
}

/** `exp` further ahead than the server allows. */
export function embedTooLong(hours: number): string {
  return t('embedMessages.this_embed_link_is_valid_for', { hours });
}

/** Embedding off, no secret, or an org that does not exist — one sentence for all three. */
export function embedUnavailable(): string {
  return t('embedMessages.embedding_is_not_available_for_this');
}

export function embedNotFound(): string {
  return t('embedMessages.this_dashboard_is_no_longer_published');
}

/** A link published before definitions were kept with it. */
export function embedRepublish(): string {
  return t('embedMessages.publish_this_dashboard_again_to_embed');
}

export function embedOrigin(): string {
  return t('embedMessages.this_site_is_not_allowed_to');
}

export function embedPreviewOnly(): string {
  return t('embedMessages.a_preview_link_opens_only_inside');
}

export function embedRateLimited(): string {
  return t('embedMessages.too_many_views_of_this_dashboard');
}

export function embedFailed(): string {
  return t('embedMessages.this_dashboard_could_not_be_built');
}

/** A tile over a dataset that lacks a locked column: refused, never drawn unfiltered. */
export function embedTileLocked(): string {
  return t('embedMessages.not_available_in_this_embedded_view');
}

/** A filter-bar control a locked embed cannot offer. */
export function embedControlLocked(): string {
  return t('embedMessages.not_offered_in_a_locked_embed');
}

export function embedOriginBad(origin: string): string {
  return t('embedMessages.is_not_a_site_origin_use', { origin });
}

export function embedOriginsMax(max: number): string {
  return t('embedMessages.at_most_sites_can_be_allowed', { max });
}

export function embedNeedsStore(): string {
  return t('embedMessages.this_server_cannot_keep_an_embed');
}

export function embedNeedsSecret(): string {
  return t('embedMessages.generate_a_signing_secret_before_turning');
}

export function embedNeedsOrigin(): string {
  return t('embedMessages.add_at_least_one_site_before');
}
