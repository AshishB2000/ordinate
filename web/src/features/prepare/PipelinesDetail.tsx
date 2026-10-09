// The selected step's panel (legacy pipelinesDetail.ts): its own schedule
// (written to the record's existing field), Run from here, Pause, Open, and the
// last 50 runs with their logs opening in place.

import { useState } from 'react';
import { Link } from 'react-router';
import { formatNumber } from '../../../../src/app/format.ts';
import { Button, buttonClass } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import type { AutoRefreshEvery } from '../../api/datasets';
import { BehindBadge, cadenceOptions } from '../data/cadence';
import type { NodeRun, PipelineNode, PipelineView } from './pipelinesApi';
import { absTime, dur, iconFor, KIND, nextText, STATUS } from './pipelineFormat';
import s from './Pipelines.module.css';

export interface DetailActions {
  running: boolean;
  run: (nodeId: string) => void;
  pause: (nodeId: string, paused: boolean) => void;
  setNode: (nodeId: string, patch: { every?: 'off' | AutoRefreshEvery; cadence?: 'off' | 'daily' | 'weekly' | 'monthly'; at?: string }) => void;
}

/** Where a step's record opens in this app, when it has a page here yet. */
function recordLink(projectId: string, n: PipelineNode): string | null {
  if (!n.ref) return null;
  if (n.ref.type === 'dataset') return `/data/${projectId}/${n.ref.id}`;
  if (n.ref.type === 'connection') return `/connections/${projectId}/${n.ref.id}`;
  return null;
}

function ScheduleBox({ n, act }: { n: PipelineNode; act: DetailActions }) {
  const sch = n.schedule;
  const last = n.lastRun;
  return (
    <div className={s.box}>
      <h4 className={s.boxH}>Schedule</h4>
      <dl className={s.facts}>
        <dt>Own schedule</dt>
        <dd>{sch.text}</dd>
        <dt>Next run</dt>
        <dd>{n.nextRunAt ? `${absTime(n.nextRunAt)} (${nextText(n.nextRunAt)})` : 'Nothing planned'}</dd>
        <dt>Last run</dt>
        <dd>{last ? `${absTime(last.at)} · ${(STATUS[last.status] ?? STATUS.never).word}${last.durationMs !== undefined ? ` · ${dur(last.durationMs)}` : ''}` : 'Never'}</dd>
      </dl>
      {sch.edit === 'dataset' ? (
        <>
          <Select
            aria-label="Refresh this dataset"
            size="sm"
            value={sch.every || 'off'}
            onValueChange={(v) => act.setNode(n.id, { every: v as 'off' | AutoRefreshEvery })}
            options={cadenceOptions(
              [
                { value: 'off', label: 'Manual — no refresh schedule' },
                { value: '5min', label: 'Refresh every 5 minutes' },
                { value: '15min', label: 'Refresh every 15 minutes' },
                { value: 'hourly', label: 'Refresh hourly' },
                { value: 'daily', label: 'Refresh daily' },
                { value: 'weekly', label: 'Refresh weekly' },
              ],
              !!sch.incremental,
            )}
          />
          <BehindBadge behind={sch.behind} />
          <p className={s.note}>Saved on the dataset — the same schedule its Refresh menu sets.</p>
        </>
      ) : sch.edit === 'report' ? (
        <>
          <div className={s.fieldRow}>
            <Select
              aria-label="How often the report is written"
              size="sm"
              value={sch.cadence || 'off'}
              onValueChange={(v) => act.setNode(n.id, { cadence: v as 'off' | 'daily' | 'weekly' | 'monthly', at: sch.at || '09:00' })}
              options={[
                { value: 'off', label: 'Manual' },
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'monthly', label: 'Monthly' },
              ]}
            />
            <input
              type="time"
              className={s.time}
              aria-label="At"
              defaultValue={sch.at || '09:00'}
              disabled={(sch.cadence || 'off') === 'off'}
              onChange={(e) => e.target.value && act.setNode(n.id, { cadence: (sch.cadence || 'off') as 'off' | 'daily' | 'weekly' | 'monthly', at: e.target.value })}
            />
          </div>
          <p className={s.note}>
            {sch.hasFolder
              ? 'Saved on the report. Each run writes a file into the report’s folder.'
              : 'This report has no folder yet — open it and pick one in its schedule, so a run has somewhere to write.'}
          </p>
        </>
      ) : (
        <p className={s.note}>
          {n.kind === 'source' ? 'A source has nothing to run: the datasets after it fetch from it.' : 'This step runs after its inputs — whenever they refresh, and in every pipeline run.'}
        </p>
      )}
    </div>
  );
}

function LogLine({ icon, tone, children }: { icon: IconName; tone: 'info' | 'warn' | 'error'; children: string }) {
  return (
    <div className={`${s.logLine} ${s[`log_${tone}`]}`}>
      <Icon name={icon} size={12} />
      <span>{children}</span>
    </div>
  );
}

