// Every sentence a subscription shows or sends — MAIN, through the catalog. Its
// own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans
// these sentences and nothing else. Figures, times and day names arrive already
// formatted: nothing here formats a number.

import type { SubSchedule } from './subscriptionSchedule';
import { t } from '../app/i18n';

/** Why a run ended as it did. Stored on the run; the sentence is written when it is read. */
export type RunCode =
  | 'sent' | 'partial' | 'unchanged' | 'not_refreshed' | 'missed'
  | 'owner_removed' | 'owner_no_access' | 'dashboard_gone' | 'no_channels' | 'no_content' | 'compute_failed'
  | 'post_failed' | 'unreachable' | 'refused' | 'no_secret';

export interface RunDetail {
  /** Channels that took the message / that were tried. */
  sent?: number;
  total?: number;
  /** The channel a failure names, and the HTTP status it answered. */
  channel?: string;
  status?: number;
  owner?: string;
}

const SHORT_DAYS = [0, 1, 2, 3, 4, 5, 6].map((d) => new Date(Date.UTC(2023, 0, 1 + d)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }));

/** "Every weekday at 08:00 (Europe/Berlin)". */
export function scheduleText(s: SubSchedule, timezone: string): string {
  const at = s.at;
  switch (s.cadence) {
    case 'hourly': {
      const minute = at.slice(3);
      return t('subscriptionText.every_hour_at', { minute, timezone });
    }
    case 'weekdays': return t('subscriptionText.every_weekday_at', { at, timezone });
    case 'weekly': {
      const days = (s.days ?? [1]).map((d) => SHORT_DAYS[d]).join(', ');
      return t('subscriptionText.every_at', { days, at, timezone });
    }
    case 'monthly': {
      const day = s.dayOfMonth ?? 1;
      return t('subscriptionText.monthly_on_day_at', { day, at, timezone });
    }
    default: return t('subscriptionText.every_day_at', { at, timezone });
  }
}

/** One run's outcome as a sentence. */
export function runText(code: RunCode, d: RunDetail = {}): string {
  const sent = d.sent ?? 0;
  const total = d.total ?? 0;
  const channel = d.channel || t('subscriptionText.a_channel');
  const owner = d.owner || t('subscriptionText.its_owner');
  const status = d.status ?? 0;
  switch (code) {
    case 'sent': return sent === 1 ? t('subscriptionText.sent_to_1_channel') : t('subscriptionText.sent_to_channels', { sent });
    case 'partial': return t('subscriptionText.sent_to_of_channels_could_not', { sent, total, channel });
    case 'unchanged': return t('subscriptionText.skipped_nothing_changed_since_the_last');
    case 'not_refreshed': return t('subscriptionText.skipped_the_data_has_not_refreshed');
    case 'missed': return t('subscriptionText.missed_the_server_was_not_running');
    case 'owner_removed': return t('subscriptionText.not_sent_is_no_longer_a', { owner });
    case 'owner_no_access': return t('subscriptionText.not_sent_no_longer_has_access', { owner });
    case 'dashboard_gone': return t('subscriptionText.not_sent_the_dashboard_was_deleted');
    case 'no_channels': return t('subscriptionText.not_sent_none_of_its_channels');
    case 'no_content': return t('subscriptionText.not_sent_none_of_the_chosen');
    case 'compute_failed': return t('subscriptionText.not_sent_the_figures_could_not');
    case 'post_failed': return t('subscriptionText.not_delivered_answered_http', { channel, status });
    case 'unreachable': return t('subscriptionText.not_delivered_could_not_be_reached', { channel });
    case 'refused': return t('subscriptionText.not_delivered_the_address_of_is', { channel });
    default: return t('subscriptionText.not_sent_this_server_cannot_read');
  }
}

/** Why a subscription switched itself off. */
export function pausedText(failures: number): string {
  return t('subscriptionText.paused_after_failed_runs_in_a', { failures });
}

/** The push an owner gets when it pauses. */
export function pausedNotice(name: string, failures: number): string {
  return t('subscriptionText.the_subscription_was_paused_after_failed', { name, failures });
}

// ── The message itself ──────────────────────────────────────────────────────

export function moreInDashboard(n: number): string {
  return t('subscriptionText.more_in_the_dashboard', { n });
}

export function moreColumns(n: number): string {
  return t('subscriptionText.more_columns_in_the_dashboard', { n });
}

export function openInOrdinate(): string {
  return t('subscriptionText.open_in_ordinate');
}

/** The KPI change, with whether that direction is the good one (a saved metric says; a plain column does not). */
export function changeText(arrow: string, pct: string, versus: string, good: boolean | null): string {
  if (good === true) return t('subscriptionText.good', { arrow, pct, versus });
  if (good === false) return t('subscriptionText.bad', { arrow, pct, versus });
  return `${arrow} ${pct} ${versus}`;
}

export function asOfText(when: string): string {
  return t('subscriptionText.data_as_of', { when });
}

export function viewText(name: string): string {
  return t('subscriptionText.view', { name });
}

export function footerText(name: string, schedule: string): string {
  return t('subscriptionText.sent_by_ordinate', { name, schedule });
}

export function shareHeading(): string {
  return t('subscriptionText.share_of_total');
}

export function latestLabel(): string {
  return t('subscriptionText.latest_value');
}

export function changeLabel(): string {
  return t('subscriptionText.change_from_the_previous_point');
}

export function rangeLabel(): string {
  return t('subscriptionText.range_over_the_period');
}

export function noFigure(): string {
  return t('subscriptionText.this_card_could_not_be_computed');
}

export function noLinkNote(): string {
  return t('subscriptionText.no_link_is_sent_this_server');
}

export function slackLimitNote(): string {
  return t('subscriptionText.shortened_to_fit_slack_50_blocks');
}

export function teamsLimitNote(): string {
  return t('subscriptionText.shortened_to_fit_teams_about_28');
}

// ── Channels ────────────────────────────────────────────────────────────────

export function testTitle(): string {
  return t('subscriptionText.test_message_from_ordinate');
}

export function testBody(name: string): string {
  return t('subscriptionText.the_channel_is_connected_subscriptions', { name });
}

export function channelNeedsName(): string {
  return t('subscriptionText.give_the_channel_a_name');
}

export function channelNeedsHttps(): string {
  return t('subscriptionText.a_webhook_url_must_start_with');
}

export function channelNeedsUrl(): string {
  return t('subscriptionText.paste_the_webhook_url_for_this');
}

export function channelGone(): string {
  return t('subscriptionText.that_channel_no_longer_exists');
}

export function channelLimit(max: number): string {
  return t('subscriptionText.an_organisation_can_have_at_most', { max });
}

export function channelsNeedStore(): string {
  return t('subscriptionText.this_server_cannot_keep_webhook_urls');
}

// ── Subscriptions ───────────────────────────────────────────────────────────

export function subscriptionGone(): string {
  return t('subscriptionText.that_subscription_no_longer_exists');
}

export function subscriptionNeedsDashboard(): string {
  return t('subscriptionText.choose_the_dashboard_to_send');
}

export function subscriptionNeedsChannel(): string {
  return t('subscriptionText.choose_at_least_one_channel_to');
}

export function untitledSubscription(): string {
  return t('subscriptionText.untitled_subscription');
}

/** An alert posted to a channel: the rule's own sentence under its name. */
export function alertTitle(rule: string): string {
  return t('subscriptionText.alert', { rule });
}
