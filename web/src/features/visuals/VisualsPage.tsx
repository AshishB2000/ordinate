
// /visuals — the gallery (visuals.ts + vizGallery.ts + vizThumbs.ts): the
// current project's saved visuals as cards with live thumbnails, favourites
// first; with none, the empty state that starts you from a dataset. "+ New
// visual" asks which dataset and how (NewVisualDialog), then opens the builder
// route. /visuals/:projectId names the project (and makes it the current one).

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useDatasets, type DatasetSummary } from '../../api/datasets';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { useAiStatus } from '../assistant/api';
import { AiNotReady } from '../assistant/AiNotReady';
import { pickDockProject, setDockOpen } from '../assistant/dockState';
import { useVisualsProject } from './project';
import { useCanEdit } from '../projects/api';
import { NoProject } from '../projects/NoProject';
import { toastMovedToTrash } from '../projects/trashToast';
import { deleteVisual, duplicateVisual, explainVisual, updateVisual, useRefreshVisuals, useVisualList, type VisualSummary } from './api';
import { NameDialog } from './NameDialog';
import { NewVisualDialog, type NewChoice } from './NewVisualDialog';
import { VisualCard, type CardActions } from './VisualCard';
import { VizIcon } from './VizIcon';
import s from './Visuals.module.css';

const TITLE = 'Visuals';
const SUB = 'Saved charts you can drop into any dashboard.';
const START_MAX = 6;
const rowsFmt = new Intl.NumberFormat();

export default function VisualsPage() {
  const { projectId: routeId } = useParams();
  const { cur, projectId, stale } = useVisualsProject(routeId);
  if (cur.status === 'pending') return <PageSkeleton />;
  if (cur.status === 'error') {
    return (
      <Page title={TITLE}>
        <ErrorState title="Projects could not be loaded" message={cur.error?.message ?? ''} onRetry={cur.refetch} />
      </Page>
    );
  }
  if (stale) return <Navigate to="/visuals" replace />;
  if (!projectId) {
    return (
      <Page title={TITLE} sub={SUB}>
        <NoProject why="A visual belongs to a project and reads one of its datasets." />
      </Page>
    );
  }
  return <Gallery key={projectId} projectId={projectId} />;
}

/** Where a choice in the New visual dialog lands: the builder, on that dataset. */
export function builderPath(projectId: string, choice: NewChoice): string {
  return `/visuals/${projectId}/new?dataset=${encodeURIComponent(choice.datasetId)}`;
}

