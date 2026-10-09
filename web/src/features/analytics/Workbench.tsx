// The frame every dataset workbench shares (statsPanel.ts's head, segments.ts's
// head): an icon-marked title, the dataset it is about, a dataset picker that
// moves the page to another dataset of the project, and the way back. Plus the
// route gate: the project the URL names becomes the current one, and a
// missing dataset or a failed read gets its designed state.

import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDatasetColumns, useDatasets, type DatasetColumns } from '../../api/datasets';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { useAdoptProject } from '../projects/current';
import { LiveOffPage } from '../live/LiveOff';
import s from './Analytics.module.css';

export type WorkbenchKind = 'stats' | 'drivers' | 'segments';

export function WorkbenchHead({
  icon,
  title,
  sub,
  projectId,
  datasetId,
  kind,
  back,
}: {
  icon: IconName;
  title: string;
  sub: string;
  projectId: string;
  datasetId: string;
  kind: WorkbenchKind;
  /** Where "back" goes, and what it says. */
  back: { to: string; label: string };
}) {
  const list = useDatasets(projectId);
  const nav = useNavigate();
  const options = (list.data ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }));
  return (
    <header className={s.head}>
      <div className={s.ident}>
        <h1 className={s.title}>
          <span className={s.mark} aria-hidden="true">
            <Icon name={icon} />
          </span>
          {title}
        </h1>
        <p className={s.sub}>{sub}</p>
      </div>
      <div className={s.actions}>
        <div className={s.dsPick}>
          <Select
            label="Dataset"
            size="sm"
            value={datasetId}
            options={options.length ? options : [{ value: datasetId, label: 'This dataset' }]}
            disabled={options.length < 2}
            onValueChange={(id) => void nav(`/analytics/${projectId}/${id}/${kind}`)}
          />
        </div>
        <Link className={buttonClass('secondary', 'sm')} to={back.to}>
          <Icon name="x" />
          {back.label}
        </Link>
      </div>
    </header>
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
