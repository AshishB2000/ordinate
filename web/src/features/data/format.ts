// Words and formats the Data screens share — formatting only: every number
// here arrived computed from the server.

import { formatNumber } from '../../../../src/app/format.ts';
import type { DatasetSummary } from '../../api/datasets';

export { formatNumber };

/** A server-computed percent, as shown: "97.3%". */
export const pctText = (p: number): string => `${formatNumber(p, { maxDecimals: 1 })}%`;

/** "1 row" / "12,840 rows". */
export const rowsText = (n: number): string => `${formatNumber(n)} ${n === 1 ? 'row' : 'rows'}`;

/** A list's row count — a Live dataset keeps none here, so it says so instead of "0 rows". */
export const rowsOf = (d: { rowCount: number; mode?: 'live' }): string => (d.mode === 'live' ? 'Live' : rowsText(d.rowCount));

/** A figure that may be absent: the number, or an em dash (never a made-up zero). */
export const figure = (n: number | null | undefined): string => (typeof n === 'number' ? formatNumber(n, { maxDecimals: 4 }) : '—');

/** The Source column's badge (dsList.ts DS_SOURCE_LABELS); an unknown kind shows as itself. */
const SOURCE_LABELS: Record<string, string> = {
  csv: 'CSV',
  json: 'JSON',
  xlsx: 'Excel',
  paste: 'Paste',
  url: 'URL',
  postgres: 'Database',
  combined: 'Combined',
  capture: 'Screenshot',
  sql: 'SQL',
  input: 'Input',
  parquet: 'Parquet',
  notebook: 'Notebook',
};
export const sourceLabel = (kind: string): string => SOURCE_LABELS[kind] || kind || 'Unknown';

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** "2:14 PM" today, "Mar 4 · 2:14 PM" otherwise (hubCapture.ts formatSidebarTime). */
export function stamp(iso: string | undefined): string {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toDateString() === new Date().toDateString() ? time.format(d) : `${day.format(d)} · ${time.format(d)}`;
}

/** "just now" / "4m ago" / "3h ago" / "2d ago" (alertsInbox.ts aiAgo). */
export function ago(iso: string | undefined): string {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * "Data as of …": the last refresh, else the last update — and a schedule is
 * stated as a promise ("Refreshes daily · last 08:00"), as dsList.ts does.
 */
export function freshness(d: Pick<DatasetSummary, 'lastRefreshedAt' | 'updatedAt' | 'autoRefresh' | 'originKind' | 'sourceKind' | 'mode'>): string {
  if (d.mode === 'live') return 'Live · asked at the warehouse';
  const when = stamp(d.lastRefreshedAt || d.updatedAt);
  if (d.autoRefresh?.every) return `Refreshes ${d.autoRefresh.every} · last ${when}`;
  if (d.originKind) return `Data as of ${when}`;
  return `${d.sourceKind === 'input' ? 'Edited' : 'Imported'} ${when}`;
}

export const NOT_REFRESHABLE = 'This dataset was saved before refresh existed, or from pasted text, so there is nothing to re-fetch. Re-import it to make it refreshable.';

export const SCHEDULES = [
  { value: 'off', label: 'Auto-refresh off' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
] as const;

/**
 * A click that landed on a control (or in a menu, list or popover a row's
 * control opened — React bubbles portal events through the tree): the row
 * behind it must not also open.
 */
export const fromControl = (target: EventTarget): boolean =>
  target instanceof Element && !!target.closest('a,button,input,textarea,[role="combobox"],[role="listbox"],[role="option"],[role="dialog"],[role="menu"],[role="menuitem"]');
