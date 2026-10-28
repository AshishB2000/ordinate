// /analyses/:projectId/:analysisId — one dashboard open for authoring
// (legacy openAnalysis + the workbench). Loads the record and the project's
// visuals in one call, then hands them to the editor, which owns them until
// the page is left; the cached copy is dropped on the way out so the next
// open reads what was saved. `viewing`: the same page opened from the
// Dashboards page (dashboards/DashboardViewPage), read-only for everyone.

import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { useRoles } from '../projects/api';
import { useAdoptProject } from '../projects/current';
import { useOpenAnalysis } from './api';
import { Editor } from './editor/Editor';
import { useReload } from '../editConflicts/useEditGuard';
import s from './editor/Editor.module.css';

function Loading() {
  return (
    <div className={s.editor} role="status" aria-busy="true" aria-label="Opening the dashboard">
      <div className={s.head}>
        <div className={s.headRow}>
          <Skeleton className={s.skName} />
        </div>
        <div className={s.headRow}>
          <Skeleton className={s.skTabs} />
        </div>
      </div>
      <div className={s.bench}>
        <div className={s.rail} />
        <div className={s.sheet}>
          <div className={s.skGrid}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className={s.skCard} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AuthoringPage({ viewing = false }: { viewing?: boolean }) {
  const { projectId = '', analysisId = '' } = useParams();
  useAdoptProject(projectId);
  const q = useOpenAnalysis(projectId, analysisId);
  // After a conflict, Reload: the record read again, in a new editor.
  const { gen, reload } = useReload(['analysis:open', projectId, analysisId]);
  // The caller's role decides whether this opens to edit or to read; wait for it, so the tools never flash.
  const roles = useRoles();
  const client = useQueryClient();
  useEffect(() => () => client.removeQueries({ queryKey: ['analysis:open', projectId, analysisId] }), [client, projectId, analysisId]);
  const back = (
    <Link className={buttonClass('primary')} to={`/${viewing ? 'dashboards' : 'analyses'}?project=${projectId}`}>
      Back to {viewing ? 'Dashboards' : 'Analyses'}
    </Link>
  );

  if (q.isPending || roles.isPending) return <Loading />;
  if (q.isError) {
    return (
      <Page title="Dashboard">
        <ErrorState title="That dashboard could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  if (!q.data.ok) {
    return (
      <Page title="Dashboard">
        <EmptyState icon="layout-dashboard" title="That dashboard could not be loaded" actions={back}>
          It may have been moved to the Trash, or it belongs to a project you cannot open.
        </EmptyState>
      </Page>
    );
  }
  const role = roles.data?.[projectId];
  return (
    <Editor
      key={`${analysisId}:${gen}`}
      projectId={projectId}
      analysis={q.data.analysis}
      visuals={q.data.visuals}
      tag={q.data.tag}
      onReload={reload}
      readOnly={viewing || (role !== 'editor' && role !== 'admin')}
      viewing={viewing}
    />
  );
}
