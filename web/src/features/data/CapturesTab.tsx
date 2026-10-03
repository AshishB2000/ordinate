// The Captures tab (captureList.ts): this project's screenshots, newest first,
// each opening its dataset or — not saved yet — the importer on it. The full
// Captures page (T2.4, /data/captures) is where a capture is deleted.

import { Link } from 'react-router';
import { Badge } from '../../ui/Badge';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { useCaptures } from '../import/api';
import { stamp } from './format';
import s from './Data.module.css';

export function CapturesTab({ projectId }: { projectId: string }) {
  const q = useCaptures(projectId);
  const upload = `/data/import?project=${projectId}&source=screenshot`;
  if (q.isPending) return <SkeletonRows rows={4} label="Loading captures" />;
  if (q.isError) return <ErrorState heading={3} title="Captures could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  if (q.data.length === 0) {
    return (
      <EmptyState
        icon="camera"
        title="No captures in this project"
        heading={3}
        actions={
          <Link className={buttonClass('primary')} to={upload}>
            Upload a screenshot
          </Link>
        }
      >
        A capture is a screenshot of a table — a report, a dashboard, a page — read into rows you check before saving.
      </EmptyState>
    );
  }
  return (
    <section className={s.section} aria-label="Captures">
      <div className={s.listBar}>
        <Link className={buttonClass('primary', 'sm')} to={upload}>
          Upload a screenshot
        </Link>
        <Link className={buttonClass('ghost', 'sm', s.barEnd)} to={`/data/captures?project=${projectId}`}>
          Manage captures
        </Link>
      </div>
      <ul className={s.capList}>
        {q.data.map((c) => (
          <li key={c.id}>
            <Link className={s.capItem} to={c.datasetId ? `/data/${projectId}/${c.datasetId}` : `/data/import?project=${projectId}&capture=${encodeURIComponent(c.id)}`}>
              <span className={s.capThumb}>
                {c.thumb ? <img src={c.thumb} alt="" draggable={false} /> : <Icon name="camera" />}
              </span>
              <span className={s.capText}>
                <span className={s.strong}>{c.title || 'Capture'}</span>
                <span className={s.meta}>{stamp(c.updatedAt)}</span>
              </span>
              {c.datasetId ? <Badge tone="accent">Dataset</Badge> : <Badge>Not saved yet</Badge>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
