// A text column's VALUE LABELS (semantic layer PR 06, D6): what each stored value is called ("EU" is "Europe").
// Charts, filter pickers, captions and the Assistant say the label; every filter, click and drill still uses the
// stored value. An editor fills the list from the column's own values (`dataset:distinct`) or adds a value by hand,
// and the server's rules are said here, in its own sentences, before a save it would refuse (a value listed twice,
// one label on two values, more than 500, a blank or over-long value): over HTTP those would be a bare 400. A row
// with no label is left out. A viewer reads the list. The Columns tab's "Value labels" cell opens it.

import { useState } from 'react';
import { formatNumber } from '../../../../src/app/format.ts';
import { MAX_LABEL_LEN, MAX_VALUE_LABELS, MAX_VALUE_LEN, valueLabelProblem, type ValueLabel, type ValueLabelProblem } from '../../../../src/analysis/valueLabels.ts';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState } from '../../ui/States';
import { distinctValues } from '../live/distinct';
import { useWrite } from './api';
import d from './Data.module.css';
import s from './ValueLabels.module.css';

/** Every screen that draws a label, by the key its answer is cached under (ruling F21): a save refreshes them all. */
export const LABEL_DRAWN_BY = ['catalog:columns', 'visual:data', 'analysis:tile', 'visual:thumbs', 'visual:preview', 'explore:answer', 'answer:card', 'dataset:distinct', 'report:preview', 'story:figures', 'subscription:preview'] as const;

/** The most values "Fill from the data" asks for: the `dataset:distinct` contract's cap. */
const FILL_LIMIT = 200;

/** The server's sentence for each refusal (src/analysis/valueLabelMessages.ts; the test pins them to src/i18n/en.json). */
export function problemText(p: ValueLabelProblem): string {
  switch (p.kind) {
    case 'repeatValue':
      return `“${p.value}” is listed twice.`;
    case 'sharedLabel':
      return `“${p.label}” would name both “${p.values[0]}” and “${p.values[1]}”. A label can name one value only.`;
    case 'tooMany':
      return `A column can have at most ${MAX_VALUE_LABELS} value labels.`;
    case 'blankValue':
      return 'A value cannot be blank.';
    case 'valueTooLong':
      return `A value can have at most ${MAX_VALUE_LEN} characters.`;
    case 'emptyLabel':
      return `“${p.value}” needs a label.`;
  }
}

/** A row of the dialog. `fixed`: a value the column holds (stored, or filled from the data), shown as it is stored. */
interface Row {
  id: number;
  value: string;
  label: string;
  fixed: boolean;
}

let nextId = 0;
const rowOf = (value: string, label: string, fixed: boolean): Row => ({ id: ++nextId, value, label, fixed });
/** What a save sends: the labelled rows, each label trimmed (the server trims it too), each value exactly as it is. */
const listOf = (rows: Row[]): ValueLabel[] => rows.filter((r) => r.label.trim() !== '').map((r) => ({ value: r.value, label: r.label.trim() }));
const countText = (n: number) => `${formatNumber(n)} label${n === 1 ? '' : 's'}`;

