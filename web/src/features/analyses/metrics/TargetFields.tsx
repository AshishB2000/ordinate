// The metric editor's Target section (semantic layer part 5, D12): none, a figure, or another metric over a plan dataset
// (usually an input table), the period one figure covers, and the status thresholds. What it sends is `target`; the
// attainment, the pro-rating and every sentence about them are the server's (a refusal comes back beside this box).

import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { useMetricList, type Target } from './api';
import type { Direction } from './parts';
import s from './Metrics.module.css';

export interface TargetDraft {
  kind: 'none' | 'value' | 'plan';
  /** The figure, as typed. */
  value: string;
  planId: string;
  per: '' | NonNullable<Target['per']>;
  /** Thresholds as typed (% of target); '' takes the default. */
  good: string;
  warn: string;
}

export const noTarget: TargetDraft = { kind: 'none', value: '', planId: '', per: '', good: '', warn: '' };

const PERIODS = [
  { value: '', label: 'Not set' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];
const KINDS: { value: TargetDraft['kind']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'value', label: 'A figure' },
  { value: 'plan', label: 'A plan metric' },
];

/** The boxes for a stored target. */
export function targetDraftOf(t: Target | null | undefined): TargetDraft {
  if (!t) return noTarget;
  return {
    kind: 'value' in t.source ? 'value' : 'plan',
    value: 'value' in t.source ? String(t.source.value) : '',
    planId: 'metricId' in t.source ? t.source.metricId : '',
    per: t.per ?? '',
    good: t.thresholds ? String(t.thresholds.good) : '',
    warn: t.thresholds ? String(t.thresholds.warn) : '',
  };
}

/** The defaults the server grades by when none are typed (scorecardModel.defaultThresholds): up is good unless the metric says otherwise. */
const defaults = (direction: Direction): { good: number; warn: number } => (direction === 'down_good' ? { good: 100, warn: 110 } : { good: 100, warn: 90 });

/** What is sent: the target, or null for none. */
export function targetBody(d: TargetDraft, direction: Direction): Target | null {
  if (d.kind === 'none') return null;
  const source = d.kind === 'value' ? { value: Number(d.value) } : { metricId: d.planId };
  const def = defaults(direction);
  const typed = d.good.trim() !== '' || d.warn.trim() !== '';
  return {
    source,
    ...(d.per ? { per: d.per } : {}),
    ...(typed ? { thresholds: { good: d.good.trim() !== '' ? Number(d.good) : def.good, warn: d.warn.trim() !== '' ? Number(d.warn) : def.warn } } : {}),
  };
}

/** Why the boxes can't be sent yet ('' when they can). */
export function targetProblem(d: TargetDraft): string {
  if (d.kind === 'value' && (d.value.trim() === '' || !Number.isFinite(Number(d.value)))) return 'Enter the target figure, or choose None.';
  if (d.kind === 'plan' && !d.planId) return 'Choose the plan metric, or choose None.';
  return '';
}

export function TargetFields({ projectId, selfId, direction, value, onChange, error }: {
  projectId: string;
  /** The metric being edited: it can't be its own plan. */
  selfId: string;
  direction: Direction;
  value: TargetDraft;
  onChange: (next: TargetDraft) => void;
  /** The server's refusal (field `target`). */
  error?: string;
}) {
  const list = useMetricList(projectId);
  const plans = (list.data ?? []).filter((m) => m.id !== selfId && !!m.timeColumn);
  const def = defaults(direction);
  const up = direction !== 'down_good';
  const set = (patch: Partial<TargetDraft>) => onChange({ ...value, ...patch });
  return (
    <div className={s.group}>
      <span className={s.groupLabel}>Target</span>
      <div className={s.aggs} role="radiogroup" aria-label="Target">
        {KINDS.map((k) => (
          <button key={k.value} type="button" role="radio" aria-checked={k.value === value.kind} className={k.value === value.kind ? `${s.agg} ${s.on}` : s.agg} onClick={() => set({ kind: k.value })}>
            {k.label}
          </button>
        ))}
      </div>
      {value.kind === 'value' && <Input type="number" label="Target figure" hint="In the metric’s own units." value={value.value} onChange={(e) => set({ value: e.target.value })} />}
      {value.kind === 'plan' && (
        <Select
          label="Plan metric"
          value={value.planId || null}
          disabled={list.isPending}
          placeholder={list.isPending ? 'Loading…' : 'Choose a metric'}
          hint="A metric over a plan dataset, such as an input table of monthly goals. It must count by a date."
          options={plans.map((m) => ({ value: m.id, label: m.name }))}
          onValueChange={(id) => set({ planId: id })}
        />
      )}
      {value.kind !== 'none' && (
        <>
          <Select
            label="Each figure covers"
            value={value.per}
            options={PERIODS}
            hint="Needed for a metric that adds up over time (a sum or a count): a month in progress then gets its share of the month’s target."
            error={error || undefined}
            onValueChange={(per) => set({ per: per as TargetDraft['per'] })}
          />
          <div className={s.format}>
            <Input size="sm" type="number" aria-label={up ? 'On track from (% of target)' : 'On track up to (% of target)'} placeholder={String(def.good)} value={value.good} onChange={(e) => set({ good: e.target.value })} />
            <Input size="sm" type="number" aria-label={up ? 'At risk from (% of target)' : 'At risk up to (% of target)'} placeholder={String(def.warn)} value={value.warn} onChange={(e) => set({ warn: e.target.value })} />
            <span className={s.groupHint}>{up ? 'On track from, at risk from' : 'On track up to, at risk up to'} (% of target)</span>
          </div>
        </>
      )}
    </div>
  );
}
