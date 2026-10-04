// The original eight steps' forms and the three mask steps (legacy
// prepareForms.ts buildStepForm + prepareMask.ts pvBuildMaskForm), and the
// segment step's rename. Each is a view over its draft; ./drafts.ts decides
// whether Save can send it.

import { Button } from '../../ui/Button';
import { formatNumber } from '../../../../src/app/format.ts';
import { AGG_FNS, FILTER_OPS, isListOp, isValuelessOp } from './steps';
import { arr, ColumnSelect, Hint, NameChecks, PickSelect, RowLine, str, TextField, type FormProps } from './FormParts';
import s from './Prepare.module.css';

export function FilterForm({ draft, set, ctx }: FormProps) {
  const op = str(draft.op) || '=';
  return (
    <>
      <ColumnSelect label="Column" value={str(draft.column)} columns={ctx.columns} onChange={(column) => set({ column, value: '', valuesText: '' })} />
      <PickSelect label="Condition" value={op} options={FILTER_OPS.map((o) => [o.op, o.label] as const)} onChange={(v) => set({ op: v })} />
      {isListOp(op) ? (
        <TextField label="Values (comma-separated)" value={draft.valuesText} onChange={(v) => set({ valuesText: v })} placeholder="East, West" />
      ) : (
        !isValuelessOp(op) && <TextField label="Value" value={draft.value} onChange={(v) => set({ value: v })} />
      )}
      <Hint>A filter keeps the rows that match. Where it sits in the pipeline does not change which rows it keeps.</Hint>
    </>
  );
}

export function GroupAggregateForm({ draft, set, ctx }: FormProps) {
  const names = ctx.columns.map((c) => c.name);
  const aggs = arr<Record<string, unknown>>(draft.aggregations);
  const put = (i: number, patch: Record<string, unknown>) => set({ aggregations: aggs.map((a, k) => (k === i ? { ...a, ...patch } : a)) });
  return (
    <>
      <NameChecks label="Group by" names={names} value={arr<string>(draft.groupBy)} onChange={(groupBy) => set({ groupBy })} />
      <div className={s.rules}>
        {aggs.map((a, i) => (
          <RowLine key={i} removeLabel="Remove aggregation" onRemove={() => set({ aggregations: aggs.filter((_, k) => k !== i) })}>
            <PickSelect ariaLabel="Aggregation" value={str(a.fn) || 'sum'} options={AGG_FNS.map((f) => [f, f] as const)} onChange={(fn) => put(i, { fn })} />
            <ColumnSelect ariaLabel="Column to aggregate" value={str(a.column)} columns={ctx.columns} onChange={(column) => put(i, { column })} />
            <TextField label="Output name" value={a.as} placeholder="output name" onChange={(as) => put(i, { as })} />
          </RowLine>
        ))}
      </div>
      <div>
        <Button size="sm" icon="plus" onClick={() => set({ aggregations: [...aggs, { fn: 'sum', column: '', as: '' }] })}>
          Add aggregation
        </Button>
      </div>
    </>
  );
}

export function DedupeForm({ draft, set, ctx }: FormProps) {
  return (
    <NameChecks
      label="Key columns (none checked = all columns)"
      names={ctx.columns.map((c) => c.name)}
      value={arr<string>(draft.columns)}
      onChange={(columns) => set({ columns })}
    />
  );
}

export function FillEmptyForm({ draft, set, ctx }: FormProps) {
  return (
    <>
      <ColumnSelect label="Column" value={str(draft.column)} columns={ctx.columns} onChange={(column) => set({ column })} />
      <TextField label="Fill empty cells with" value={draft.value} onChange={(value) => set({ value })} />
    </>
  );
}

export function TrimForm({ draft, set, ctx }: FormProps) {
  return <ColumnSelect label="Column" value={str(draft.column)} columns={ctx.columns} blank="(all text columns)" onChange={(column) => set({ column })} />;
}

export function DropForm({ draft, set, ctx }: FormProps) {
  return <ColumnSelect label="Column" value={str(draft.column)} columns={ctx.columns} onChange={(column) => set({ column })} />;
}

export function RenameForm({ draft, set, ctx }: FormProps) {
  return (
    <>
      <ColumnSelect label="Rename" value={str(draft.from)} columns={ctx.columns} onChange={(from) => set({ from })} />
      <TextField label="To" value={draft.to} onChange={(to) => set({ to })} />
    </>
  );
}

const SAMPLE = '4111111111111234';

export function MaskForm({ draft, set, ctx }: FormProps) {
  const type = str(draft.type);
  const column = <ColumnSelect label="Column" value={str(draft.column)} columns={ctx.columns} onChange={(c) => set({ column: c })} />;
  if (type === 'mask_hash') {
    return (
      <>
        {column}
        <Hint>
          Each value becomes a short token like #3f9a0c21b7d4 — the same token for the same value everywhere in this project, so counts, joins and
          groupings still work. The key that makes the tokens stays with this project on the server and never leaves it.
        </Hint>
      </>
    );
  }
  if (type === 'mask_redact') {
    const k = Math.max(0, Math.min(8, Math.floor(Number(draft.keep) || 0)));
    return (
      <>
        {column}
        <TextField label="Characters to keep" type="number" min={0} max={8} value={draft.keep} onChange={(keep) => set({ keep })} />
        <Hint>{k > 0 ? `${SAMPLE} becomes •••${SAMPLE.slice(-k)}. A value no longer than ${k} characters is hidden whole.` : 'Every value becomes •••.'}</Hint>
      </>
    );
  }
  const mode = str(draft.mode) || 'bucket';
  const size = Number(draft.size);
  return (
    <>
      {column}
      <PickSelect
        label="Generalise"
        value={mode}
        options={[
          ['bucket', 'Bucket numbers'],
          ['month', 'Truncate dates to the month'],
          ['domain', 'Keep only the email domain'],
        ]}
        onChange={(m) => set({ mode: m })}
      />
      {mode === 'bucket' && <TextField label="Bucket size" type="number" min={0} value={draft.size} onChange={(v) => set({ size: v })} />}
      <Hint>
        {mode === 'month'
          ? '2024-03-17 becomes 2024-03. Values that are not dates are cleared.'
          : mode === 'domain'
            ? 'jane@example.com becomes @example.com. Values that are not email addresses are cleared.'
            : `Each number is rounded down to the start of its bucket of ${size > 0 ? formatNumber(size) : 10}. The column stays a number column.`}
      </Hint>
    </>
  );
}

/** A segment step's model is the fit's (the Segments workbench); only its column's name changes here. */
export function SegmentForm({ draft, set }: FormProps) {
  return (
    <>
      <TextField label="Column" value={draft.column} onChange={(column) => set({ column })} />
      <Hint>Segments: {arr<string>(draft.names).join(', ') || '—'}</Hint>
    </>
  );
}
