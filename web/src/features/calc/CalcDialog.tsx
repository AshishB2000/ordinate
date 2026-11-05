// "New calculated field", in place — from the chart builder's measure picker and
// from the analysis rail — instead of leaving for the Metrics tab or Prepare.
//
// Two kinds (./Kinds explains them where the choice is made):
//
//   Measure  a saved metric whose definition is a formula (./MeasureForm). The
//            caller is handed the metric and makes it the chart's measure.
//   Column   a `calculated_field` step appended to the dataset's pipeline
//            through `dataset:addStep` — the path Prepare itself saves by, which
//            sanitizes the step and recomputes the dataset from its immutable
//            source. The editor is Prepare's own (../prepare/FormulaEditor).
//
// A Live dataset keeps no rows here, so it has no pipeline to append to: its
// Column kind is a Live calculated field instead (semantic layer part 8), appended
// to the dataset's list through `live:setCalculated` and computed in the
// warehouse. Where the server does not allow them (Databricks, an older server)
// the kind is off, with the reason and "Make a copy". A measure on Live is asked
// of the warehouse like any other figure; if it is refused the preview carries
// the server's sentence.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import type { Metric, MetricSummary } from '../analyses/metrics/api';
import { MakeCopyButton } from '../live/LiveOff';
import { LIVE_OFF } from '../live/offFeatures';
import { mutate, useApplyReply, type Column } from '../prepare/api';
import { checkLiveCalc, useLiveSchema, useSetCalculated } from '../data/liveApi';
import { useColumnFormula } from '../prepare/FormulaEditor';
import { useSuggestCalc } from '../prepare/Suggest';
import { KindPicker, type Kind } from './Kinds';
import { useMeasureForm } from './MeasureForm';
import { QuickStarts } from './QuickStarts';
import c from './Calc.module.css';

export type CalcCreated = { kind: 'measure'; metric: Metric } | { kind: 'column'; name: string; type: Column['type'] };

export function CalcDialog({ projectId, datasetId, columns, metrics, live, chart = false, editing, onReload, copyTo, onCreated, onClose }: {
  projectId: string;
  datasetId: string;
  columns: readonly Column[];
  metrics: readonly MetricSummary[];
  /** The dataset is Live: no pipeline, so the Column kind is a Live calculated field (where the server allows one). */
  live: boolean;
  /** Opened from a chart: a measure's operands must be this dataset's. */
  chart?: boolean;
  /** A formula metric to edit (the measure form alone, no kind to choose). */
  editing?: MetricSummary;
  /** The measure form's Reload after a conflict (docs/edit-conflicts). */
  onReload?: () => void;
  /** Where "Make a copy" lands (the builder on the copy); the copy's Prepare page otherwise. */
  copyTo?: (copyId: string) => string;
  onCreated: (made: CalcCreated) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>('measure');
  const client = useQueryClient();
  const applyReply = useApplyReply(projectId, datasetId);

  const measure = useMeasureForm({ projectId, datasetId, columns, metrics, existing: editing, chart, onClose, onReload, onSaved: (metric) => onCreated({ kind: 'measure', metric }) });

  // A Live dataset's calculated fields: on where the server allows them and the whole list can be read back.
  const schema = useLiveSchema(projectId, datasetId, live);
  const calc = schema.data?.calculated;
  const liveCalcs = live && !!calc?.allowed && !calc.fields.some((f) => f.hidden);
  const setCalc = useSetCalculated(projectId, datasetId);

  const column = useColumnFormula({
    projectId,
    datasetId,
    columns,
    onClose,
    ...(liveCalcs ? { live: true, check: checkLiveCalc } : {}),
    saveLabel: 'Add column',
    savingNote: liveCalcs ? 'Saving the calculated field…' : 'Recomputing the dataset with the new column…',
    onSave: async (field) => {
      if (liveCalcs) {
        const list = [...(calc?.fields ?? []).map((f) => ({ name: f.name, expression: f.expression })), field];
        const r = await setCalc.mutateAsync(list).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : undefined }));
        if (!r.ok) return r.error ?? 'The calculated field could not be saved.';
        await client.refetchQueries({ queryKey: ['dataset:columns', projectId, datasetId] });
        onCreated({ kind: 'column', name: field.name, type: r.calculated.at(-1)?.type ?? 'text' });
        return null;
      }
      const r = await mutate(projectId, datasetId, { kind: 'add', step: { type: 'calculated_field', name: field.name, expression: field.expression } }).catch(
        (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'The column could not be added.' }),
      );
      if (!r.ok) return r.error || 'The column could not be added.';
      // The server drops a step it cannot run and says why: the column is there, or it was not added.
      const made = r.preview.columns.find((col) => col.name === field.name);
      if (!made) return r.preview.warnings[0] ?? 'The dataset was recomputed, but the new column is not in it.';
      applyReply(r);
      // The builder's pickers read this list: have it in hand before the new column is selected.
      await client.refetchQueries({ queryKey: ['dataset:columns', projectId, datasetId] });
      onCreated({ kind: 'column', name: made.name, type: made.type });
      return null;
    },
  });
  const suggest = useSuggestCalc(projectId, datasetId, (prefill) => column.fill({ name: column.name.trim() ? undefined : prefill.name, expression: prefill.expression }));

  const columnOff = live && !liveCalcs ? (
    <>
      <p>{calc?.why ?? `${LIVE_OFF.prepare.why} Make a copy to add columns.`} This Live dataset stays as it is.</p>
      <MakeCopyButton projectId={projectId} datasetId={datasetId} variant="secondary" size="sm" open={copyTo ?? ((id) => LIVE_OFF.prepare.open(projectId, id))} />
    </>
  ) : undefined;
  const shown: Kind = editing || (live && !liveCalcs) ? 'measure' : kind;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={editing ? `Edit “${editing.name}”` : 'New calculated field'}
      description={editing ? 'A calculated measure: totals first, then the formula.' : 'A number the dataset does not have yet, from a formula. The server checks it and works it out as you type.'}
      footer={shown === 'measure' ? measure.footer : column.footer}
    >
      {!editing && <KindPicker value={shown} onChange={setKind} columnOff={columnOff} />}
      {shown === 'measure' ? (
        measure.body
      ) : (
        <>
          <QuickStarts
            measure={false}
            columns={columns}
            onFill={(t) => column.fill({ expression: t.expression, name: column.name.trim() ? undefined : t.name })}
            extra={
              <Button size="sm" icon="sparkles" loading={suggest.busy} title="Ask the Assistant for a formula. It proposes text only; the server checks and computes it." onClick={() => void suggest.ask()}>
                Suggest
              </Button>
            }
          />
          {suggest.hint && (
            <p className={c.hint} role="status">
              {suggest.hint}
            </p>
          )}
          {column.body}
        </>
      )}
    </Dialog>
  );
}
