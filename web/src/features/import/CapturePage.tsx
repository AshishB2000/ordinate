// /data/captures/:projectId/:captureId — one capture's own page (the desktop's
// capture result surface): the screenshot beside what was read out of it, and
// the question a capture exists to ask — "Want an analysis built from this?".
//
// Nothing here is computed in the browser. The narration and the follow-up
// questions are the model's words; the headline's figures, the metric lines and
// the chart's `{labels, series}` are the server's (captureDataset:get), drawn
// through the same <Chart> every visual uses. The table is the model's READING
// of an image, which is why "Build an analysis" goes through the composer,
// where every cell can be corrected, before anything is built on it.

import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Chart } from '../../charts/Chart';
import { VIZ_LABELS, VIZ_RENDERER, type VizId } from '../../charts/vizLabels';
import { Badge } from '../../ui/Badge';
import { buttonClass } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Skeleton } from '../../ui/Skeleton';
import { Icon } from '../../ui/icons/Icon';
import { openDockWith } from '../assistant/dockState';
import { useCanEdit } from '../projects/api';
import { useCapture, useCaptureImage, type CaptureView } from './api';
import s from './Capture.module.css';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** Rows drawn on this page; the composer pages every row. */
const TABLE_ROWS = 100;

/** The suggested chart ids <Chart> itself draws (a table, a grid or a map has a renderer of its own). */
function drawable(view: CaptureView): VizId[] {
  if (!view.chart.series.length) return [];
  const ids = view.chartTypes.filter((t): t is VizId => t in VIZ_LABELS && !VIZ_RENDERER[t as VizId]);
  return ids.length ? [...new Set(ids)] : ['column'];
}

function Shot({ projectId, view }: { projectId: string; view: CaptureView }) {
  const img = useCaptureImage(projectId, view.id, view.hasImage);
  const [open, setOpen] = useState(false);
  let body;
  if (view.hasImage && img.isPending) body = <Skeleton className={s.shotSkel} />;
  else if (img.data) {
    body = (
      <button type="button" className={s.shotBtn} onClick={() => setOpen(true)} aria-label="Enlarge the screenshot">
        <img className={s.shotImg} src={img.data} alt={`Screenshot: ${view.title}`} draggable={false} />
        <span className={s.shotHint} aria-hidden="true">
          <Icon name="maximize" size={12} />
          Enlarge
        </span>
      </button>
    );
  } else {
    body = (
      <div className={s.shotNone}>
        <Icon name="camera" size={24} />
        <span>{img.isError ? 'The screenshot could not be loaded.' : 'The screenshot is not stored with this capture.'}</span>
      </div>
    );
  }
  return (
    <section className={s.shot} aria-label="Screenshot">
      <h2 className={s.label}>Screenshot</h2>
      {body}
      {img.data && (
        <Dialog open={open} onOpenChange={setOpen} size="xxl" title={view.title}>
          <img className={s.shotFull} src={img.data} alt={`Screenshot: ${view.title}`} />
        </Dialog>
      )}
    </section>
  );
}

