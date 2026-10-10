// The top bar's bell, its inbox and the rules page (legacy alertsInbox.ts).
// The badge is the server's `unseen` count for the current project; a fired
// alert arrives as an `alerts:fired` push (to members who may read the
// project, T6.3) and the list re-reads. Every figure in a message is the
// server's sentence; the sparkline draws the rule's own stored history.

import { useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../api/client';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Popover } from '../../ui/Popover';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { ago } from '../../app/when';
import { openDockWith } from '../assistant/dockState';
import { Drawer } from '../../ui/Dialog';
import { DriversView } from '../analytics/drivers/DriversView';
import type { DriversRequest } from '../analytics/api';
import { useCurrentProject } from '../projects/current';
import { reason, useAlerts, useAlertsLive, useAlertWrite, type AlertEvent, type AlertRule } from './api';
import { usePausedNotice } from '../subscriptions/notices';
import s from './Alerts.module.css';

/** The rule's last values as a 96×24 line — positions only; every value is the server's. */
function Spark({ values }: { values: number[] | undefined }) {
  const v = (values ?? []).filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const lo = Math.min(...v);
  const span = Math.max(...v) - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * 94 + 1).toFixed(1)},${(23 - ((x - lo) / span) * 22).toFixed(1)}`).join(' ');
  return (
    <svg className={s.spark} width="96" height="24" viewBox="0 0 96 24" aria-hidden="true">
      <polyline points={pts} />
    </svg>
  );
}

const condition = (r: AlertRule): string => {
  if (r.compare === 'anomaly') return 'Unusual values';
  if (r.compare === 'change' && r.change) return `${r.change.direction === 'up' ? 'Rises' : r.change.direction === 'down' ? 'Falls' : 'Moves'} ${r.change.pct}% vs ${r.change.vs === 'previous_period' ? 'previous period' : 'previous refresh'}`;
  if (r.threshold) return `${{ '<': 'Below', '<=': 'At or below', '>': 'Above', '>=': 'At or above' }[r.threshold.op]} ${r.threshold.value}`;
  return '';
};
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

function RulesDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const q = useAlerts(projectId);
  const write = useAlertWrite(projectId);
  const [armed, setArmed] = useState<string | null>(null);
  const fail = (e: unknown) => toast(reason(e, 'Could not change the rule.'), { kind: 'error' });
  const patch = (ruleId: string, p: { enabled?: boolean; quietHours?: { from: number; to: number } | null }) =>
    write.mutate({ channel: 'alerts:patch', input: { projectId, ruleId, patch: p } }, { onError: fail });
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="Alert rules"
      description="What each rule watches, and when it last fired."
      footer={
        <DialogClose asChild>
          <Button variant="primary">Done</Button>
        </DialogClose>
      }
    >
      {q.isPending ? (
        <SkeletonRows rows={4} label="Loading rules" />
      ) : q.isError ? (
        <ErrorState compact heading={3} title="Could not read alerts" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !q.data.rules.length ? (
        <EmptyState compact heading={3} icon="bell" title="No alert rules yet">
          Open a KPI card’s actions menu and choose “Alert me…”.
        </EmptyState>
      ) : (
        <>
          <Checkbox
            label="One digest notification per refresh"
            checked={q.data.digest}
            onCheckedChange={(on) => write.mutate({ channel: 'alerts:setDigest', input: { projectId, on } }, { onError: fail })}
          />
          <table className={s.rules}>
            <thead>
              <tr>
                <th scope="col">On</th>
                <th scope="col">Rule</th>
                <th scope="col">Metric</th>
                <th scope="col">Condition</th>
                <th scope="col">Last value</th>
                <th scope="col">Last fired</th>
                <th scope="col">Quiet hours</th>
                <th scope="col">
                  <span className={s.srOnly}>Delete</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input type="checkbox" role="switch" className={s.switchCell} aria-label={`Enable ${r.name}`} checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} />
                  </td>
                  <td className={s.ruleName}>{r.name}</td>
                  <td>{r.metric.column ? `${r.metric.aggregation}(${r.metric.column})` : 'whole dataset'}</td>
                  <td>{condition(r)}</td>
                  <td className={s.tnum}>{r.lastValue ?? '—'}</td>
                  <td>{r.lastFiredAt ? ago(r.lastFiredAt) : 'never'}</td>
                  <td>
                    <div className={s.quiet}>
                      <Select size="sm" aria-label={`Quiet from, ${r.name}`} value={r.quietHours ? String(r.quietHours.from) : null} placeholder="—" options={HOURS}
                        onValueChange={(v) => patch(r.id, { quietHours: { from: Number(v), to: r.quietHours?.to ?? (Number(v) + 8) % 24 } })} />
                      <Select size="sm" aria-label={`Quiet until, ${r.name}`} value={r.quietHours ? String(r.quietHours.to) : null} placeholder="—" options={HOURS}
                        onValueChange={(v) => patch(r.id, { quietHours: { from: r.quietHours?.from ?? 22, to: Number(v) } })} />
                      {r.quietHours && <IconButton icon="x" size="sm" label={`No quiet hours for ${r.name}`} onClick={() => patch(r.id, { quietHours: null })} />}
                    </div>
                  </td>
                  <td>
                    <IconButton
                      icon="trash"
                      size="sm"
                      label={armed === r.id ? `Delete “${r.name}”? Its past alerts go with it` : `Delete ${r.name}`}
                      onClick={() => {
                        if (armed !== r.id) return setArmed(r.id);
                        write.mutate({ channel: 'alerts:delete', input: { projectId, ruleId: r.id } }, { onError: fail });
                        setArmed(null);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Dialog>
  );
}

function EventRow({ e, rule, projectId, onClose }: { e: AlertEvent; rule?: AlertRule; projectId: string; onClose: () => void }) {
  const write = useAlertWrite(projectId);
  const fail = (err: unknown) => toast(reason(err, 'Could not change the alert.'), { kind: 'error' });
  // Explain: the dock asks the alert's own sentence, as the desktop's explainEvent seeds it
  // (the app's figures in the question; the dock says how to connect a model when none is).
  const explain = () => {
    onClose();
    openDockWith(`${e.message} Why might that have happened?`);
  };
  // Why (driversEntry.ts drvWhyFromAlert): the change broken down by what drove it, from the rule.
  const [why, setWhy] = useState<{ request?: DriversRequest; error?: string } | null>(null);
  const askWhy = async () => {
    setWhy({});
    try {
      const r = (await rpc('drivers:explainAlert', { projectId, ruleId: e.ruleId })) as { ok: boolean; spec?: DriversRequest; error?: string };
      setWhy(r.ok && r.spec ? { request: r.spec } : { error: reason(r, 'That alert has no dated data to compare.') });
    } catch (err) {
      setWhy({ error: reason(err, 'Could not explain the alert.') });
    }
  };
  return (
    <li className={e.seen ? s.event : `${s.event} ${s.unseen}`}>
      <div className={s.eventHead}>
        <span className={s.eventName}>{e.ruleName}</span>
        <span className={s.when}>{ago(e.at)}</span>
      </div>
      <div className={s.eventMain}>
        <p className={s.eventMsg}>{e.message}</p>
        <Spark values={rule?.history} />
      </div>
      <div className={s.eventActions}>
        {e.analysisId && (
          <Link className={s.linkBtn} to={`/analyses/${projectId}/${e.analysisId}`} onClick={onClose}>
            Open dashboard
          </Link>
        )}
        <button type="button" className={s.linkBtn} onClick={explain}>
          Explain
        </button>
        {rule && rule.compare !== 'anomaly' && (
          <button type="button" className={s.linkBtn} onClick={() => void askWhy()}>
            Why
          </button>
        )}
        {why && (
          <Drawer open wide onOpenChange={(o) => !o && setWhy(null)} title={`Why: ${e.ruleName}`} description="What drove the change the alert caught">
            {why.request ? <DriversView projectId={projectId} request={why.request} /> : why.error ? <p className={s.alTestBad}>{why.error}</p> : <SkeletonRows rows={4} label="Breaking the change down" />}
          </Drawer>
        )}
        {rule && (
          <button
            type="button"
            className={s.linkBtn}
            onClick={() => write.mutate({ channel: 'alerts:patch', input: { projectId, ruleId: rule.id, patch: { snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() } } }, { onError: fail, onSuccess: () => toast('Snoozed for 24 hours') })}
          >
            Snooze 24h
          </button>
        )}
        {!e.seen && (
          <button type="button" className={s.linkBtn} onClick={() => write.mutate({ channel: 'alerts:markSeen', input: { projectId, eventId: e.id } }, { onError: fail })}>
            Mark seen
          </button>
        )}
      </div>
    </li>
  );
}

export function AlertsBell() {
  const { projectId } = useCurrentProject();
  const [open, setOpen] = useState(false);
  // The bell is on every page, so it is also where a subscription's owner hears that it paused itself.
  usePausedNotice();
  // The bell asks the server only once it matters: opened, or an alert fired
  // (alerts:fired). A dashboard's KPI cards read the same list, so on a
  // dashboard the badge is there at once; every other page stays inside its
  // RPC budget (plan §9) instead of paying one more call per load.
  const [wanted, setWanted] = useState(false);
  const q = useAlerts(projectId, open || wanted);
  useAlertsLive(projectId, () => setWanted(true));
  const write = useAlertWrite(projectId ?? '');
  const [rules, setRules] = useState(false);
  const unseen = q.data?.unseen ?? 0;
  const label = unseen ? `Alerts: ${unseen} unseen` : 'Alerts';
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        title="Alerts"
        align="end"
        className={s.inbox}
        trigger={
          <button type="button" className={s.bell} aria-label={label} title={label} disabled={!projectId}>
            <Icon name="bell" />
            {unseen > 0 && <span className={s.bellBadge}>{unseen > 9 ? '9+' : unseen}</span>}
          </button>
        }
      >
        <div className={s.inboxHead}>
          <span className={s.inboxTitle}>Alerts</span>
          {unseen > 0 && projectId && (
            <Button size="sm" variant="ghost" onClick={() => write.mutate({ channel: 'alerts:markSeen', input: { projectId } })}>
              Mark all seen
            </Button>
          )}
        </div>
        <div className={s.inboxBody}>
          {q.isPending ? (
            <SkeletonRows rows={3} label="Loading alerts" />
          ) : q.isError ? (
            <ErrorState compact heading={3} title="Could not read alerts" message={q.error.message} onRetry={() => void q.refetch()} />
          ) : !q.data.rules.length ? (
            <EmptyState compact heading={3} icon="bell" title="No alerts yet">
              Open a KPI card’s actions menu and choose “Alert me…” to watch a number.
            </EmptyState>
          ) : !q.data.events.length ? (
            <EmptyState compact heading={3} icon="circle-check" title="Nothing has fired">
              Your rules are watching. You’ll see anything they catch here.
            </EmptyState>
          ) : (
            <ul className={s.events} aria-label="Fired alerts">
              {q.data.events.slice(0, 50).map((e) => (
                <EventRow key={e.id} e={e} rule={q.data.rules.find((r) => r.id === e.ruleId)} projectId={projectId as string} onClose={() => setOpen(false)} />
              ))}
            </ul>
          )}
        </div>
        <div className={s.inboxFoot}>
          <Button
            size="sm"
            variant="ghost"
            icon="settings"
            onClick={() => {
              setOpen(false);
              setRules(true);
            }}
          >
            Manage rules
          </Button>
        </div>
      </Popover>
      {rules && projectId && <RulesDialog projectId={projectId} onClose={() => setRules(false)} />}
    </>
  );
}
