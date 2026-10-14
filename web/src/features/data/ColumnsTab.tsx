// The dataset page's Columns tab (catalogPage.ts ctPaintColumnsTab): the column
// docs as a table edited in place. A cell reads as text until it is focused
// and saves on blur or Enter; sensitivity saves on pick. Display names and
// descriptions show wherever the column is named (the grid's header tooltip).
// "Also called" is the other names people ask for the column by: the Assistant
// resolves a question written in one (src/ai/answerSpec.ts), and the server
// refuses a name another column already answers to — said at the field.
// A viewer of the project reads every note and changes none.

import { useId, useRef, useState } from 'react';
import type { DatasetColumns } from '../../api/datasets';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { useColumnDocs, useStats, useWrite, type ColumnDoc } from './api';
import { useLiveSchema } from './liveApi';
import { useCanEdit } from '../projects/api';
import { SENSITIVITY } from './Details';
import s from './Data.module.css';

type Patch = Pick<ColumnDoc, 'displayName' | 'description' | 'example' | 'sensitivity'>;

/** The server's bounds on an "Also called" list (src/app/columnNames.ts), said at the field instead of sent to be refused. */
const MAX_NAMES = 8;
const MAX_NAME_LEN = 60;
const ALSO_CALLED_HELP = 'Other names people use for this column. The Assistant understands them in questions.';

const namesOf = (text: string): string[] => text.split(',').map((n) => n.trim()).filter(Boolean);

/**
 * A column's "Also called" names: one comma-separated line, saved on blur or
 * Enter like every cell here. What it shows after a save is what the SERVER
 * stored (trimmed, repeats gone), and a refusal — a name another column
 * already answers to — is the server's sentence under the field, which keeps
 * what was typed so it can be put right.
 */
function AlsoCalled({ projectId, datasetId, column, names, helpId, readOnly }: { projectId: string; datasetId: string; column: string; names: string[]; helpId: string; readOnly: boolean }) {
  const [saved, setSaved] = useState(names.join(', '));
  const [v, setV] = useState(saved);
  const [problem, setProblem] = useState('');
  /** The line last sent: Enter and the blur after it are one save, and a refused line is not sent again until the field is come back to. */
  const sent = useRef<string | null>(null);
  const errorId = useId();
  const save = useWrite('catalog:setColumn', ['catalog:columns'], {
    quiet: true, // the refusal belongs at the field, not in a toast
    onDone: (r: { ok?: boolean; error?: string; column?: ColumnDoc }) => {
      if (!r.ok || !r.column) return setProblem(r.error || 'These names could not be saved.');
      const stored = (r.column.aliases ?? []).join(', ');
      setSaved(stored);
      setV((cur) => (namesOf(cur).join(', ') === sent.current ? stored : cur)); // not over what was typed while it saved
      setProblem('');
    },
  });
  const commit = () => {
    const next = namesOf(v);
    const line = next.join(', ');
    if (line === saved) {
      sent.current = null;
      setV(saved);
      return setProblem('');
    }
    if (line === sent.current && !save.isError) return;
    if (next.length > MAX_NAMES) return setProblem(`A column can have at most ${MAX_NAMES} other names.`);
    if (next.some((n) => n.length > MAX_NAME_LEN)) return setProblem(`A name can be at most ${MAX_NAME_LEN} characters.`);
    sent.current = line;
    save.mutate({ projectId, datasetId, column, patch: { aliases: next } });
  };
  return (
    <>
      <input
        className={s.cellInput}
        type="text"
        value={v}
        title={v || undefined /* the cell is narrower than eight names */}
        readOnly={readOnly}
        placeholder={readOnly ? '—' : 'Add names'}
        aria-label={`Also called, for ${column}`}
        aria-describedby={problem ? `${helpId} ${errorId}` : helpId}
        aria-invalid={problem ? true : undefined}
        aria-busy={save.isPending || undefined}
        onChange={(e) => setV(e.target.value)}
        // Come back to: the column that had the name may have let it go, so a refused line may be sent again.
        onFocus={() => {
          if (!save.isPending) sent.current = null;
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())}
      />
      {problem && (
        <span className={s.rowError} id={errorId} role="alert">
          {problem}
        </span>
      )}
    </>
  );
}

