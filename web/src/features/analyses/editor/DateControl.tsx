// A date-range control (docs/dashboard-filters/00-design.md): a chip named by
// the SERVER — "Last 30 days", "Q3 2024" — that opens the visuals' period
// picker (PeriodPanel: preset pills, Last N units, Between dates) in a
// popover, with "All dates" to clear it. There is no client table of preset
// names: the label is `period:picker`'s, asked once per relative value and
// shared by query key; a fixed range is its own dates and asks nothing.
//
// The STORED shape is the control's (dashboards.ts sanitizeControlDefault):
// `{preset, n}` in that key order, or `{from, to}` — never `{preset:'custom'}`,
// which is only how the panel spells a range while it is being picked.

import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { Popover } from '../../../ui/Popover';
import { Icon } from '../../../ui/icons/Icon';
import { PeriodPanel, usePeriodPicker, type PeriodSpec } from '../../visuals/filters/PeriodPanel';
import type { Card, ControlValue } from '../api';
import s from './FilterBar.module.css';

/** A control's value as the panel reads it. */
export function toSpec(v: ControlValue | undefined): PeriodSpec | null {
  if (!v) return null;
  if ('preset' in v) return v.n != null ? { preset: v.preset, n: v.n } : { preset: v.preset };
  if ('from' in v || 'to' in v) return { preset: 'custom', ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}) };
  return null;
}

/** What the panel picked, as the control stores it; undefined = All dates. */
export function fromSpec(spec: PeriodSpec | null): ControlValue | undefined {
  if (!spec) return undefined;
  if (spec.preset !== 'custom') return typeof spec.n === 'number' ? { preset: spec.preset, n: spec.n } : { preset: spec.preset };
  const out: { from?: string; to?: string } = {};
  if (spec.from) out.from = spec.from;
  if (spec.to) out.to = spec.to;
  return out.from || out.to ? out : undefined;
}

/** A date value in words: the server's name for a relative period, the dates of a fixed one. */
export function usePeriodLabel(v: ControlValue | undefined): string {
  const spec = v && 'preset' in v ? toSpec(v) : null;
  const q = usePeriodPicker(spec, !!spec);
  if (spec) return q.data?.current?.label ?? (q.isError ? 'A relative period' : 'Loading…');
  const r = (v ?? {}) as { from?: string; to?: string };
  return r.from && r.to ? `${r.from} – ${r.to}` : r.from ? `From ${r.from}` : r.to ? `Until ${r.to}` : 'All dates';
}

export function DateControl({ control, value, onChange }: { control: NonNullable<Card['control']>; value: ControlValue | undefined; onChange: (v: ControlValue | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const label = usePeriodLabel(value);
  const name = control.label || control.column;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className={s.datePanel}
      title={name}
      trigger={
        <button type="button" className={s.multiBtn} aria-label={`${name}: ${label}`}>
          <Icon name="calendar" size={12} />
          <span className={s.chipText}>{label}</span>
          <Icon name="chevron-down" size={12} />
        </button>
      }
    >
      <PeriodPanel value={toSpec(value)} onChange={(spec) => onChange(fromSpec(spec))} />
      <Button
        size="sm"
        variant="ghost"
        disabled={!value}
        onClick={() => {
          onChange(undefined);
          setOpen(false);
        }}
      >
        All dates
      </Button>
    </Popover>
  );
}
