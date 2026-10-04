// Which saved metric a KPI card shows, if any (legacy metricsPage.ts
// mpCardMenuItems). The card stores the metric's id alongside its own column
// and aggregation, so a deleted metric degrades to the card's own figure.

import type { Card } from '../api';
import { useMetricList } from '../metrics/api';
import { useEditor } from './context';
import s from './Properties.module.css';

export function MetricLink({ card }: { card: Card }) {
  const ed = useEditor();
  const list = useMetricList(ed.projectId);
  const id = card.metric?.metricId;
  if (!id) return <p className={s.note}>Computed from a column — not a saved metric.</p>;
  const m = list.data?.find((x) => x.id === id);
  return <p className={s.note}>{m ? `Shows the saved metric “${m.name}”: ${m.definitionText}.` : list.isPending ? 'Reading the metric…' : 'Its saved metric was deleted — the card shows its own column’s figure.'}</p>;
}
