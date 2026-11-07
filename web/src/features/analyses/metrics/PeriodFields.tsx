// The metric editor's Period mode (semantic layer part 5, D8): another metric of this dataset over a window ("year
// to date", "last 7 days"), compared with an earlier period, or both. The base must count by a date, which the period
// metric then counts by too. Every figure and every word about it is the server's (metric:preview).

import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { isPeriod, useMetricList, type MetricFormat, type PeriodCompare, type PeriodDefinition, type PeriodWindow } from './api';
import s from './Metrics.module.css';

/** What the boxes hold: a base may be unpicked (''). */
export type PeriodDraft = PeriodDefinition;

const PERCENT: MetricFormat = { kind: 'percent', decimals: 1, prefix: '', suffix: '', compact: false };
const TO_DATE = [
  { value: 'week', label: 'Week to date' },
  { value: 'month', label: 'Month to date' },
  { value: 'quarter', label: 'Quarter to date' },
  { value: 'year', label: 'Year to date' },
];
const UNITS = [
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
];
const SHOWS = [
  { value: 'pct_change', label: '% change' },
  { value: 'change', label: 'Change' },
  { value: 'prior', label: 'The prior figure' },
];

type Choice<T extends string> = { value: T; label: string };
const WINDOWS: Choice<'none' | 'to_date' | 'last'>[] = [
  { value: 'none', label: 'No window' },
  { value: 'to_date', label: 'To date' },
  { value: 'last', label: 'Last' },
];
const COMPARES: Choice<'none' | PeriodCompare['vs']>[] = [
  { value: 'none', label: 'No comparison' },
  { value: 'previous_period', label: 'Previous period' },
  { value: 'previous_year', label: 'Same period last year' },
];

function Segments<T extends string>({ label, choices, value, onPick }: { label: string; choices: Choice<T>[]; value: T; onPick: (v: T) => void }) {
  return (
    <div className={s.aggs} role="radiogroup" aria-label={label}>
      {choices.map((c) => (
        <button key={c.value} type="button" role="radio" aria-checked={c.value === value} className={c.value === value ? `${s.agg} ${s.on}` : s.agg} onClick={() => onPick(c.value)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The base, the window and the comparison. `onChange` hands a format with the draft when the choice decides it:
 * % change is a percent, anything else reads in the base's format (the user may change either afterwards).
 */
export function PeriodFields({ projectId, datasetId, value, onChange, error }: {
  projectId: string;
  datasetId: string | null;
  value: PeriodDraft;
  onChange: (next: PeriodDraft, format?: MetricFormat) => void;
  /** The server's refusal of the base (field `definition`). */
  error?: string;
}) {
  const list = useMetricList(projectId);
  const bases = (list.data ?? []).filter((m) => m.datasetId === datasetId && !!m.timeColumn && !isPeriod(m.definition));
  const base = bases.find((m) => m.id === value.base);
  const formatOf = (next: PeriodDraft): MetricFormat | undefined => (next.compare?.show === 'pct_change' ? PERCENT : bases.find((m) => m.id === next.base)?.format);
  const set = (next: PeriodDraft, reformat = false) => onChange(next, reformat ? formatOf(next) : undefined);
  const w = value.window;
  const c = value.compare;
  const windowKind = !w ? 'none' : 'to_date' in w ? 'to_date' : 'last';
  const withWindow = (window: PeriodWindow | undefined): PeriodDraft => ({ base: value.base, ...(window ? { window } : {}), ...(c ? { compare: c } : {}) });
  const withCompare = (compare: PeriodCompare | undefined): PeriodDraft => ({ base: value.base, ...(w ? { window: w } : {}), ...(compare ? { compare } : {}) });
  const none = list.isSuccess && bases.length === 0;
  return (
    <>
      <Select
        label="Base metric"
        value={value.base || null}
        disabled={!datasetId || list.isPending}
        placeholder={list.isPending ? 'Loading…' : 'Choose a metric'}
        hint={base ? `Counts by ${base.timeColumn}, its base’s date, and follows the base’s edits.` : 'A metric of this dataset that counts by a date.'}
        error={error || (list.isError ? `The metrics could not be listed: ${list.error.message}` : none ? 'No metric of this dataset counts by a date yet. Give one a date it counts by first.' : undefined)}
        options={bases.map((m) => ({ value: m.id, label: m.name }))}
        onValueChange={(id) => set({ ...value, base: id }, true)}
      />
      <div className={s.group}>
        <span className={s.groupLabel}>Window</span>
        <Segments label="Window" choices={WINDOWS} value={windowKind} onPick={(k) => set(withWindow(k === 'none' ? undefined : k === 'to_date' ? { to_date: 'year' } : { last: 7, unit: 'day' }))} />
        {w && 'to_date' in w && (
          <div className={s.format}>
            <Select size="sm" aria-label="To date of" value={w.to_date} options={TO_DATE} onValueChange={(u) => set(withWindow({ to_date: u as typeof w.to_date }))} />
          </div>
        )}
        {w && 'last' in w && (
          <div className={s.format}>
            <Input size="sm" type="number" min={1} max={366} aria-label="How many" value={String(w.last)} onChange={(e) => set(withWindow({ last: Math.min(366, Math.max(1, Math.floor(Number(e.target.value)) || 1)), unit: w.unit }))} />
            <Select size="sm" aria-label="Unit" value={w.unit} options={UNITS} onValueChange={(u) => set(withWindow({ last: w.last, unit: u as typeof w.unit }))} />
            <span className={s.groupHint}>Whole {w.unit}s, up to the end of the dashboard’s date range, or the latest whole ones before today.</span>
          </div>
        )}
      </div>
      <div className={s.group}>
        <span className={s.groupLabel}>Compare</span>
        <Segments label="Compare" choices={COMPARES} value={c ? c.vs : 'none'} onPick={(vs) => set(withCompare(vs === 'none' ? undefined : { vs, show: c?.show ?? 'pct_change' }), true)} />
        {c && (
          <div className={s.format}>
            <Select size="sm" label="Show" value={c.show} options={SHOWS} onValueChange={(show) => set(withCompare({ vs: c.vs, show: show as PeriodCompare['show'] }), true)} />
          </div>
        )}
      </div>
    </>
  );
}
