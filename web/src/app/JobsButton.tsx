// The top bar's Jobs button and its popover — jobsPanel.ts, ported. The button
// pulses while anything runs and carries a count; the panel lists running jobs
// (progress, Cancel) over recent ones (outcome, how long, "Clear finished").
// EVERYTHING here is the server's record (src/app/jobs.ts): the panel paints
// `jobs:list` and its pushes, and sends Cancel / Clear back by job id.

import { useState } from 'react';
import { useCancelJob, useClearJobs, useJobs, type Job } from '../api/jobs';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/icons/Icon';
import { Popover } from '../ui/Popover';
import { SkeletonRows } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/States';
import { ago, duration } from './when';
import s from './JobsButton.module.css';

const KIND_ICON: Record<string, IconName> = {
  import: 'upload', refresh: 'refresh', export: 'download', report: 'file-text', bundle: 'package',
  'sql-save': 'code', quality: 'circle-check', insights: 'sparkles', publish: 'globe',
  backup: 'hard-drive', restore: 'rotate-ccw', automation: 'terminal', analysis: 'activity', compute: 'activity',
};

const STATE_WORD: Record<Job['state'], string> = {
  queued: 'Waiting', running: 'Running', done: 'Done', error: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
};

const pct = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });

function detail(j: Job): string {
  if (j.state === 'running' || j.state === 'queued') {
    return j.note || (j.state === 'queued' ? 'Waiting for a free slot' : pct.format(j.progress));
  }
  return [ago(j.finishedAt), j.state === 'done' ? duration(j.startedAt, j.finishedAt) : ''].filter(Boolean).join(' · ');
}

function JobRow({ j }: { j: Job }) {
  const cancel = useCancelJob();
  const live = j.state === 'running' || j.state === 'queued';
  const line = j.state === 'error' || j.state === 'interrupted' ? j.error : j.result?.message;
  return (
    <li className={`${s.row} ${s[j.state]}`} data-job-id={j.id}>
      <span className={s.ic} aria-hidden="true">
        <Icon name={KIND_ICON[j.kind] ?? 'activity'} />
      </span>
      <div className={s.main}>
        <div className={s.name} title={j.label}>
          {j.label}
        </div>
        <div className={s.meta}>
          <span className={`${s.state} ${s[`st_${j.state}`]}`}>{STATE_WORD[j.state] ?? j.state}</span>
          <span className={s.detail}>{detail(j)}</span>
        </div>
        {live && (
          <progress className={s.bar} value={j.state === 'queued' ? undefined : j.progress} max={1} aria-label={j.label} />
        )}
        {line && <div className={s.msg}>{line}</div>}
      </div>
      {live && j.cancellable && (
        <Button size="sm" icon="x" loading={cancel.isPending} onClick={() => cancel.mutate(j.id)}>
          Cancel
        </Button>
      )}
    </li>
  );
}

function Section({ title, jobs }: { title: string; jobs: Job[] }) {
  if (!jobs.length) return null;
  return (
    <section aria-label={title}>
      <h3 className={s.section}>{title}</h3>
      <ul className={s.rows}>
        {jobs.map((j) => (
          <JobRow key={j.id} j={j} />
        ))}
      </ul>
    </section>
  );
}

function Panel({ q }: { q: ReturnType<typeof useJobs> }) {
  const clear = useClearJobs();
  if (q.isPending) return <SkeletonRows rows={3} label="Loading jobs" />;
  if (q.isError) {
    return (
      <div className={s.pad}>
        <ErrorState compact heading={3} title="Jobs could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  const { active, recent } = q.data;
  return (
    <>
      <div className={s.head}>
        <h2 className={s.title}>Jobs</h2>
        {recent.length > 0 && (
          <Button size="sm" variant="ghost" loading={clear.isPending} onClick={() => clear.mutate()}>
            Clear finished
          </Button>
        )}
      </div>
      <div className={s.list}>
        {active.length === 0 && recent.length === 0 ? (
          <div className={s.pad}>
            <EmptyState compact heading={3} icon="activity" title="Nothing running">
              Imports, refreshes, exports, publishes and backups show up here while they run — you can keep working.
            </EmptyState>
          </div>
        ) : (
          <>
            <Section title="Running" jobs={active} />
            <Section title="Recent" jobs={recent} />
          </>
        )}
      </div>
    </>
  );
}

export function JobsButton() {
  const q = useJobs(); // mounted with the shell, so the stream is open and the button live everywhere
  const [open, setOpen] = useState(false);
  const active = q.data?.active ?? [];
  const running = active.filter((j) => j.state === 'running').length;
  const waiting = active.length - running;
  const label = active.length === 0 ? 'Jobs' : `Jobs — ${running} running${waiting ? `, ${waiting} waiting` : ''}`;
  return (
    <Popover
      title="Jobs"
      align="end"
      open={open}
      onOpenChange={setOpen}
      className={s.pop}
      trigger={
        <button type="button" className={active.length ? `${s.btn} ${s.busy}` : s.btn} aria-label={label} title={label}>
          <Icon name="activity" />
          {active.length > 0 && (
            <span className={s.badge} aria-hidden="true">
              {active.length > 9 ? '9+' : active.length}
            </span>
          )}
        </button>
      }
    >
      {open && <Panel q={q} />}
    </Popover>
  );
}
