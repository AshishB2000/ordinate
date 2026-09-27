// The Assistant's FACTS for an open scenario — MAIN PROCESS, PURE.
//
// Lays out figures the app already computed (src/analysis/scenarioResolve.ts
// computeScenario) as a facts block, a provenance line and a number ledger, the
// contract ./scorecardFacts.ts keeps: the app does the math, the model narrates
// it. "Which driver matters most?" is answered from the app's own tornado, and
// "what does this do to margin?" from its own recomputed figure — the model
// never applies a driver itself.

import type { CopilotFacts } from './copilot';
import type { LedgerEntry } from './numberAudit';
import { harvestAppNumbers } from './numberAudit';
import type { ScenarioResult } from '../analysis/scenarioResolve';

const GUARD_LINE =
  'The numbers below were computed by the app (Ordinate), not by you. ' +
  'Treat them as ground truth: cite them exactly and NEVER recompute, round, or invent a figure.';

const raw = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a');

export function scenarioFacts(sc: Pick<ScenarioResult, 'name' | 'metrics' | 'drivers' | 'tornado' | 'notes'>): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  const num = (label: string, v: number | null | undefined, unit: LedgerEntry['unit'] = 'number'): void => {
    if (typeof v === 'number' && Number.isFinite(v)) ledger.push({ label, value: v, unit, source: 'scenario' });
  };

  lines.push(`Scenario: "${sc.name}" — a what-if. Drivers move the inputs of the metrics below; the stored data is unchanged.`);
  lines.push('Drivers, applied in this order:');
  if (!sc.drivers.length) lines.push('- (none — every scenario figure equals its baseline)');
  for (const d of sc.drivers) {
    lines.push(`- ${d.label} (${d.kind === 'pct' ? 'percent change' : 'set to'} ${raw(d.value)}; ${d.targetText}${d.applied ? '' : '; changes none of these metrics'})`);
    num(`${d.label} driver value`, d.value, d.kind === 'pct' ? 'percent' : 'number');
  }

  lines.push('');
  lines.push('Each metric: baseline → scenario value, and the change.');
  for (const m of sc.metrics) {
    if (m.missing) { lines.push('- (a metric that no longer exists)'); continue; }
    const parts = [`- "${m.name}": baseline ${raw(m.baseline)} (shown as ${m.baselineDisplay}) → scenario ${raw(m.value)} (shown as ${m.display})`];
    if (m.delta !== null) parts.push(`change ${raw(m.delta)}` + (m.pct !== null ? ` (${raw(m.pct)}%)` : ''));
    lines.push(parts.join(', '));
    num(`${m.name} baseline`, m.baseline);
    num(`${m.name} scenario`, m.value);
    num(`${m.name} change`, m.delta);
    num(`${m.name} change %`, m.pct, 'percent');
  }

  const t = sc.tornado;
  if (t && t.bars.length) {
    lines.push('');
    lines.push(`Sensitivity of "${t.name}" (scenario value ${raw(t.value)}): each driver's target moved −${raw(t.step * 100)}% and +${raw(t.step * 100)}%, the others as set, widest swing first.`);
    num('sensitivity step %', t.step * 100, 'percent');
    for (const b of t.bars) {
      lines.push(`- ${b.label}: ${raw(b.low)} to ${raw(b.high)} (swing ${raw(b.swing)})`);
      num(`${b.label} at −step`, b.low);
      num(`${b.label} at +step`, b.high);
      num(`${b.label} swing`, b.swing);
    }
  }
  for (const n of sc.notes) lines.push('Note: ' + n);

  const text = lines.join('\n');
  // Backstop, as in scorecardFacts: a digit in a metric or column NAME is
  // printed but computed by nobody, and must not read as invented.
  for (const h of harvestAppNumbers(text)) {
    if (!ledger.some((e) => Object.is(e.value, h.value))) {
      ledger.push({ label: 'figure printed in the facts block', value: h.value, unit: h.unit, source: 'scenario' });
    }
  }
  return { text, ledger, provenance: { kind: 'project', name: sc.name, note: 'scenario figures app-computed' } };
}