export function ValueLabelsDialog({ projectId, datasetId, column, values, readOnly, onClose }: { projectId: string; datasetId: string; column: string; values: ValueLabel[]; readOnly: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => values.map((v) => rowOf(v.value, v.label, true)));
  const [filling, setFilling] = useState(false);
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState('');
  const save = useWrite('catalog:setColumn', LABEL_DRAWN_BY, { quiet: true }); // a refusal is said in the dialog, not a toast

  const list = listOf(rows);
  const problem = valueLabelProblem(list);
  const changed = JSON.stringify(list) !== JSON.stringify(values);
  const said = problem ? problemText(problem) : refusal;
  const edit = (next: Row[]) => {
    setRows(next);
    setRefusal('');
  };
  const change = (id: number, patch: Partial<Row>) => edit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const fill = async () => {
    setFilling(true);
    setNote('');
    setRefusal('');
    try {
      const r = await distinctValues({ projectId, datasetId, column, limit: FILL_LIMIT });
      const listed = new Set(rows.map((x) => x.value));
      const added = r.values.filter((v) => v !== '' && !listed.has(v));
      setRows((now) => [...now, ...added.map((v) => rowOf(v, '', true))]);
      const sample = r.approximate ? ` From a sample of ${formatNumber(r.sampleRows ?? 0)} rows: the warehouse may hold others.` : '';
      const capped = r.total > r.values.length ? ` The data has ${formatNumber(r.total)}; these are the first ${formatNumber(r.values.length)}. Add the others by hand.` : '';
      setNote(added.length ? `Added ${formatNumber(added.length)} value${added.length === 1 ? '' : 's'}.${capped}${sample} Give each a label; a row with no label is left out.` : `Every value the data lists is already here.${capped}`);
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : String(err)); // a Live column with no list: the server's own sentence
    } finally {
      setFilling(false);
    }
  };
  const submit = async () => {
    const r = (await save.mutateAsync({ projectId, datasetId, column, patch: { values: list } }).catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (r?.ok) onClose();
    else if (r) setRefusal(r.error || 'The labels could not be saved.');
  };

  const tools = (first: boolean) => (
    <>
      <Button size="sm" icon="database" variant={first ? 'primary' : 'secondary'} loading={filling} onClick={() => void fill()}>
        Fill from the data
      </Button>
      <Button size="sm" icon="plus" variant="ghost" onClick={() => edit([...rows, rowOf('', '', false)])}>
        Add a value
      </Button>
    </>
  );
  const body = rows.length ? (
    <div className={s.list}>
      <table className={`${d.table} ${s.table}`}>
        <thead>
          <tr>
            <th scope="col">Stored value</th>
            <th scope="col">Label</th>
            {!readOnly && (
              <th scope="col" className={d.actions}>
                <span className={s.hidden}>Remove</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const name = r.value || 'the new value';
            return (
              <tr key={r.id}>
                <td className={s.value}>
                  {r.fixed || readOnly ? (
                    <code title={r.value}>{r.value === '' ? '(blank)' : r.value}</code>
                  ) : (
                    <input className={`${d.cellInput} ${s.mono}`} aria-label="New value" placeholder="As stored, exactly" value={r.value} onChange={(e) => change(r.id, { value: e.target.value })} />
                  )}
                </td>
                <td>
                  {readOnly ? (
                    r.label
                  ) : (
                    <input className={d.cellInput} aria-label={`Label for ${name}`} placeholder="No label: left out" maxLength={MAX_LABEL_LEN} value={r.label} onChange={(e) => change(r.id, { label: e.target.value })} />
                  )}
                </td>
                {!readOnly && (
                  <td className={d.actions}>
                    <IconButton icon="x" size="sm" label={`Remove ${name}`} onClick={() => edit(rows.filter((x) => x.id !== r.id))} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : filling ? null : (
    <EmptyState icon="list" heading={3} title="No labels yet" actions={!readOnly && tools(true)} compact>
      Fill them from the data, or add a value by hand. Charts, filters and the Assistant then show the label; every filter still uses the stored value.
    </EmptyState>
  );

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={`Value labels of ${column}`}
      description={readOnly ? 'What each stored value of this column is called.' : 'Say what each stored value means. Charts, filter pickers and the Assistant show the label; filters still use the stored value.'}
      footer={
        readOnly ? (
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" loading={save.isPending} disabled={!changed || !!problem} onClick={() => void submit()}>
              Save
            </Button>
          </>
        )
      }
    >
      {!readOnly && rows.length > 0 && (
        <div className={s.tools}>
          {tools(false)}
          <span className={s.hint}>{`${countText(list.length)} of ${formatNumber(rows.length)} rows`}</span>
        </div>
      )}
      {body}
      {filling && <SkeletonRows rows={4} label="Reading the column's values" />}
      {said && (
        <p className={s.alert} role="alert">
          {said}
        </p>
      )}
      <p className={s.note} role="status">
        {note}
      </p>
    </Dialog>
  );
}

/** The Columns tab's cell on a text column: how many labels, a button that opens them; a viewer with none sees a dash. */
export function ValueLabelsCell({ projectId, datasetId, column, values, canEdit }: { projectId: string; datasetId: string; column: string; values: ValueLabel[] | undefined; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const n = values?.length ?? 0;
  if (!n && !canEdit) {
    return (
      <span className={s.none}>
        <span aria-hidden="true">—</span>
        <span className={s.hidden}>No value labels</span>
      </span>
    );
  }
  const text = n ? countText(n) : 'Add labels';
  return (
    <>
      <Button size="sm" variant="ghost" icon={n ? 'list' : 'plus'} aria-label={`Value labels of ${column}: ${text}`} onClick={() => setOpen(true)}>
        {text}
      </Button>
      {open && <ValueLabelsDialog projectId={projectId} datasetId={datasetId} column={column} values={values ?? []} readOnly={!canEdit} onClose={() => setOpen(false)} />}
    </>
  );
}