function Cell({ value, placeholder, label, multiline, readOnly, onSave }: { value: string; placeholder: string; label: string; multiline?: boolean; readOnly?: boolean; onSave: (v: string, refused: () => void) => void }) {
  const [v, setV] = useState(value);
  const [saved, setSaved] = useState(value);
  const commit = () => {
    const next = v.trim();
    if (next === saved) return;
    setSaved(next);
    // A refused write is not the saved one: the cell goes back to what is stored, and the toast says why.
    onSave(next, () => {
      setSaved(saved);
      setV(saved);
    });
  };
  const common = {
    className: s.cellInput,
    value: v,
    placeholder,
    readOnly,
    'aria-label': label,
    onBlur: commit,
  };
  return multiline ? (
    <textarea {...common} rows={1} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), commit())} />
  ) : (
    <input {...common} type="text" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())} />
  );
}

export function ColumnsTab({ projectId, datasetId, header, live }: { projectId: string; datasetId: string; header: DatasetColumns; live?: boolean }) {
  const docs = useColumnDocs(projectId, datasetId);
  // An example placeholder: the most common value — on a Live dataset, the schema sync's sample (it keeps no rows to count).
  const stats = useStats(projectId, live ? '' : datasetId, !live);
  const schema = useLiveSchema(projectId, datasetId, !!live);
  const save = useWrite('catalog:setColumn', ['catalog:columns']);
  // The notes are an editor's to change; a viewer reads them (false until the roles are known).
  const canEdit = useCanEdit(projectId);
  const helpId = useId();
  if (header.columns.length === 0) {
    return (
      <EmptyState icon="table" heading={3} title="No columns">
        This dataset has no columns to document.
      </EmptyState>
    );
  }
  if (docs.isPending) return <SkeletonTable cols={7} rows={Math.min(8, header.columns.length)} label="Loading the column notes" />;
  if (docs.isError) return <ErrorState heading={3} title="The column notes could not be loaded" message={docs.error.message} onRetry={() => void docs.refetch()} />;
  const all = docs.data;
  const doc = (name: string): ColumnDoc => (Object.prototype.hasOwnProperty.call(all, name) ? all[name] : {});
  // Per write, not per observer: a refusal (a display name another column is also called) reaches the cell that asked.
  const patch = (column: string, p: Patch, refused?: () => void) =>
    void save.mutateAsync({ projectId, datasetId, column, patch: p }).then((r) => r?.ok === false && refused?.(), () => undefined);
  return (
    <section className={s.section} aria-label="Column notes">
      <p className={s.lead}>
        Descriptions show as tooltips wherever a column is named, and a display name replaces the raw one in pickers. Mark a
        column personal or financial so exports and reports can say so.
      </p>
      <p className={s.lead} id={helpId}>
        <span className={s.strong}>Also called</span> — {ALSO_CALLED_HELP} Separate names with commas.
      </p>
      <div className={s.card}>
        <table className={`${s.table} ${s.docTable}`}>
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col">Type</th>
              <th scope="col">Display name</th>
              <th scope="col">Also called</th>
              <th scope="col">Description</th>
              <th scope="col">Example</th>
              <th scope="col">Sensitivity</th>
            </tr>
          </thead>
          <tbody>
            {header.columns.map((c, i) => {
              const d = doc(c.name);
              const common = live ? schema.data?.columns.find((x) => x.name === c.name)?.values[0] : stats.data?.summaries[i]?.mostCommon?.value;
              return (
                <tr key={c.name} data-column={c.name}>
                  <td className={s.strong}>{c.name}</td>
                  <td>
                    <span className={s.typeChip}>{c.type}</span>
                  </td>
                  <td>
                    <Cell readOnly={!canEdit} value={d.displayName ?? ''} placeholder={c.name} label={`Display name of ${c.name}`} onSave={(v, no) => patch(c.name, { displayName: v }, no)} />
                  </td>
                  <td>
                    <AlsoCalled projectId={projectId} datasetId={datasetId} column={c.name} names={d.aliases ?? []} helpId={helpId} readOnly={!canEdit} />
                  </td>
                  <td>
                    <Cell multiline readOnly={!canEdit} value={d.description ?? ''} placeholder={canEdit ? 'Add a description' : '—'} label={`Description of ${c.name}`} onSave={(v, no) => patch(c.name, { description: v }, no)} />
                  </td>
                  <td>
                    <Cell readOnly={!canEdit} value={d.example ?? ''} placeholder={common || '—'} label={`Example of ${c.name}`} onSave={(v, no) => patch(c.name, { example: v }, no)} />
                  </td>
                  <td>
                    <Select
                      size="sm"
                      disabled={!canEdit}
                      aria-label={`Sensitivity of ${c.name}`}
                      value={d.sensitivity ?? 'none'}
                      options={SENSITIVITY}
                      onValueChange={(v) => patch(c.name, { sensitivity: v as ColumnDoc['sensitivity'] })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
