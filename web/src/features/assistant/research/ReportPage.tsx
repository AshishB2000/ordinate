// /research/:projectId/:runId — a deep-research report, private to the person who ran it (docs/deep-research/00-design.md, "The
// report"). The words are the model's, audited by the server against the steps they cite; every chart is drawn NOW by the server
// from the step's spec under this person's access (`research:card`). Caveats stand out in a warning callout; "How this was made"
// lists every step and what became of it; "Add to project" saves the cited charts and makes an ordinary Story, after which the page
// offers it ("Open story"). Until then the page says only its starter can see it.

import { useParams } from 'react-router';
import { Link } from 'react-router';
import { Chart } from '../../../charts/Chart';
import type { ChartDataShape } from '../../../charts/types';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../../app/blocks';
import { Badge } from '../../../ui/Badge';
import { Button, buttonClass } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { AnswerSql, isSqlCard, type SqlCard } from '../AnswerSql';
import { day } from '../../data/format';
import { endedText, isActive, useAddToProject, useRun, useStepCard, type ResearchRun, type ResearchStep } from './api';
import s from './Research.module.css';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

type DrawnCard = { ok: true; title: string; chartType: string; data: ChartDataShape; caption?: string } | SqlCard;

/** One step's chart, live. */
function StepChart({ run, step }: { run: ResearchRun; step: ResearchStep }) {
  const q = useStepCard(run.projectId, run.id, step.n, step.status === 'done');
  if (q.isPending) return <div className={s.chart} role="status" aria-busy="true" aria-label={`Drawing ${step.title}`}><Skeleton className={s.skelChart} /></div>;
  const card = q.data as ({ ok: false; reason?: string; error?: string } | DrawnCard) | undefined;
  if (!card || card.ok === false) {
    return (
      <div className={s.chart} data-testid="report-chart-error">
        <div className={s.chartTitle}>{step.title}</div>
        <p className={s.chartError}>{(card && 'reason' in card && card.reason) || 'This chart could not be drawn now.'}</p>
      </div>
    );
  }
  if (isSqlCard(card as never)) return <AnswerSql projectId={run.projectId} sql={{ text: '', datasetIds: [], title: step.title }} card={card as SqlCard} />;
  const c = card as Extract<DrawnCard, { chartType: string }>;
  return (
    <figure className={s.chart} data-testid="report-chart">
      <div className={s.chartTitle}>{c.title || step.title}</div>
      <div className={s.plot}>
        <Chart type={c.chartType} data={c.data} label={c.title || step.title} />
      </div>
      {c.caption && <figcaption className={s.caption}>{c.caption}</figcaption>}
    </figure>
  );
}

function HowMade({ run }: { run: ResearchRun }) {
  return (
    <div className={s.sideBox}>
      <h2 className={s.sideTitle}>How this was made</h2>
      {run.plan.length > 0 && (
        <details>
          <summary className={s.written}>{`Plan · ${run.plan.length} questions`}</summary>
          <ol className={s.made}>{run.plan.map((p) => <li key={p}><span /> <span className={s.madeText}>{p}</span></li>)}</ol>
        </details>
      )}
      <ol className={s.made} aria-label="Steps">
        {run.steps.map((st) => (
          <li key={st.n}>
            <Icon name={st.status === 'done' ? 'check' : st.status === 'failed' ? 'alert' : 'x'} size={12} />
            <span className={s.madeText}>
              {`${st.n}. ${st.title || 'Step not run'}`}
              {st.reason && <span className={s.madeWhy}>{st.reason}</span>}
            </span>
          </li>
        ))}
      </ol>
      <span className={s.written}>{`${plural(run.stepsUsed, 'model step')} · ${plural(run.queriesUsed, 'engine query', 'engine queries')} · computed by the engine, not the model`}</span>
    </div>
  );
}

export default function ReportPage() {
  const { projectId, runId } = useParams();
  const q = useRun(projectId, runId);
  const add = useAddToProject(projectId ?? '', runId ?? '');
  const back = { to: '/assistant', label: 'Assistant' };
  if (!projectId || !runId) return <ErrorState title="No report here" message="This link is missing its run." />;
  if (q.isPending) return <PageSkeleton />;
  const run = q.data;
  if (!run) {
    return (
      <Page title="Research report" back={back}>
        <ErrorState title="This report is not available" message={q.error?.message || 'It is private to the person who ran it, or it was removed.'} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  const r = run.report;
  if (!r) {
    return (
      <Page title="Research report" sub={run.question} back={back}>
        <EmptyState icon="file-text" title={isActive(run.state) ? 'The report is not ready yet' : 'This run wrote no report'} actions={<Link className={buttonClass('secondary', 'md')} to="/assistant">Back to the conversation</Link>}>
          {isActive(run.state) ? 'The research is still running. The report opens here when it is written.' : endedText(run) || 'There is nothing to show.'}
        </EmptyState>
      </Page>
    );
  }
  const steps = new Map(run.steps.map((st) => [st.n, st]));
  const onAdd = () => add.mutate(undefined, { onSuccess: (res) => { toast(res.ok ? 'Added to the project as a story.' : res.error || 'The report could not be added.', { kind: res.ok ? 'success' : 'error' }); } });
  return (
    <Page
      title={r.title || run.question}
      sub={`Written ${day.format(new Date(r.writtenAt))} from the data then. Charts below are drawn now.`}
      back={back}
      status={run.state === 'partial' ? <Badge tone="warn">Partial</Badge> : undefined}
      actions={run.storyId ? <Link className={buttonClass('primary', 'md')} to={`/stories/${projectId}/${run.storyId}`}>Open story</Link> : <Button variant="primary" icon="plus" loading={add.isPending} onClick={onAdd}>Add to project</Button>}
    >
      <div className={s.page}>
        <article className={s.body} data-testid="research-report">
          {r.chartsOnly && <p className={s.note}>{`${endedText(run)} The charts below are the steps that ran.`}</p>}
          {r.summary && <p className={s.lead}>{r.summary}</p>}
          {r.sections.map((sec, i) => (
            <section key={i} className={s.section} aria-label={sec.heading || `Section ${i + 1}`}>
              {sec.heading && <h2 className={s.h2}>{sec.heading}</h2>}
              {sec.steps.flatMap((n) => { const st = steps.get(n); return st ? [<StepChart key={n} run={run} step={st} />] : []; })}
              {sec.text && <p className={s.prose}>{sec.text}</p>}
            </section>
          ))}
          {r.caveats.length > 0 && (
            <aside className={s.callout} role="note" aria-label="Caveats" data-testid="research-caveats">
              <Icon name="alert" size={16} />
              <div>
                <div className={s.calloutTitle}>Caveats</div>
                <ul>{r.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
              </div>
            </aside>
          )}
          {r.conclusion && <p className={s.lead}>{r.conclusion}</p>}
        </article>
        <aside className={s.side}>
          <div className={s.sideBox}>
            {run.storyId ? (
              <>
                <h2 className={s.sideTitle}>In the project</h2>
                <span className={s.written}>This report is now a story. The charts follow each reader’s own access.</span>
                <Link className={buttonClass('secondary', 'md')} to={`/stories/${projectId}/${run.storyId}`}>Open story</Link>
              </>
            ) : (
              <>
                <span className={s.privateLine} data-testid="research-private"><Icon name="lock" size={16} />Only you can see this report</span>
                <span className={s.written}>Add it to the project to share it as a story. Each chart is saved, and the prose stays only where the data is open to everyone.</span>
              </>
            )}
          </div>
          <HowMade run={run} />
        </aside>
      </div>
    </Page>
  );
}
