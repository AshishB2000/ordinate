// One overlay's inline editor (analyticsEditors.ts). Every control writes into
// the definition; the server's next reply brings the readout back. A value
// source is Constant · Average · Median · Minimum · Maximum · Percentile —
// switching a computed source to Constant starts from the figure the server
// last resolved for it.

import type { Cx } from '../../../charts/types';
import { Input } from '../../../ui/Field';
import { Select, type SelectOption } from '../../../ui/Select';
import type { Overlay } from './AnalyticsPane';
import { kindInfo } from './AnalyticsPane';
import s from './Analytics.module.css';

type Source = { type: 'constant'; value: number } | { type: 'stat'; stat: string; p?: number } | { type: 'metric'; metricId: string };

const SOURCES: SelectOption[] = [
  { value: 'constant', label: 'Constant' },
  { value: 'avg', label: 'Average' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
  { value: 'percentile', label: 'Percentile' },
];

/** A number field that commits on change, not per keystroke — each commit is a recompute. */
function NumberField({ label, value, onCommit, min, max, step = 'any' }: { label: string; value: unknown; onCommit: (n: number) => void; min?: number; max?: number; step?: string }) {
  return (
    <Input
      label={label}
      size="sm"
      type="number"
      min={min}
      max={max}
      step={step}
      defaultValue={typeof value === 'number' && Number.isFinite(value) ? String(value) : ''}
      onBlur={(e) => {
        const v = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(v)) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function SourceEditor({ label, src, resolvedValue, onChange }: { label: string; src: Source | undefined; resolvedValue: number | undefined; onChange: (s: Source) => void }) {
  if (src && src.type === 'metric') {
    // A metric source is picked in the desktop's metric picker (T2.8 ports it); here it is kept as saved.
    return <p className={s.note}>{label}: a saved metric, resolved by the server under the chart’s scope.</p>;
  }
  const cur = !src ? 'avg' : src.type === 'constant' ? 'constant' : src.stat;
  return (
    <div className={s.source}>
      <Select
        label={label}
        size="sm"
        value={cur}
        options={SOURCES}
        onValueChange={(v) => {
          if (v === 'constant') onChange({ type: 'constant', value: src && src.type === 'constant' ? src.value : (resolvedValue ?? 0) });
          else if (v === 'percentile') onChange({ type: 'stat', stat: 'percentile', p: 90 });
          else onChange({ type: 'stat', stat: v });
        }}
      />
      {src?.type === 'constant' && <NumberField key={`c${src.value}`} label={`${label} value`} value={src.value} onCommit={(n) => onChange({ type: 'constant', value: n })} />}
      {src?.type === 'stat' && src.stat === 'percentile' && (
        <NumberField key="p" label="Percentile" value={src.p} min={0} max={100} step="1" onCommit={(n) => onChange({ type: 'stat', stat: 'percentile', p: n })} />
      )}
    </div>
  );
}

const pick = (options: SelectOption[], label: string, value: string, onChange: (v: string) => void) => (
  <Select label={label} size="sm" value={value} options={options} onValueChange={onChange} />
);

export function OverlayEditor({ ov, res, labels, series, onChange }: { ov: Overlay; res: Cx; labels: string[]; series: string[]; onChange: (next: Overlay) => void }) {
  const set = (patch: Record<string, unknown>) => {
    const next = { ...ov, ...patch } as Overlay;
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    onChange(next);
  };
  const constantLine = (ov.kind === 'reference' || ov.kind === 'target') && (ov.value as Source | undefined)?.type === 'constant';
  return (
    <div className={s.editor}>
      <Input
        label="Label"
        size="sm"
        maxLength={280}
        placeholder={(res?.label as string) || kindInfo(ov.kind).label}
        defaultValue={(ov.label as string) || ''}
        onBlur={(e) => set({ label: e.target.value.trim() || undefined })}
      />
      {series.length > 1 && ov.kind !== 'band' &&
        pick(series.map((n, i) => ({ value: String(i), label: n })), 'Series', String(ov.series || 0), (v) => set({ series: Number(v) || undefined }))}

      {(ov.kind === 'reference' || ov.kind === 'target') && (
        <SourceEditor label="Value" src={ov.value as Source} resolvedValue={typeof res?.value === 'number' ? res.value : undefined} onChange={(v) => set({ value: v })} />
      )}
      {ov.kind === 'band' && (
        <>
          {pick([{ value: 'sd', label: 'Mean ± σ' }, { value: 'values', label: 'Between two values' }], 'Shade', ov.sd ? 'sd' : 'values', (v) =>
            v === 'sd'
              ? set({ sd: ov.sd || 1, from: undefined, to: undefined })
              : set({ sd: undefined, from: ov.from || { type: 'stat', stat: 'min' }, to: ov.to || { type: 'stat', stat: 'avg' } }),
          )}
          {ov.sd ? (
            <NumberField label="σ (standard deviations)" value={ov.sd} min={0.1} max={6} step="0.5" onCommit={(n) => set({ sd: Math.max(0.1, Math.min(6, n)) })} />
          ) : (
            <>
              <SourceEditor label="From" src={ov.from as Source} resolvedValue={typeof res?.from === 'number' ? res.from : undefined} onChange={(v) => set({ from: v })} />
              <SourceEditor label="To" src={ov.to as Source} resolvedValue={typeof res?.to === 'number' ? res.to : undefined} onChange={(v) => set({ to: v })} />
            </>
          )}
        </>
      )}
      {ov.kind === 'moving_average' && (
        <NumberField label="Window" value={ov.window} min={2} max={60} step="1" onCommit={(n) => set({ window: Math.max(2, Math.min(60, Math.round(n))) })} />
      )}
      {ov.kind === 'forecast' && (
        <>
          {pick(
            [
              { value: 'linear', label: 'Linear' },
              { value: 'seasonal_naive', label: 'Seasonal naive' },
              { value: 'holt_winters', label: 'Holt-Winters' },
            ],
            'Method',
            String(ov.method || 'linear'),
            (v) => set({ method: v }),
          )}
          <NumberField label="Periods" value={ov.horizon} min={1} max={36} step="1" onCommit={(n) => set({ horizon: Math.max(1, Math.min(36, Math.round(n))) })} />
          {pick(
            [
              { value: 'auto', label: 'Detect (4 / 7 / 12)' },
              { value: '0', label: 'None' },
              { value: '4', label: '4 (quarters)' },
              { value: '7', label: '7 (weekdays)' },
              { value: '12', label: '12 (months)' },
            ],
            'Season',
            String(ov.season === undefined ? 'auto' : ov.season),
            (v) => set({ season: v === 'auto' ? 'auto' : Number(v) }),
          )}
          {res?.forecast && (
            <p className={s.note}>
              {res.forecast.season ? `Season ${res.forecast.season}` : 'No season'}
              {ov.season === 'auto' || ov.season === undefined ? ' (detected)' : ''} · shaded band is the 80% interval
            </p>
          )}
        </>
      )}
      {ov.kind === 'annotation' && (
        <>
          {pick((labels.length ? labels : [String(ov.at || '')]).map((l) => ({ value: l, label: l })), 'At', String(ov.at || labels[0] || ''), (v) => set({ at: v }))}
          <Input label="Note" size="sm" maxLength={280} placeholder="What happened here" defaultValue={String(ov.text || '')} onBlur={(e) => e.target.value.trim() && set({ text: e.target.value.trim() })} />
        </>
      )}
      {ov.kind === 'highlight' && (
        <>
          {pick(
            [
              { value: 'top', label: 'Top N' },
              { value: 'bottom', label: 'Bottom N' },
              { value: 'above', label: 'Above a value' },
              { value: 'below', label: 'Below a value' },
            ],
            'Rule',
            String(ov.rule || 'top'),
            (v) => set(v === 'top' || v === 'bottom' ? { rule: v, n: ov.n || 3, threshold: undefined } : { rule: v, threshold: ov.threshold ?? 0, n: undefined }),
          )}
          {ov.rule === 'above' || ov.rule === 'below' ? (
            <NumberField key="t" label="Value" value={ov.threshold} onCommit={(n) => set({ threshold: n })} />
          ) : (
            <NumberField key="n" label="How many" value={ov.n} min={1} max={50} step="1" onCommit={(n) => set({ n: Math.max(1, Math.min(50, Math.round(n))) })} />
          )}
        </>
      )}
      {ov.kind === 'trend' && res?.text && <p className={s.note}>{String(res.text)} — least squares; R² is the share of the variation the line explains.</p>}
      <label className={s.colorField}>
        <span>Colour</span>
        <input type="color" aria-label="Overlay colour" value={typeof ov.color === 'string' ? ov.color : '#6366f1'} onChange={(e) => set({ color: e.target.value })} />
      </label>
      {constantLine && <p className={s.note}>Tip: drag the line on the chart to move it.</p>}
    </div>
  );
}
