// The builder's measures on a SEMANTIC dataset (semantic layer part 7, b3; docs/semantic-layer/07-portability.md D12,
// D13): the layer's own metrics — the mirror metrics its sync wrote — by their names there, under one heading
// ("Metrics from Snowflake · Sales"), each saying whether the layer adds it up (its `additive`, the layer's word, as
// the server stored it). No column measure, no aggregation and no formula: the layer computes every figure, and the
// door refuses anything else. A pick writes what that door reads, `{ column: '', aggregation: 'sum', metricId }`.
// Its date grains are the layer's too (./EncodingForm reads them through `layerGrains`).

import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Select, type SelectOption } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { isExternal, useMetricList, type MetricSummary } from '../analyses/metrics/api';
import { pickerOrder } from '../model/status/status';
import type { Encoding, Measure } from './api';
import type { Column } from './model';
import s from './Builder.module.css';

/** What the builder knows of a semantic dataset: the layer's name, the dataset's, and the grains per date field. */
export interface SemanticInfo {
  layer?: string;
  label: string;
  dataset: string;
  grains: { column: string; grains: string[] }[];
}

/** The measure a mirror metric is: its id, no column of ours. */
export const mirrorMeasure = (id: string): Measure => ({ column: '', aggregation: 'sum', metricId: id });

/** The grains the layer lists for `column`, or null when it is no date the layer grains. */
export function layerGrains(grains: SemanticInfo['grains'], column: string | undefined): string[] | null {
  return grains.find((g) => g.column === column)?.grains ?? null;
}

/** A date axis starts at the layer's month when it lists one, else at its first grain; anything else has none. */
export function defaultGrain(grains: SemanticInfo['grains'], column: string | undefined): string | undefined {
  const g = layerGrains(grains, column);
  return g ? (g.includes('month') ? 'month' : g[0]) : undefined;
}

/** A new chart on a semantic dataset: the first field as the axis (a date at its grain), measured by the first metric. */
export function semanticEncoding(cols: readonly Column[], mirrors: readonly Pick<MetricSummary, 'id'>[], grains: SemanticInfo['grains']): Encoding {
  const category = cols.find((c) => c.type !== 'number')?.name ?? '';
  const grain = defaultGrain(grains, category);
  return { category, ...(grain ? { grain } : {}), values: mirrors[0] ? [mirrorMeasure(mirrors[0].id)] : [] };
}

/** This dataset's mirrors, in the picker's order (certified first, retired left out). */
export function useMirrors(projectId: string, datasetId: string) {
  const list = useMetricList(projectId);
  const mirrors = pickerOrder((list.data ?? []).filter((m) => m.datasetId === datasetId && isExternal(m.definition))).main;
  return { list, mirrors };
}

export function SemanticMeasures({ projectId, datasetId, semantic, values, onValues }: {
  projectId: string;
  datasetId: string;
  semantic: SemanticInfo;
  values: Measure[];
  onValues: (values: Measure[]) => void;
}) {
  const { list, mirrors } = useMirrors(projectId, datasetId);
  const defined = `Defined in ${semantic.label}: edit it there.`;
  const options: SelectOption[] = [
    { value: '__h', label: `Metrics from ${semantic.label} · ${semantic.dataset}`, disabled: true },
    ...mirrors.map((m) => ({ value: m.id, label: m.name, hint: m.definition && isExternal(m.definition) && m.definition.additive ? 'can be added up' : 'can’t be added up' })),
  ];
  const next = () => mirrors.find((m) => !values.some((v) => v.metricId === m.id)) ?? mirrors[0];
  let body;
  if (list.isPending) body = <Skeleton className={s.skMeasure} />;
  else if (list.isError) {
    body = (
      <p className={s.note} role="alert">
        The metrics could not be listed: {list.error.message}{' '}
        <Button size="sm" variant="ghost" onClick={() => void list.refetch()}>
          Retry
        </Button>
      </p>
    );
  } else if (!mirrors.length) body = <p className={s.note}>{`${semantic.dataset} has no metrics yet. Sync it after adding them in ${semantic.label}.`}</p>;
  else {
    body = (
      <>
        {values.map((m, i) => (
          <div key={i} className={s.valueRow}>
            <div className={s.grow}>
              {/* A column measure from an older tab names no metric: the chart shows the layer's refusal until one is picked. */}
              <Select aria-label="Measure" size="sm" placeholder="Choose a metric" value={m.metricId ?? null} options={options} onValueChange={(id) => onValues(values.map((x, j) => (j === i ? mirrorMeasure(id) : x)))} />
            </div>
            <span className={s.metric} title={defined}>
              <Badge tone="accent" icon="layers">
                {semantic.label}
              </Badge>
            </span>
            <IconButton icon="x" size="sm" label="Remove measure" disabled={values.length <= 1} onClick={() => onValues(values.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className={s.addRow}>
          <Button size="sm" icon="plus" className={s.addSlot} onClick={() => onValues([...values, mirrorMeasure(next().id)])}>
            Add measure
          </Button>
        </div>
      </>
    );
  }
  return (
    <div className={s.row} role="group" aria-labelledby="enc-measures">
      <span className={s.label} id="enc-measures">
        Measures
      </span>
      {body}
    </div>
  );
}
