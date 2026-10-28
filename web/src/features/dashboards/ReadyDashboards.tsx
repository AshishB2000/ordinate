// The Dashboards tab: every dashboard of the project an editor marked Ready, drawn as the Analyses gallery draws its
// cards — the same `analysis:gallery` reply and preview, filtered. One click opens it in view mode inside the app
// (/dashboards/<p>/<id>). Building and editing stay in Analyses.

import { Link } from 'react-router';
import { EmptyState, ErrorState } from '../../app/blocks';
import { ago } from '../../app/when';
import { buttonClass } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { Icon } from '../../ui/icons/Icon';
import { useGallery } from '../analyses/api';
import { GalleryPreview } from '../analyses/GalleryPreview';
import { useCanEdit } from '../projects/api';
import a from '../analyses/Analyses.module.css';

export function ReadyDashboards({ projectId }: { projectId: string }) {
  const q = useGallery(projectId);
  const canEdit = useCanEdit(projectId);
  if (q.isPending) {
    return (
      <ul className={a.grid} role="status" aria-busy="true" aria-label="Loading dashboards">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className={a.card} aria-hidden="true">
            <Skeleton className={a.skPrev} />
            <Skeleton className={a.skLine} />
            <Skeleton className={a.skMeta} />
          </li>
        ))}
      </ul>
    );
  }
  if (q.isError) return <ErrorState title="Dashboards could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const ready = q.data.filter((d) => d.ready);
  if (!ready.length) {
    return (
      <EmptyState
        icon="layout-dashboard"
        title="No dashboards are Ready yet"
        actions={
          // An editor's Create dashboard is the page header's; this is the way to the ones already built.
          <Link className={buttonClass(canEdit ? 'primary' : 'secondary')} to={`/analyses?project=${projectId}`}>
            <Icon name="layers" />
            <span>Go to Analyses</span>
          </Link>
        }
      >
        {canEdit
          ? 'This page lists the dashboards people should read. Dashboards are built in Analyses; switch Ready on at the top of one and it appears here. Nothing else about it changes.'
          : 'This page lists the dashboards people should read. One appears here once an editor of this project marks it Ready. You have view-only access.'}
      </EmptyState>
    );
  }
  return (
    <ul className={a.grid} aria-label="Ready dashboards">
      {ready.map((item) => (
        <li key={item.id} className={a.card}>
          <Link className={a.body} to={`/dashboards/${projectId}/${item.id}`}>
            <GalleryPreview projectId={projectId} item={item} />
            <span className={a.name}>{item.name || 'Untitled dashboard'}</span>
            <span className={a.meta}>
              {item.sheetCount} {item.sheetCount === 1 ? 'sheet' : 'sheets'} · Updated {ago(item.updatedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