function RunRow({ r }: { r: NodeRun }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[r.status] ?? STATUS.never;
  const rows =
    typeof r.rows === 'number'
      ? typeof r.rowsBefore === 'number' && r.rowsBefore !== r.rows
        ? `${formatNumber(r.rowsBefore)} → ${formatNumber(r.rows)}`
        : formatNumber(r.rows)
      : '—';
  return (
    <>
      <button type="button" className={s.run} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{absTime(r.startedAt)}</span>
        <span>{r.trigger === 'schedule' ? 'Schedule' : 'Run now'}</span>
        <span>
          <span className={`${s.pill} ${s[`pill_${r.status}`] ?? ''}`}>
            <Icon name={st.icon} size={12} />
            <span>{st.word}</span>
          </span>
        </span>
        <span>{r.status === 'ok' || r.status === 'failed' ? dur(r.durationMs) : '—'}</span>
        <span>{rows}</span>
        <span>{r.attempts || '—'}</span>
      </button>
      {open && (
        <div className={s.log}>
          <LogLine icon="history" tone="info">
            {`Started ${new Date(r.startedAt).toLocaleString()} · finished ${new Date(r.finishedAt).toLocaleTimeString()}${r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}`}
          </LogLine>
          {typeof r.rows === 'number' && (
            <LogLine icon="table" tone="info">
              {typeof r.rowsBefore === 'number' && typeof r.rowsDelta === 'number'
                ? `${formatNumber(r.rowsBefore)} rows before, ${formatNumber(r.rows)} after (${r.rowsDelta >= 0 ? '+' : ''}${formatNumber(r.rowsDelta)})`
                : `${formatNumber(r.rows)} rows`}
            </LogLine>
          )}
          {r.note && (
            <LogLine icon="info" tone="info">
              {r.note}
            </LogLine>
          )}
          {r.warnings.map((w) => (
            <LogLine key={w} icon="alert" tone="warn">
              {w}
            </LogLine>
          ))}
          {r.errors.map((e) => (
            <LogLine key={e} icon="alert" tone="error">
              {e}
            </LogLine>
          ))}
          {!r.note && !r.warnings.length && !r.errors.length && typeof r.rows !== 'number' && (
            <LogLine icon="circle-check" tone="info">
              Nothing else to report.
            </LogLine>
          )}
        </div>
      )}
    </>
  );
}

export function PipelinesDetail({ projectId, view, selected, act }: { projectId: string; view: PipelineView; selected: string | null; act: DetailActions }) {
  const n = selected ? view.nodes.find((x) => x.id === selected) : undefined;
  if (!n) {
    return (
      <section className={`${s.detail} ${s.detailHint}`} aria-label="Selected step">
        <Icon name="lineage" />
        <span>Select a step to change its schedule, run it and everything after it, or read its run history. Hover one to trace its path.</span>
      </section>
    );
  }
  const kind = KIND[n.kind] ?? KIND.dataset;
  const link = recordLink(projectId, n);
  return (
    <section className={s.detail} id="pq-detail" aria-label={`Step: ${n.name}`}>
      <div className={s.detailHead}>
        <span className={s.nodeIc}>
          <Icon name={iconFor(n)} />
        </span>
        <div className={s.detailId}>
          <h3 className={s.detailName}>{n.name}</h3>
          <span className={s.muted}>
            {n.stage === 2 ? 'Derived dataset' : kind.word} · {view.stages[n.stage]} stage{n.paused ? ' · paused' : ''}
          </span>
        </div>
        <div className={s.detailActs}>
          <Button size="sm" icon="play" loading={act.running} title="Runs this step, then everything after it, in order." onClick={() => act.run(n.id)}>
            {act.running ? 'Running…' : 'Run from here'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={n.paused ? 'Run this step again in pipeline runs.' : 'Step over this step in pipeline runs; what follows it still runs.'}
            onClick={() => act.pause(n.id, !n.paused)}
          >
            {n.paused ? 'Resume' : 'Pause'}
          </Button>
          {link && (
            <Link className={buttonClass('ghost', 'sm')} to={link}>
              <Icon name="external-link" />
              <span>Open</span>
            </Link>
          )}
        </div>
      </div>
      <div className={s.detailBody}>
        <ScheduleBox n={n} act={act} />
        <div className={s.box}>
          <h4 className={s.boxH}>
            Run history <span className={s.colN}>{n.runs.length}</span>
          </h4>
          {n.runs.length === 0 ? (
            <p className={s.note}>No pipeline runs yet. “Run from here” starts one; so does the pipeline schedule.</p>
          ) : (
            <div className={s.runs}>
              <div className={`${s.run} ${s.runHead}`} aria-hidden="true">
                {['When', 'Trigger', 'Status', 'Duration', 'Rows', 'Tries'].map((h) => (
                  <span key={h}>{h}</span>
                ))}
              </div>
              {n.runs.map((r) => (
                <RunRow key={r.id} r={r} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
