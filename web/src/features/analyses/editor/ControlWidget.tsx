// The control widgets (legacy dashControls.ts + dashParams.ts renderParamControl):
// a dropdown or multi-select (ValuePicker: the column's values in a searchable
// popover), a date range (DateControl: the server's period picker in a
// popover), and a parameter's slider / box / picker. A widget only ever
// reports a selection; filtering is the server's.

import { Checkbox } from '../../../ui/Choice';
import { Popover } from '../../../ui/Popover';
import type { Card, ControlValue, Parameter } from '../api';
import { DateControl } from './DateControl';
import { ValuePicker } from './ValuePicker';
import s from './FilterBar.module.css';

// Moved to ValuePicker with the pickers; re-exported for the callers and tests that import them from here.
export { NoList, noListOf } from './ValuePicker';

const str = (v: unknown) => (v == null ? '' : String(v));

/** A parameter's widget: a slider with both bounds, else a number box; options → a picker; a date; a list. */
export function ParamWidget({ param, value, onChange, label }: { param: Parameter; value: unknown; onChange: (v: unknown) => void; label: string }) {
  if (param.kind === 'number') {
    const n = typeof value === 'number' ? value : null;
    if (param.min !== undefined && param.max !== undefined) {
      return (
        <span className={s.slider}>
          <input
            type="range"
            aria-label={label}
            min={param.min}
            max={param.max}
            step={param.step ?? 'any'}
            value={n ?? param.min}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <output className={s.out}>{n ?? '—'}</output>
        </span>
      );
    }
    return (
      <input
        type="number"
        className={s.num}
        aria-label={label}
        step={param.step ?? 'any'}
        value={n ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  }
  if (param.kind === 'date') return <input type="date" className={s.date} aria-label={label} value={str(value)} onChange={(e) => onChange(e.target.value || null)} />;
  const options = Array.isArray(param.list) ? param.list : [];
  if (param.kind === 'list') {
    const picked = Array.isArray(value) ? value.map(str) : [];
    if (!options.length) {
      return <input className={s.text} aria-label={label} value={picked.join(', ')} onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />;
    }
    return (
      <Popover trigger={<button type="button" className={s.multiBtn}>{picked.length ? picked.join(', ') : 'None'}</button>} title={label}>
        <div className={s.multiList}>
          {options.map((o) => (
            <Checkbox key={o} label={o} checked={picked.includes(o)} onCheckedChange={(c) => onChange(c ? [...picked, o] : picked.filter((x) => x !== o))} />
          ))}
        </div>
      </Popover>
    );
  }
  if (options.length) {
    return (
      <select className={s.select} aria-label={label} value={str(value)} onChange={(e) => onChange(e.target.value || null)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return <input className={s.text} aria-label={label} value={str(value)} onChange={(e) => onChange(e.target.value || null)} />;
}

/** The widget for one control's kind. */
export function ControlWidget({ projectId, control, value, onChange }: { projectId: string; control: NonNullable<Card['control']>; value: ControlValue | undefined; onChange: (v: ControlValue | undefined) => void }) {
  if (!control.datasetId || !control.column) return <span className={s.missing}>No source column</span>;
  if (control.kind === 'date_range') return <DateControl control={control} value={value} onChange={onChange} />;
  if (control.kind === 'dropdown' || control.kind === 'multi') return <ValuePicker projectId={projectId} control={control} value={value} onChange={onChange} />;
  return <span className={s.missing}>Shown on the dashboard</span>;
}
