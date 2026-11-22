// Model → Assistant → Issues (docs/issues-board/00-design.md): where the Assistant struggled, found by a weekly read of stored answers
// (no new query), grouped by cause, with a suggested fix. Editors read and work it; the project's admin switches the check on.
// Editors see question text and the reason, never an answer (the owner's answer to Q1).

import { useSearchParams } from 'react-router';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useCan } from '../projects/api';
import { day } from '../data/format';
import { useBoard, useIssueCall, type Settings } from './api';
import { IssueCard } from './IssueCard';
import s from './Issues.module.css';
import a from '../model/assistant/Assistant.module.css';

function Bar({ projectId, st }: { projectId: string; st: Settings }) {
  const call = useIssueCall(projectId);
  const admin = useCan(projectId)('admin');
  const last = st.lastRunAt && !Number.isNaN(Date.parse(st.lastRunAt)) ? day.format(new Date(st.lastRunAt)) : '';
  const change = async (channel: 'issues:setEnabled' | 'issues:checkNow', input: Record<string, unknown>, done: string) => {
    try {
      const r = await call.mutateAsync({ channel, input });
      toast(r.ok ? done : r.error || 'That did not work.', { kind: r.ok ? 'success' : 'error' });
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'That did not work.', { kind: 'error' });
    }
  };
  return (
    <div className={s.bar}>
      <div className={s.barText}>
        <p className={s.barTitle}>
          Weekly check {st.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
        </p>
        <p className={st.lastError ? `${s.barNote} ${s.warn}` : s.barNote}>
          {st.lastError ? 'The last check could not finish. It tries again.' : st.enabled ? (last ? `Last checked ${last}. It reads stored answers only and runs no query.` : 'It runs within a few hours, then once a week. It reads stored answers only and runs no query.') : admin ? 'Off. Turn it on to read last week’s answers for where the Assistant struggled.' : 'Off. A project admin turns it on.'}
        </p>
      </div>
      {admin && (
        <div className={s.barActions}>
          <Switch label="Check every week" checked={st.enabled} disabled={call.isPending} onCheckedChange={(on) => void change('issues:setEnabled', { enabled: on }, on ? 'The weekly check is on.' : 'The weekly check is off.')} />
          {st.enabled && <Button size="sm" icon="refresh" loading={call.isPending} onClick={() => void change('issues:checkNow', {}, 'Checked.')}>Check now</Button>}
        </div>
      )}
    </div>
  );
}

export function IssuesSection({ projectId }: { projectId: string }) {
  const q = useBoard(projectId);
  const [params] = useSearchParams();
  const asked = params.get('issue') ?? '';
  const board = q.data && q.data.ok ? q.data : null;
  if (board && !board.available) return null; // without a database there is no board
  let body;
  if (q.isPending) body = <SkeletonRows rows={2} label="Loading the issues" />;
  else if (q.isError || (q.data && !q.data.ok)) body = <ErrorState heading={3} title="The issues could not be loaded" message={q.error?.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  else if (board && !board.issues.length) {
    body = (
      <EmptyState icon="circle-check" heading={3} title="No issues yet">
        Once the weekly check is on, it finds the questions the Assistant could not answer and groups them here. A group shows up when three questions share a cause.
      </EmptyState>
    );
  } else if (board) {
    body = (
      <ul className={s.list} aria-label="Issues">
        {board.issues.map((i) => <IssueCard key={i.id} projectId={projectId} issue={i} trackers={board.trackers} current={i.id === asked} />)}
      </ul>
    );
  }
  const open = board?.issues.filter((i) => i.status === 'open').length ?? 0;
  return (
    <section className={a.section} aria-labelledby="issues-h">
      <div className={a.head}>
        <div>
          <div className={a.titleRow}>
            <h2 className={a.title} id="issues-h">Issues</h2>
            {open > 0 && <Badge>{open} open</Badge>}
          </div>
          <p className={a.sub}>Where the Assistant struggled, from stored answers. You see the questions and why, never the answers.</p>
        </div>
      </div>
      {board && <Bar projectId={projectId} st={board.settings} />}
      {body}
    </section>
  );
}
