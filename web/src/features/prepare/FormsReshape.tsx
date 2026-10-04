// Power-step forms, RESHAPE family — split column, unpivot, pivot, window
// (legacy prepareReshape.ts). Views over a draft; ./drafts.ts builds the step.

import { Checkbox } from '../../ui/Choice';
import { AGG_FNS, WINDOW_FNS } from './steps';
import { arr, ColumnSelect, Hint, NameChecks, PickSelect, str, TextField, type FormProps } from './FormParts';

export function SplitForm({ draft, set, ctx }: FormProps) {
  const mode = str(draft.mode) || 'delimiter';
  const into = str(draft.into) || 'columns';
  const col = str(draft.column) || 'column';
  return (
    <>
      <ColumnSelect label="Column" value={str(draft.column)} columns={ctx.columns} onChange={(column) => set({ column })} />
      <PickSelect label="Split by" value={mode} options={[['delimiter', 'delimiter'], ['position', 'position'], ['regex', 'regex']]} onChange={(m) => set({ mode: m })} />
      {mode === 'delimiter' && <TextField label="Delimiter" value={draft.delimiter} onChange={(delimiter) => set({ delimiter })} />}
      {mode === 'position' && (
        <TextField label="Cut at positions" value={draft.positionsText} placeholder="e.g. 3, 5 — character positions to cut at" onChange={(positionsText) => set({ positionsText })} />
      )}
      {mode === 'regex' && (
        <>
          <TextField label="Pattern (no lookaround or backreferences)" value={draft.pattern} placeholder="e.g. [,;]\s*" onChange={(pattern) => set({ pattern })} />
          <Checkbox label="Ignore case" checked={!!draft.ignoreCase} onCheckedChange={(ignoreCase) => set({ ignoreCase })} />
        </>
      )}
      <PickSelect label="Into" value={into} options={[['columns', 'columns'], ['rows', 'rows']]} onChange={(v) => set({ into: v })} />
      {into === 'columns' && mode !== 'position' && (
        <TextField label="How many columns (extra parts are dropped)" type="number" min={1} max={50} value={draft.count} onChange={(count) => set({ count })} />
      )}
      <Hint>{into === 'rows' ? 'Each part becomes its own row; the other columns repeat.' : `The parts replace the column as ${col}_1, ${col}_2, …`}</Hint>
    </>
  );
}

export function UnpivotForm({ draft, set, ctx }: FormProps) {
  return (
    <>
      <NameChecks label="Columns that become rows" names={ctx.columns.map((c) => c.name)} value={arr<string>(draft.columns)} onChange={(columns) => set({ columns })} />
      <TextField label="Name for the column-name column" value={draft.attribute} onChange={(attribute) => set({ attribute })} />
      <TextField label="Name for the value column" value={draft.value} onChange={(value) => set({ value })} />
    </>
  );
}

export function PivotForm({ draft, set, ctx }: FormProps) {
  return (
    <>
      <ColumnSelect label="Key column (its values become columns)" value={str(draft.key)} columns={ctx.columns} onChange={(key) => set({ key })} />
      <ColumnSelect label="Value column" value={str(draft.value)} columns={ctx.columns} onChange={(value) => set({ value })} />
      <PickSelect label="Aggregation" value={str(draft.fn) || 'sum'} options={AGG_FNS.map((f) => [f, f] as const)} onChange={(fn) => set({ fn })} />
      <NameChecks label="One row per" names={ctx.columns.map((c) => c.name)} value={arr<string>(draft.groupBy)} onChange={(groupBy) => set({ groupBy })} />
      <Hint>Each distinct value of the key column becomes a column (up to 100, in first-seen order).</Hint>
    </>
  );
}

export function WindowForm({ draft, set, ctx }: FormProps) {
  const fn = str(draft.fn) || 'row_number';
  return (
    <>
      <PickSelect label="Calculate" value={fn} options={WINDOW_FNS.map((w) => [w.fn, w.label] as const)} onChange={(v) => set({ fn: v })} />
      {fn !== 'row_number' && <ColumnSelect label="Value column" value={str(draft.column)} columns={ctx.columns} onChange={(column) => set({ column })} />}
      {(fn === 'lag' || fn === 'lead') && <TextField label="Rows back / ahead" type="number" min={1} value={draft.offset} onChange={(offset) => set({ offset })} />}
      <NameChecks label="Restart for each (partition)" names={ctx.columns.map((c) => c.name)} value={arr<string>(draft.partitionBy)} onChange={(partitionBy) => set({ partitionBy })} />
      <ColumnSelect label="Order by (ties keep the stored order)" value={str(draft.orderBy)} columns={ctx.columns} blank="(stored row order)" onChange={(orderBy) => set({ orderBy })} />
      <Checkbox label="Descending" checked={!!draft.desc} onCheckedChange={(desc) => set({ desc })} />
      <TextField label="New column" value={draft.as} placeholder="new column name" onChange={(as) => set({ as })} />
    </>
  );
}
