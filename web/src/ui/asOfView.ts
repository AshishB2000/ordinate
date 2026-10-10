// How fresh a figure is, in words (docs/live-data/00-plan.md, L0.2) — PURE.
//
// The server dates every chart, KPI and answer with `asOf` (src/api/asOf.ts);
// this only words it, in the reader's time zone. Every variant a later phase
// will set is worded here already, so those phases only send fields:
//
//   extract                      As of 1:00 AM
//   live, just asked             Live · 2:05 AM
//   live, from the cache         Live · cached 3 min ago
//   the source failed            Stale · as of 1:00 AM          (warning tint)
//   a newer copy on its way      As of 1:00 AM · refreshing…
//
// Older than a day wears the warning tint too: a dashboard that quietly stopped
// refreshing is the wrong number this caption exists to catch.

import type { AsOf } from '../../../src/api/asOf.ts';

export type { AsOf };

/** Past this age a figure's caption takes the warning tint. */
export const OLD_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AsOfView {
  /** The caption: "As of 1:00 AM", "Live · cached 3 min ago", … */
  text: string;
  /** The full time, for the hover title: "Data as of Thursday, October 9, 2026 at 1:00 AM". */
  title: string;
  /** `warn`: stale, or more than a day old. */
  tone: 'muted' | 'warn';
}

/** Pinned in tests; the reader's own clock, locale and zone otherwise. */
export interface AsOfOptions {
  now?: number;
  locale?: string;
  timeZone?: string;
}

// Newer ICU puts a narrow no-break space before "AM"; one plain space reads the
// same and keeps the words identical on every engine (the caption never wraps).
const fmt = (o: AsOfOptions, f: Intl.DateTimeFormatOptions) => {
  const d = new Intl.DateTimeFormat(o.locale, { ...f, ...(o.timeZone ? { timeZone: o.timeZone } : {}) });
  return { format: (t: number) => d.format(t).replace(/[\u202f\u00a0]/g, ' ') };
};

/** "1:00 AM" today, "Oct 8, 1:00 AM" this year, "Oct 8, 2025, 1:00 AM" before. */
function when(t: number, o: AsOfOptions, now: number): string {
  const day = fmt(o, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (day.format(t) === day.format(now)) return fmt(o, { hour: 'numeric', minute: '2-digit' }).format(t);
  const year = fmt(o, { year: 'numeric' });
  const sameYear = year.format(t) === year.format(now);
  return fmt(o, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' }).format(t);
}

/** "just now" / "3 min ago" / "2 h ago", then the time itself. */
function ago(t: number, o: AsOfOptions, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return when(t, o, now);
}

/** The caption for a figure's `asOf`, or null when there is none to show (no time, or one that does not parse). */
export function asOfView(asOf: AsOf | null | undefined, o: AsOfOptions = {}): AsOfView | null {
  const t = asOf ? Date.parse(asOf.at) : NaN;
  if (!asOf || !Number.isFinite(t)) return null;
  const now = o.now ?? Date.now();
  const time = when(t, o, now);
  let text: string;
  if (asOf.stale) text = `Stale · as of ${time}`;
  else if (asOf.mode === 'live') text = asOf.cached ? `Live · cached ${ago(t, o, now)}` : `Live · ${time}`;
  else text = `As of ${time}`;
  if (asOf.refreshing) text += ' · refreshing…';
  const old = now - t > OLD_AFTER_MS;
  const full = fmt(o, { dateStyle: 'full', timeStyle: 'short' }).format(t);
  const why = asOf.stale ? ' — the source could not be reached, so this is the last answer it gave' : old ? ' — more than a day old' : '';
  const title = `${asOf.mode === 'live' ? `Live data${asOf.cached ? ', from the cache,' : ''} as of` : 'Data as of'} ${full}${why}`;
  return { text, title, tone: asOf.stale || old ? 'warn' : 'muted' };
}
