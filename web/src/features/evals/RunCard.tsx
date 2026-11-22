// A run's card (docs/eval-suites/00-design.md, "The run and its results"): the cases done, passed, failed and not scored, the model
// calls, a Stop button while it goes, Resume when it stopped short, and a link to the results. Every number is the server's.

import { Link } from 'react-router';
import { Badge, type BadgeTone } from '../../ui/Badge';
import { Button, buttonClass } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { END_TEXT, isActive, useEvalCall, useRun, type RunState } from './api';
import s from './Evals.module.css';

export const TONE: Record<RunState, BadgeTone> = { queued: 'neutral', running: 'accent', done: 'ok', partial: 'warn', failed: 'error', stopped: 'neutral' };
export const LABEL: Record<RunState, string> = { queued: 'Waiting to start', running: 'Running', done: 'Finished', partial: 'Stopped early', failed: 'Failed', stopped: 'Stopped' };
export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export function Stats({ run }: { run: { casesDone: number; casesTotal: number; passed: number; failed: number; notScored: number; modelCalls: number } }) {
  return (
    <dl className={s.stats}>
      <div><dt>Done</dt><dd>{`${run.casesDone} of ${run.casesTotal}`}</dd></div>
      <div><dt>Passed</dt><dd className={s.good}>{run.passed}</dd></div>
      <div><dt>Failed</dt><dd className={run.failed ? s.bad : undefined}>{run.failed}</dd></div>
      {run.notScored > 0 && <div><dt>Not scored</dt><dd>{run.notScored}</dd></div>}
      <div><dt>Model calls</dt><dd>{run.modelCalls}</dd></div>
    </dl>
  );
}

export function RunCard({ projectId, runId }: { projectId: string; runId: string }) {
  const q = useRun(projectId, runId);
  const call = useEvalCall(projectId);
  const act = async (channel: 'eval:runStop' | 'eval:runResume') => {
    const r = await call(channel, { runId });
    if (!r.ok) toast(r.error || 'That did not work.', { kind: 'error' });
  };
  if (q.isPending) return <div className={s.runCard} role="status" aria-busy="true" aria-label="Loading the run"><Skeleton className={s.skel} /></div>;
  const data = q.data;
  if (!data) return <div className={s.runCard}><p className={s.note}>{q.error?.message || 'This run is no longer available.'}</p></div>;
  const run = data.run;
  const active = isActive(run.state);
  const pct = run.casesTotal ? Math.min(100, (run.casesDone / run.casesTotal) * 100) : 0;
  return (
    <section className={s.runCard} data-testid="run-card" data-state={run.state} aria-label="Test run">
      <div className={s.runHead}>
        <Badge tone={TONE[run.state]}>{LABEL[run.state]}</Badge>
        <span className={s.runTime}>{clock(run.elapsedSec)}</span>
      </div>
      <div className={s.bar} role="img" aria-label={`${run.casesDone} of ${run.casesTotal} cases done`}>
        <span className={s.barFill} style={{ width: `${pct}%` }} />
      </div>
      <Stats run={run} />
      {!active && run.errorCode && END_TEXT[run.errorCode] && <p className={s.note}>{END_TEXT[run.errorCode]}</p>}
      <div className={s.runActions}>
        {active && <Button size="sm" icon="x" onClick={() => void act('eval:runStop')}>Stop run</Button>}
        {run.resumable && <Button size="sm" variant="primary" icon="rotate-ccw" onClick={() => void act('eval:runResume')}>Resume</Button>}
        <Link className={buttonClass('secondary', 'sm')} to={`/evals/${projectId}/${runId}`}>Results</Link>
      </div>
    </section>
  );
}
