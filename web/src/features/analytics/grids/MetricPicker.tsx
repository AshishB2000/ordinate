// "Use a metric…" for a pivot value (pivotBuilder.ts pickValueMetric over
// metricPicker.ts): the project's saved metrics with each one's live figure,
// searched by name or definition, and "Custom…" to go back to a column and an
// aggregation. Every figure and its words are the server's (`metric:list`'s
// definitionText, `metric:values`' display); nothing here formats a number.
// The row markup is the KPI picker's (T2.8, analyses/editor/AddKpi.tsx).

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../../ui/Button';
import { Dialog } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { SkeletonRows } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { formatBadge, useMetricList, useMetricValues, type MetricSummary } from '../../analyses/metrics/api';
import d from '../../analyses/editor/Dialogs.module.css';

/** Rows past this and the picker is a list to scroll — which is what search is for (MPK_MAX_ROWS). */
const MAX_ROWS = 40;

export type MetricPick = { kind: 'metric'; metric: MetricSummary } | { kind: 'custom' };

export function MetricPicker({ projectId, onPick, onClose }: { projectId: string; onPick: (p: MetricPick) => void; onClose: () => void }) {
  const list = useMetricList(projectId);
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const all = list.data ?? [];
    const k = q.trim().toLowerCase();
    return (k ? all.filter((m) => m.name.toLowerCase().includes(k) || m.definitionText.toLowerCase().includes(k)) : all).slice(0, MAX_ROWS);
  }, [list.data, q]);
  // The pivot builder opened its picker with no filters: each figure is the metric over all its rows.
  const values = useMetricValues(projectId, shown.map((m) => m.id), [], []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Use a metric" description="A saved metric fills this value with its column and aggregation; the pivot still folds every cell on the server.">
      <div className={d.picker}>
        <Input icon="search" type="search" aria-label="Search metrics" placeholder="Search metrics" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className={d.mpkRows} role="list" aria-label="Metrics">
          {list.isPending ? (
            <SkeletonRows rows={4} label="Loading metrics" />
          ) : list.isError ? (
            <ErrorState compact heading={3} title="The metrics could not be listed" message={list.error.message} onRetry={() => void list.refetch()} />
          ) : shown.length === 0 ? (
            <p className={d.empty}>{(list.data ?? []).length ? 'No metric matches that.' : 'No metrics in this project yet — define one with Manage metrics below, or use Custom….'}</p>
          ) : (
            shown.map((m) => (
              <div key={m.id} role="listitem">
                <button type="button" className={d.mpkRow} title={m.definitionText} onClick={() => onPick({ kind: 'metric', metric: m })}>
                  <span className={d.mpkName}>{m.name}</span>
                  <span className={d.badge}>{formatBadge(m.format)}</span>
                  <span className={d.mpkValue} title={values.isError ? 'The figures could not be computed.' : undefined}>
                    {values.isError ? '—' : (values.data?.get(m.id) ?? '…')}
                  </span>
                </button>
              </div>
            ))
          )}
        </div>
        <div className={d.pickerFoot}>
          <Button variant="ghost" onClick={() => onPick({ kind: 'custom' })}>
            Custom…
          </Button>
          <Link className={d.link} to={`/data/metrics?project=${projectId}`}>
            Manage metrics
          </Link>
        </div>
      </div>
    </Dialog>
  );
}
