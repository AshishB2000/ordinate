// The encoding form (encodingForm.ts + encodingRelated.ts): Category (text and
// date columns, numbers under "Bin numeric…" — the server bins those into ten
// ranges), the date grain and the period overlay for a date category, the
// measures, Split by and Map regions. Columns of related datasets join each
// picker as "From <dataset>" groups. Controlled: it reads an encoding and
// reports a new one; what an edit MEANS (recompute, save) is the builder's.
//
// A measure is a column with an aggregation, or a saved METRIC of this dataset —
// picked from the same list, and made right here: "New calculated measure…"
// opens the calculated-field dialog (../calc) and the metric it saves becomes
// the measure in the same step. A formula metric is calculated by the server
// after totals (src/ipc/vizMetricMeasures.ts); the form only names it.
//
// The grain and the "top 50" note are the server's: the reply says which grain
// it picked and whether it capped a long tail, and the form only shows them.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Select, type SelectOption } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { isFormula, useMetricList, type Metric, type MetricSummary } from '../analyses/metrics/api';
import { MetricEditor } from '../analyses/metrics/MetricEditor';
import { metricMeasure } from '../calc/api';
import { CalcDialog, type CalcCreated } from '../calc/CalcDialog';
import type { Agg, Encoding, Measure, Preview, RelatedCol } from './api';
import { MapRegions } from './MapRegions';
import { AGG_LABELS, AGGS, categoryType, fieldKey, GRAINS, measureColumns, measureFrom, parseKey, type Column } from './model';
import s from './Builder.module.css';

const heading = (label: string, key: string): SelectOption => ({ value: `__h:${key}`, label, disabled: true });
/** Select values that are not columns: a saved metric, and the door to a new one. */
const METRIC = '__m:';
const NEW = '__new';

/** Related columns as one heading + options per dataset, nearest first (the server's order). */
function relatedOptions(related: readonly RelatedCol[], keep: (c: RelatedCol) => boolean): SelectOption[] {
  const out: SelectOption[] = [];
  let at = '';
  for (const c of related) {
    if (!keep(c)) continue;
    if (c.datasetId !== at) {
      at = c.datasetId;
      out.push(heading(`From ${c.group}`, c.datasetId));
    }
    // The dataset rides in the text too: the closed control shows the option, not its group.
    out.push({ value: c.key, label: `${c.column} · ${c.group}` });
  }
  return out;
}

