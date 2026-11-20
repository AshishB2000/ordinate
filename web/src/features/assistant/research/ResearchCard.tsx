// The run card: a deep-research run in the conversation, live (docs/deep-research/00-design.md, "Screens"). While it runs: the
// question, the plan the model wrote, a meter (steps, queries and time against the org's limits), the steps with what became of
// each, and Stop. When it ends: Open report, or Resume for a run that stopped short, or Open story once its report is a Story.
// Every number is the server's (`research:get`); the bars are only a drawing of two of them.

import { Link } from 'react-router';
import { Badge, type BadgeTone } from '../../../ui/Badge';
import { Button, buttonClass } from '../../../ui/Button';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { endedText, isActive, useRun, useRunAction, type ResearchRun, type ResearchStep } from './api';
import s from './Research.module.css';

const TONE: Record<ResearchRun['state'], BadgeTone> = { queued: 'neutral', running: 'accent', writing: 'accent', done: 'ok', partial: 'warn', failed: 'error', stopped: 'neutral' };
const LABEL: Record<ResearchRun['state'], string> = { queued: 'Waiting to start', running: 'Researching', writing: 'Writing the report', done: 'Finished', partial: 'Stopped early', failed: 'Failed', stopped: 'Stopped' };

/** m:ss — the server's seconds, formatted. */
export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

const KIND: Record<ResearchStep['kind'], string> = { answer: 'Chart', sql: 'SQL', drivers: 'Why it changed', none: 'Step' };
const ICON: Record<ResearchStep['status'], IconName> = { done: 'check', refused: 'x', failed: 'alert' };

function Meter({ label, used, of }: { label: string; used: number; of: number }) {
  return (
    <div className={s.meter}>
      <div className={s.meterText}>
        <span>{label}</span>
        <span className={s.num}>{`${used} of ${of}`}</span>
      </div>
      <div className={s.bar} aria-hidden="true">
        <span className={s.barFill} style={{ width: `${Math.min(100, (used / Math.max(1, of)) * 100)}%` }} />
      </div>
    </div>
  );
}

function Steps({ run }: { run: ResearchRun }) {
  const active = isActive(run.state);
  if (!run.steps.length && !active) return null;
  return (
    <ol className={s.steps} aria-label="Steps">
      {run.steps.map((st) => (
        <li key={st.n} className={`${s.step} ${s[st.status]}`}>
          <span className={s.stepIcon}><Icon name={ICON[st.status]} size={16} /></span>
          <div className={s.stepBody}>
            <span className={s.stepTitle}>{st.title || (st.status === 'refused' ? 'Step not run' : KIND[st.kind])}</span>
            {st.reason && <span className={s.reason}>{st.reason}</span>}
          </div>
          <span className={s.stepKind}>{KIND[st.kind]}</span>
        </li>
      ))}
      {active && (
        <li className={`${s.step} ${s.running}`} aria-label="Running">
          <span className={`${s.stepIcon} ${s.spin}`}><Icon name="loader" size={16} /></span>
          <div className={s.stepBody}>
            <span className={s.stepTitle}>{run.state === 'writing' ? 'Writing the report' : run.state === 'queued' ? 'Waiting for a free worker' : run.steps.length ? 'Choosing the next step' : 'Planning'}</span>
          </div>
        </li>
      )}
    </ol>
  );
}

export function ResearchCard({ projectId, runId }: { projectId: string; runId: string }) {
  const q = useRun(projectId, runId);
  const stop = useRunAction('research:stop', projectId, runId);
  const resume = useRunAction('research:resume', projectId, runId);
  const run = q.data;
  if (q.isPending) return <div className={s.card} role="status" aria-busy="true" aria-label="Loading the research"><Skeleton className={s.skel} /></div>;
  if (!run) {
    return (
      <div className={`${s.card} ${s.gone}`} data-testid="research-card">
        <div className={s.head}><Icon name="sparkles" size={16} /><span className={s.title}>Deep research</span></div>
        <p className={s.note}>{q.error?.message || 'This research run is no longer available.'}</p>
        <div><Button size="sm" onClick={() => void q.refetch()}>Try again</Button></div>
      </div>
    );
  }
  const active = isActive(run.state);
  const act = (m: typeof stop) => () => m.mutate(undefined, { onSuccess: (r) => { if (!r.ok) toast(r.error || 'That did not work.', { kind: 'error' }); } });
  const ended = endedText(run);
  return (
    <section className={s.card} data-testid="research-card" data-state={run.state} aria-label="Deep research">
      <div className={s.head}>
        <Icon name="sparkles" size={16} />
        <span className={s.title}>Deep research</span>
        <Badge tone={TONE[run.state]}>{LABEL[run.state]}</Badge>
      </div>
      <p className={s.question}>{run.question}</p>
      {run.plan.length > 0 && (
        <details className={s.plan} open={active}>
          <summary>{`Plan · ${run.plan.length} questions`}</summary>
          <ol>{run.plan.map((p) => <li key={p}>{p}</li>)}</ol>
        </details>
      )}
      {(active || run.stepsUsed > 0) && (
        <div className={s.meters} data-testid="research-meter">
          <Meter label="Steps" used={run.stepsUsed} of={run.limits.steps} />
          <Meter label="Queries" used={run.queriesUsed} of={run.limits.queries} />
          <div className={s.meterText}><span>Time</span><span className={s.num}>{`${clock(run.elapsedSec)} of ${run.limits.minutes}:00`}</span></div>
        </div>
      )}
      <Steps run={run} />
      {ended && !active && <p className={run.state === 'failed' ? `${s.note} ${s.noteError}` : s.note}>{ended}</p>}
      <div className={s.actions}>
        {active && (
          <Button size="sm" icon="x" loading={stop.isPending || stop.isSuccess} onClick={act(stop)}>
            Stop research
          </Button>
        )}
        {run.report && (
          <Link className={buttonClass(run.storyId ? 'secondary' : 'primary', 'sm')} to={`/research/${projectId}/${runId}`}>
            Open report
          </Link>
        )}
        {run.storyId && (
          <Link className={buttonClass('secondary', 'sm')} to={`/stories/${projectId}/${run.storyId}`}>
            Open story
          </Link>
        )}
        {run.resumable && (
          <Button size="sm" variant={run.report ? 'secondary' : 'primary'} icon="rotate-ccw" loading={resume.isPending} onClick={act(resume)}>
            Resume
          </Button>
        )}
        {run.report && !run.storyId && <span className={s.private}>Only you can see this report</span>}
      </div>
    </section>
  );
}
