// Small multiples (facetShelf.ts): `encoding.facet` and nothing else — Rows
// and/or Columns (one field each), a shared or independent value axis, panel
// order, how many panels before the rest fold into "Other", and the panel
// title. The server does the splitting (src/analysis/facets.ts).

import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import type { Column } from '../model';
import s from './Facets.module.css';

export interface Facet {
  rows?: string;
  cols?: string;
  scale?: 'independent';
  order?: 'measure';
  max?: number;
  title?: string;
}

const TITLES = [
  { value: '{value}', label: 'Value' },
  { value: '{field}: {value}', label: 'Field: value' },
];

/** The facet to store: null when no field is on either side; defaults dropped. */
function clean(f: Facet): Facet | null {
  if (!f.rows && !f.cols) return null;
  const out: Facet = {};
  for (const k of ['rows', 'cols', 'scale', 'order', 'max', 'title'] as const) if (f[k] !== undefined) (out as Record<string, unknown>)[k] = f[k];
  return out;
}

export function FacetShelf({ cols, facet, onChange }: { cols: readonly Column[]; facet: Facet | undefined; onChange: (f: Facet | null) => void }) {
  const f: Facet = facet ?? {};
  const on = !!(f.rows || f.cols);
  const set = (patch: Partial<Facet>) => onChange(clean({ ...f, ...patch }));
  const fields = [{ value: '', label: 'None' }, ...cols.map((c) => ({ value: c.name, label: c.name }))];
  const side = (key: 'rows' | 'cols', label: string, aria: string) => (
    <Select
      label={label}
      aria-label={aria}
      size="sm"
      value={f[key] && cols.some((c) => c.name === f[key]) ? f[key]! : ''}
      options={fields}
      onValueChange={(v) => {
        const other = key === 'rows' ? 'cols' : 'rows';
        // One field, one side.
        set({ [key]: v || undefined, ...(f[other] === v ? { [other]: undefined } : {}) });
      }}
    />
  );
  return (
    <section className={on ? `${s.shelf} ${s.on}` : s.shelf} aria-labelledby="fc-title">
      <div className={s.head}>
        <span className={s.title} id="fc-title">
          Small multiples
        </span>
        {on && <span className={s.badge}>{f.rows && f.cols ? 'Matrix' : 'Wrapped'}</span>}
        {on && (
          <Button size="sm" variant="ghost" className={s.clear} onClick={() => onChange(null)}>
            Clear
          </Button>
        )}
      </div>
      {!on && <p className={s.empty}>Split this chart into a grid of panels — one per value of a field, all drawn the same way.</p>}
      <div className={s.dims}>
        {side('rows', 'Rows', 'Facet rows')}
        {side('cols', 'Columns', 'Facet columns')}
      </div>
      {on && (
        <div className={s.opts}>
          <div className={s.wide}>
            <span className={s.label} id="fc-scale">
              Value axis
            </span>
            <div className={s.seg} role="group" aria-labelledby="fc-scale">
              {(['shared', 'independent'] as const).map((v) => (
                <button key={v} type="button" className={s.segOpt} aria-pressed={(f.scale || 'shared') === v} onClick={() => set({ scale: v === 'shared' ? undefined : v })}>
                  {v === 'shared' ? 'Shared' : 'Independent'}
                </button>
              ))}
            </div>
          </div>
          <Select
            label="Order"
            aria-label="Panel order"
            size="sm"
            value={f.order === 'measure' ? 'measure' : 'label'}
            options={[
              { value: 'label', label: 'By label' },
              { value: 'measure', label: 'By value' },
            ]}
            onValueChange={(v) => set({ order: v === 'measure' ? 'measure' : undefined })}
          />
          <Input
            key={f.max ?? 'auto'}
            label="Panels before Other"
            aria-label="Panels before the rest fold into Other"
            size="sm"
            type="number"
            min={2}
            max={36}
            placeholder="12"
            defaultValue={f.max ? String(f.max) : ''}
            onBlur={(e) => {
              const n = Math.round(Number(e.target.value));
              set({ max: e.target.value && Number.isFinite(n) && n >= 2 && n <= 36 ? n : undefined });
            }}
          />
          <Select
            label="Panel title"
            aria-label="Panel title format"
            size="sm"
            value={TITLES.some((t) => t.value === f.title) ? f.title! : '{value}'}
            options={TITLES}
            onValueChange={(v) => set({ title: v === '{value}' ? undefined : v })}
          />
        </div>
      )}
    </section>
  );
}
