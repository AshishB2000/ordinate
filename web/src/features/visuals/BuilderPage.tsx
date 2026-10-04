// /visuals/:projectId/new?dataset=… and /visuals/:projectId/:visualId — the
// builder (vizBuilder.ts + visuals.ts): a header (Back, the name, the dataset,
// Suggest chart, Save), a controls rail (the encoding form) and a stage (the
// chart-type chips, the chart's controls, the chart). Every edit recomputes on
// the server through `visual:preview`; nothing is saved until Save, except a
// saved visual's styling, which is kept as you change it (as on the desktop).
//
// This file loads; ./Editor.tsx holds the editing state once everything the
// form needs has arrived, so the form starts from ONE settled encoding.

import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useDatasetColumns, useDatasets } from '../../api/datasets';
import { useVisualsProject } from './project';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Button } from '../../ui/Button';
import { useRelated, useVisual, type Encoding } from './api';
import { Editor, type Initial } from './Editor';
import { defaultEncoding, fitEncoding, type Column } from './model';
import { switchEncoding } from '../analytics/grids/gridEncoding';

export default function BuilderPage() {
  const { projectId: routeId, visualId } = useParams();
  const [params] = useSearchParams();
  const { cur, projectId, stale } = useVisualsProject(routeId);
  if (cur.status === 'pending') return <PageSkeleton />;
  if (cur.status === 'error') {
    return (
      <Page title="Visual">
        <ErrorState title="Projects could not be loaded" message={cur.error?.message ?? ''} onRetry={cur.refetch} />
      </Page>
    );
  }
  if (stale || !projectId) return <Navigate to="/visuals" replace />;
  const datasetParam = params.get('dataset') ?? undefined;
  return <Load key={visualId ?? `new:${datasetParam ?? ''}`} projectId={projectId} visualId={visualId} datasetParam={datasetParam} />;
}

function Load({ projectId, visualId, datasetParam }: { projectId: string; visualId?: string; datasetParam?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const datasets = useDatasets(projectId);
  const saved = useVisual(projectId, visualId);
  const datasetId = visualId ? saved.data?.datasetId : (datasetParam ?? datasets.data?.[0]?.id);
  const cols = useDatasetColumns(projectId, datasetId);
  const related = useRelated(projectId, datasetId);
  const back = () => void navigate(`/visuals/${projectId}`);

  if (datasets.isPending || (visualId && saved.isPending)) return <PageSkeleton />;
  if (datasets.isError || saved.isError) {
    const err = datasets.error ?? saved.error;
    return (
      <Page title="Visual">
        <ErrorState title="The builder could not be opened" message={err?.message ?? ''} onRetry={() => void (datasets.isError ? datasets.refetch() : saved.refetch())} />
      </Page>
    );
  }
  if (visualId && !saved.data) {
    return (
      <Page title="Visual">
        <EmptyState icon="chart-bar" title="That visual could not be loaded" actions={<Button onClick={back}>Back to Visuals</Button>}>
          It may have been deleted, or it belongs to another project.
        </EmptyState>
      </Page>
    );
  }
  if (!datasetId) {
    return (
      <Page title="New visual">
        <EmptyState
          icon="database"
          title="No dataset to build from"
          actions={
            <>
              <Button variant="primary" onClick={() => void navigate('/data')}>
                Import data
              </Button>
              <Button onClick={back}>Back to Visuals</Button>
            </>
          }
        >
          Import a dataset in the Data section first, then build a visual from it.
        </EmptyState>
      </Page>
    );
  }
  if (cols.isPending || related.isPending) return <PageSkeleton />;
  if (cols.isError || !cols.data) {
    return (
      <Page title="Visual">
        <ErrorState title="That dataset could not be loaded" message={cols.error?.message ?? 'It may have been deleted.'} onRetry={() => void cols.refetch()} />
      </Page>
    );
  }

  const columns: Column[] = cols.data.columns.map((c) => ({ name: c.name, type: c.type === 'number' || c.type === 'date' ? c.type : 'text' }));
  const rel = related.data ?? [];
  const suggested = location.state as { encoding?: Encoding; chartType?: string } | null;
  const v = saved.data ?? null;
  const preset = v ? v.encoding : suggested?.encoding;
  const initial: Initial = {
    visualId: v?.id,
    name: v?.name ?? '',
    datasetId,
    // A grid type opened from a door (/analytics) starts with its own shelves filled (T2.11).
    encoding: switchEncoding(preset ? fitEncoding(preset, columns, rel) : defaultEncoding(columns), 'column', v?.chartType ?? suggested?.chartType ?? '', columns),
    chartType: v?.chartType ?? suggested?.chartType ?? '',
    overrides: v?.overrides ?? {},
    filters: v?.filters ?? [],
    analytics: v?.analytics ?? [],
  };
  return <Editor projectId={projectId} datasets={datasets.data} columns={columns} related={rel} initial={initial} />;
}
