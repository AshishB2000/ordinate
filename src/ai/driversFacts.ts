// The Assistant's FACTS for a "Why did this change?" panel — MAIN PROCESS, PURE.
//
// Lays out the figures src/ipc/drivers.ts computed (totals, the ranked
// dimensions, the chosen dimension's contributors, the caption) as a facts
// block, a provenance line and a number ledger — the contract every builder in
// ./copilotFacts keeps. The model can then say WHY in words, but every figure
// in its answer is one of these, and ./numberAudit checks that it is.

import type { CopilotFacts } from './copilot';
import type { LedgerEntry } from './numberAudit';
import { harvestAppNumbers } from './numberAudit';
import type { DriversResult } from '../ipc/drivers';

const GUARD_LINE =
  'The numbers below were computed by the app (Ordinate), not by you. ' +
  'Treat them as ground truth: cite them exactly and NEVER recompute, round, or invent a figure.';

const raw = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a');

export function driversFacts(r: DriversResult): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  const num = (label: string, v: number | null | undefined, unit: LedgerEntry['unit'] = 'number'): void => {
    if (typeof v === 'number' && Number.isFinite(v)) ledger.push({ label, value: v, unit, source: 'drivers' });
  };

  const where = r.path.length ? ' within ' + r.path.map((p) => `${p.column} = "${p.label}"`).join(' and ') : '';
  lines.push(`Question: why did "${r.metric.name}"${where} change from ${r.periods.b} to ${r.periods.a}?`);
  lines.push(`"${r.metric.name}" was ${raw(r.totals.b)} (shown as ${r.totals.bText}) in ${r.periods.b} and ${raw(r.totals.a)} (shown as ${r.totals.aText}) in ${r.periods.a}; change ${raw(r.totals.delta)} (shown as ${r.totals.deltaText})` +
    (r.totals.pct !== null ? `, ${raw(r.totals.pct)}%.` : '.'));
  num('value now', r.totals.a);
  num('value before', r.totals.b);
  num('change', r.totals.delta);
  num('change %', r.totals.pct, 'percent');
  if (r.metric.kind === 'ratio') {
    lines.push('It is a RATIO, so each member\'s contribution splits into a MIX effect (its weight moved) and a RATE effect (its own ratio moved); mix + rate = the contribution.');
  }
  if (r.unavailable) lines.push(`The change could not be broken down: ${r.unavailable}`);

  if (r.dimensions.length) {
    lines.push('');
    lines.push('Dimensions ranked by explained variance of the change (0–100%, the share of the change that is member-specific rather than across the board):');
    for (const d of r.dimensions) {
      const pct = d.explained * 100;
      lines.push(`- ${d.column}: ${raw(pct)}% explained, ${d.memberCount} members` + (d.lead ? `, moved most by "${d.lead}"` : ''));
      num(`${d.column} explained variance`, pct, 'percent');
      num(`${d.column} members`, d.memberCount, 'count');
    }
  }

  const s = r.selected;
  if (s) {
    lines.push('');
    lines.push(`Contributors by ${s.column} (a waterfall from ${s.waterfall.startText} to ${s.waterfall.endText}):`);
    if (s.offsetting) lines.push('The members largely OFFSET each other: the net change is small beside how much they moved, so a member\'s "% of the change" can pass 100%; its "% of all movement" is the fairer weight.');
    for (const m of s.waterfall.steps) {
      const parts = [`- "${m.label}": ${raw(m.delta)} (shown as ${m.deltaText})`];
      if (m.share !== null) parts.push(`${raw(m.share)}% of the change`);
      parts.push(`${raw(m.moveShare)}% of all movement`);
      if (m.mixText !== undefined) parts.push(`mix ${raw(m.mix)} (${m.mixText}), rate ${raw(m.rate)} (${m.rateText})`);
      lines.push(parts.join(', '));
      num(`${m.label} contribution`, m.delta);
      num(`${m.label} share of change`, m.share, 'percent');
      num(`${m.label} share of all movement`, m.moveShare, 'percent');
      num(`${m.label} mix effect`, m.mix);
      num(`${m.label} rate effect`, m.rate);
    }
    if (s.waterfall.other.count > 0) {
      lines.push(`- ${s.waterfall.other.count} other members together: ${raw(s.waterfall.other.delta)} (shown as ${s.waterfall.other.deltaText})`);
      num('other members', s.waterfall.other.count, 'count');
      num('other members contribution', s.waterfall.other.delta);
    }
    num('waterfall start', s.waterfall.start);
    num('waterfall end', s.waterfall.end);
  }
  if (r.caption) {
    lines.push('');
    lines.push(`The app's own summary: ${r.caption}`);
  }

  const text = lines.join('\n');
  // Backstop, as in copilotFacts.sealLedger: a digit in a member NAME or a
  // period label is printed but was computed by nobody.
  for (const h of harvestAppNumbers(text)) {
    if (!ledger.some((e) => Object.is(e.value, h.value))) {
      ledger.push({ label: 'figure printed in the facts block', value: h.value, unit: h.unit, source: 'drivers' });
    }
  }
  return { text, ledger, provenance: { kind: 'project', name: r.metric.name, note: 'driver figures app-computed' } };
}
