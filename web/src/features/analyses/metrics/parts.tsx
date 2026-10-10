// The pieces every metric editor shares — the full one on the Metrics tab
// (./MetricEditor) and the chart builder's "New calculated measure"
// (../../calc): how a figure is written, which way is good news, and the ONE
// save. A duplicate name is refused by the server; `saveMetric` hands its
// sentence back with the field it belongs beside.

import { rpc } from '../../../api/client';
import { Checkbox } from '../../../ui/Choice';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { failure } from '../api';
import type { Definition, Metric, MetricFormat } from './api';
import s from './Metrics.module.css';

const KINDS = [
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'duration', label: 'Duration' },
];

/** Kind and decimal places; with `affixes`, the prefix, suffix and compact switch too. */
export function FormatFields({ format, onChange, affixes }: { format: MetricFormat; onChange: (next: MetricFormat) => void; affixes?: boolean }) {
  return (
    <div className={s.format}>
      <Select size="sm" aria-label="Format" value={format.kind} options={KINDS} onValueChange={(v) => onChange({ ...format, kind: v as MetricFormat['kind'] })} />
      <Input size="sm" type="number" min={0} max={6} aria-label="Decimal places" value={String(format.decimals ?? 0)} onChange={(e) => onChange({ ...format, decimals: Number(e.target.value) || 0 })} />
      {affixes && (
        <>
          <Input size="sm" aria-label="Prefix" placeholder="Prefix" value={format.prefix ?? ''} maxLength={8} onChange={(e) => onChange({ ...format, prefix: e.target.value })} />
          <Input size="sm" aria-label="Suffix" placeholder="Suffix" value={format.suffix ?? ''} maxLength={8} onChange={(e) => onChange({ ...format, suffix: e.target.value })} />
          <Checkbox label="Compact" checked={!!format.compact} onCheckedChange={(c) => onChange({ ...format, compact: c })} />
        </>
      )}
    </div>
  );
}

export type Direction = '' | 'up_good' | 'down_good';

export function DirectionSelect({ value, onChange, size, bare }: { value: Direction; onChange: (next: Direction) => void; size?: 'sm' | 'md'; /** No hint line (a tight row). */ bare?: boolean }) {
  return (
    <Select
      label="Direction"
      size={size}
      hint={bare ? undefined : 'Which way is good news, for the surfaces that colour a change.'}
      value={value}
      options={[
        { value: '', label: 'No opinion' },
        { value: 'up_good', label: 'Up is good' },
        { value: 'down_good', label: 'Down is good' },
      ]}
      onValueChange={(v) => onChange(v as Direction)}
    />
  );
}

export interface MetricFields {
  name: string;
  definition: Definition;
  /** Left out, an edit keeps the metric's own filters. */
  filters?: Metric['filters'];
  format: MetricFormat;
  description: string;
  direction: Direction;
}

export type SaveResult = { metric: Metric } | { error: string; field?: 'name' };

/** Create (no `editingId`) or update a metric. Never throws: a refusal comes back as its sentence. */
export async function saveMetric(projectId: string, editingId: string, datasetId: string, fields: MetricFields): Promise<SaveResult> {
  try {
    const r = (editingId
      ? await rpc('metric:update', { projectId, id: editingId, patch: fields })
      : await rpc('metric:save', { projectId, input: { ...fields, datasetId } })) as { ok: boolean; metric?: Metric; error?: string; field?: 'name' };
    if (r.ok && r.metric) return { metric: r.metric };
    return { error: r.error || 'Could not save the metric.', field: r.field };
  } catch (err) {
    return { error: failure(err, 'Could not save the metric.') };
  }
}
