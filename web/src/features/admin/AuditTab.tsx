// Admin → Audit log: who did what, newest first — sign-ins and sign-outs,
// every write and admin call, audited reads. Filtered and paged on the server
// (keyset by id: "Older" asks for rows before the last one shown). A row holds
// channel names and ids, never a value — there are none to show.

import { useState, type FormEvent } from 'react';
import { Badge, type BadgeTone } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { fmtDateTime, useAdminProjects, useAudit, type AuditFilter, type AuditRow } from './api';
import s from './Admin.module.css';

const ACTIONS = [
  { value: '', label: 'Any event' },
  { value: 'rpc', label: 'Calls' },
  { value: 'login', label: 'Sign-ins' },
  { value: 'logout', label: 'Sign-outs' },
  { value: 'logout_everywhere', label: 'Sign-outs everywhere' },
  { value: 'password_change', label: 'Password changes' },
];
const OUTCOMES = [
  { value: '', label: 'Any outcome' },
  { value: 'ok', label: 'Succeeded' },
  { value: 'denied', label: 'Denied' },
  { value: 'error', label: 'Failed' },
];
const TONE: Record<AuditRow['outcome'], BadgeTone> = { ok: 'ok', denied: 'warn', error: 'error' };
const OUTCOME_LABEL: Record<AuditRow['outcome'], string> = { ok: 'OK', denied: 'Denied', error: 'Failed' };
const EVENT: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  logout_everywhere: 'Signed out everywhere',
  password_change: 'Changed password',
};

/** A `<input type="date">` day as the ISO instant its LOCAL midnight is, `days` later. */
function dayStart(value: string, days = 0): string | undefined {
  const [y, m, d] = value.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d + days).toISOString() : undefined;
}

type Filters = { actor: string; action: string; channel: string; projectId: string; outcome: string; from: string; to: string };
const NONE: Filters = { actor: '', action: '', channel: '', projectId: '', outcome: '', from: '', to: '' };

function toQuery(f: Filters, before: number | undefined): AuditFilter {
  const q: AuditFilter = {};
  if (f.actor.trim()) q.actor = f.actor.trim();
  if (f.action) q.action = f.action as AuditFilter['action'];
  if (f.channel) q.channel = f.channel;
  if (f.projectId) q.projectId = f.projectId;
  if (f.outcome) q.outcome = f.outcome as AuditFilter['outcome'];
  if (f.from) q.from = dayStart(f.from);
  if (f.to) q.to = dayStart(f.to, 1); // through the end of that day
  if (before) q.before = before;
  return q;
}

export function AuditTab() {
  const [applied, setApplied] = useState<Filters>(NONE);
  const [actor, setActor] = useState('');
  // Cursors of the pages above this one; the last is this page's `before`.
  const [cursors, setCursors] = useState<number[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const audit = useAudit(toQuery(applied, cursors.at(-1)));
  const projects = useAdminProjects();
  if (audit.data?.channels && audit.data.channels.join() !== channels.join()) setChannels(audit.data.channels);
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const set = (patch: Partial<Filters>) => {
    setApplied((f) => ({ ...f, ...patch }));
    setCursors([]);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    set({ actor });
  };
  const filtered = JSON.stringify(applied) !== JSON.stringify(NONE);

  let body;
  if (audit.isPending) body = <SkeletonTable cols={6} rows={10} label="Loading the audit log" />;
  else if (audit.isError) {
    body = <ErrorState heading={3} title="The audit log could not be loaded" message={audit.error.message} onRetry={() => void audit.refetch()} />;
  } else if (audit.data.rows.length === 0) {
    body = (
      <EmptyState heading={3} icon="history" title={filtered ? 'Nothing matches these filters' : 'Nothing recorded yet'}>
        {filtered ? 'Widen the dates or clear a filter.' : 'Sign-ins, changes and admin actions appear here as they happen.'}
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Event</th>
              <th scope="col">Project</th>
              <th scope="col">Ids</th>
              <th scope="col">Outcome</th>
              <th scope="col">Request</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.rows.map((r) => {
              // An org-level call (a transfer, a creation) names its project among the ids.
              const pid = r.projectId ?? r.targets.find((t) => projectName.has(t)) ?? null;
              return (
                <tr key={r.id}>
                  <td className={s.meta}>{fmtDateTime(r.at)}</td>
                  <td>{r.actor ?? <span className={s.meta}>Unknown</span>}</td>
                  <td className={r.action === 'rpc' ? s.mono : undefined}>{r.action === 'rpc' ? r.channel : EVENT[r.action] ?? r.action}</td>
                  <td>{pid ? projectName.get(pid) ?? <span className={s.mono}>{pid.slice(0, 8)}</span> : <span className={s.meta}>—</span>}</td>
                  <td className={s.mono} title={r.targets.join('\n')}>
                    {r.targets.length ? r.targets.map((t) => t.slice(0, 8)).join(' ') : <span className={s.meta}>—</span>}
                  </td>
                  <td>
                    <Badge tone={TONE[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</Badge>
                  </td>
                  <td className={`${s.mono} ${s.meta}`}>{r.requestId ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className={s.section} aria-label="Audit log">
      <form className={s.filters} onSubmit={submit} aria-label="Audit filters">
        <Input label="Who" type="search" placeholder="Email contains…" value={actor} onChange={(e) => setActor(e.target.value)} onBlur={() => actor !== applied.actor && set({ actor })} />
        <Select label="Event" value={applied.action} options={ACTIONS} onValueChange={(v) => set({ action: v })} />
        <Select
          label="Channel"
          value={applied.channel}
          options={[{ value: '', label: 'Any channel' }, ...channels.map((c) => ({ value: c, label: c }))]}
          onValueChange={(v) => set({ channel: v })}
        />
        <Select
          label="Project"
          value={applied.projectId}
          options={[{ value: '', label: 'Any project' }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))]}
          onValueChange={(v) => set({ projectId: v })}
        />
        <Select label="Outcome" value={applied.outcome} options={OUTCOMES} onValueChange={(v) => set({ outcome: v })} />
        <Input label="From" type="date" value={applied.from} max={applied.to || undefined} onChange={(e) => set({ from: e.target.value })} />
        <Input label="To" type="date" value={applied.to} min={applied.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        <Button
          variant="ghost"
          icon="x"
          disabled={!filtered && !actor}
          onClick={() => {
            setActor('');
            set(NONE);
          }}
        >
          Clear filters
        </Button>
      </form>
      {body}
      <nav className={s.pager} aria-label="Audit pages">
        <Button icon="chevron-left" disabled={cursors.length === 0 || audit.isFetching} onClick={() => setCursors((c) => c.slice(0, -1))}>
          Newer
        </Button>
        <Button
          iconEnd="chevron-right"
          disabled={!audit.data?.next || audit.isFetching}
          onClick={() => audit.data?.next && setCursors((c) => [...c, audit.data.next as number])}
        >
          Older
        </Button>
      </nav>
    </section>
  );
}
