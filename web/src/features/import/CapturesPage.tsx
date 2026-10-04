// /data/captures?project=<id> — the Captures tab of Data (legacy
// captureList.ts): the project's screenshots the model has read, as a card
// grid. A capture is a project record and a SOURCE: "Save as dataset" opens
// its table in the composer, a card that already became a dataset links to
// it, and a new one comes from "Upload a screenshot".

import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { Badge } from '../../ui/Badge';
import { Button, buttonClass } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useCaptures, type CaptureSummary } from './api';
import { ProjectGate } from './ProjectGate';
import s from './Captures.module.css';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Card({ c, projectId, onDelete }: { c: CaptureSummary; projectId: string; onDelete: () => void }) {
  const save = `/data/import?project=${projectId}&capture=${encodeURIComponent(c.id)}`;
  return (
    <li className={s.capCard}>
      <Link className={s.capBody} to={c.datasetId ? `/data/${projectId}/${c.datasetId}` : save}>
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
      <div className={s.capActs}>
        <Link className={buttonClass('secondary', 'sm')} to={save}>
          Save as dataset
        </Link>
        <Button size="sm" variant="ghost" icon="trash" onClick={onDelete} aria-label={`Delete ${c.title || 'capture'}`}>
          Delete
        </Button>
      </div>
    </li>
  );
}

function Captures({ projectId }: { projectId: string }) {
  const q = useCaptures(projectId);
  const client = useQueryClient();
  const [deleting, setDeleting] = useState<CaptureSummary | null>(null);
  const upload = (
    <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}&source=screenshot`}>
      <Icon name="camera" />
      <span>Upload a screenshot</span>
    </Link>
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
    body = (
      <EmptyState icon="camera" title="No captures yet" actions={upload}>
        Upload or paste a screenshot of any chart or table and the model reads the figures out of it. Save the ones that carry a table as a dataset.
      </EmptyState>
    );
  } else {
    body = (
      <ul className={s.capGrid} aria-label="Captures">
        {q.data.map((c) => (
          <Card key={c.id} c={c} projectId={projectId} onDelete={() => setDeleting(c)} />
        ))}
      </ul>
    );
  }
  return (
    <Page title="Captures" sub="Screenshots the model has read in this project.">
      {q.data && q.data.length > 0 && <div className={s.capBar}>{upload}</div>}
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
