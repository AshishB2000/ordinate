// One issue on the board (docs/issues-board/00-design.md): what is wrong, how many questions and people, the suggested fix, a few of the
// questions (their words, never an answer or who asked) and the actions. Nothing here counts or derives a figure: the server's counts.

import { useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { day } from '../data/format';
import { KIND_LABEL, PROVIDER_LABEL, REASON_LABEL, useIssueCall, type Issue, type Provider } from './api';
import s from './Issues.module.css';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function IssueCard({ projectId, issue, trackers, current }: { projectId: string; issue: Issue; trackers: Record<Provider, boolean>; current: boolean }) {
  const call = useIssueCall(projectId);
  const [error, setError] = useState('');
  const run = async (channel: 'issues:setStatus' | 'issues:propose' | 'issues:send', input: Record<string, unknown>, done: string): Promise<void> => {
    setError('');
    try {
      const r = await call.mutateAsync({ channel, input: { id: issue.id, ...input } });
      if (!r.ok) setError(r.error || 'That did not work.');
      else toast(done, { kind: 'success' });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'That did not work.');
    }
  };
  const open = issue.status === 'open';
  const sent = new Set(issue.tickets.map((t) => t.provider));
  return (
    <li className={s.issue} data-status={issue.status} data-testid="issue" id={`issue-${issue.id}`} aria-current={current ? 'true' : undefined}>
      <div className={s.head}>
        <div className={s.titleBox}>
          <h3 className={s.title}>{issue.title}</h3>
          <p className={s.counts}>{plural(issue.questions, 'question', 'questions')} · {plural(issue.people, 'person', 'people')} affected</p>
        </div>
        <div className={s.badges}>
          {issue.kinds.map((k) => <Badge key={k.kind} tone="neutral">{KIND_LABEL[k.kind]}{issue.kinds.length > 1 ? ` · ${k.count}` : ''}</Badge>)}
          {issue.status !== 'open' && <Badge tone={issue.status === 'resolved' ? 'ok' : 'neutral'}>{issue.status === 'resolved' ? 'Resolved' : 'Ignored'}</Badge>}
          {issue.reopened > 0 && open && <Badge tone="warn">Came back</Badge>}
        </div>
      </div>
      {issue.fix && (
        <p className={s.fix}>
          <span className={s.fixLabel}>Suggested fix: </span>
          {issue.fix}
        </p>
      )}
      {issue.examples.length > 0 && (
        <div>
          <p className={s.examplesLabel}>Questions people asked. Never the answers.</p>
          <ul className={s.examples} aria-label="Example questions">
            {issue.examples.map((e) => (
              <li key={`${e.kind}-${e.question}-${e.at}`}>
                <span>{e.question}</span>
                <span className={s.why}>{[KIND_LABEL[e.kind], e.reason ? REASON_LABEL[e.reason] ?? e.reason : '', Number.isNaN(Date.parse(e.at)) ? '' : day.format(new Date(e.at))].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {issue.tickets.length > 0 && (
        <ul className={s.tickets} aria-label="Tickets">
          {issue.tickets.map((t) => (
            <li key={t.provider}>
              {PROVIDER_LABEL[t.provider]}: <a className={s.link} href={t.url} target="_blank" rel="noreferrer noopener">{t.ref}</a>
            </li>
          ))}
        </ul>
      )}
      <div className={s.actions}>
        {open && (
          <Button size="sm" icon="sparkles" disabled={call.isPending} onClick={() => void run('issues:propose', {}, 'The definition went to the proposals queue.')}>
            Propose a definition
          </Button>
        )}
        {issue.proposalId && <Link className={s.link} to={`/model/${projectId}?tab=proposals`}>See the proposal</Link>}
        {(['linear', 'jira'] as const).filter((p) => trackers[p] && !sent.has(p)).map((p) => (
          <Button key={p} size="sm" icon="send" disabled={call.isPending} onClick={() => void run('issues:send', { provider: p }, `Sent to ${PROVIDER_LABEL[p]}.`)}>
            Send to {PROVIDER_LABEL[p]}
          </Button>
        ))}
        {open ? (
          <>
            <Button size="sm" variant="ghost" icon="circle-check" disabled={call.isPending} onClick={() => void run('issues:setStatus', { status: 'resolved' }, 'Marked as resolved.')}>Resolve</Button>
            <Button size="sm" variant="ghost" icon="x" disabled={call.isPending} onClick={() => void run('issues:setStatus', { status: 'ignored' }, 'Ignored.')}>Ignore</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon="rotate-ccw" disabled={call.isPending} onClick={() => void run('issues:setStatus', { status: 'open' }, 'Reopened.')}>Reopen</Button>
        )}
      </div>
      {error && <p className={s.problem} role="alert">{error}</p>}
    </li>
  );
}
