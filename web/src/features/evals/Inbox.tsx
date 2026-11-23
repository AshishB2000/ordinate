// The thumbs-down inbox (docs/eval-suites/00-design.md, the owner's answer to Q1): the QUESTIONS people marked as a bad answer, with the
// agent and the reason, never the answer or its figures and never who asked. An editor adds one to a suite, with what a good answer says
// or that it should be refused, or dismisses it.

import { useState } from 'react';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { day } from '../data/format';
import { REASONS } from '../assistant/Thumbs';
import { AddToTestsDialog } from './AddToTests';
import { useEvalCall, useInbox, type InboxItem } from './api';
import s from './Evals.module.css';
import a from '../assistant/setup/Assistant.module.css';

const REASON = new Map<string, string>(REASONS.map((r) => [r.id, r.label]));

export function Inbox({ projectId }: { projectId: string }) {
  const q = useInbox(projectId, true);
  const call = useEvalCall(projectId);
  const [adding, setAdding] = useState<InboxItem | null>(null);
  const items = q.data?.items ?? [];
  if (q.data && q.data.available === false) return null; // without a database there is no inbox
  const dismiss = async (it: InboxItem) => {
    const r = await call('feedback:dismiss', { turnId: it.turnId });
    if (!r.ok) toast(r.error || 'That did not work.', { kind: 'error' });
  };
  let body;
  if (q.isPending) body = <SkeletonRows rows={2} label="Loading the thumbs-down questions" />;
  else if (q.isError) body = <ErrorState heading={3} title="The thumbs-down questions could not be loaded" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  else if (!items.length) {
    body = (
      <EmptyState icon="thumbs-down" heading={3} title="No thumbs-down questions waiting">
        When someone marks an answer as bad, its question lands here. You never see the answer, only the question, the assistant and the reason.
      </EmptyState>
    );
  } else {
    body = (
      <div className={a.card}>
        <ul className={s.cases} aria-label="Thumbs-down questions">
          {items.map((it) => (
            <li key={it.turnId} className={s.caseRow} data-testid="inbox-row">
              <div className={s.caseBody}>
                <p className={s.caseQuestion}>{it.question}</p>
                <p className={s.caseMeta}>
                  {[it.agentName ?? 'Project assistant', Number.isNaN(Date.parse(it.createdAt)) ? '' : day.format(new Date(it.createdAt))].filter(Boolean).join(' · ')}
                </p>
              </div>
              {it.reason && <Badge tone="warn">{REASON.get(it.reason) ?? it.reason}</Badge>}
              <span className={s.rowActions}>
                <Button size="sm" icon="circle-check" onClick={() => setAdding(it)}>Add to tests</Button>
                <IconButton icon="x" size="sm" label={`Dismiss “${it.question}”`} onClick={() => void dismiss(it)} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <section className={a.section} aria-labelledby="thumbs-inbox-h">
      <div className={a.head}>
        <div>
          <div className={a.titleRow}>
            <h2 className={a.title} id="thumbs-inbox-h">Thumbs-down questions</h2>
            {!!items.length && <Badge>{items.length}</Badge>}
          </div>
          <p className={a.sub}>Questions people marked as a bad answer. Turn the useful ones into tests.</p>
        </div>
      </div>
      {body}
      {adding && <AddToTestsDialog projectId={projectId} source={{ kind: 'inbox', turnId: adding.turnId }} agentId={adding.agentId} onClose={() => setAdding(null)} />}
    </section>
  );
}
