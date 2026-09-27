// The Assistant's FACTS for an open scorecard — MAIN PROCESS, PURE.
//
// Lays out figures the app already computed (src/ipc/scorecards.ts
// computeScorecard) as a facts block, a provenance line and a number ledger, the
// contract every builder in ./copilotFacts keeps: the app does the math, the
// model narrates it. With this, "what's off track?" is answered from the app's
// own statuses and attainments — the model never judges a row itself.
//
// Its own file because copilotFacts.ts is past the soft size limit and a
// scorecard is a new kind of context, not a variation on an old one.

import type { CopilotFacts } from './copilot';
import type { LedgerEntry } from './numberAudit';
import { harvestAppNumbers } from './numberAudit';
import { STATUS_WORDS } from '../analysis/scorecardModel';
import type { RowStatus } from '../analysis/scorecardModel';

const GUARD_LINE =
  'The numbers below were computed by the app (Ordinate), not by you. ' +
  'Treat them as ground truth: cite them exactly and NEVER recompute, round, or invent a figure.';

/** The slice of a computed scorecard this builder reads. */
export interface ScorecardFactInput {
  name: string;
  period: string;
  windowLabel: string;
  rows: Array<{
    name: string;
    value: number | null;
    display: string;
    target: number | null;
    targetDisplay: string;
    attainment: number | null;
    status: RowStatus;
    delta: number | null;
    pct: number | null;
    group?: string;
    owner?: string;
    missing?: boolean;
  }>;
  groups: Array<{ group: string; onTrack: number; scored: number; total: number }>;
}

const raw = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a');

export function scorecardFacts(sc: ScorecardFactInput): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  const num = (label: string, v: number | null | undefined, unit: LedgerEntry['unit'] = 'number'): void => {
    if (typeof v === 'number' && Number.isFinite(v)) ledger.push({ label, value: v, unit, source: 'scorecard' });
  };

  lines.push(`Scorecard: "${sc.name}" — ${sc.period}ly, showing ${sc.windowLabel}.`);
  lines.push('Each row: metric = value vs target (attainment %), status, change on the previous period. Status is the app\'s own verdict from the row\'s thresholds and the metric\'s direction — use it as given.');
  for (const r of sc.rows) {
    if (r.missing) { lines.push(`- (a metric that no longer exists)`); continue; }
    const parts = [`- "${r.name}" = ${raw(r.value)} (shown as ${r.display})`];
    if (r.target !== null) parts.push(`target ${raw(r.target)}`);
    if (r.attainment !== null) parts.push(`attainment ${raw(r.attainment)}%`);
    parts.push(`status: ${STATUS_WORDS[r.status]}`);
    if (r.delta !== null) parts.push(`change ${raw(r.delta)}` + (r.pct !== null ? ` (${raw(r.pct)}%)` : ''));
    if (r.group) parts.push(`group ${r.group}`);
    if (r.owner) parts.push(`owner ${r.owner}`);
    lines.push(parts.join(', '));
    num(`${r.name} value`, r.value);
    num(`${r.name} target`, r.target);
    num(`${r.name} attainment`, r.attainment, 'percent');
    num(`${r.name} change`, r.delta);
    num(`${r.name} change %`, r.pct, 'percent');
  }

  const off = sc.rows.filter((r) => r.status === 'off').map((r) => r.name);
  const warn = sc.rows.filter((r) => r.status === 'warn').map((r) => r.name);
  lines.push('');
  lines.push(`Off track: ${off.length ? off.map((n) => `"${n}"`).join(', ') : 'none'}.`);
  lines.push(`At risk: ${warn.length ? warn.map((n) => `"${n}"`).join(', ') : 'none'}.`);
  num('rows off track', off.length, 'count');
  num('rows at risk', warn.length, 'count');
  for (const g of sc.groups) {
    if (!g.group) continue;
    lines.push(`Group "${g.group}": ${g.onTrack} of ${g.scored} with a target on track (${g.total} rows).`);
    num(`${g.group} on track`, g.onTrack, 'count');
    num(`${g.group} with a target`, g.scored, 'count');
    num(`${g.group} rows`, g.total, 'count');
  }

  const text = lines.join('\n');
  // Backstop, as in copilotFacts.sealLedger: a digit in a metric or group NAME
  // is printed but was computed by nobody, and must not read as invented.
  for (const h of harvestAppNumbers(text)) {
    if (!ledger.some((e) => Object.is(e.value, h.value))) {
      ledger.push({ label: 'figure printed in the facts block', value: h.value, unit: h.unit, source: 'scorecard' });
    }
  }
  return {
    text,
    ledger,
    provenance: { kind: 'project', name: sc.name, note: 'scorecard figures app-computed' },
  };
}
