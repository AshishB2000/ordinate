// An admin's look at what moved since an item was certified, and the one button that certifies it again.
// `model:review` is read when this opens; Certify sends the pin it returned as `base`, so a definition that moved while
// the dialog was open is refused by the server (409) and the diff reloads: nothing is certified unseen.

import { useState } from 'react';
import { RpcError } from '../../../api/client';
import { EmptyState, ErrorState } from '../../../app/blocks';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Textarea } from '../../../ui/Field';
import { SkeletonRows } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { useVersionDiff, useVersions, type VersionType } from '../../projects/api';
import { VersionCompare } from '../../projects/VersionCompare';
import { refOf, useReview, useStatusActions } from './api';
import { StatusBadge } from './StatusBadge';
import type { StatusKind } from './status';
import s from './Status.module.css';

export const UNCHANGED = 'The definition is unchanged. Something it uses changed: a metric or term it names, or its dataset.';

function Compare({ projectId, kind, id, from, to }: { projectId: string; kind: StatusKind; id: string; from: string; to: string }) {
  const type = kind as VersionType; // the server keeps a term's history too; the web's type predates it
  const versions = useVersions(projectId, type, id);
  const diff = useVersionDiff(projectId, type, id, from, to);
  const [pick, setPick] = useState({ from, to });
  if (versions.isPending || diff.isPending) return <SkeletonRows rows={4} label="Comparing with the certified version" />;
  if (versions.isError || diff.isError) return <ErrorState compact heading={3} title="The two versions could not be compared" message={(versions.error ?? diff.error)?.message ?? ''} />;
  if (pick.from === from && pick.to === to && diff.data.changes.length === 0) {
    return (
      <EmptyState compact heading={3} icon="circle-check" title="Nothing in the definition moved">
        {UNCHANGED}
      </EmptyState>
    );
  }
  return <VersionCompare projectId={projectId} type={type} id={id} versions={versions.data} from={pick.from} to={pick.to} onPick={(f, t) => setPick({ from: f, to: t })} onClose={() => setPick({ from, to })} noRestore />;
}

export function ReviewDialog({ projectId, kind, id, name, onClose }: { projectId: string; kind: StatusKind; id: string; name: string; onClose: () => void }) {
  const ref = refOf(kind, id);
  const review = useReview(projectId, ref);
  const { certify } = useStatusActions(projectId);
  const [note, setNote] = useState('');
  const [stale, setStale] = useState<string | null>(null);
  const r = review.data;
  const go = () => {
    if (!r) return;
    certify.mutate(
      { ref, base: r.pin, ...(note.trim() && { note: note.trim() }) },
      {
        onSuccess: (reply) => {
          if (reply.ok) {
            toast(`${name} is certified.`, { kind: 'success' });
            onClose();
          }
        },
        onError: (err) => {
          if (err instanceof RpcError && err.status === 409) {
            setStale(err.message); // never certify what the admin did not see: show the sentence and read it again
            void review.refetch();
          } else toast(err.message, { kind: 'error' });
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Review ${name}`}
      description="Certify it once you have read what changed since it was last certified."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" icon="circle-check" disabled={!r} loading={certify.isPending} onClick={go}>
            Certify
          </Button>
        </>
      }
    >
      {review.isPending ? (
        <SkeletonRows rows={4} label="Loading the review" />
      ) : review.isError && !r ? (
        <ErrorState compact heading={3} title="It could not be reviewed" message={review.error.message} onRetry={() => void review.refetch()} />
      ) : (
        r && (
          <div className={s.review}>
            <div className={s.reviewHead}>
              <StatusBadge status={r.status} />
              {!r.status && <span className={s.muted}>Not certified yet. Certifying records this definition as it is now.</span>}
            </div>
            {stale && (
              <p className={s.stale} role="alert">
                {stale}
              </p>
            )}
            {r.status?.versionKey && r.newestKey && <Compare key={r.pin} projectId={projectId} kind={kind} id={id} from={r.status.versionKey} to={r.newestKey} />}
            <Textarea label="Note (optional)" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )
      )}
    </Dialog>
  );
}
