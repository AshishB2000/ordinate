// Timestamps as the hub writes them — formatting only, in the browser's locale.

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** hub `formatSidebarTime`: "2:14 PM" today, "Mar 4 · 2:14 PM" otherwise; '' for no date. */
export function shortTime(iso: string | undefined, now = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const time = timeFmt.format(d);
  return d.toDateString() === now.toDateString() ? time : `${dayFmt.format(d)} · ${time}`;
}

/** jobsPanel `jpAgo`: "just now", "4 min ago", "2 h ago", then a date. */
export function ago(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return dateFmt.format(t);
}

/** jobsPanel `jpDuration`: how long a finished job ran — "640 ms", "2.3 s", "4 min"; '' if unknown. */
export function duration(start: string | undefined, end: string | undefined): string {
  const a = start ? Date.parse(start) : NaN;
  const b = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const ms = b - a;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
