// Pieces both Find-segments tabs share (segments.ts / segmentsView.ts): a
// card, a headline figure, a run's progress (from the Jobs stream the shell
// already holds open — the job for THIS dataset) and its failure line.

import { useState, type ReactNode } from 'react';
import { rpc } from '../../../api/client';
import { useServerEvent } from '../../../api/events';
import type { Job } from '../../../api/jobs';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import s from './Segments.module.css';

export function Card({ id, title, hint, children, className }: { id: string; title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={className ? `${s.card} ${className}` : s.card} aria-labelledby={id}>
      <div className={s.cardHead}>
        <h3 className={s.cardH} id={id}>
          {title}
        </h3>
        {hint && <p className={s.hint}>{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div className={s.kpi}>
      <div className={s.kpiV}>{value}</div>
      <div className={s.kpiL}>{label}</div>
    </div>
  );
}

/** This dataset's running analysis job, as the Jobs stream reports it. */
export function useDatasetJob(datasetId: string, watching: boolean): Job | null {
  const [job, setJob] = useState<Job | null>(null);
  useServerEvent('jobs:changed', (p) => {
    if (!watching) return;
    const snap = p as { active?: Array<Job & { datasetId?: string }> } | null;
    setJob((snap?.active ?? []).find((j) => j.kind === 'analysis' && j.datasetId === datasetId) ?? null);
  });
  return watching ? job : null;
}

/** Progress, its note and Cancel (segments.ts sgProgressBox). */
export function Progress({ job }: { job: Job | null }) {
  const pct = Math.round(Math.max(0, Math.min(1, job?.progress ?? 0)) * 100);
  const note = !job ? 'Starting…' : job.state === 'queued' ? 'Waiting for another job on this dataset…' : job.note || 'Working…';
  return (
    <div className={s.progress} role="status">
      <div className={s.bar} role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={s.barFill} style={{ width: `${Math.max(3, pct)}%` }} />
      </div>
      <span className={s.progressNote}>{note}</span>
      <Button size="sm" icon="x" disabled={!job} onClick={() => job && void rpc('jobs:cancel', { id: job.id })}>
        Cancel
      </Button>
    </div>
  );
}

/** A run's failure line; a cancelled run is said softly. */
export function RunError({ text, soft }: { text: string; soft?: boolean }) {
  if (!text) return null;
  return (
    <p className={soft ? `${s.error} ${s.soft}` : s.error} role="alert">
      <Icon name={soft ? 'info' : 'alert'} />
      <span>{text}</span>
    </p>
  );
}
