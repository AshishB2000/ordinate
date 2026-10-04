// The relative-period picker (periodPicker.ts buildPeriodPanel): preset pills,
// a "Last N units" row, and — unless `relativeOnly` — a Between-dates tab. A
// period is STORED as its preset and turned into dates by the server at query
// time, so a filter saved on "Last 30 days" is current every time it opens.
// The presets' NAMES and the resolved dates both come from `period:picker`.

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { Select } from '../../../ui/Select';
import { Skeleton } from '../../../ui/Skeleton';
import s from './Filters.module.css';

export interface PeriodSpec {
  [k: string]: unknown;
  preset: string;
  n?: number;
  from?: string;
  to?: string;
}

interface Picker {
  groups: { title: string; items: { spec: PeriodSpec; label: string }[] }[];
  units: { preset: string; label: string }[];
  fiscal: boolean;
  current?: { spec: PeriodSpec; label: string; from?: string; to?: string; range?: string };
}

/** The picker's presets, and `spec` named and resolved — one server call, cached per spec. */
export function usePeriodPicker(spec: PeriodSpec | null) {
  return useQuery({
    queryKey: ['period:picker', spec],
    queryFn: async () => (await rpc('period:picker', spec ? { spec } : {})) as Picker,
    staleTime: 60_000,
  });
}

const relative = (v: PeriodSpec | null): boolean => !!v && typeof v.preset === 'string' && v.preset !== 'custom';
const same = (a: PeriodSpec | null, b: PeriodSpec): boolean => !!a && a.preset === b.preset && (Number(a.n) || 0) === (Number(b.n) || 0);

export function PeriodPanel({ value, relativeOnly, onChange }: { value: PeriodSpec | null; relativeOnly?: boolean; onChange: (v: PeriodSpec | null) => void }) {
  const [tab, setTab] = useState<'rel' | 'abs'>(relativeOnly || !value || relative(value) ? 'rel' : 'abs');
  const q = usePeriodPicker(value && relative(value) ? value : null);
  const isN = relative(value) && !!q.data?.units.some((u) => u.preset === value!.preset);
  const [n, setN] = useState(String(isN ? value!.n || 1 : 6));
  const [unit, setUnit] = useState(isN ? value!.preset : 'last_n_months');
  const applyLastN = (u = unit, k = n) => onChange({ preset: u, n: Math.max(1, Math.min(3660, Math.floor(Number(k) || 1))) });
  const abs: Partial<PeriodSpec> = value && !relative(value) ? value : {};

  return (
    <div className={s.period}>
      {!relativeOnly && (
        <div className={s.tabs} role="tablist" aria-label="Period kind">
          {(['rel', 'abs'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? `${s.tab} ${s.tabOn}` : s.tab} onClick={() => setTab(t)}>
              {t === 'rel' ? 'Relative' : 'Between dates'}
            </button>
          ))}
        </div>
      )}
      {tab === 'rel' ? (
        q.isPending ? (
          <div role="status" aria-busy="true" aria-label="Loading periods" className={s.pills}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className={s.pillSkel} />
            ))}
          </div>
        ) : q.isError ? (
          <p className={s.note}>The periods could not be loaded: {q.error.message}</p>
        ) : (
          <>
            {q.data.groups.map((g) => (
              <div key={g.title} className={s.group}>
                <div className={s.groupTitle}>{g.title}</div>
                <div className={s.pills}>
                  {g.items.map((it) => {
                    const on = relative(value) && same(value, it.spec);
                    return (
                      <button key={it.label} type="button" aria-pressed={on} className={on ? `${s.pill} ${s.pillOn}` : s.pill} onClick={() => onChange({ ...it.spec })}>
                        {it.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className={s.lastN}>
              <span className={s.lead}>Last</span>
              <Input
                aria-label="How many"
                size="sm"
                type="number"
                min={1}
                max={3660}
                value={n}
                className={s.nBox}
                onChange={(e) => setN(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyLastN();
                  }
                }}
              />
              <Select
                aria-label="Unit"
                size="sm"
                value={unit}
                options={q.data.units.map((u) => ({ value: u.preset, label: u.label }))}
                onValueChange={(u) => {
                  setUnit(u);
                  applyLastN(u);
                }}
              />
              <Button size="sm" onClick={() => applyLastN()}>
                Use
              </Button>
            </div>
            <p className={s.note}>
              “Last” periods are complete ones — Last 30 days ends yesterday.{' '}
              {q.data.fiscal ? 'Quarters and years follow your fiscal year.' : 'Weeks and fiscal years follow Settings → Formats.'}
            </p>
          </>
        )
      ) : (
        <>
          <div className={s.pair}>
            {(['from', 'to'] as const).map((k) => (
              <Input
                key={k}
                label={k === 'from' ? 'From' : 'To'}
                type="date"
                value={(abs[k] as string | undefined) || ''}
                onChange={(e) => {
                  const next: PeriodSpec = { preset: 'custom', ...(value && !relative(value) ? value : {}) };
                  if (e.target.value) next[k] = e.target.value;
                  else delete next[k];
                  onChange(next.from || next.to ? next : null);
                }}
              />
            ))}
          </div>
          <p className={s.note}>Both dates are inclusive. Leave one empty for an open-ended range.</p>
        </>
      )}
      <Resolved value={value} />
    </div>
  );
}

/** The line under the picker: the period's name and its dates today, or why there is none. */
function Resolved({ value }: { value: PeriodSpec | null }) {
  const q = usePeriodPicker(value && relative(value) ? value : null);
  let text: ReactNode;
  if (!value) text = 'No date filter — every date is included';
  else if (!relative(value)) text = value.from && value.to ? `${value.from} to ${value.to}` : value.from ? `From ${value.from}` : value.to ? `Until ${value.to}` : 'Pick a start or an end';
  else if (q.isPending) text = <Skeleton className={s.lineSkel} />;
  else
    text = (
      <>
        <strong>{q.data?.current?.label ?? ''}</strong>
        {q.data?.current?.range ? ` · ${q.data.current.range}` : ''}
      </>
    );
  return (
    <div className={s.resolved} role="status">
      <Icon name="calendar" size={12} /> {text}
    </div>
  );
}
