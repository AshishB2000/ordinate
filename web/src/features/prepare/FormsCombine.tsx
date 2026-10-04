// Power-step forms, COMBINE family — look up from another dataset, append
// another dataset (legacy prepareCombine.ts). The other dataset's columns come
// from `dataset:columns` (never its origin); the matched rate and the column
// match are counted by the server over the step's real input. A relationship in
// the project's data model between the two datasets prefills the lookup keys.

import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { useDatasetColumns, useDatasets, type DatasetColumns } from '../../api/datasets';
import { listRelationships, previewPower } from './api';
import { buildStep } from './drafts';
import { fmtN } from './steps';
import { arr, ColumnSelect, Hint, NameChecks, NameSelect, PreviewBox, str, TextField, usePreview, type FormCtx, type FormProps } from './FormParts';
import { Select } from '../../ui/Select';
import s from './Prepare.module.css';

/** The other datasets of the project, for the picker (the open one excluded). */
function DatasetPicker({ label, value, ctx, onPick }: { label: string; value: string; ctx: FormCtx; onPick: (id: string) => void }) {
  const list = useDatasets(ctx.projectId);
  const others = (list.data ?? []).filter((d) => d.id !== ctx.datasetId);
  const placeholder = list.isPending ? 'Loading datasets…' : others.length ? 'Choose a dataset…' : 'No other dataset in this project';
  return (
    <Select
      label={label}
      size="sm"
      value={value || null}
      placeholder={placeholder}
      onValueChange={onPick}
      options={others.map((d) => ({ value: d.id, label: d.name }))}
    />
  );
}

function usePowerPreview(type: string, draft: FormProps['draft'], ctx: FormCtx, probe?: (d: FormProps['draft']) => FormProps['draft']) {
  const built = buildStep(type, probe ? probe(draft) : draft, ctx.columns);
  const step = 'steps' in built ? built.steps[0] : null;
  return usePreview(step ? JSON.stringify(step) : null, () => previewPower(ctx.projectId, ctx.datasetId, ctx.index, step!));
}