function Gallery({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const list = useVisualList(projectId);
  const refresh = useRefreshVisuals(projectId);
  const [creating, setCreating] = useState<{ datasetId?: string; startAtSuggest?: boolean } | null>(null);
  const [renaming, setRenaming] = useState<VisualSummary | null>(null);
  const canEdit = useCanEdit(projectId);

  const go = (choice: NewChoice) => {
    setCreating(null);
    void navigate(builderPath(projectId, choice), { state: choice.kind === 'suggested' ? { encoding: choice.encoding, chartType: choice.chartType } : null });
  };

  const actions: CardActions = {
    open: (v) => void navigate(`/visuals/${projectId}/${v.id}`),
    favorite: (v, next) =>
      void updateVisual(projectId, v.id, { favorite: next })
        .catch((e: Error) => toast(e.message, { kind: 'error' }))
        .finally(() => refresh(v.id)),
    rename: setRenaming,
    duplicate: (v) =>
      void duplicateVisual(projectId, v.id).then(
        (copy) => {
          refresh();
          toast(`Made “${copy.name}”.`, { kind: 'success' });
        },
        (e: Error) => toast(e.message, { kind: 'error' }),
      ),
    explain: (v) =>
      void explainVisual(projectId, v.id).then(
        () => {
          pickDockProject(projectId);
          setDockOpen(true);
        },
        (e: Error) => toast(e.message, { kind: 'error' }),
      ),
    history: (v) => void navigate(`/versions/${projectId}/visual/${v.id}`),
    // To the Trash, with Undo on the toast — no confirm for a delete that can be taken back.
    remove: (v) =>
      void deleteVisual(projectId, v.id).then((reply) => {
        refresh(v.id);
        toastMovedToTrash(client, { projectId, type: 'visual', id: v.id, name: v.name }, reply);
      }),
  };

  const count = list.data?.length ?? 0;
  return (
    <Page title={TITLE} sub={SUB}>
      <div className={s.toolbar}>
        <span className={s.spacer} />
        {count > 0 && <span className={s.count}>{count === 1 ? '1 visual' : `${count} visuals`}</span>}
        {canEdit && (
          <Button variant="primary" icon="plus" onClick={() => setCreating({})}>
            New visual
          </Button>
        )}
      </div>

      {list.isPending ? (
        <div className={s.grid} role="status" aria-busy="true" aria-label="Loading visuals">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={s.cardSkel} aria-hidden="true">
              <Skeleton className={s.cardSkelTile} />
              <Skeleton className={s.cardSkelLine} />
              <Skeleton className={s.cardSkelLine} />
            </div>
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState title="Your visuals could not be loaded" message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.data.length > 0 ? (
        <div className={s.grid}>
          {list.data.map((v) => (
            <VisualCard key={`${v.id}:${v.updatedAt}`} projectId={projectId} v={v} actions={actions} canEdit={canEdit} />
          ))}
        </div>
      ) : canEdit ? (
        <Empty projectId={projectId} onNew={setCreating} />
      ) : (
        <EmptyState icon="chart-bar" title="No visuals yet">
          An editor of this project can build visuals from its data. You have view-only access.
        </EmptyState>
      )}

      {creating && (
        <NewVisualDialog
          projectId={projectId}
          datasetId={creating.datasetId}
          startAtSuggest={creating.startAtSuggest}
          onClose={() => setCreating(null)}
          onChoose={go}
        />
      )}
      {renaming && (
        <NameDialog
          name={renaming.name}
          onClose={() => setRenaming(null)}
          onRename={(name) =>
            updateVisual(projectId, renaming.id, { name }).then(() => {
              refresh(renaming.id);
              setRenaming(null);
            })
          }
        />
      )}
    </Page>
  );
}

/** No visuals yet: the glyph cluster, what a visual is, the two doors, then the project's datasets. */
function Empty({ projectId, onNew }: { projectId: string; onNew: (o: { datasetId?: string; startAtSuggest?: boolean }) => void }) {
  const navigate = useNavigate();
  const ds = useDatasets(projectId);
  const ai = useAiStatus();
  const aiReady = !!ai.data?.ready;
  const sets: DatasetSummary[] = ds.data ?? [];
  return (
    <>
      <section className={s.empty} aria-labelledby="viz-empty-h">
        <div className={s.art} aria-hidden="true">
          {['column', 'line', 'donut', 'treemap'].map((t, i) => (
            <span key={t} className={i === 1 ? `${s.artGlyph} ${s.artFocus}` : s.artGlyph}>
              <VizIcon type={t} />
            </span>
          ))}
        </div>
        <h2 id="viz-empty-h" className={s.emptyH}>
          No visuals yet
        </h2>
        <p className={s.emptyP}>
          A visual is one saved chart — build it once, then drop it into any dashboard, or export it on its own. Every number is computed by the
          app.
        </p>
        <div className={s.emptyActions}>
          <Button variant="primary" size="lg" icon="plus" onClick={() => onNew({})}>
            New visual
          </Button>
          <Button variant="ghost" size="lg" icon="sparkles" disabled={!aiReady} onClick={() => onNew({ startAtSuggest: true })}>
            Start with the Assistant
          </Button>
        </div>
        {ai.data && !aiReady && <AiNotReady status={ai.data} className={s.hint} />}
      </section>

      <section className={s.start} aria-labelledby="viz-start-h">
        <div className={s.startHead}>
          <h3 id="viz-start-h" className={s.startH}>
            Start from a dataset
          </h3>
          {sets.length > START_MAX && (
            <Button size="sm" variant="ghost" onClick={() => void navigate('/data')}>
              See all in Data
            </Button>
          )}
        </div>
        {ds.isPending ? (
          <div className={s.startGrid} role="status" aria-busy="true" aria-label="Loading datasets">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className={s.cardSkelTile} />
            ))}
          </div>
        ) : ds.isError ? (
          <ErrorState compact heading={3} title="Datasets could not be loaded" message={ds.error.message} onRetry={() => void ds.refetch()} />
        ) : (
          <div className={s.startGrid}>
            {sets.length === 0 ? (
              <div className={s.noData}>
                <h4 className={s.noDataH}>No data yet</h4>
                <p className={s.noDataP}>Import a CSV, paste a table, or connect a source — then build your first visual.</p>
                <Button variant="primary" onClick={() => void navigate('/data')}>
                  Import data
                </Button>
              </div>
            ) : (
              sets.slice(0, START_MAX).map((d) => (
                <button key={d.id} type="button" className={s.dsCard} onClick={() => onNew({ datasetId: d.id })}>
                  <span className={s.dsName}>{d.name || 'Untitled dataset'}</span>
                  <span className={s.dsMeta}>
                    {rowsFmt.format(d.rowCount)} rows · {rowsFmt.format(d.columnCount)} columns
                  </span>
                  <span className={s.dsKind}>{d.sourceKind || 'csv'}</span>
                </button>
              ))
            )}
          </div>
        )}
      </section>
    </>
  );
}
