// The control widgets (legacy dashControls.ts + dashParams.ts renderParamControl):
// a dropdown, a multi-select popover, a date pair, and a parameter's slider /
// box / picker. Options come from the server's distinct values (searched in
// SQL). A widget only ever reports a selection; filtering is the server's.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Popover } from '../../../ui/Popover';
import type { Card, ControlValue, Parameter } from '../api';
import s from './FilterBar.module.css';

function useDistinct(projectId: string, datasetId: string, column: string, search = '') {
  return useQuery({
    queryKey: ['dataset:distinct', projectId, datasetId, column, search],
    enabled: !!datasetId && !!column,
    queryFn: async () =>
      (await rpc('dataset:distinct', { projectId, datasetId, column, limit: 200, ...(search ? { search } : {}) })) as { values: unknown[]; total: number },
  });
}

const str = (v: unknown) => (v == null ? '' : String(v));

function Dropdown({ projectId, control, value, onChange }: { projectId: string; control: NonNullable<Card['control']>; value: ControlValue | undefined; onChange: (v: ControlValue | undefined) => void }) {
  const q = useDistinct(projectId, control.datasetId, control.column);
  const cur = value && 'value' in value ? value.value : '';
  return (
    <select
      className={s.select}
      aria-label={control.label || control.column}
      value={cur}
      onChange={(e) => onChange(e.target.value ? { value: e.target.value } : undefined)}
    >
      <option value="">All</option>
      {cur && !q.data?.values.some((v) => str(v) === cur) && <option value={cur}>{cur}</option>}
      {(q.data?.values ?? []).map((v) => (
        <option key={str(v)} value={str(v)}>
          {str(v) || '(blank)'}
        </option>
      ))}
    </select>
  );
}

function Multi({ projectId, control, value, onChange }: { projectId: string; control: NonNullable<Card['control']>; value: ControlValue | undefined; onChange: (v: ControlValue | undefined) => void }) {
  const [search, setSearch] = useState('');
  const q = useDistinct(projectId, control.datasetId, control.column, search.trim());
  const picked = value && 'values' in value ? value.values : [];
  const set = (next: string[]) => onChange(next.length ? { values: next } : undefined);
  const summary = picked.length === 0 ? 'All' : picked.length === 1 ? picked[0] : `${picked.length} selected`;
  return (
    <Popover
      trigger={
        <button type="button" className={s.multiBtn} aria-label={`${control.label || control.column}: ${summary}`}>
          {summary}
        </button>
      }
      title={control.label || control.column}
    >
      <div className={s.multi}>
        <input className={s.search} type="search" placeholder="Search values" aria-label="Search values" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className={s.multiList}>
          {(q.data?.values ?? []).map((raw) => {
            const v = str(raw);
            return (
              <Checkbox
                key={v}
                label={v || '(blank)'}
                checked={picked.includes(v)}
                onCheckedChange={(c) => set(c ? [...picked, v] : picked.filter((x) => x !== v))}
              />
            );
          })}
          {q.data && q.data.total > q.data.values.length && <p className={s.more}>Showing the first {q.data.values.length} of {q.data.total.toLocaleString()} — search to narrow.</p>}
        </div>
        {picked.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => set([])}>
            Clear
          </Button>
        )}
      </div>
    </Popover>
  );
}

function DateRange({ control, value, onChange }: { control: NonNullable<Card['control']>; value: ControlValue | undefined; onChange: (v: ControlValue | undefined) => void }) {
  const cur = value && ('from' in value || 'to' in value) ? (value as { from?: string; to?: string }) : {};
  const relative = value && 'preset' in value ? value.preset : '';
  const set = (from?: string, to?: string) => onChange(from || to ? { ...(from ? { from } : {}), ...(to ? { to } : {}) } : undefined);
  return (
    <span className={s.dates}>
      {relative && <span className={s.relative}>{relative.replace(/_/g, ' ')}</span>}
      <input type="date" className={s.date} aria-label={`${control.label || control.column} from`} value={cur.from ?? ''} onChange={(e) => set(e.target.value, cur.to)} />
      <span aria-hidden="true">–</span>
      <input type="date" className={s.date} aria-label={`${control.label || control.column} to`} value={cur.to ?? ''} onChange={(e) => set(cur.from, e.target.value)} />
    </span>
  );
}

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
  if (control.kind === 'multi') return <Multi projectId={projectId} control={control} value={value} onChange={onChange} />;
  if (control.kind === 'date_range') return <DateRange control={control} value={value} onChange={onChange} />;
  if (control.kind === 'dropdown') return <Dropdown projectId={projectId} control={control} value={value} onChange={onChange} />;
  return <span className={s.missing}>Shown on the dashboard</span>;
}
