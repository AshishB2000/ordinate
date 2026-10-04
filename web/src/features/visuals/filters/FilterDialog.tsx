// ONE filter dialog, adapting to the column's DECLARED type (filterDialog.ts):
//
//   text   → a checkbox list of the column's real distinct values, searched IN
//            SQL on the server (`dataset:distinct`, capped pages), Select all
//            shown / Clear / Exclude; or a Condition (contains, =, is empty…)
//   number → a min / max Range (two AND-ed steps), or a Condition
//   date   → a Range (a date picker only when the stored values are ISO — a
//            textual comparison otherwise, and the dialog says so), or a
//            Relative period stored as its preset
//
// Truncation is never silent: past the page, the list says "Showing the first
// 200 of 4,812". Apply is disabled while it would produce nothing. Resolves the
// steps to apply (0–2), or null when cancelled.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { Checkbox, Switch } from '../../../ui/Choice';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { SkeletonRows } from '../../../ui/Skeleton';
import type { FilterStep } from '../api';
import { isListOp, isValuelessOp } from './filterText';
import { PeriodPanel, type PeriodSpec } from './PeriodPanel';
import s from './Filters.module.css';

/** One page of the checkbox list; the cap is the server's too. */
const PAGE = 200;
const fmt = new Intl.NumberFormat();

type Mode = 'values' | 'cond' | 'range' | 'relative';

const TEXT_OPS = [
  { value: 'contains', label: 'contains' },
  { value: '=', label: 'equals' },
  { value: '!=', label: 'does not equal' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
];
const NUM_OPS = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'does not equal' },
  { value: '>', label: 'greater than' },
  { value: '<', label: 'less than' },
  { value: '>=', label: 'at least' },
  { value: '<=', label: 'at most' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
];

