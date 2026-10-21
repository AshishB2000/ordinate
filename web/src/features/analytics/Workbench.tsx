// The frame every dataset workbench shares (statsPanel.ts's head, segments.ts's
// head): the page header with an icon-marked title, the dataset it is about, a
// dataset picker that moves the page to another dataset of the project, and the
// crumb back to where it was opened from. Plus the
// route gate: the project the URL names becomes the current one, and a
// missing dataset or a failed read gets its designed state.

import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDatasetColumns, useDatasets, type DatasetColumns } from '../../api/datasets';
import { EmptyState, ErrorState, Page, PageHead, PageSkeleton, useCameFrom, type Back } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { useAdoptProject } from '../projects/current';
import { LiveOffPage } from '../live/LiveOff';
import s from './Analytics.module.css';

export type WorkbenchKind = 'stats' | 'drivers' | 'segments';

/** A workbench's title, marked with its icon (the hub's cards wear the same mark). */
export function Marked({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className={s.marked}>
      <span className={s.mark} aria-hidden="true">
        <Icon name={icon} />
      </span>
      {children}
    </span>
  );
}

/** The crumb back to where the workbench was opened from (the Analytics hub unless the opener said). */
export function useWorkbenchBack(projectId: string): Back {
  return useCameFrom({ to: `/analytics?project=${projectId}`, label: 'Analytics' });
}

export function WorkbenchHead({
  icon,
  title,
  sub,
  projectId,
  datasetId,
  kind,
}: {
  icon: IconName;
  title: string;
  sub: string;
  projectId: string;
  datasetId: string;
  kind: WorkbenchKind;
}) {
  const list = useDatasets(projectId);
  const nav = useNavigate();
  const back = useWorkbenchBack(projectId);
  const options = (list.data ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }));
  return (
    <PageHead
      className={s.head}
      back={back}
      title={<Marked icon={icon}>{title}</Marked>}
      sub={sub}
      actions={
        <div className={s.dsPick}>
          <Select
            label="Dataset"
            size="sm"
            value={datasetId}
            options={options.length ? options : [{ value: datasetId, label: 'This dataset' }]}
            disabled={options.length < 2}
            // Another dataset, the same way back (and nothing else the opener passed: it was about this dataset).
            onValueChange={(id) => void nav(`/analytics/${projectId}/${id}/${kind}`, { state: { back } })}
          />
        </div>
      }
    />
  );
}

/**
 * Renders `children(projectId, datasetId, dataset)` once the route's dataset is
 * read; its states otherwise. A Live dataset keeps no rows for a workbench to
 * read (L2.6): the page says so and offers a copy, and the workbench never runs.
 */
export function DatasetRoute({ title, kind, children }: { title: string; kind: WorkbenchKind; children: (projectId: string, datasetId: string, d: DatasetColumns) => ReactNode }) {
  const { projectId, datasetId } = useParams();
  useAdoptProject(projectId);
  const q = useDatasetColumns(projectId, datasetId);
  if (!projectId || !datasetId || q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <Page title={title}>
        <ErrorState title="This dataset could not be opened" message={q.error.message} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  if (!q.data) {
    return (
      <Page title={title}>
        <EmptyState
          icon="database"
          title="Dataset not found"
          actions={
            <Link className={buttonClass('primary')} to={`/analytics?project=${projectId}`}>
              Pick another dataset
            </Link>
          }
        >
          It may have been deleted, or moved to the Trash with its project.
        </EmptyState>
      </Page>
    );
  }
  if (q.data.mode === 'live') return <LiveOffPage title={title} projectId={projectId} datasetId={datasetId} feature={kind} />;
  return <>{children(projectId, datasetId, q.data)}</>;
}