export function EncodingForm({
  projectId,
  datasetId,
  cols,
  related,
  encoding,
  info,
  live,
  canEdit,
  onChange,
  onFormat,
}: {
  projectId: string;
  datasetId: string;
  cols: readonly Column[];
  related: readonly RelatedCol[];
  encoding: Encoding;
  /** The `category` block of the last reply: the grain the server used, its note. */
  info: Preview['category'] | undefined;
  /** The dataset is Live: a calculated COLUMN is off (it has no pipeline). */
  live?: boolean;
  /** May this person save a metric or a step? A viewer picks from what exists. */
  canEdit?: boolean;
  onChange: (e: Encoding) => void;
  /** A new measure is the chart's only one: how its figures read (percent, currency). */
  onFormat?: (kind: Metric['format']['kind']) => void;
}) {
  const qc = useQueryClient();
  const metrics = useMetricList(projectId);
  // Which dialog is open: a new field for a slot (-1 = a new measure), or a metric to edit.
  const [calc, setCalc] = useState<{ slot: number; editing?: MetricSummary; full?: Metric } | null>(null);
  const set = (patch: Partial<Encoding>) => {
    const next: Encoding = { ...encoding, ...patch };
    for (const k of Object.keys(patch)) if (next[k] === undefined) delete next[k];
    onChange(next);
  };
  const dims = cols.filter((c) => c.type !== 'number');
  const nums = cols.filter((c) => c.type === 'number');
  const catOptions: SelectOption[] = [
    ...dims.map((c) => ({ value: c.name, label: c.name })),
    ...(nums.length ? [heading('Bin numeric…', 'bin'), ...nums.map((c) => ({ value: c.name, label: c.name }))] : []),
    ...relatedOptions(related, () => true),
  ];
  const isDate = categoryType(encoding, cols, related) === 'date';
  const own = (metrics.data ?? []).filter((m) => m.datasetId === datasetId);
  const byId = new Map(own.map((m) => [m.id, m]));
  const measureOpts: SelectOption[] = [
    ...measureColumns(cols).map((c) => ({ value: c.name, label: c.name })),
    ...relatedOptions(related, (c) => c.type === 'number'),
    ...(own.length ? [heading('Metrics', 'metrics'), ...own.map((m) => ({ value: METRIC + m.id, label: m.name }))] : []),
  ];
  const seriesOpts: SelectOption[] = [
    { value: '', label: 'None' },
    ...dims.map((c) => ({ value: c.name, label: c.name })),
    ...relatedOptions(related, (c) => c.type !== 'number'),
  ];

  // The dimension moved: the grain belonged to the old column and the overlay to a date.
  const pickCategory = (v: string) => {
    const { column, datasetId: from } = parseKey(v);
    set({ category: column, categoryDatasetId: from, grain: undefined });
  };
  const setMeasure = (i: number, m: Measure) => set({ values: encoding.values.map((x, j) => (j === i ? m : x)) });
  /** Into its slot, or as one more measure. Returns how many measures the chart then has. */
  const place = (slot: number, m: Measure): number => {
    const inPlace = slot >= 0 && slot < encoding.values.length;
    set({ values: inPlace ? encoding.values.map((x, j) => (j === slot ? m : x)) : [...encoding.values, m] });
    return inPlace ? encoding.values.length : encoding.values.length + 1;
  };
  const firstMeasure = measureColumns(cols)[0]?.name ?? '';

  const pickMeasure = (i: number, v: string) => {
    const m = encoding.values[i];
    if (v === NEW) return setCalc({ slot: i });
    const metric = v.startsWith(METRIC) ? byId.get(v.slice(METRIC.length)) : undefined;
    if (metric) return setMeasure(i, metricMeasure(metric, m));
    // Leaving a metric for a column: the metric's aggregation was never the user's choice.
    setMeasure(i, measureFrom(v, m.metricId ? 'sum' : m.aggregation, m));
  };

  /** A metric was created or changed: the list every picker reads, and the chart drawn from it. */
  const metricSaved = (metric: Metric) => {
    qc.setQueryData<MetricSummary[]>(['metric:list', projectId], (old) => {
      const row: MetricSummary = { ...metric, datasetName: null, definitionText: isFormula(metric.definition) ? metric.definition.formula : '' };
      return old?.some((x) => x.id === metric.id) ? old.map((x) => (x.id === metric.id ? { ...x, ...row, datasetName: x.datasetName } : x)) : [...(old ?? []), row];
    });
    void qc.invalidateQueries({ queryKey: ['metric:list', projectId] });
    void qc.invalidateQueries({ queryKey: ['visual:preview'] });
  };
  const created = (slot: number, made: CalcCreated) => {
    if (made.kind === 'measure') {
      metricSaved(made.metric);
      const count = place(slot, metricMeasure(made.metric, encoding.values[slot]));
      if (count === 1) onFormat?.(made.metric.format.kind);
      toast(`“${made.metric.name}” is now this chart’s measure.`, { kind: 'success' });
    } else if (made.type === 'number') {
      place(slot, { column: made.name, aggregation: 'sum' });
      toast(`Added the column “${made.name}” and measured it.`, { kind: 'success' });
    } else {
      // Text or a date is something to group by, not to total.
      set({ category: made.name, categoryDatasetId: undefined, grain: undefined });
      toast(`Added the column “${made.name}” and grouped the chart by it.`, { kind: 'success' });
    }
  };
  const edit = (slot: number, metric: MetricSummary) => {
    if (isFormula(metric.definition)) return setCalc({ slot, editing: metric });
    // A simple metric opens in the Metrics tab's own editor, which needs the whole record (its filters).
    void rpc('metric:get', { projectId, id: metric.id }).then((r) => {
      const res = r as { ok: boolean; metric?: Metric; error?: string };
      if (res.ok && res.metric) setCalc({ slot, full: res.metric });
      else toast(res.error || 'That metric could not be opened.', { kind: 'error' });
    }, (err: Error) => toast(err.message, { kind: 'error' }));
  };

  return (
    <div className={s.encoding}>
      <div className={s.row}>
        <Select label="Category" aria-label="Category (dimension)" value={fieldKey(encoding.category, encoding.categoryDatasetId)} options={catOptions} onValueChange={pickCategory} />
        {isDate && (
          <Select
            aria-label="Date grain"
            size="sm"
            placeholder="Auto"
            value={(encoding.grain as string | undefined) || info?.grain || null}
            options={GRAINS}
            onValueChange={(g) => set({ grain: g })}
          />
        )}
        {info?.note && <p className={s.note}>{info.note}</p>}
      </div>

      {isDate && (
        <div className={s.row}>
          <Select
            label="Compare"
            aria-label="Period overlay"
            value={encoding.overlay ?? ''}
            options={[
              { value: '', label: 'No period overlay' },
              { value: 'previous_year', label: 'Overlay: vs previous year' },
            ]}
            onValueChange={(v) => set({ overlay: v === 'previous_year' ? 'previous_year' : undefined })}
          />
          <p className={s.note}>Draws the same periods a year earlier as a muted series, on line and column charts.</p>
        </div>
      )}

      <div className={s.row} role="group" aria-labelledby="enc-measures">
        <span className={s.label} id="enc-measures">
          Measures
        </span>
        {encoding.values.map((m, i) => {
          const metric = m.metricId ? byId.get(m.metricId) : undefined;
          // While the list is on its way a metric measure keeps its name; one whose metric is gone is a column again.
          const asMetric = !!m.metricId && (!!metric || metrics.isPending);
          const options = [
            ...measureOpts,
            ...(asMetric && !metric ? [{ value: METRIC + m.metricId, label: m.column }] : []),
            ...(canEdit ? [{ value: NEW, label: '+ New calculated measure…' }] : []),
          ];
          return (
            <div key={i} className={s.valueRow}>
              <div className={s.grow}>
                <Select aria-label="Measure column" size="sm" value={asMetric ? METRIC + m.metricId : fieldKey(m.column, m.datasetId)} options={options} onValueChange={(v) => pickMeasure(i, v)} />
              </div>
              {asMetric ? (
                <span className={s.metric} title={metric ? `A saved metric: ${metric.definitionText}` : 'A saved metric'}>
                  <Badge tone="accent" icon="function">
                    Metric
                  </Badge>
                  {canEdit && metric && <IconButton icon="pencil" size="sm" label={`Edit the metric ${metric.name}`} onClick={() => edit(i, metric)} />}
                </span>
              ) : (
                <div className={s.agg}>
                  <Select
                    aria-label="Aggregation"
                    size="sm"
                    value={m.aggregation}
                    options={AGGS.map((a) => ({ value: a, label: AGG_LABELS[a] }))}
                    onValueChange={(a) => setMeasure(i, { ...m, aggregation: a as Agg })}
                  />
                </div>
              )}
              {m.calc && <Badge tone="accent">{String(m.calc.kind ?? 'calc').replace(/_/g, ' ')}</Badge>}
              <IconButton
                icon="x"
                size="sm"
                label="Remove measure"
                disabled={encoding.values.length <= 1}
                onClick={() => set({ values: encoding.values.filter((_, j) => j !== i) })}
              />
            </div>
          );
        })}
        <div className={s.addRow}>
          <Button size="sm" icon="plus" className={s.addSlot} onClick={() => set({ values: [...encoding.values, { column: firstMeasure, aggregation: 'sum' }] })}>
            Add measure
          </Button>
          {canEdit && (
            <Button size="sm" variant="ghost" icon="function" title="Write a formula — a ratio, a difference, a share — and chart it" onClick={() => setCalc({ slot: -1 })}>
              Calculated measure
            </Button>
          )}
        </div>
      </div>

      <div className={s.row}>
        <Select
          label="Split by"
          aria-label="Split/series column"
          value={encoding.series ? fieldKey(encoding.series, encoding.seriesDatasetId) : ''}
          options={seriesOpts}
          onValueChange={(v) => {
            const { column, datasetId: from } = parseKey(v);
            set({ series: column || undefined, seriesDatasetId: column ? from : undefined });
          }}
        />
      </div>

      <MapRegions projectId={projectId} cols={cols} geo={encoding.geo} onChange={(geo) => set({ geo })} />

      {calc?.full ? (
        <MetricEditor
          projectId={projectId}
          existing={calc.full}
          onSaved={(metric) => {
            metricSaved(metric);
            // Its column, its aggregation or its kind may have changed: the measure follows the metric.
            setMeasure(calc.slot, metricMeasure(metric, encoding.values[calc.slot]));
          }}
          onClose={() => setCalc(null)}
        />
      ) : (
        calc && (
          <CalcDialog
            projectId={projectId}
            datasetId={datasetId}
            columns={cols}
            metrics={metrics.data ?? []}
            live={!!live}
            chart
            editing={calc.editing}
            copyTo={(id) => `/visuals/${projectId}/new?dataset=${encodeURIComponent(id)}`}
            onCreated={(made) => created(calc.slot, made)}
            onClose={() => setCalc(null)}
          />
        )
      )}
    </div>
  );
}
