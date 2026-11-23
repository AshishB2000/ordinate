// /evals/:projectId/:runId — a suite run's results (docs/eval-suites/00-design.md, phase 4): each case's pass, fail or score, the cost in
// model calls, and the comparison with the last run ("3 better, 1 worse, 46 the same"). Every editor sees each case's outcome and which
// checks failed; the words of the answer and the judge's line are the server's to send only to the person who ran it, so they appear
// here only when they are in the reply. The figures are the engine's: nothing on this page computes one.

import { useState } from 'react';
import { useParams } from 'react-router';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Badge, type BadgeTone } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { toast } from '../../ui/Toast';
import { dayInYear } from '../data/format';
import { CHECK_LABEL, CODE_TEXT, END_TEXT, ERROR_TEXT, PART_TEXT, isActive, useEvalCall, useRun, type CaseLine, type RunReply } from './api';
import { LABEL, Stats, TONE, clock } from './RunCard';
import s from './Evals.module.css';

const OUTCOME: Record<CaseLine['outcome'], { label: string; tone: BadgeTone }> = {
  pass: { label: 'Pass', tone: 'ok' }, fail: { label: 'Fail', tone: 'error' }, not_scored: { label: 'Not scored', tone: 'warn' }, error: { label: 'Error', tone: 'error' }, pending: { label: 'Waiting', tone: 'neutral' },
};
const MOVE: Record<NonNullable<CaseLine['move']>, { label: string; tone: BadgeTone } | null> = { better: { label: 'Better', tone: 'ok' }, worse: { label: 'Worse', tone: 'error' }, same: null, new: { label: 'New', tone: 'neutral' } };

function Line({ c }: { c: CaseLine }) {
  const [open, setOpen] = useState(false);
  const o = OUTCOME[c.outcome];
  const move = c.move ? MOVE[c.move] : null;
  const failed = c.checks.filter((k) => !k.ok);
  const detail = c.outcome !== 'pending';
  return (
    <li className={s.result} data-testid="result-row" data-outcome={c.outcome}>
      <button type="button" className={s.resultHead} aria-expanded={open} disabled={!detail} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <span className={s.resultQuestion}>{c.question || 'A case that was deleted'}</span>
        {c.score !== null && <span className={s.score} aria-label={`Judge score ${c.score} of 5`}>{`${c.score}/5`}</span>}
        {move && <Badge tone={move.tone}>{move.label}</Badge>}
        <Badge tone={o.tone}>{o.label}</Badge>
      </button>
      {!open && failed.length > 0 && <p className={s.why}>{failed.map((k) => CHECK_LABEL[k.id]).join(' · ')}: not met</p>}
      {open && (
        <div className={s.detail}>
          {c.errorCode && <p className={s.note}>{ERROR_TEXT[c.errorCode] ?? 'The case could not be run.'}</p>}
          {c.checks.length > 0 && (
            <ul className={s.checks} aria-label="Checks">
              {c.checks.map((k) => (
                <li key={k.id} className={k.ok ? s.checkOk : s.checkBad}>
                  <Icon name={k.ok ? 'check' : 'x'} size={12} />
                  <span>{CHECK_LABEL[k.id]}</span>
                  {!k.ok && k.code && <span className={s.checkWhy}>{CODE_TEXT[k.code] ?? ''}</span>}
                </li>
              ))}
            </ul>
          )}
          {c.judged === 'scored' && <p className={s.note}>{`The judge scored the words ${c.score} of 5.`}{c.why ? ` ${c.why}` : ''}</p>}
          {c.judged === 'not_scored' && <p className={s.note}>The judge’s reply could not be read, so the words were not scored. This is not a pass.</p>}
          {c.reply !== undefined ? (
            <blockquote className={s.reply}>
              <span className={s.replyLabel}>What it said</span>
              {c.reply}
            </blockquote>
          ) : (
            <p className={s.help}><Icon name="lock" size={12} />The answer’s words are shown only to the person who ran these tests.</p>
          )}
        </div>
      )}
    </li>
  );
}

function Compare({ data }: { data: RunReply }) {
  const c = data.compare;
  if (!c) return <p className={s.help}><Icon name="info" size={12} />This is the first run of the suite, so there is nothing to compare it with yet.</p>;
  const changed = c.changed.map((p) => PART_TEXT[p] ?? p);
  return (
    <div className={s.compare} data-testid="compare">
      <p className={s.compareLine}>
        <b className={s.good}>{`${c.better} better`}</b>, <b className={c.worse ? s.bad : undefined}>{`${c.worse} worse`}</b>, {`${c.same} the same`}{c.new ? `, ${c.new} new` : ''}
        <span className={s.help}> compared with the last run</span>
      </p>
      {(changed.length > 0 || c.judgeDiffers) && (
        <p className={s.help}>
          <Icon name="info" size={12} />
          {[...changed, ...(c.judgeDiffers ? ['A different model judged the words'] : [])].join('. ')}.
        </p>
      )}
    </div>
  );
}

export default function ResultsPage() {
  const { projectId, runId } = useParams();
  const q = useRun(projectId, runId);
  const call = useEvalCall(projectId ?? '');
  const back = { to: `/assistant/setup/${projectId}`, label: 'Agents & setup' };
  if (!projectId || !runId) return <ErrorState title="No results here" message="This link is missing its run." />;
  if (q.isPending) return <PageSkeleton />;
  const data = q.data;
  if (!data) return <Page title="Test results" back={back}><ErrorState title="These results are not available" message={q.error?.message || 'The run was removed, or you cannot open this project’s tests.'} onRetry={() => void q.refetch()} /></Page>;
  const run = data.run;
  const active = isActive(run.state);
  const act = async (channel: 'eval:runStop' | 'eval:runResume') => {
    const r = await call(channel, { runId });
    if (!r.ok) toast(r.error || 'That did not work.', { kind: 'error' });
  };
  const judge = run.judge ? (run.judgeOwn ? `The Assistant’s own model judged the words (${run.judge}).` : `The Judge model judged the words (${run.judge}).`) : 'No model judged: there were no words to score, or none was set up.';
  return (
    <Page
      title={data.suite?.name ?? 'Test results'}
      sub={`Run on ${Number.isNaN(Date.parse(run.startedAt)) ? '' : dayInYear.format(new Date(run.startedAt))} · ${clock(run.elapsedSec)}`}
      back={back}
      status={<Badge tone={TONE[run.state]}>{LABEL[run.state]}</Badge>}
      actions={
        <>
          {active && <Button icon="x" onClick={() => void act('eval:runStop')}>Stop run</Button>}
          {run.resumable && <Button variant="primary" icon="rotate-ccw" onClick={() => void act('eval:runResume')}>Resume</Button>}
        </>
      }
    >
      <div className={s.results} data-testid="eval-results">
        <div className={s.summary}>
          <Stats run={run} />
          <Compare data={data} />
          <p className={s.help}><Icon name="info" size={12} />{judge}</p>
          {!active && run.errorCode && END_TEXT[run.errorCode] && <p className={s.note}>{END_TEXT[run.errorCode]}</p>}
        </div>
        {data.cases.length === 0 ? (
          <EmptyState icon="circle-check" title="No cases to show">The cases of this run are in a folder you cannot open, or were deleted.</EmptyState>
        ) : (
          <ul className={s.resultList} aria-label="Results">
            {data.cases.map((c) => <Line key={c.caseId} c={c} />)}
          </ul>
        )}
      </div>
    </Page>
  );
}
