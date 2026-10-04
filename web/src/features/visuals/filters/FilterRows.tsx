// The encoding form's FILTERS block (encodingForm.ts renderFilters): one row per
// visual-level filter — the column (how a filter is retargeted), ONE control
// for the whole condition that opens the type-aware dialog, a "context" tag
// when it runs before LOD expressions, and a remove. A new row has no operator
// until the dialog gives it one, so it changes nothing on its own; rows are
// filtered BEFORE aggregation, on the server.

import { useState } from 'react';
import { Button, IconButton } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import type { FilterStep } from '../api';
import type { Column } from '../model';
import { FilterDialog } from './FilterDialog';
import { stepSummary } from './filterText';
import { usePeriodPicker, type PeriodSpec } from './PeriodPanel';
import s from './Filters.module.css';

function Summary({ step }: { step: FilterStep }) {
  const period = step.op === 'period' ? ((step.period as PeriodSpec) ?? null) : null;
  const q = usePeriodPicker(period);
  return <>{stepSummary(step, q.data?.current?.label) || 'Set a condition…'}</>;
}

export function FilterRows({
  projectId,
  datasetId,
  cols,
  filters,
  onChange,
}: {
  projectId: string;
  datasetId: string;
  cols: readonly Column[];
  filters: FilterStep[];
  onChange: (next: FilterStep[]) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const cur = editing === null ? null : filters[editing];
  return (
    <div className={s.rows} role="group" aria-labelledby="enc-filters">
      <span className={s.head} id="enc-filters">
        Filters
      </span>
      {filters.map((f, i) => (
        <div key={i} className={s.row}>
          <div className={s.col}>
            <Select
              aria-label="Filter column"
              size="sm"
              value={f.column}
              options={cols.map((c) => ({ value: c.name, label: c.name }))}
              // Another column makes the old operand meaningless: the row goes inert until set again.
              onValueChange={(c) => onChange(filters.map((x, j) => (j === i ? { type: 'filter', column: c, op: '' } : x)))}
            />
          </div>
          <button type="button" className={s.cond} aria-label={`Edit the filter on ${f.column || 'this column'}`} onClick={() => setEditing(i)}>
            <Summary step={f} />
          </button>
          {f.context === true && (
            <span className={s.ctx} title="Applied before LOD expressions">
              context
            </span>
          )}
          <IconButton icon="x" size="sm" label="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" icon="plus" className={s.add} disabled={!cols.length} onClick={() => onChange([...filters, { type: 'filter', column: cols[0]?.name ?? '', op: '' }])}>
        Add filter
      </Button>
      {cur && editing !== null && (
        <FilterDialog
          projectId={projectId}
          datasetId={datasetId}
          column={cur.column}
          type={cols.find((c) => c.name === cur.column)?.type ?? 'text'}
          existing={cur}
          lodToggle
          onClose={() => setEditing(null)}
          // A min/max range is TWO steps: splice them in place, each editable and removable on its own.
          onApply={(steps) => {
            onChange([...filters.slice(0, editing), ...steps, ...filters.slice(editing + 1)]);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
