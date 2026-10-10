// The strip over the graph (legacy pipelinesPage.ts pqHead + pqCronEditor):
// the pipeline's schedule, its retry policy, Run all, and its numbers — all
// counted by the server (view.summary) — then the cron editor, whose "next
// three runs" the server works out as it is typed.

import { useEffect, useState } from 'react';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { cronPreview, type PipelineView } from './pipelinesApi';
import { absTime, dur, relTime } from './pipelineFormat';
import s from './Pipelines.module.css';

const PRESETS: readonly (readonly [string, string])[] = [
  ['Hourly', '0 * * * *'],
  ['Daily 06:00', '0 6 * * *'],
  ['Weekdays 07:00', '0 7 * * 1-5'],
  ['Mondays 09:00', '0 9 * * 1'],
];
const RETRIES = ['Stop — no retries', 'Retry once', 'Retry twice', 'Retry 3 times'];
const BACKOFFS: readonly (readonly [number, string])[] = [
  [10_000, 'after 10 s, doubling'],
  [30_000, 'after 30 s, doubling'],
  [60_000, 'after 1 min, doubling'],
  [300_000, 'after 5 min, doubling'],
];

function CronEditor({ view, onSave, onRemove, onCancel }: { view: PipelineView; onSave: (cron: string, tz: string) => void; onRemove: () => void; onCancel: () => void }) {
  const sch = view.schedule;
  const tz = sch ? sch.tz : view.tz;
  const [cron, setCron] = useState(sch ? sch.cron : '0 6 * * *');
  const [preview, setPreview] = useState<{ ok: boolean; text: string; next: string[] } | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      cronPreview(cron, tz).then(
        (p) => live && setPreview(p),
        () => live && setPreview({ ok: false, text: '', next: [] }),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [cron, tz]);
  return (
    <section className={s.cron} aria-label="Pipeline schedule editor">
      <div className={s.cronRow}>
        <input
          className={s.cronInput}
          spellCheck={false}
          aria-label="Schedule, as five cron fields"
          placeholder="minute hour day month weekday — e.g. 0 6 * * *"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
        />
        <div className={s.presets}>
          {PRESETS.map(([label, expr]) => (
            <button key={label} type="button" className={s.preset} onClick={() => setCron(expr)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={s.cronPreview} aria-live="polite">
        {preview && !preview.ok ? (
          <span className={s.cronBad}>Five fields: minute (0–59), hour (0–23), day (1–31), month (1–12), weekday (0–6, Sunday is 0).</span>
        ) : preview ? (
          <>
            <strong>{preview.text}</strong>
            <span>
              {' '}
              · times in {tz} · next: {preview.next.map(absTime).join(', ')}
            </span>
          </>
        ) : null}
      </div>
      <div className={s.cronActs}>
        <Button size="sm" variant="primary" disabled={!preview?.ok} onClick={() => onSave(cron, tz)}>
          Save schedule
        </Button>
        {sch && (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            Remove schedule
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function Stat({ icon, tone, children }: { icon: IconName; tone?: 'bad' | 'good'; children: string }) {
  return (
    <span className={tone ? `${s.stat} ${s[`stat_${tone}`]}` : s.stat}>
      <Icon name={icon} size={12} />
      <span>{children}</span>
    </span>
  );
}

export function PipelineHead({
  view,
  running,
  canEdit,
  onRunAll,
  saveSchedule,
  savePolicy,
}: {
  view: PipelineView;
  running: boolean;
  /** An editor sets the schedule and the retry policy and runs the pipeline; a viewer reads them. */
  canEdit: boolean;
  onRunAll: () => void;
  saveSchedule: (patch: { cron?: string | null; tz?: string; paused?: boolean }) => Promise<boolean>;
  savePolicy: (retries: number, backoffMs: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const sch = view.schedule;
  const { summary, policy } = view;
  const steps = view.nodes.length;
  const backoffs = BACKOFFS.some(([ms]) => ms === policy.backoffMs) ? BACKOFFS : [...BACKOFFS, [policy.backoffMs, `after ${dur(policy.backoffMs)}, doubling`] as const];
  return (
    <div className={s.headWrap}>
      <div className={s.head}>
        <div className={s.sched}>
          <span className={s.schedIc}>
            <Icon name="calendar" />
          </span>
          <div className={s.schedText}>
            <span className={s.label}>Pipeline schedule</span>
            <strong className={s.schedMain}>{sch ? `${sch.text}${sch.paused ? ' · paused' : ''}` : 'Not scheduled'}</strong>
            <span className={s.schedSub}>
              {sch
                ? sch.paused
                  ? `Times in ${sch.tz}. Paused — nothing runs on this schedule until you resume it.`
                  : `Times in ${sch.tz} · next run ${sch.nextRunAt ? `${absTime(sch.nextRunAt)} (${relTime(sch.nextRunAt)})` : 'never'}`
                : 'Run every step on one schedule, in order. Each step’s own schedule still applies.'}
            </span>
          </div>
          {canEdit && (
            <div className={s.schedActs}>
              <Button size="sm" variant="ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>
                {sch ? 'Edit' : 'Set a schedule'}
              </Button>
              {sch && (
                <Button size="sm" variant="ghost" onClick={() => void saveSchedule({ paused: !sch.paused })}>
                  {sch.paused ? 'Resume' : 'Pause'}
                </Button>
              )}
            </div>
          )}
        </div>
        <div className={s.field}>
          <span className={s.label}>On failure</span>
          <div className={s.fieldRow}>
            <Select
              aria-label="On failure"
              size="sm"
              disabled={!canEdit}
              value={String(policy.retries)}
              onValueChange={(v) => savePolicy(Number(v), policy.backoffMs)}
              options={RETRIES.map((l, i) => ({ value: String(i), label: l }))}
            />
            <Select
              aria-label="First wait before a retry"
              size="sm"
              disabled={!canEdit || policy.retries === 0}
              value={String(policy.backoffMs)}
              onValueChange={(v) => savePolicy(policy.retries, Number(v))}
              options={backoffs.map(([ms, l]) => ({ value: String(ms), label: l }))}
            />
          </div>
        </div>
        {canEdit && (
          <Button variant="primary" icon="play" loading={running} disabled={!steps} onClick={onRunAll}>
            {running ? 'Running…' : 'Run all'}
          </Button>
        )}
      </div>
      {steps > 0 && (
        <div className={s.stats}>
          <Stat icon="layers">{`${steps} ${steps === 1 ? 'step' : 'steps'} in ${summary.stages} ${summary.stages === 1 ? 'stage' : 'stages'}`}</Stat>
          <Stat icon="calendar">{summary.scheduled ? `${summary.scheduled} on their own schedule` : 'No step has its own schedule'}</Stat>
          {summary.failed ? (
            <Stat icon="alert" tone="bad">{`${summary.failed} failed or blocked last time`}</Stat>
          ) : (
            summary.lastActivityAt && (
              <Stat icon="circle-check" tone="good">
                Everything ran cleanly last time
              </Stat>
            )
          )}
          <Stat icon="history">{summary.lastActivityAt ? `Last activity ${relTime(summary.lastActivityAt)}` : 'Never run'}</Stat>
        </div>
      )}
      {editing && (
        <CronEditor
          view={view}
          onCancel={() => setEditing(false)}
          onRemove={() => void saveSchedule({ cron: null }).then((ok) => ok && setEditing(false))}
          onSave={(cron, tz) => void saveSchedule({ cron, tz }).then((ok) => ok && setEditing(false))}
        />
      )}
    </div>
  );
}
