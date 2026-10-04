// How the Pipelines page words a step (legacy pipelinesGraph.ts PQ_KIND /
// PQ_STATUS / pqStatusOf / pqIconFor, pipelinesPage.ts pqRel / pqAbs / pqDur):
// a kind, a status, and times as "5 min ago" / "in 3 h" / "Tue 3 Oct, 09:00".
// Formatting only — every count on the page is the server's.

import type { IconName } from '../../ui/icons/Icon';
import type { PipelineNode } from './pipelinesApi';

export const KIND: Record<string, { word: string; icon: IconName }> = {
  source: { word: 'Source', icon: 'plug' },
  dataset: { word: 'Dataset', icon: 'database' },
  quality: { word: 'Quality checks', icon: 'shield' },
  alert: { word: 'Alert', icon: 'bell' },
  report: { word: 'Report', icon: 'file-text' },
  publish: { word: 'Publish', icon: 'globe' },
};

export const STATUS: Record<string, { word: string; icon: IconName }> = {
  running: { word: 'Running', icon: 'loader' },
  queued: { word: 'Queued', icon: 'history' },
  ok: { word: 'OK', icon: 'circle-check' },
  failed: { word: 'Failed', icon: 'alert' },
  blocked: { word: 'Blocked', icon: 'lock' },
  paused: { word: 'Paused', icon: 'circle' },
  never: { word: 'Not run yet', icon: 'circle' },
  source: { word: 'Source', icon: 'arrow-right' },
};

/** What a card's pill says: live state first, then a pause, then the last run. */
export function statusOf(n: PipelineNode, live: Readonly<Record<string, string>>): string {
  if (live[n.id]) return live[n.id];
  if (n.paused) return 'paused';
  if (n.lastRun) return n.lastRun.status;
  // A source has nothing of its own to run; "not run yet" would read as a fault.
  return n.kind === 'source' ? 'source' : 'never';
}

export function iconFor(n: PipelineNode): IconName {
  if (n.kind === 'source') {
    if (n.id.startsWith('source:file:')) return 'file-text';
    if (n.id.startsWith('source:url:')) return 'link';
    return /Watching/.test(n.schedule.text) ? 'folder' : 'plug';
  }
  if (n.kind === 'dataset' && n.stage === 2) return 'code';
  return (KIND[n.kind] ?? KIND.dataset).icon;
}

/** "5 min ago", "in 3 h", "just now". */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const d = Date.parse(iso) - now;
  const a = Math.abs(d);
  if (a < 60_000) return d > 0 ? 'in under a minute' : 'just now';
  const [n, u] =
    a < 3_600_000 ? [Math.round(a / 60_000), 'min'] : a < 86_400_000 ? [Math.round(a / 3_600_000), 'h'] : [Math.round(a / 86_400_000), a < 2 * 86_400_000 ? 'day' : 'days'];
  return d > 0 ? `in ${n} ${u}` : `${n} ${u} ago`;
}

/** "Tue 3 Oct, 09:00" in the viewer's own zone. */
export function absTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "1.2 s", "14 s", "2 min 5 s". */
export function dur(ms: number | undefined): string {
  if (typeof ms !== 'number') return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** A due time already passed: the scheduler picks it up on its next check. */
export const nextText = (iso: string, now = Date.now()): string => (Date.parse(iso) <= now ? 'on the next check' : relTime(iso, now));
