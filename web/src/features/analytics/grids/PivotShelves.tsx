// The pivot's shelves (pivotBuilder.ts) — Rows, Columns, Values, then Totals,
// Sort, Top N and conditional formatting. They REPLACE the encoding form's
// Category / Measures / Split by while the chart type is `pivot`; filters stay
// where they are. Controlled: reads a pivot, reports a new one. The shelves
// are ordered (the first row dimension is the outer one), so a chip moves by
// drag or by its menu's Move earlier / later. Every cell, subtotal and total
// is the server's (pivotData / pivotResident) — nothing here reads a row.

import { useState, type DragEvent } from 'react';
import { Badge } from '../../../ui/Badge';
import { IconButton } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Input } from '../../../ui/Field';
import { Menu, type MenuEntry } from '../../../ui/Menu';
import { Select } from '../../../ui/Select';
import { toast } from '../../../ui/Toast';
import { useMetricList } from '../../analyses/metrics/api';
import { AGG_LABELS, type Column } from '../../visuals/model';
import { MetricPicker, type MetricPick } from './MetricPicker';
import { dropValue, PIVOT_AGGS, poolFor, SHELF_LIMITS, sortSummary, type Pivot, type PivotDim, type PivotValue, type Shelf } from './gridEncoding';
import b from '../../visuals/Builder.module.css';
import s from './Shelves.module.css';

const SHELF_LABEL: Record<Shelf, string> = { rows: 'Rows', columns: 'Columns', values: 'Values' };
const SHELF_EMPTY: Record<Shelf, string> = { rows: 'Add a dimension', columns: 'Add a dimension', values: 'Add a measure' };
const GRAINS = [
  { value: '', label: 'No roll-up' },
  { value: 'year', label: 'Year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month' },
];
const SHOW_AS = [
  { value: 'value', label: 'Value' },
  { value: 'pct_row', label: '% of row' },
  { value: 'pct_col', label: '% of column' },
  { value: 'pct_total', label: '% of total' },
  { value: 'rank', label: 'Rank' },
];
const FORMATS = [
  { value: 'auto', label: 'Auto' },
  { value: 'plain', label: 'Plain' },
  { value: 'thousands', label: 'Thousands' },
  { value: 'compact', label: 'Compact' },
  { value: 'percent', label: 'Percent' },
  { value: 'currency', label: 'Currency' },
];
const COND = [
  { value: '', label: 'None' },
  { value: 'scale', label: 'Colour scale' },
  { value: 'bars', label: 'Data bars' },
  { value: 'threshold', label: 'Above / below' },
];
const DRAG = 'text/ordinate-pivot';

const AGG_SET: ReadonlySet<string> = new Set(PIVOT_AGGS);

