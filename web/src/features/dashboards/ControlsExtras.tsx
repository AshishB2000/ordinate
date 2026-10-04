// Two pieces of the desktop's control bar and filter toolbar that T2.8 left
// out (legacy dashControls.ts resetAllControls / updateResetControlsBtn, and
// dashFiltersUi.ts handleDashCategory / handleDashPeriod):
//
//   Reset controls   every control back to what the AUTHOR published (its
//                    default, or All when it has none), every parameter to its
//                    saved value. Shown only when something is off its default
//                    AND a default exists to go back to — otherwise it is the
//                    bar's "Clear all" under another name.
//   Category / Period  a one-value dashboard filter in two picks: a column of
//                    the dataset (date columns for Period), then one of its
//                    values. Saved with the record, like any dashboard filter;
//                    a filter already on that column is replaced.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Select } from '../../ui/Select';
import type { Card, Step } from '../analyses/api';
import { allControls } from '../analyses/editor/doc';
import { useEditor, type EditorApi } from '../analyses/editor/context';
import s from './Dashboards.module.css';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A control at what its author published (dashControls.ts controlIsAtDefault). */
function atDefault(ed: EditorApi, c: Card): boolean {
  const ctl = c.control;
  if (!ctl) return true;
  if (ctl.kind === 'parameter') {
    const p = ed.doc.parameters.find((x) => x.id === ctl.paramId);
    return !p || same(ed.paramValue(p.id), p.value);
  }
  return same(ed.controlValue(c.id), ctl.default);
}

export function ResetControls() {
  const ed = useEditor();
  const controls = allControls(ed.doc);
  const show = controls.some((c) => !atDefault(ed, c)) && controls.some((c) => !!c.control?.default || c.control?.kind === 'parameter');
  if (!show) return null;
  const reset = () => {
    for (const c of controls) {
      if (c.control?.kind === 'parameter') {
        const p = ed.doc.parameters.find((x) => x.id === c.control?.paramId);
        if (p) ed.setParam(p.id, p.value);
      } else ed.setControl(c.id, c.control?.default);
    }
  };
  return (
    <Button size="sm" variant="ghost" icon="rotate-ccw" onClick={reset} title="Every control back to what the dashboard’s author set">
      Reset controls
    </Button>
  );
}

/** Replace a filter on the same column, else add it (dashFiltersUi.ts upsertDashFilter). */
export function upsertFilter(filters: readonly Step[], step: Step): Step[] {
  const at = filters.findIndex((f) => f.column === step.column);
  return at >= 0 ? filters.map((f, i) => (i === at ? step : f)) : [...filters, step];
}

function QuickDialog({ kind, datasetId, cols, onClose }: { kind: 'category' | 'period'; datasetId: string; cols: { name: string; type: string }[]; onClose: () => void }) {
  const ed = useEditor();
  // Period: date columns, or every column when the dataset has none (the desktop's fallback).
  const dates = cols.filter((c) => c.type === 'date');
  const choices = kind === 'period' && dates.length ? dates : cols;
  const [column, setColumn] = useState<string | null>(choices[0]?.name ?? null);
  const [value, setValue] = useState<string | null>(null);
  const values = useQuery({
    queryKey: ['dataset:distinct', ed.projectId, datasetId, column, ''],
    enabled: !!column,
    queryFn: async () => (await rpc('dataset:distinct', { projectId: ed.projectId, datasetId, column: column as string, limit: 200 })) as { values: unknown[]; total: number },
  });
  const opts = (values.data?.values ?? []).filter((v) => v != null && String(v).trim() !== '').map((v) => ({ value: String(v), label: String(v) }));
  const title = kind === 'period' ? 'Period: pick a value' : 'Category: pick a value';
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description="A dashboard filter on one value. It replaces any filter already on that column."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!column || value === null}
            onClick={() => {
              ed.edit(kind === 'period' ? 'Set period filter' : 'Set category filter', (d) => void (d.filters = upsertFilter(d.filters, { type: 'filter', column: column as string, op: '=', value })));
              onClose();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <Select
        label="Column"
        value={column}
        onValueChange={(c) => {
          setColumn(c);
          setValue(null);
        }}
        options={choices.map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))}
      />
      <Select
        label="Value"
        value={value}
        placeholder={values.isPending ? 'Loading…' : opts.length ? 'Pick a value' : 'This column has no values'}
        disabled={!opts.length}
        onValueChange={setValue}
        options={opts}
      />
    </Dialog>
  );
}

/** "Category…" / "Period…" in the dashboard-filters flyout. */
export function QuickFilters({ datasetId, cols }: { datasetId: string; cols: { name: string; type: string }[] }) {
  const [open, setOpen] = useState<'category' | 'period' | null>(null);
  if (!datasetId || !cols.length) return null;
  return (
    <>
      <div className={s.quickRow} role="group" aria-label="Quick filters">
        <Button size="sm" icon="filter" onClick={() => setOpen('category')}>
          Category…
        </Button>
        <Button size="sm" icon="calendar" onClick={() => setOpen('period')}>
          Period…
        </Button>
      </div>
      {open && <QuickDialog kind={open} datasetId={datasetId} cols={cols} onClose={() => setOpen(null)} />}
    </>
  );
}
