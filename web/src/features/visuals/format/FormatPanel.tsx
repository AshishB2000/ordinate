// Format — the depth of a chart's formatting (formatPanel.ts + fmtSort.ts),
// inside the ⋯ menu's Customize: Legend, Axes (per axis: title, min / max,
// start at zero, log scale, number format, tick density, hide — and the right
// axis with the measures on it), Data labels, Sort (by value, label, or a
// custom order you drag) and Colours (./Colours). Every control writes a key of
// the visual's ordinary `overrides`, which the server clamps
// (src/analysis/chartFormat.ts); a null drops the key.

import { useState, type ReactNode } from 'react';
import { chartSeries } from '../../../charts/build';
import { fmtAxisRoles, type FmtRole } from '../../../charts/fmtApply';
import { legendOnByDefault, NO_VALUE_LABEL_TYPES } from '../../../charts/traits';
import { resolveChartType } from '../../../charts/typeSpec';
import type { ChartDataShape, Cx, Overrides } from '../../../charts/types';
import { Switch } from '../../../ui/Choice';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { Select, type SelectOption } from '../../../ui/Select';
import { Colours, type ColourScope } from './Colours';
import { SortOrder } from './SortOrder';
import s from './Format.module.css';

export type Patch = Record<string, unknown>;

export interface FormatCtx {
  type: string;
  data: ChartDataShape | null;
  /** The visual's measures, by the names its series are drawn under. */
  measures: string[];
  overrides: Overrides;
  patch: (p: Patch) => void;
  /** Where the chart's labels and series come from, and the project's colour map. */
  scope: ColourScope | null;
}

