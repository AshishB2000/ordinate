// /data/captures?project=<id> — the Captures tab of Data (legacy
// captureList.ts): the project's screenshots the model has read, as a card
// grid. A capture is a project record: a card opens its own page (the
// screenshot beside the analysis), "Save as dataset" opens its table in the
// composer, and a new one is uploaded or pasted right here — the model reads
// it and its page opens. A viewer opens and reads captures: uploading, saving
// and deleting are an editor's, and the reader (whose paste listener would
// upload) is never mounted for them.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { Badge } from '../../ui/Badge';
import { Button, buttonClass } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useCanEdit } from '../projects/api';
import { useCaptures, type CaptureSummary } from './api';
import { ProjectGate } from './ProjectGate';
import { ScreenshotSource } from './ScreenshotSource';
import s from './Captures.module.css';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** `onDelete` absent: a viewer's card — it opens, it is not saved or deleted from here. */
function Card({ c, projectId, onDelete }: { c: CaptureSummary; projectId: string; onDelete?: () => void }) {
  const save = `/data/import?project=${projectId}&capture=${encodeURIComponent(c.id)}`;
  return (
    <li className={s.capCard}>
      <Link className={s.capBody} to={`/data/captures/${projectId}/${encodeURIComponent(c.id)}`}>
        <span className={s.capTile}>
          {c.thumb ? (
            <img className={s.capImg} src={c.thumb} alt="" draggable={false} />
          ) : (
            <span className={s.capNoImg} aria-hidden="true">
              <Icon name="camera" size={24} />
            </span>
          )}
        </span>
        <span className={s.capName}>{c.title || 'Capture'}</span>
        <time className={s.capMeta} dateTime={c.updatedAt}>
          {when.format(new Date(c.updatedAt))}
        </time>
      </Link>
      {c.datasetId && (
        <span className={s.capBadge}>
          <Badge tone="accent">Dataset</Badge>
        </span>
      )}
      {(c.datasetId || onDelete) && (
        <div className={s.capActs}>
          {c.datasetId ? (
            <Link className={buttonClass('secondary', 'sm')} to={`/data/${projectId}/${c.datasetId}`}>
              Open dataset
            </Link>
          ) : (
            onDelete && (
              <Link className={buttonClass('secondary', 'sm')} to={save}>
                Save as dataset
              </Link>
            )
          )}
          {onDelete && (
            <Button size="sm" variant="ghost" icon="trash" onClick={onDelete} aria-label={`Delete ${c.title || 'capture'}`}>
              Delete
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function Captures({ projectId }: { projectId: string }) {
  const q = useCaptures(projectId);
  const client = useQueryClient();
  const [deleting, setDeleting] = useState<CaptureSummary | null>(null);
  const navigate = useNavigate();
  const [uploading, setUploading] = useState(false);
  const canEdit = useCanEdit(projectId);
  // The drop zone, the model's progress and its typed errors — here, not on Bring data in.
  const reader = (
    <section className={s.capUpload} aria-label="Upload a screenshot">
      <ScreenshotSource projectId={projectId} onRead={(id) => void navigate(`/data/captures/${projectId}/${encodeURIComponent(id)}`)} />
    </section>
  );
  const remove = async (c: CaptureSummary) => {
    setDeleting(null);
    try {
      const r = (await rpc('captureDataset:delete', { projectId, captureId: c.id })) as { ok: boolean; error?: string };
      if (!r.ok) toast(r.error || 'The capture could not be deleted.', { kind: 'error' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The capture could not be deleted.', { kind: 'error' });
    }
    void client.invalidateQueries({ queryKey: ['captureDataset:list', projectId] });
  };

  let body;
  if (q.isPending) {
    body = (
      <ul className={s.capGrid} role="status" aria-busy="true" aria-label="Loading captures">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className={s.capCard} aria-hidden="true">
            <Skeleton className={s.capSkTile} />
            <Skeleton className={s.capSkLine} />
          </li>
        ))}
      </ul>
    );
  } else if (q.isError) {
    body = <ErrorState title="Captures could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  } else if (q.data.length === 0) {
    // No captures yet: for an editor the way to make the first one IS the empty state.
    body = canEdit ? (
      reader
    ) : (
      <EmptyState icon="camera" title="No captures in this project">
        A capture is a screenshot of a table — a report, a dashboard, a page — read into rows. An editor of this project can upload one. You have view-only
        access.
      </EmptyState>
    );
  } else {
    body = (
      <ul className={s.capGrid} aria-label="Captures">
        {q.data.map((c) => (
          <Card key={c.id} c={c} projectId={projectId} onDelete={canEdit ? () => setDeleting(c) : undefined} />
        ))}
      </ul>
    );
  }
  return (
    <Page title="Captures" sub="Screenshots the model has read in this project.">
      {canEdit && q.data && q.data.length > 0 && (
        <>
          <div className={s.capBar}>
            <Button variant={uploading ? 'secondary' : 'primary'} icon={uploading ? 'x' : 'camera'} aria-expanded={uploading} onClick={() => setUploading(!uploading)}>
              {uploading ? 'Cancel' : 'Upload a screenshot'}
            </Button>
          </div>
          {uploading && reader}
        </>
      )}
      {body}
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        size="sm"
        title="Delete this capture?"
        description="Its screenshot and analysis are deleted. A dataset saved from it stays."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete
            </Button>
          </>
        }
      />
    </Page>
  );
}

export default function CapturesPage() {
  return (
    <ProjectGate title="Captures" why="Captures belong to a project.">
      {(projectId) => <Captures key={projectId} projectId={projectId} />}
    </ProjectGate>
  );
}
