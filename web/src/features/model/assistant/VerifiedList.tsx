// The project's verified questions (semantic part 3 D7): each a question the team signed off, kept as its answer's
// definition, never its figures. Every row is the server's words — what it draws, who verified it and when, or why
// it no longer runs (never repaired: an editor deletes it or verifies it again). An editor edits one in place
// (./VerifiedDialog) or deletes it to the Trash behind the house confirm; a viewer only reads. A row whose values
// row access rules hide comes without its spec, so it offers no edit.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Badge } from '../../../ui/Badge';
import { IconButton } from '../../../ui/Button';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { day, formatNumber } from '../../data/format';
import { toastMovedToTrash } from '../../projects/trashToast';
import { useVerified, type VerifiedRow } from './api';
import { VerifiedDialog } from './VerifiedDialog';
import a from './Assistant.module.css';

function Row({ projectId, row, canEdit, onEdit }: { projectId: string; row: VerifiedRow; canEdit: boolean; onEdit: () => void }) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    let reply: { ok?: boolean } | null = null;
    try {
      reply = (await rpc('verified:delete', { projectId, id: row.id })) as { ok?: boolean };
    } catch {
      reply = null;
    }
    setBusy(false);
    setAsking(false);
    toastMovedToTrash(client, { projectId, type: 'verified', id: row.id, name: row.question }, reply);
    void client.invalidateQueries({ queryKey: ['verified:list', projectId] });
  };
  const when = Number.isNaN(Date.parse(row.verifiedAt)) ? '' : day.format(new Date(row.verifiedAt));
  const who = [row.verifiedBy, when].filter(Boolean).join(' · ');
  const what = [row.datasetName, row.describe, ...row.filters].filter(Boolean).join(' · ');
  return (
    <li className={`${a.vRow} ${row.runs ? '' : a.vBroken}`}>
      <span className={row.runs ? a.vMark : `${a.vMark} ${a.vMarkWarn}`} aria-hidden="true">
        <Icon name={row.runs ? 'check' : 'alert'} size={12} />
      </span>
      <div className={a.main}>
        <p className={a.question}>{row.question}</p>
        <p className={a.detail}>{what}</p>
        {!!row.phrasings.length && <p className={a.detail}>Also asked as {row.phrasings.map((p) => `“${p}”`).join(', ')}</p>}
        {row.note && <p className={a.note}>{row.note}</p>}
        {!row.runs && row.problem && (
          <p className={a.warn}>
            <Icon name="alert" size={12} />
            {row.problem}
          </p>
        )}
      </div>
      <div className={a.side}>
        {who && <span className={row.runs ? `${a.meta} ${a.vWho}` : a.meta}>{row.runs ? `✓ ${who}` : who}</span>}
        {canEdit && (
          <span className={a.actions}>
            {row.runs && row.spec ? <IconButton icon="pencil" size="sm" label="Edit" onClick={onEdit} /> : <span className={a.slot} aria-hidden="true" />}
            <IconButton icon="trash" size="sm" label="Delete" onClick={() => setAsking(true)} />
          </span>
        )}
      </div>
      {asking && (
        <ConfirmDelete
          title="Delete this verified question?"
          description={`“${row.question}” goes to the Trash for 30 days, and its answers lose their ✓ Verified mark.`}
          busy={busy}
          onConfirm={() => void remove()}
          onClose={() => setAsking(false)}
        />
      )}
    </li>
  );
}

export function VerifiedList({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const q = useVerified(projectId);
  const [editing, setEditing] = useState<string | null>(null);
  const list = q.data?.questions ?? [];
  const broken = q.data?.broken ?? 0;
  const open = list.find((r) => r.id === editing);

  let body;
  if (q.isPending) body = <SkeletonRows rows={3} label="Loading the verified questions" />;
  else if (q.isError) body = <ErrorState heading={3} title="The verified questions could not be loaded" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  else if (!list.length) {
    body = (
      <EmptyState icon="circle-check" heading={3} title="No verified questions yet">
        A verified question is answered the team’s way every time, by the app, without a model.
      </EmptyState>
    );
  } else {
    body = (
      <div className={a.card}>
        <ul className={a.vList} aria-label="Verified questions">
          {list.map((row) => (
            <Row key={row.id} projectId={projectId} row={row} canEdit={canEdit} onEdit={() => setEditing(row.id)} />
          ))}
        </ul>
        <p className={a.foot}>
          <Icon name="info" size={12} />
          Each keeps how its answer is worked out, never the figures: every time it is asked, the app draws it again from today’s data.
        </p>
      </div>
    );
  }

  return (
    <section className={a.section} aria-labelledby="verified-h">
      <div className={a.head}>
        <div>
          <div className={a.titleRow}>
            <h2 className={a.title} id="verified-h">
              Verified questions
            </h2>
            {!!list.length && <Badge>{formatNumber(list.length)}</Badge>}
            {broken > 0 && (
              <Badge tone="warn" icon="alert">
                {`${formatNumber(broken)} no longer runs`}
              </Badge>
            )}
          </div>
          <p className={a.sub}>Questions the team checked, with the answer the Assistant gives every time.</p>
        </div>
      </div>
      {body}
      {open?.spec && <VerifiedDialog projectId={projectId} row={{ ...open, spec: open.spec }} onClose={() => setEditing(null)} />}
    </section>
  );
}