const NUMBER_FORMATS: SelectOption[] = [
  { value: '', label: 'Chart default' },
  { value: 'auto', label: 'Auto (K/M/B)' },
  { value: 'plain', label: 'Plain' },
  { value: 'thousands', label: 'Thousands (1,234)' },
  { value: 'compact', label: 'Compact (1.2K)' },
  { value: 'percent', label: 'Percent (12%)' },
  { value: 'currency', label: 'Currency ($1,234)' },
];
const VALUE_MODES: SelectOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'all', label: 'All' },
  { value: 'maxmin', label: 'Max & min' },
  { value: 'max', label: 'Max' },
  { value: 'min', label: 'Min' },
];
const SORTABLE = ['column', 'bar', 'clustered_column', 'clustered_bar', 'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'pie', 'donut', 'bullet'];

/** A disclosure: the open ones stay open across redraws. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={s.sec}>
      <button type="button" className={s.secHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {title}
      </button>
      {open && <div className={s.secBody}>{children}</div>}
    </section>
  );
}

export const Note = ({ children, warn }: { children: ReactNode; warn?: boolean }) => <p className={warn ? `${s.note} ${s.warn}` : s.note}>{children}</p>;

function AxisBlock({ ctx, axis, role }: { ctx: FormatCtx; axis: 'x' | 'y' | 'y2'; role: FmtRole }) {
  const ov = ctx.overrides;
  const a: Cx = (ov.axes && ov.axes[axis]) || {};
  const [err, setErr] = useState('');
  const setAxis = (props: Record<string, unknown>) => {
    const axes = { ...(ov.axes || {}) };
    const next = { ...(axes[axis] || {}) };
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false || v === '') delete next[k];
      else next[k] = v;
    }
    if (Object.keys(next).length) axes[axis] = next;
    else delete axes[axis];
    ctx.patch({ axes: Object.keys(axes).length ? axes : null });
  };
  const titleKey = axis === 'x' ? 'xAxisLabel' : axis === 'y' ? 'yAxisLabel' : 'y2AxisLabel';
  const spec = resolveChartType(ctx.type);
  const zeroAxis = spec.isHoriz ? 'x' : 'y';
  const minBlocks = typeof a.min === 'number' && a.min <= 0;
  const onAxis = (): number[] => {
    const right = new Set(Array.isArray(ov.y2Series) ? ov.y2Series : []);
    return chartSeries(ctx.data || {})
      .filter((x) => x.role !== 'overlay' && (axis === 'y2' ? right.has(x.name) : !right.has(x.name)))
      .flatMap((x) => x.values.filter((v: unknown) => typeof v === 'number' && Number.isFinite(v)) as number[]);
  };
  const bound = (prop: 'min' | 'max', label: string) => (
    <Input
      key={`${prop}${a[prop] ?? ''}`}
      label={label}
      size="sm"
      type="number"
      step="any"
      placeholder="Auto"
      defaultValue={typeof a[prop] === 'number' ? String(a[prop]) : ''}
      onBlur={(e) => {
        const n = e.target.value.trim() === '' ? null : Number(e.target.value);
        const next = { ...a, [prop]: n };
        const problem =
          n !== null && !Number.isFinite(n)
            ? 'Enter a number, or leave it empty for Auto.'
            : typeof next.min === 'number' && typeof next.max === 'number' && !(next.min < next.max)
              ? 'Min must be below Max.'
              : a.log && typeof next.min === 'number' && next.min <= 0
                ? 'A log scale needs Min above 0.'
                : '';
        setErr(problem);
        if (!problem) setAxis({ [prop]: n });
      }}
    />
  );
  return (
    <div className={s.axis}>
      <div className={s.sub}>
        {axis === 'x' ? 'X axis' : axis === 'y' ? 'Y axis' : 'Right axis'}
        {role === 'value' ? ' · values' : ' · categories'}
      </div>
      <Input
        key={`t${ov[titleKey] ?? ''}`}
        label="Title"
        size="sm"
        placeholder="No title"
        defaultValue={(ov[titleKey] as string) || ''}
        onBlur={(e) => ctx.patch({ [titleKey]: e.target.value.trim() || null })}
      />
      {role === 'value' && (
        <>
          <div className={s.pair}>
            {bound('min', 'Min')}
            {bound('max', 'Max')}
          </div>
          {err && <Note warn>{err}</Note>}
          {axis === zeroAxis && !a.log && !spec.isScatter && !spec.isBubble && !spec.isCandlestick && !spec.isBoxplot && !spec.opts.pct && (
            <Switch label="Start at zero" checked={ov.yZero !== undefined ? !!ov.yZero : spec.chartType === 'bar'} onCheckedChange={(on) => ctx.patch({ yZero: on })} />
          )}
          <Switch label="Log scale" checked={!!a.log} disabled={!a.log && minBlocks} onCheckedChange={(on) => setAxis({ log: on })} />
          {!a.log && minBlocks && <Note>A log scale needs Min above 0.</Note>}
          {a.log && ctx.data && onAxis().some((v) => v <= 0) && <Note warn>Some values here are zero or below, so this axis is drawn linear.</Note>}
          <Select label="Number format" size="sm" value={a.format || ''} options={NUMBER_FORMATS} onValueChange={(v) => setAxis({ format: v || null })} />
        </>
      )}
      <Select
        label="Tick density"
        size="sm"
        value={a.ticks || ''}
        options={[
          { value: '', label: 'Auto' },
          { value: 'few', label: 'Fewer' },
          { value: 'many', label: 'More' },
        ]}
        onValueChange={(v) => setAxis({ ticks: v || null })}
      />
      <Switch label="Hide axis" checked={!!a.hide} onCheckedChange={(on) => setAxis({ hide: on })} />
    </div>
  );
}

function Axes({ ctx }: { ctx: FormatCtx }) {
  const roles = fmtAxisRoles(ctx.type);
  if (!roles.x && !roles.y) return null;
  const ov = ctx.overrides;
  // A right axis takes two or more measure series, never a split.
  const names = ctx.scope?.series ? [] : chartSeries(ctx.data || {}).filter((x) => x.role !== 'overlay').map((x) => String(x.name || ''));
  const measures = roles.y2 && names.length >= 2 ? names : [];
  const right = new Set<string>(Array.isArray(ov.y2Series) ? ov.y2Series : ctx.type === 'combo' ? measures.slice(1) : []);
  return (
    <Section title="Axes">
      <Switch label="Gridlines" checked={ov.showGridlines !== false} onCheckedChange={(on) => ctx.patch({ showGridlines: on ? null : false })} />
      {(Array.isArray(ctx.data?.events) || ov.showEvents === false) && (
        <Switch label="Event markers" checked={ov.showEvents !== false} onCheckedChange={(on) => ctx.patch({ showEvents: on ? null : false })} />
      )}
      {roles.x && <AxisBlock ctx={ctx} axis="x" role={roles.x} />}
      {roles.y && <AxisBlock ctx={ctx} axis="y" role={roles.y} />}
      {measures.length > 0 && (
        <>
          <div className={s.sub}>Measures on the right axis</div>
          {measures.map((m) => {
            const on = right.has(m);
            return (
              <Switch
                key={m}
                label={m}
                checked={on}
                // At least one measure stays on the left axis (the server clamps the same rule).
                disabled={!on && right.size >= measures.length - 1}
                onCheckedChange={(next) => {
                  const set = new Set(right);
                  if (next) set.add(m);
                  else set.delete(m);
                  ctx.patch({ y2Series: measures.filter((x) => set.has(x)) });
                }}
              />
            );
          })}
          {right.size > 0 && <AxisBlock ctx={ctx} axis="y2" role="value" />}
        </>
      )}
    </Section>
  );
}

export function FormatPanel({ ctx }: { ctx: FormatCtx }) {
  const ov = ctx.overrides;
  const type = ctx.type;
  const dflt = legendOnByDefault(type, chartSeries(ctx.data || {}));
  const shown = ov.showLegend !== undefined ? !!ov.showLegend : dflt;
  const roles = fmtAxisRoles(type);
  const labels = Array.isArray(ctx.data?.labels) ? ctx.data!.labels : [];
  return (
    <div className={s.panel}>
      <Select
        label="Legend"
        size="sm"
        value={shown ? (ov.legendPosition as string) || 'bottom' : 'none'}
        options={['top', 'right', 'bottom', 'left', 'none'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))}
        onValueChange={(v) => (v === 'none' ? ctx.patch({ showLegend: false }) : ctx.patch({ showLegend: dflt ? null : true, legendPosition: v === 'bottom' ? null : v }))}
      />
      <Axes ctx={ctx} />
      {!NO_VALUE_LABEL_TYPES.has(type) && type !== 'table' && !type.startsWith('map_') && (
        <Section title="Data labels">
          <Select
            label="Show"
            size="sm"
            value={(ov.valueMode as string) || (ov.showValues ? 'all' : 'maxmin')}
            options={VALUE_MODES}
            onValueChange={(v) => ctx.patch({ valueMode: v })}
          />
          <Select label="Format" size="sm" value={(ov.labelFormat as string) || ''} options={NUMBER_FORMATS} onValueChange={(v) => ctx.patch({ labelFormat: v || null })} />
          {(roles.x === 'value' || roles.y === 'value') && (
            <Select
              label="Position"
              size="sm"
              value={(ov.labelPosition as string) || 'outside'}
              options={[
                { value: 'outside', label: 'Outside end' },
                { value: 'inside', label: 'Inside end' },
                { value: 'center', label: 'Centre' },
              ]}
              onValueChange={(v) => ctx.patch({ labelPosition: v === 'outside' ? null : v })}
            />
          )}
        </Section>
      )}
      {SORTABLE.includes(type) && (
        <Section title="Sort">
          <SortOrder labels={labels} overrides={ov} patch={ctx.patch} />
        </Section>
      )}
      {type !== 'table' && !type.startsWith('map_') && type !== 'pivot' && (
        <Section title="Colours">
          <Colours ctx={ctx} />
        </Section>
      )}
    </div>
  );
}