function useDistinct(projectId: string, datasetId: string, column: string, limit: number, search: string, enabled = true) {
  return useQuery({
    queryKey: ['dataset:distinct', projectId, datasetId, column, limit, search],
    queryFn: async () => (await rpc('dataset:distinct', { projectId, datasetId, column, limit, ...(search ? { search } : {}) })) as { values: string[]; total: number },
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function FilterDialog({
  projectId,
  datasetId,
  column,
  type: declared,
  existing,
  lodToggle,
  onClose,
  onApply,
}: {
  projectId: string;
  datasetId: string;
  column: string;
  type: string;
  existing?: FilterStep;
  lodToggle?: boolean;
  onClose: () => void;
  onApply: (steps: FilterStep[]) => void;
}) {
  const type = declared === 'number' || declared === 'date' ? declared : 'text';
  const ex = existing ?? ({ type: 'filter', column, op: '' } as FilterStep);
  const modes: { id: Mode; label: string }[] =
    type === 'number'
      ? [{ id: 'range', label: 'Range' }, { id: 'cond', label: 'Condition' }]
      : type === 'date'
        ? [{ id: 'range', label: 'Range' }, { id: 'relative', label: 'Relative' }]
        : [{ id: 'values', label: 'Values' }, { id: 'cond', label: 'Condition' }];
  const initialMode: Mode =
    ex.op === 'period' ? 'relative' : isListOp(ex.op) ? 'values' : ex.op && (type === 'text' || isValuelessOp(ex.op)) ? 'cond' : modes[0].id;
  const [mode, setMode] = useState<Mode>(initialMode);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(isListOp(ex.op) && Array.isArray(ex.values) ? ex.values.map((v) => (v == null ? '' : String(v))) : []));
  const [exclude, setExclude] = useState(ex.op === 'not in');
  const [condOp, setCondOp] = useState(!isListOp(ex.op) && ex.op && ex.op !== 'period' ? String(ex.op) : type === 'text' ? 'contains' : '>=');
  const [condVal, setCondVal] = useState(ex.value != null ? String(ex.value) : '');
  const [rangeMin, setRangeMin] = useState(ex.op === '>=' && ex.value != null ? String(ex.value) : '');
  const [rangeMax, setRangeMax] = useState(ex.op === '<=' && ex.value != null ? String(ex.value) : '');
  const [rel, setRel] = useState<PeriodSpec | null>(ex.op === 'period' && ex.period ? { ...(ex.period as PeriodSpec) } : null);
  const [context, setContext] = useState(ex.context === true);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(typed.trim()), 250); // the answer for "Cali" is worthless once "Calif" is typed
    return () => window.clearTimeout(t);
  }, [typed]);

  const list = useDistinct(projectId, datasetId, column, PAGE, search, mode === 'values');
  // One bounded peek decides which date input is honest: ISO strings compare as dates, anything else as text.
  const probe = useDistinct(projectId, datasetId, column, 20, '', type === 'date');
  const isoDates = !probe.data || probe.data.values.length === 0 || probe.data.values.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v));

  const ops = type === 'text' ? TEXT_OPS : NUM_OPS;
  const op = ops.some((o) => o.value === condOp) ? condOp : ops[0].value;
  const steps = ((): FilterStep[] => {
    const base = { type: 'filter' as const, column };
    if (mode === 'values') return selected.size ? [{ ...base, op: exclude ? 'not in' : 'in', values: [...selected] }] : [];
    if (mode === 'relative') return rel ? [{ ...base, op: 'period', period: rel }] : [];
    if (mode === 'range') {
      const out: FilterStep[] = [];
      if (rangeMin.trim()) out.push({ ...base, op: '>=', value: rangeMin.trim() });
      if (rangeMax.trim()) out.push({ ...base, op: '<=', value: rangeMax.trim() });
      return out;
    }
    if (isValuelessOp(op)) return [{ ...base, op }];
    return condVal.trim() ? [{ ...base, op, value: condVal }] : [];
  })();
  const apply = () => steps.length && onApply(lodToggle ? steps.map((x) => (context ? { ...x, context: true } : x)) : steps);

  const toggle = (v: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(v);
      else next.delete(v);
      return next;
    });
  const shown = list.data?.values ?? [];
  const total = list.data?.total ?? shown.length;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Filter: ${column}`}
      description={type === 'number' ? 'Number column' : type === 'date' ? 'Date column' : 'Text column'}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" disabled={!steps.length} onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <div className={s.tabs} role="tablist" aria-label="Filter kind">
        {modes.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} className={mode === m.id ? `${s.tab} ${s.tabOn}` : s.tab} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <div className={s.body}>
        {mode === 'values' && (
          <>
            <Input aria-label="Search values in this column" maxLength={200} placeholder="Search values…" icon="search" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <div className={s.bulk}>
              <Button size="sm" variant="ghost" onClick={() => setSelected((prev) => new Set([...prev, ...shown]))}>
                Select all shown
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
              <Checkbox label="Exclude these" checked={exclude} onCheckedChange={setExclude} />
            </div>
            <div className={s.list} role="group" aria-label={`Values of ${column}`}>
              {list.isPending ? (
                <SkeletonRows rows={5} label="Loading values" />
              ) : list.isError ? (
                <p className={s.empty}>The values could not be loaded: {list.error.message}</p>
              ) : shown.length === 0 ? (
                <p className={s.empty}>{search ? 'No values match that search.' : 'This column has no values to filter on.'}</p>
              ) : (
                shown.map((v) => <Checkbox key={v} label={v === '' ? '(empty)' : v} checked={selected.has(v)} onCheckedChange={(on) => toggle(v, on)} />)
              )}
            </div>
            <p className={s.note} role="status">
              {[total > shown.length ? `Showing the first ${fmt.format(shown.length)} of ${fmt.format(total)} values — search to narrow.` : '', selected.size ? `${selected.size} selected.` : '']
                .filter(Boolean)
                .join(' ')}
            </p>
          </>
        )}

        {mode === 'range' && (
          <>
            <div className={s.pair}>
              <Input label={type === 'date' ? 'From' : 'Minimum'} type={type === 'number' ? 'number' : type === 'date' && isoDates ? 'date' : 'text'} step="any" value={rangeMin} onChange={(e) => setRangeMin(e.target.value)} />
              <Input label={type === 'date' ? 'To' : 'Maximum'} type={type === 'number' ? 'number' : type === 'date' && isoDates ? 'date' : 'text'} step="any" value={rangeMax} onChange={(e) => setRangeMax(e.target.value)} />
            </div>
            <p className={s.note}>
              {type === 'date' && !isoDates
                ? 'These dates are not stored as YYYY-MM-DD, so they are compared as text. Type the value exactly as it appears in the data.'
                : 'Leave either box empty for an open-ended range. Both bounds are inclusive.'}
            </p>
          </>
        )}

        {mode === 'cond' && (
          <div className={s.pair}>
            <Select label="Condition" value={op} options={ops} onValueChange={setCondOp} />
            {!isValuelessOp(op) && <Input label="Value" type={type === 'number' ? 'number' : 'text'} step="any" value={condVal} onChange={(e) => setCondVal(e.target.value)} />}
          </div>
        )}

        {mode === 'relative' && <PeriodPanel value={rel} relativeOnly onChange={setRel} />}
      </div>

      {lodToggle && (
        <div className={s.lod}>
          <Switch
            label="Apply before LOD"
            hint={
              context
                ? 'Context filter: runs first, so FIXED, INCLUDE and EXCLUDE expressions only see the rows it keeps.'
                : 'Runs after LOD expressions, so a FIXED value — a region’s total — still counts every row.'
            }
            checked={context}
            onCheckedChange={setContext}
          />
        </div>
      )}
    </Dialog>
  );
}