export function PivotShelves({ projectId, cols, pivot, onChange }: { projectId: string; cols: readonly Column[]; pivot: Pivot; onChange: (p: Pivot) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  // A value that IS a metric shows the metric's NAME, re-read from the record (never persisted):
  // a deleted metric costs the chip its name, not its figures.
  const metrics = useMetricList(projectId);
  const valueName = (v: PivotValue) => (v.metricId && metrics.data?.find((m) => m.id === v.metricId)?.name) || `${AGG_LABELS[v.aggregation]} of ${v.column}`;
  /** pivotBuilder.pickValueMetric: a formula metric or another dataset's is refused and says why. */
  const applyPick = (i: number, p: MetricPick) => {
    setPicking(null);
    if (p.kind === 'custom') return patchValue(i, { metricId: undefined });
    const m = p.metric;
    const def = m.definition as { formula?: string; column?: string; aggregation?: string };
    if (typeof def.formula === 'string') {
      toast(`"${m.name}" is a formula metric. Every pivot cell is a column rolled up within a group — use it on a KPI card instead.`, { kind: 'error' });
      return;
    }
    if (!cols.some((c) => c.name === def.column)) {
      toast(`"${m.name}" is defined on a different dataset's column.`, { kind: 'error' });
      return;
    }
    patchValue(i, { column: String(def.column), aggregation: (AGG_SET.has(String(def.aggregation)) ? def.aggregation : 'sum') as PivotValue['aggregation'], metricId: m.id });
  };
  const isDate = (name: string) => cols.some((c) => c.name === name && c.type === 'date');
  const list = (shelf: Shelf): Array<PivotDim | PivotValue> => pivot[shelf];
  const put = (shelf: Shelf, items: Array<PivotDim | PivotValue>) => onChange({ ...pivot, [shelf]: items });
  const move = (shelf: Shelf, from: number, to: number) => {
    const items = list(shelf).slice();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    // A moved value takes its formatting rule with it.
    if (shelf === 'values' && pivot.conditional) {
      const remap = (i: number) => (i === from ? to : from < to && i > from && i <= to ? i - 1 : from > to && i >= to && i < from ? i + 1 : i);
      onChange({ ...pivot, values: items as PivotValue[], conditional: pivot.conditional.map((c) => ({ ...c, valueIdx: remap(c.valueIdx) })) });
      return;
    }
    put(shelf, items);
  };
  const remove = (shelf: Shelf, i: number) => (shelf === 'values' ? onChange(dropValue(pivot, i)) : put(shelf, list(shelf).filter((_, j) => j !== i)));
  const patchValue = (i: number, patch: Partial<PivotValue>) => {
    const values = pivot.values.map((v, j) => {
      if (j !== i) return v;
      const next = { ...v, ...patch } as PivotValue & Record<string, unknown>;
      for (const k of Object.keys(patch)) if (next[k] === undefined) delete next[k];
      return next;
    });
    onChange({ ...pivot, values });
  };

  function chipMenu(shelf: Shelf, chip: PivotDim | PivotValue, i: number): MenuEntry[] {
    const items: MenuEntry[] = [];
    if (shelf === 'values') {
      const v = chip as PivotValue;
      // The metric picker first — the same one a KPI card opens (metricPicker.ts).
      items.push({ label: v.metricId ? 'Change metric…' : 'Use a metric…', icon: 'target', onSelect: () => setPicking(i) });
      items.push({ kind: 'separator' });
      // 'none' means nothing in a pivot cell — every cell IS a group. Picking one drops a metric link.
      items.push({ kind: 'radio', label: 'Aggregation', value: v.aggregation, options: PIVOT_AGGS.map((a) => ({ value: a, label: AGG_LABELS[a] })), onChange: (a) => patchValue(i, { aggregation: a as PivotValue['aggregation'], metricId: undefined }) });
      items.push({ kind: 'separator' }, { kind: 'heading', label: 'Show as' });
      items.push({ kind: 'radio', label: 'Show as', value: v.showAs ?? 'value', options: SHOW_AS, onChange: (x) => patchValue(i, { showAs: x === 'value' ? undefined : x }) });
      items.push({ kind: 'separator' }, { kind: 'heading', label: 'Format' });
      items.push({ kind: 'radio', label: 'Format', value: v.format ?? 'auto', options: FORMATS, onChange: (x) => patchValue(i, { format: x === 'auto' ? undefined : x }) });
      items.push({ kind: 'separator' });
    }
    const n = list(shelf).length;
    if (i > 0) items.push({ label: 'Move earlier', icon: 'arrow-up', onSelect: () => move(shelf, i, i - 1) });
    if (i < n - 1) items.push({ label: 'Move later', icon: 'arrow-down', onSelect: () => move(shelf, i, i + 1) });
    // Retarget to another column of the same role, without deleting and re-adding the chip.
    const others = poolFor(shelf, cols).filter((c) => c.name !== chip.column).slice(0, 20);
    if (others.length) {
      items.push({ kind: 'heading', label: 'Use instead' });
      for (const c of others) {
        items.push({ label: c.name, onSelect: () => (shelf === 'values' ? patchValue(i, { column: c.name, metricId: undefined }) : put(shelf, list(shelf).map((x, j) => (j === i ? { column: c.name } : x)))) });
      }
      items.push({ kind: 'separator' });
    }
    items.push({ label: 'Remove', icon: 'trash', danger: true, onSelect: () => remove(shelf, i) });
    return items;
  }

  const drag = (shelf: Shelf, i: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG, `${shelf}:${i}`);
    },
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG)) return;
      e.preventDefault();
      setOver(`${shelf}:${i}`);
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => {
      setOver(null);
      const [from, idx] = e.dataTransfer.getData(DRAG).split(':');
      const at = Number(idx);
      if (from !== shelf || !Number.isInteger(at) || at === i) return;
      e.preventDefault();
      move(shelf, at, i);
    },
  });

  return (
    <div className={b.encoding}>
      {(['rows', 'columns', 'values'] as Shelf[]).map((shelf) => {
        const items = list(shelf);
        const taken = new Set(items.map((c) => c.column));
        const avail = poolFor(shelf, cols).filter((c) => !taken.has(c.name)).slice(0, 40);
        const full = items.length >= SHELF_LIMITS[shelf];
        const id = `pivot-${shelf}`;
        return (
          <div key={shelf} className={b.row} role="group" aria-labelledby={id}>
            <div className={s.shelfHead}>
              <span className={b.label} id={id}>
                {SHELF_LABEL[shelf]}
              </span>
              <Menu
                label={`Add a field to ${SHELF_LABEL[shelf]}`}
                trigger={<IconButton icon="plus" size="sm" label={`Add a field to ${SHELF_LABEL[shelf]}`} disabled={full || avail.length === 0} />}
                items={avail.map((c) => ({
                  label: c.name,
                  onSelect: () => put(shelf, [...items, shelf === 'values' ? { column: c.name, aggregation: c.type === 'number' ? 'sum' : 'count' } : { column: c.name }]),
                }))}
              />
            </div>
            {items.length === 0 ? (
              <p className={s.empty}>{SHELF_EMPTY[shelf]}</p>
            ) : (
              <ol className={s.chips}>
                {items.map((chip, i) => {
                  const name = shelf === 'values' ? valueName(chip as PivotValue) : chip.column;
                  return (
                    <li key={`${chip.column}:${i}`} className={over === `${shelf}:${i}` ? `${s.chip} ${s.drop}` : s.chip} {...drag(shelf, i)}>
                      <span className={s.chipName} title={name}>
                        {name}
                      </span>
                      {shelf === 'values' && (chip as PivotValue).calc && <Badge tone="accent">{String((chip as PivotValue).calc?.kind ?? 'calc').replace(/_/g, ' ')}</Badge>}
                      {shelf !== 'values' && isDate(chip.column) && (
                        <div className={s.grain}>
                          <Select
                            size="sm"
                            aria-label={`Roll ${chip.column} up by`}
                            value={(chip as PivotDim).grain ?? ''}
                            options={GRAINS}
                            onValueChange={(g) => put(shelf, items.map((x, j) => (j === i ? (g ? { column: x.column, grain: g } : { column: x.column }) : x)))}
                          />
                        </div>
                      )}
                      <Menu label={`Options for ${name}`} align="end" trigger={<IconButton icon="more-vertical" size="sm" label={`Options for ${name}`} />} items={chipMenu(shelf, chip, i)} />
                      <IconButton icon="x" size="sm" label={`Remove ${name}`} onClick={() => remove(shelf, i)} />
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        );
      })}
      {picking !== null && <MetricPicker projectId={projectId} onClose={() => setPicking(null)} onPick={(p) => applyPick(picking, p)} />}

      <div className={b.row} role="group" aria-labelledby="pivot-totals">
        <span className={b.label} id="pivot-totals">
          Totals
        </span>
        <div className={s.checks}>
          {(
            [
              ['rows', 'Total column'],
              ['columns', 'Total row'],
              ['grand', 'Grand total'],
            ] as const
          ).map(([key, text]) => (
            <Checkbox key={key} label={text} checked={pivot.totals[key]} onCheckedChange={(on) => onChange({ ...pivot, totals: { ...pivot.totals, [key]: on } })} />
          ))}
        </div>
      </div>

      <div className={b.row}>
        <span className={b.label}>Sort</span>
        <div className={s.sortRow}>
          <span className={s.sortText}>{sortSummary(pivot.sort)}</span>
          {pivot.sort && (
            <IconButton
              icon="x"
              size="sm"
              label="Clear the sort"
              onClick={() => {
                const { sort: _gone, ...rest } = pivot;
                onChange(rest);
              }}
            />
          )}
        </div>
        <p className={b.note}>Click a column header in the grid to sort by it.</p>
      </div>

      <div className={b.row}>
        <Input
          label="Top N"
          size="sm"
          type="number"
          min={1}
          placeholder="all"
          aria-label="Keep only the top N of the first row dimension"
          value={pivot.topN ? String(pivot.topN.n) : ''}
          onChange={(e) => {
            const n = Math.floor(Number(e.target.value));
            const { topN: _gone, ...rest } = pivot;
            onChange(Number.isInteger(n) && n > 0 ? { ...rest, topN: { n, byValueIdx: 0 } } : rest);
          }}
        />
      </div>

      <div className={b.row} role="group" aria-labelledby="pivot-cond">
        <span className={b.label} id="pivot-cond">
          Formatting
        </span>
        {pivot.values.length === 0 ? (
          <p className={s.empty}>Add a value to format it</p>
        ) : (
          pivot.values.map((v, i) => {
            const rule = pivot.conditional?.find((c) => c.valueIdx === i);
            const set = (next: { kind: string; threshold?: number } | null) => {
              const rest = (pivot.conditional ?? []).filter((c) => c.valueIdx !== i);
              const all = next ? [...rest, { valueIdx: i, ...next }].sort((a, x) => a.valueIdx - x.valueIdx) : rest;
              const { conditional: _gone, ...base } = pivot;
              onChange(all.length ? { ...base, conditional: all } : base);
            };
            return (
              <div key={`${v.column}:${i}`} className={s.condRow}>
                <span className={s.condName} title={v.column}>
                  {v.column}
                </span>
                <div className={s.condPick}>
                  <Select
                    size="sm"
                    aria-label={`Conditional formatting for ${v.column}`}
                    value={rule?.kind ?? ''}
                    options={COND}
                    onValueChange={(k) => set(k ? { kind: k, ...(k === 'threshold' ? { threshold: rule?.threshold ?? 0 } : {}) } : null)}
                  />
                </div>
                {rule?.kind === 'threshold' && (
                  <Input
                    size="sm"
                    type="number"
                    className={s.threshold}
                    aria-label={`Threshold for ${v.column}`}
                    value={String(rule.threshold ?? 0)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      set({ kind: 'threshold', threshold: Number.isFinite(n) ? n : 0 });
                    }}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