export function LookupForm({ draft, set, ctx }: FormProps) {
  const datasetId = str(draft.datasetId);
  const other = useDatasetColumns(ctx.projectId, datasetId || undefined);
  const otherCols = (other.data?.columns ?? []).map((c) => c.name);
  const qc = useQueryClient();

  // A freshly picked dataset: keys from a relationship (either direction), else a same-named column.
  async function pick(id: string) {
    set({ datasetId: id, rightKey: '', columns: [], fromModel: false });
    const [cols, rels] = await Promise.all([
      qc.fetchQuery({ queryKey: ['dataset:columns', ctx.projectId, id], queryFn: () => rpc('dataset:columns', { projectId: ctx.projectId, id }) }) as Promise<DatasetColumns | null>,
      listRelationships(ctx.projectId).catch(() => null),
    ]);
    const names = (cols?.columns ?? []).map((c) => c.name);
    const rel = (rels?.relationships ?? []).find(
      (r) => (r.from.datasetId === ctx.datasetId && r.to.datasetId === id) || (r.to.datasetId === ctx.datasetId && r.from.datasetId === id),
    );
    const mine = rel ? (rel.from.datasetId === ctx.datasetId ? rel.from : rel.to) : null;
    const theirs = rel ? (rel.from.datasetId === ctx.datasetId ? rel.to : rel.from) : null;
    const left = mine?.column ?? str(draft.leftKey);
    const right = theirs?.column ?? (names.includes(left) ? left : '');
    set({ datasetId: id, leftKey: left, rightKey: right, columns: names.filter((c) => c !== right), fromModel: !!rel });
  }

  // Previewable before any column is chosen: the rate needs the keys only.
  const p = usePowerPreview('lookup_join', draft, ctx, (d) => (arr(d.columns).length ? d : { ...d, columns: [str(d.rightKey)] }));
  const l = p.data?.ok ? p.data.lookup : null;
  const notes = (p.data?.warnings ?? []).filter((w) => /skipped|already exists/.test(w));
  return (
    <>
      <DatasetPicker label="Look up in" value={datasetId} ctx={ctx} onPick={(id) => void pick(id)} />
      <ColumnSelect label="Key in this dataset" value={str(draft.leftKey)} columns={ctx.columns} onChange={(leftKey) => set({ leftKey })} />
      <NameSelect
        label="Matching key in the other dataset (one row per key)"
        value={str(draft.rightKey)}
        names={otherCols}
        blank="Choose the matching column…"
        onChange={(rightKey) => set({ rightKey })}
      />
      {!!draft.fromModel && <Hint>Keys taken from the relationship in the data model.</Hint>}
      <NameChecks label="Columns to bring across" names={otherCols} value={arr<string>(draft.columns)} onChange={(columns) => set({ columns })} />
      <TextField label="Prefix for the new columns" value={draft.prefix} placeholder="(optional) e.g. product_" onChange={(prefix) => set({ prefix })} />
      {datasetId && str(draft.leftKey) && str(draft.rightKey) && (
        <PreviewBox busy={p.busy} warn={!!l && (l.dupes > 0 || l.matched < l.total)}>
          {l ? (
            <>
              <div>
                {fmtN(l.matched)} of {fmtN(l.total)} rows matched · {l.ratePct}%
              </div>
              {l.dupes > 0 && <div>{fmtN(l.dupes)} key value(s) repeat in the other dataset — the first match in stored order is used.</div>}
              {notes.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </>
          ) : (
            <div>{p.error ?? (p.data && !p.data.ok ? p.data.error : 'Counting…')}</div>
          )}
        </PreviewBox>
      )}
    </>
  );
}

export function UnionForm({ draft, set, ctx }: FormProps) {
  const datasetId = str(draft.datasetId);
  const other = useDatasetColumns(ctx.projectId, datasetId || undefined);
  const otherCols = (other.data?.columns ?? []).map((c) => c.name);
  const mine = ctx.columns.map((c) => c.name);
  const spare = otherCols.filter((c) => !mine.includes(c));
  // One row per column of this dataset the other has no same-named column for.
  const unmatched = other.data ? mine.filter((c) => !otherCols.includes(c)) : [];
  const mapping = arr<{ from: string; to: string }>(draft.mapping);
  const fromFor = (to: string) => mapping.find((m) => m.to === to)?.from ?? '';
  const p = usePowerPreview('union', draft, ctx);
  const u = p.data?.ok ? p.data.union : null;
  return (
    <>
      <DatasetPicker label="Append the rows of" value={datasetId} ctx={ctx} onPick={(id) => set({ datasetId: id, mapping: [] })} />
      {datasetId && other.data && (
        <fieldset className={s.checks}>
          <legend className={s.legend}>Columns are matched by name; fill the rest from</legend>
          {unmatched.length === 0 ? (
            <Hint>Every column here has a same-named column there.</Hint>
          ) : (
            <div className={s.rules}>
              {unmatched.map((to) => (
                <div key={to} className={s.ruleRow}>
                  <span className={s.arrow}>{to} ←</span>
                  <NameSelect
                    ariaLabel={`Fill ${to} from`}
                    value={fromFor(to)}
                    names={spare}
                    blank="(leave empty)"
                    onChange={(from) => set({ mapping: [...mapping.filter((m) => m.to !== to), ...(from ? [{ from, to }] : [])] })}
                  />
                </div>
              ))}
            </div>
          )}
        </fieldset>
      )}
      {datasetId && (
        <PreviewBox busy={p.busy} warn={!!u && u.unmatched.length > 0}>
          {u && p.data ? (
            <>
              <div>
                Rows: {fmtN(p.data.before ?? 0)} → {fmtN(p.data.after ?? 0)} ({fmtN(u.otherRows)} appended)
              </div>
              {u.unmatched.length > 0 && <div>Dropped — no matching column here: {u.unmatched.join(', ')}</div>}
              {u.missing.length > 0 && <div>Empty for the appended rows: {u.missing.join(', ')}</div>}
            </>
          ) : (
            <div>{p.error ?? (p.data && !p.data.ok ? p.data.error : 'Counting…')}</div>
          )}
        </PreviewBox>
      )}
    </>
  );
}
