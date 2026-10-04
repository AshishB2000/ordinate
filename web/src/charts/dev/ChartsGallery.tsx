// /dev/charts — every chart id (39) drawn from the API over the sample
// dataset: one `visual:data` per distinct encoding (sampleEncodings.ts), each
// answer drawn by <Chart> or <DataTable>. The review surface for the chart
// engine and what web/e2e/charts.e2e.ts drives. Not in the nav.

import { useState } from 'react';
import { useDatasets, type DatasetSummary } from '../../api/datasets';
import { useCurrentProject } from '../../features/projects/current';
import { useVizData } from '../../api/visuals';
import { EmptyState, ErrorState, Page, SkeletonRows } from '../../app/blocks';
import { Button } from '../../ui/Button';
import { SkeletonBlock } from '../../ui/Skeleton';
import { Chart, type ChartHandle } from '../Chart';
import { DataTable } from '../DataTable';
import { canvasToPng } from '../png';
import { SAMPLE_ENCODINGS } from '../sampleEncodings';
import { VIZ_IDS, VIZ_LABELS, VIZ_RENDERER, type VizId } from '../vizLabels';
import s from './ChartsGallery.module.css';

const SAMPLE_DATASET = 'Retail orders';

const NOTE = {
  grid: 'Drawn here as its {labels, series}; the grid itself lands with T1.2.',
  map: 'Drawn here as its {labels, series}; the map itself lands with T1.3.',
  table: '',
} as const;

function savePng(id: VizId, chart: ChartHandle): void {
  const a = document.createElement('a');
  a.href = canvasToPng(chart.canvas);
  a.download = `${id}.png`;
  a.click();
}

function Tile({ id, projectId, datasetId }: { id: VizId; projectId: string; datasetId: string }) {
  const q = useVizData({ projectId, datasetId, encoding: SAMPLE_ENCODINGS[id] });
  const [chart, setChart] = useState<ChartHandle | null>(null);
  const label = VIZ_LABELS[id];
  const renderer = VIZ_RENDERER[id];
  const titleId = `chart-${id}`;
  return (
    <section className={s.tile} aria-labelledby={titleId} data-chart-id={id}>
      <header className={s.head}>
        <h2 id={titleId} className={s.name}>
          {label}
        </h2>
        <code className={s.id}>{id}</code>
        {renderer !== 'table' && (
          <Button
            size="sm"
            variant="ghost"
            icon="download"
            disabled={!chart}
            aria-label={`Download ${label} as PNG`}
            onClick={() => chart && savePng(id, chart)}
          >
            PNG
          </Button>
        )}
      </header>
      {renderer && NOTE[renderer] && <p className={s.note}>{NOTE[renderer]}</p>}
      <div className={s.body}>
        {q.status === 'pending' ? (
          <SkeletonBlock label={`Loading ${label}`} />
        ) : q.isError ? (
          <ErrorState compact heading={3} title="No data for this chart" message={q.error.message} onRetry={() => void q.refetch()} />
        ) : renderer === 'table' ? (
          <DataTable data={q.data.data} label={label} />
        ) : (
          <Chart type={id} data={q.data.data} label={label} onChart={setChart} />
        )}
      </div>
    </section>
  );
}

function Gallery({ projectId, datasets }: { projectId: string; datasets: DatasetSummary[] }) {
  const ds = datasets.find((d) => d.name === SAMPLE_DATASET) ?? datasets[0];
  if (!ds) {
    return (
      <EmptyState icon="database" title="No dataset to draw">
        The gallery draws every chart over the bundled sample dataset ({SAMPLE_DATASET}). This project has no
        datasets.
      </EmptyState>
    );
  }
  return (
    <div className={s.grid}>
      {VIZ_IDS.map((id) => (
        <Tile key={id} id={id} projectId={projectId} datasetId={ds.id} />
      ))}
    </div>
  );
}

function ForProject({ projectId }: { projectId: string }) {
  const q = useDatasets(projectId);
  if (q.isPending) return <SkeletonRows label="Loading datasets" rows={3} />;
  if (q.isError) return <ErrorState title="Datasets could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  return <Gallery projectId={projectId} datasets={q.data} />;
}

export default function ChartsGallery() {
  // The current project (the shell's, T2.2): no second project list per load.
  const q = useCurrentProject();
  const project = q.project;
  return (
    <Page title="Charts" sub={`All ${VIZ_IDS.length} chart types, computed by the server over the sample dataset and drawn by the chart engine.`}>
      {q.status === 'pending' ? (
        <SkeletonRows label="Loading projects" rows={3} />
      ) : q.status === 'error' ? (
        <ErrorState title="Projects could not be loaded" message={q.error?.message ?? ''} onRetry={q.refetch} />
      ) : !project ? (
        <EmptyState icon="folder" title="No project to draw from">
          The gallery needs the sample project, which a new server seeds on first start.
        </EmptyState>
      ) : (
        <ForProject projectId={project.id} />
      )}
    </Page>
  );
}
