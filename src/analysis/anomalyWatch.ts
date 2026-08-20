// Anomaly watch — MAIN PROCESS, and opt-in per dataset.
//
// After a successful UNATTENDED refresh of a watched dataset, run the detector
// and tell the user about anomalies that are NEW since the last run. Not about
// the ones that were already there: a watch that re-reports the same finding
// every hour is a watch people turn off.
//
// NO MODEL IS INVOLVED anywhere in this path. src/anomalies.ts is a pure
// detector and the count in the notification is app-computed, like every number
// this app shows. The AI "explain anomalies" action stays exactly where it is —
// pull, not push.
//
// "New" is decided by KEY, not by text. An anomaly's `detail` embeds computed
// figures, so it changes on every refresh even when the finding is the same one;
// keying on kind + column + severity is what makes "same finding" stable across
// runs while still letting a genuinely different finding through.

import type { Anomaly } from './anomalies';

/** How many keys we keep per dataset. A cap, so a pathological table cannot grow the record without bound. */
export const MAX_KEYS = 200;

/**
 * The identity of an anomaly across runs.
 *
 * Deliberately NOT the detail string: that carries the numbers, which move on
 * every refresh, so keying on it would report every finding as new every time —
 * the exact failure this watch exists to avoid.
 */
export function anomalyKey(a: Anomaly): string {
  return [a.kind, a.column || '', a.severity].join('|');
}

/** Sanitize a stored key list — untrusted like every other optional block. */
export function sanitizeAnomalyKeys(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k === 'string' && k && out.indexOf(k) < 0) out.push(k);
    if (out.length >= MAX_KEYS) break;
  }
  return out.length ? out : undefined;
}

export interface WatchDiff {
  /** Keys present now and absent last time — the only ones worth an alert. */
  newKeys: string[];
  /** What to store for next time: exactly what is present NOW, capped. */
  keep: string[];
}

/**
 * Diff this run's anomalies against the previous run's keys.
 *
 * `keep` is the CURRENT set, not a union: an anomaly that has been resolved must
 * drop out of storage, or it would count as "new" again the day it comes back
 * having never left. That is also why a first run alerts everything — there is
 * no previous set, and every finding really is new to the user.
 */
export function diffAnomalies(current: Anomaly[], previous: string[] | undefined): WatchDiff {
  const prev = new Set(Array.isArray(previous) ? previous : []);
  const keep: string[] = [];
  const newKeys: string[] = [];
  for (const a of Array.isArray(current) ? current : []) {
    const k = anomalyKey(a);
    if (keep.indexOf(k) >= 0) continue; // one key, however many findings share it
    if (keep.length < MAX_KEYS) keep.push(k);
    if (!prev.has(k)) newKeys.push(k);
  }
  return { newKeys, keep };
}

/** The sentence a user reads. App-computed count, no model. */
export function watchMessage(name: string, newCount: number): string {
  return `${newCount} new anomal${newCount === 1 ? 'y' : 'ies'} in "${name}".`;
}
