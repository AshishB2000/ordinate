// Which saved metric a KPI card shows, and the door to it (legacy
// metricsPage.ts mpCardMenuItems / promoteToMetric): a card that names a
// metric offers to edit THE metric; one computed from a column offers to save
// that definition as a metric and link itself to it — a promote, not a second
// definition beside the first. The card keeps its own column and aggregation
// either way, so a deleted metric degrades to the card's own figure.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { toast } from '../../../ui/Toast';
import { failure, type Card } from '../api';
import { useMetricList, type Metric } from '../metrics/api';
import { MetricEditor, type MetricDraft } from '../metrics/MetricEditor';
import { useEditor } from './context';
import s from './Properties.module.css';

export function MetricLink({ card }: { card: Card }) {
  const ed = useEditor();
  const client = useQueryClient();
  const list = useMetricList(ed.projectId);
  const [editing, setEditing] = useState<MetricDraft | null>(null);
  const m = card.metric as NonNullable<Card['metric']>;
  const linked = m.metricId ? list.data?.find((x) => x.id === m.metricId) : undefined;

  const editMetric = async () => {
    try {
      const r = (await rpc('metric:get', { projectId: ed.projectId, id: m.metricId as string })) as { ok: boolean; metric?: Metric; error?: string };
      if (!r.ok || !r.metric) throw new Error(r.error);
      setEditing(r.metric);
    } catch (err) {
      toast(failure(err, 'That metric could not be read.'), { kind: 'error' });
    }
  };
  const saved = (metric: Metric) => {
    void client.invalidateQueries({ queryKey: ['metric:list', ed.projectId] });
    void client.invalidateQueries({ queryKey: ['metric:table', ed.projectId] });
    void client.invalidateQueries({ queryKey: ['analysis:tile'] });
    if (m.metricId) return;
    // Linking the card is what makes this a promote.
    ed.edit('Save as metric', (d) => {
      const c = d.sheets[ed.sheet].cards.find((x) => x.id === card.id);
      if (!c?.metric) return;
      c.metric.metricId = metric.id;
      if (!c.metric.label) c.metric.label = metric.name;
    });
  };

  return (
    <>
      {m.metricId ? (
        <p className={s.note}>
          {linked
            ? `Shows the saved metric “${linked.name}”: ${linked.definitionText}.`
            : list.isPending
              ? 'Reading the metric…'
              : list.isError
                ? 'The saved metrics could not be read, so this card’s metric cannot be shown here.'
                : 'Its saved metric was deleted — the card shows its own column’s figure.'}
        </p>
      ) : (
        <p className={s.note}>Computed from a column — not a saved metric.</p>
      )}
      {m.metricId && linked && (
        <Button size="sm" icon="pencil" onClick={() => void editMetric()}>
          Edit metric…
        </Button>
      )}
      {!m.metricId && (
        <Button
          size="sm"
          icon="target"
          onClick={() =>
            setEditing({ name: m.label || '', datasetId: m.datasetId, definition: { column: m.column, aggregation: m.aggregation }, filters: [] })
          }
        >
          Save as metric…
        </Button>
      )}
      {editing && <MetricEditor projectId={ed.projectId} existing={editing} onClose={() => setEditing(null)} onSaved={saved} />}
    </>
  );
}
