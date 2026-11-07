// The metric editor's Funnel mode (semantic layer part 5, D5–D7): a funnel saved from the funnel grid with "Save as
// metric". Its steps, window and columns are the grid's and read-only here (change them in the grid and save again);
// what it shows is the choice: the conversion rate, the converted count or the entered count. Every figure and every
// word about it is the server's (metric:preview).

import type { MetricFormat, FunnelDefinition } from './api';
import type { MetricDraft } from './MetricEditor';
import s from './Metrics.module.css';

const PERCENT: MetricFormat = { kind: 'percent', decimals: 1, prefix: '', suffix: '', compact: false };
const WHOLE: MetricFormat = { kind: 'number', decimals: 0, prefix: '', suffix: '', compact: false };
const SHOWS: { value: FunnelDefinition['show']; label: string; hint: string }[] = [
  { value: 'rate', label: 'Conversion rate', hint: 'The share of those who entered that reached the last step.' },
  { value: 'converted', label: 'Converted', hint: 'How many reached the last step.' },
  { value: 'entered', label: 'Entered', hint: 'How many did the first step.' },
];

/** The grid's encoding as a metric to save: entity, event, time, steps and window (never its breakdown), showing its rate. */
export function funnelDraft(datasetId: string, enc: { entity: string; event: string; time: string; steps: string[]; window: { n: number; unit: 'hours' | 'days' } }): MetricDraft {
  const { entity, event, time, steps, window } = enc;
  return {
    name: `${steps[0]} → ${steps.at(-1)}`,
    datasetId,
    definition: { funnel: { entity, event, time, steps: steps.slice(), window: { ...window } }, show: 'rate' },
    filters: [],
    format: PERCENT,
  };
}

const windowWords = (w: FunnelDefinition['funnel']['window']): string => `${w.n} ${w.unit === 'hours' ? (w.n === 1 ? 'hour' : 'hours') : w.n === 1 ? 'day' : 'days'}`;

/** The steps as words and what the metric shows; `onChange` hands the format the choice implies (a rate is a percent). */
export function FunnelFields({ value, onChange, error }: { value: FunnelDefinition; onChange: (next: FunnelDefinition, format: MetricFormat) => void; error?: string }) {
  const f = value.funnel;
  const shown = SHOWS.find((c) => c.value === value.show) ?? SHOWS[0];
  return (
    <>
      <div className={s.group}>
        <span className={s.groupLabel}>Steps</span>
        <span className={s.funnelSteps}>{`${f.steps.join(' → ')}, within ${windowWords(f.window)}`}</span>
        <span className={s.groupHint}>
          Each <code>{f.entity}</code> enters at its first <code>{f.steps[0]}</code> in <code>{f.event}</code>, by <code>{f.time}</code>. A dashboard’s filters pick who enters; the metric’s own filters pick which events count. To change the steps, edit the funnel and save it again.
        </span>
        {error && (
          <span className={s.previewError} role="alert">
            {error}
          </span>
        )}
      </div>
      <div className={s.group}>
        <span className={s.groupLabel}>Show</span>
        <div className={s.aggs} role="radiogroup" aria-label="Show">
          {SHOWS.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={c.value === value.show}
              className={c.value === value.show ? `${s.agg} ${s.on}` : s.agg}
              onClick={() => onChange({ ...value, show: c.value }, c.value === 'rate' ? PERCENT : WHOLE)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <span className={s.groupHint}>{shown.hint}</span>
      </div>
    </>
  );
}