/** The question, and the two ways on: an analysis (through the cell check), or just the dataset. */
function Ask({ projectId, view }: { projectId: string; view: CaptureView }) {
  const composer = `/data/import?project=${projectId}&capture=${encodeURIComponent(view.id)}`;
  if (!view.table) {
    return (
      <div className={s.ask} data-tone="quiet">
        <div className={s.askText}>
          <h2 className={s.askTitle}>Nothing to build from yet</h2>
          <p className={s.askBody}>The model found no table in this screenshot, so there is no dataset to build an analysis on. A tighter screenshot of one chart or one table usually reads cleanly.</p>
        </div>
        <div className={s.askActs}>
          <Link className={buttonClass('secondary')} to={`/data/captures?project=${projectId}`}>
            <Icon name="camera" />
            <span>Try another screenshot</span>
          </Link>
        </div>
      </div>
    );
  }
  if (view.datasetId) {
    return (
      <div className={s.ask}>
        <div className={s.askText}>
          <h2 className={s.askTitle}>Want an analysis built from this?</h2>
          <p className={s.askBody}>This capture is already saved as a dataset. Start an analysis on it — a draft from the assistant, a template or a blank layout.</p>
        </div>
        <div className={s.askActs}>
          <Link className={buttonClass('primary')} to={`/analyses?project=${projectId}&new=1&dataset=${view.datasetId}`}>
            <Icon name="layout-dashboard" />
            <span>Build an analysis</span>
          </Link>
          <Link className={buttonClass('secondary')} to={`/data/${projectId}/${view.datasetId}`}>
            Open the dataset
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className={s.ask}>
      <div className={s.askText}>
        <h2 className={s.askTitle}>Want an analysis built from this?</h2>
        <p className={s.askBody}>
          You check the table the model read first — any cell can be corrected — then it is saved as a dataset and the analysis starts on it.
        </p>
      </div>
      <div className={s.askActs}>
        <Link className={buttonClass('primary')} to={`${composer}&then=analysis`}>
          <Icon name="layout-dashboard" />
          <span>Build an analysis</span>
        </Link>
        <Link className={buttonClass('secondary')} to={composer}>
          Just save as dataset
        </Link>
      </div>
    </div>
  );
}

function Figures({ view }: { view: CaptureView }) {
  const types = drawable(view);
  const [picked, setPicked] = useState<VizId | null>(null);
  const type = picked && types.includes(picked) ? picked : types[0];
  if (!type) return null;
  return (
    <section className={s.card} aria-label="Chart">
      <div className={s.cardHead}>
        <h2 className={s.label}>Chart</h2>
        {types.length > 1 && (
          <div className={s.types} role="group" aria-label="Chart type">
            {types.map((t) => (
              <button key={t} type="button" className={s.type} aria-pressed={t === type} onClick={() => setPicked(t)}>
                {VIZ_LABELS[t]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={s.chart}>
        <Chart type={type} data={view.chart} label={view.title} />
      </div>
    </section>
  );
}

function ReadTable({ view }: { view: CaptureView }) {
  const t = view.table;
  if (!t) return null;
  const rows = t.rows.slice(0, TABLE_ROWS);
  return (
    <section className={s.card} aria-label="What the model read">
      <div className={s.cardHead}>
        <h2 className={s.label}>What the model read</h2>
        {view.unsure && <Badge tone="warn">Check the cells</Badge>}
      </div>
      {view.unsure && <p className={s.note}>The model was unsure about some of what it read. Check the cells before you build on them — any of them can be corrected when you save.</p>}
      {t.warnings.map((w, i) => (
        <p key={i} className={s.note}>
          {w}
        </p>
      ))}
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              {t.columns.map((c, j) => (
                <th key={j} scope="col" data-type={c.type}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {t.columns.map((c, j) => (
                  <td key={j} data-type={c.type}>
                    {r[j] === null || r[j] === undefined ? '' : String(r[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.rows.length > TABLE_ROWS && <p className={s.note}>The first {TABLE_ROWS} rows. Every row opens in the composer.</p>}
    </section>
  );
}

function Capture({ projectId, view }: { projectId: string; view: CaptureView }) {
  // Saving a dataset and building an analysis are an editor's; a viewer reads the capture.
  const canEdit = useCanEdit(projectId);
  const at = view.createdAt ? new Date(view.createdAt) : null;
  return (
    <Page
      back={{ to: `/data/captures?project=${projectId}`, label: 'Captures' }}
      title={view.title}
      status={view.datasetId ? <Badge tone="accent">Dataset</Badge> : null}
      sub={`${at && !Number.isNaN(at.getTime()) ? `Captured ${when.format(at)}. ` : ''}What the model read out of this screenshot. Every figure is computed by Ordinate from the table it extracted.`}
    >
      <div className={s.layout}>
        <Shot projectId={projectId} view={view} />
        <div className={s.read}>
          <section className={s.card} aria-label="Analysis">
            <h2 className={s.label}>
              <Icon name="sparkles" size={12} />
              Analysis
            </h2>
            {view.headline && (
              <p className={s.headline}>
                {view.headline.map((seg, i) => (seg.bold ? <strong key={i}>{seg.text}</strong> : <span key={i}>{seg.text}</span>))}
              </p>
            )}
            {view.analysis && <p className={s.narration}>{view.analysis}</p>}
            {!view.headline && !view.analysis && <p className={s.note}>The model wrote no analysis for this screenshot.</p>}
            {view.followups.length > 0 && (
              <div className={s.followups} role="group" aria-label="Ask the assistant">
                {view.followups.map((q, i) => (
                  <button key={i} type="button" className={s.followup} onClick={() => openDockWith(q)}>
                    <Icon name="message-square" size={12} />
                    {q}
                  </button>
                ))}
              </div>
            )}
          </section>
          {canEdit && <Ask projectId={projectId} view={view} />}
          {view.metrics.length > 0 && (
            <section className={s.metrics} aria-label="Metrics">
              {view.metrics.map((m) => (
                <div key={m.id} className={s.metric}>
                  <h3 className={s.metricTitle}>{m.title}</h3>
                  <ul className={s.metricLines}>
                    {m.lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}
          <Figures view={view} />
          <ReadTable view={view} />
        </div>
      </div>
    </Page>
  );
}

export default function CapturePage() {
  const { projectId = '', captureId = '' } = useParams();
  const q = useCapture(projectId, captureId);
  const back = (
    <Link className={buttonClass('secondary')} to={`/data/captures?project=${projectId}`}>
      Back to Captures
    </Link>
  );
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <Page title="Capture">
        <ErrorState title="This capture could not be opened" message={q.error.message} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  if (!q.data.ok) {
    return (
      <Page title="Capture">
        <EmptyState icon="camera" title="This capture is gone" actions={back}>
          {q.data.error} It may have been deleted, or it belongs to another project.
        </EmptyState>
      </Page>
    );
  }
  return <Capture key={q.data.id} projectId={projectId} view={q.data} />;
}
