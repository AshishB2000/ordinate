// The dataset page's Insights tab (insights.ts insRenderDatasetTab): what the
// app found in this dataset, grouped by kind in the desktop's order with a
// count each. "Explain" opens the column's profile on the Data tab (T2.3's
// panel — never a second copy here). Every figure is the server's.

import { useNavigate } from 'react-router';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { useCanEdit } from '../../projects/api';
import { KIND_LABELS, useDismiss, useInsights } from './api';
import { InsightCard } from './InsightCard';
import s from './Insights.module.css';

export function InsightsTab({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const q = useInsights(projectId, datasetId);
  const dismiss = useDismiss(projectId);
  const canEdit = useCanEdit(projectId);
  const navigate = useNavigate();
  if (q.isPending) return <SkeletonRows rows={4} label="Scanning the dataset for insights" />;
  if (q.isError) return <ErrorState heading={3} title="Could not read the insights" message={q.error.message} onRetry={() => void q.refetch()} />;
  const list = q.data;
  if (!list.length) {
    return (
      <div className={s.tabEmpty}>
        <EmptyState icon="zap" title="Nothing stands out yet" heading={3}>
          Insights appear when a dataset has a date column and at least two periods, or a category with an outsized share.
        </EmptyState>
      </div>
    );
  }
  return (
    <section className={s.tab} aria-label="Insights">
      {KIND_LABELS.map(([kind, label]) => {
        const group = list.filter((i) => i.kind === kind);
        if (!group.length) return null;
        return (
          <div key={kind} className={s.group}>
            <h2 className={s.groupH}>
              {label}
              <span className={s.groupN}>{group.length}</span>
            </h2>
            <div className={s.grid}>
              {group.map((ins) => (
                <InsightCard
                  key={ins.id}
                  projectId={projectId}
                  ins={ins}
                  onDismiss={canEdit ? dismiss : undefined}
                  actions={ins.column ? [{ label: 'Explain', run: (x) => void navigate(`/data/${projectId}/${datasetId}?profile=${encodeURIComponent(x.column ?? '')}`) }] : []}
                />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
