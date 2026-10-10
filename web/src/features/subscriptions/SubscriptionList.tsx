// Reports → Subscriptions: every scheduled send of this project — what it
// sends, when (the server's sentence), where, its next run and how the last one
// ended — with the three things a list can do on its own: switch one on or off,
// send it now, and read its runs. Editing opens the Subscribe dialog.

import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState } from '../../app/blocks';
import { ago } from '../../app/when';
import { Badge, type BadgeTone } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { Dialog, DialogClose, Drawer } from '../../ui/Dialog';
import { Menu } from '../../ui/Menu';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useCanEdit } from '../projects/api';
import { ChannelChip } from './ChannelMark';
import { reason, useHistory, useSubscriptions, useSubscriptionsLive, useSubscriptionWrites, type Channel, type RunView, type Subscription } from './api';
import s from './List.module.css';

const SubscribeDialog = lazy(() => import('./SubscribeDialog'));

const OUTCOME: Record<RunView['outcome'], { tone: BadgeTone; word: string }> = {
  sent: { tone: 'ok', word: 'Sent' },
  skipped: { tone: 'neutral', word: 'Skipped' },
  failed: { tone: 'error', word: 'Failed' },
  missed: { tone: 'warn', word: 'Missed' },
};

function Outcome({ run }: { run: RunView }) {
  const o = OUTCOME[run.outcome];
  return <Badge tone={o.tone}>{o.word}</Badge>;
}

function HistoryDrawer({ projectId, sub, onClose }: { projectId: string; sub: Subscription; onClose: () => void }) {
  const q = useHistory(projectId, sub.id);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={`Runs of ${sub.name}`} description="The last 20, newest first. What a channel answered is in the server log, not here.">
      {q.isPending ? (
        <div className={s.runs} role="status" aria-busy="true" aria-label="Loading runs">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className={s.skRun} />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState compact heading={3} title="The runs could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.data.runs.length === 0 ? (
        <EmptyState compact heading={3} icon="history" title="No runs yet">
          {sub.nextRuns[0] ? `The first is ${sub.nextRuns[0].text}. Send now to try it today.` : 'Switch it on, or send it now.'}
        </EmptyState>
      ) : (
        <ol className={s.runs} aria-label="Runs">
          {q.data.runs.map((r, i) => (
            <li key={`${r.at}-${i}`} className={s.run}>
              <div className={s.runHead}>
                <Outcome run={r} />
                <time className={s.runWhen} dateTime={r.at} title={new Date(r.at).toLocaleString()}>
                  {ago(r.at)}
                </time>
                <span className={s.runTrigger}>{r.trigger === 'manual' ? 'Sent by hand' : 'Scheduled'}</span>
              </div>
              <p className={s.runText}>{r.text}</p>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}

function Row({
  projectId,
  sub,
  channels,
  canEdit,
  onEdit,
  onHistory,
  onDelete,
}: {
  projectId: string;
  sub: Subscription;
  channels: Map<string, Channel>;
  canEdit: boolean;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
}) {
  const { setEnabled, sendNow } = useSubscriptionWrites(projectId);
  const fail = (e: unknown) => toast(reason(e, 'That did not work.'), { kind: 'error' });
  const send = () =>
    sendNow.mutate(sub.id, {
      onSuccess: (r) => toast(r.ok ? (r.run?.text ?? 'Sent') : reason(r, 'It could not be sent.'), { kind: r.ok ? 'success' : 'error' }),
      onError: fail,
    });
  return (
    <li className={sub.enabled ? s.row : `${s.row} ${s.rowOff}`} aria-label={sub.name} data-subscription-id={sub.id}>
      <span className={s.icon} aria-hidden="true">
        <Icon name="send" />
      </span>
      <div className={s.main}>
        <div className={s.nameLine}>
          <span className={s.name}>{sub.name}</span>
          {sub.paused && <Badge tone="error">Paused</Badge>}
        </div>
        <div className={s.meta}>
          {sub.dashboard ? (
            <Link to={`/analyses/${projectId}/${sub.analysisId}`}>{sub.dashboard}</Link>
          ) : (
            <span className={s.gone}>Its dashboard was deleted</span>
          )}
          <span> · {sub.content.mode === 'all' ? 'whole dashboard' : sub.content.cardIds.length === 1 ? '1 card' : `${sub.content.cardIds.length} cards`}</span>
          <span> · owned by {sub.owner}</span>
        </div>
        {sub.paused && (
          <p className={s.paused} role="note">
            {sub.paused.text} {sub.paused.reason}
          </p>
        )}
      </div>
      <div className={s.cell}>
        <span className={s.cellLabel}>Schedule</span>
        <span className={s.cellValue}>{sub.scheduleText}</span>
        <span className={s.cellSub}>{sub.enabled ? (sub.nextRuns[0] ? `Next: ${sub.nextRuns[0].text}` : '') : 'Off — no next run'}</span>
      </div>
      <div className={s.cell}>
        <span className={s.cellLabel}>Channels</span>
        <span className={s.chips}>
          {sub.channelIds.map((id) => {
            const c = channels.get(id);
            return c ? <ChannelChip key={id} kind={c.kind} name={c.name} missing={!c.secretSet} /> : <ChannelChip key={id} kind="slack" name="Removed channel" missing />;
          })}
        </span>
      </div>
      <div className={s.cell}>
        <span className={s.cellLabel}>Last run</span>
        {sub.lastRun ? (
          <>
            <span className={s.lastLine}>
              <Outcome run={sub.lastRun} />
              <time className={s.cellSub} dateTime={sub.lastRun.at}>
                {ago(sub.lastRun.at)}
              </time>
            </span>
            <span className={s.cellSub}>{sub.lastRun.text}</span>
          </>
        ) : (
          <span className={s.cellSub}>Not run yet</span>
        )}
      </div>
      <div className={s.actions}>
        {canEdit && (
          <Switch
            label={sub.enabled ? 'On' : 'Off'}
            className={s.toggle}
            checked={sub.enabled}
            disabled={setEnabled.isPending}
            aria-label={`Send ${sub.name} on its schedule`}
            onCheckedChange={(enabled) => setEnabled.mutate({ id: sub.id, enabled }, { onSuccess: () => toast(enabled ? 'Switched on' : 'Switched off'), onError: fail })}
          />
        )}
        {canEdit && (
          <Button size="sm" icon="send" loading={sendNow.isPending} onClick={send}>
            Send now
          </Button>
        )}
        <Menu
          label={`${sub.name} options`}
          align="end"
          trigger={<IconButton icon="more-horizontal" size="sm" label={`${sub.name} options`} />}
          items={[
            { label: 'Runs', icon: 'history', onSelect: onHistory },
            ...(canEdit
              ? [{ label: 'Edit…', icon: 'pencil' as const, onSelect: onEdit }, { kind: 'separator' as const }, { label: 'Delete…', icon: 'trash' as const, danger: true, onSelect: onDelete }]
              : []),
          ]}
        />
      </div>
    </li>
  );
}

export function SubscriptionList({ projectId }: { projectId: string }) {
  const q = useSubscriptions(projectId);
  useSubscriptionsLive(projectId);
  const canEdit = useCanEdit(projectId);
  const { remove } = useSubscriptionWrites(projectId);
  const [dialog, setDialog] = useState<{ existing?: Subscription } | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Subscription | null>(null);

  let body;
  if (q.isPending) {
    body = (
      <ul className={s.list} aria-busy="true" aria-label="Loading subscriptions">
        {[0, 1, 2].map((i) => (
          <li key={i} className={s.row} aria-hidden="true">
            <Skeleton className={s.skIcon} />
            <Skeleton className={s.skMain} />
            <Skeleton className={s.skCell} />
            <Skeleton className={s.skCell} />
            <Skeleton className={s.skCell} />
            <Skeleton className={s.skCell} />
          </li>
        ))}
      </ul>
    );
  } else if (q.isError) {
    body = <ErrorState title="Subscriptions could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  } else if (q.data.subscriptions.length === 0) {
    body = (
      <EmptyState
        icon="send"
        title="Nothing is scheduled yet"
        actions={
          canEdit && (
            <Button variant="primary" size="lg" icon="plus" onClick={() => setDialog({})}>
              New subscription
            </Button>
          )
        }
      >
        A subscription posts a dashboard’s figures to a Slack or Teams channel on a schedule — every weekday at 08:00, say — with a link back. The server sends it
        with nobody signed in: each KPI with its change, each chart as its top rows, every number one the app computed.
        {!canEdit && ' An editor of this project can create one. You have view-only access.'}
        {canEdit && q.data.channels.length === 0 &&
          (!q.data.canStore
            ? ' This server cannot keep webhook URLs yet (it needs DATABASE_URL and ORDINATE_MASTER_KEY), so no channel can be connected.'
            : q.data.canManage
              ? ' You will need a channel first: add one in Admin → Channels.'
              : ' An organization admin has to connect a channel first.')}
      </EmptyState>
    );
  } else {
    const channels = new Map(q.data.channels.map((c) => [c.id, c]));
    body = (
      <ul className={s.list} aria-label="Subscriptions">
        {q.data.subscriptions.map((sub) => (
          <Row
            key={sub.id}
            projectId={projectId}
            sub={sub}
            channels={channels}
            canEdit={canEdit}
            onEdit={() => setDialog({ existing: sub })}
            onHistory={() => setHistory(sub.id)}
            onDelete={() => setDeleting(sub)}
          />
        ))}
      </ul>
    );
  }
  const historyOf = q.data?.subscriptions.find((x) => x.id === history);
  return (
    <div className={s.tab}>
      {!!q.data?.subscriptions.length && (
        <div className={s.bar}>
          <span className={s.count}>{q.data.subscriptions.length === 1 ? '1 subscription' : `${q.data.subscriptions.length} subscriptions`}</span>
          {canEdit && (
            <Button variant="primary" icon="plus" onClick={() => setDialog({})}>
              New subscription
            </Button>
          )}
        </div>
      )}
      {body}
      {dialog && (
        <Suspense fallback={null}>
          <SubscribeDialog projectId={projectId} existing={dialog.existing} onClose={() => setDialog(null)} />
        </Suspense>
      )}
      {historyOf && <HistoryDrawer projectId={projectId} sub={historyOf} onClose={() => setHistory(null)} />}
      {deleting && (
        <Dialog
          open
          size="sm"
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete ${deleting.name}?`}
          description="It stops sending and its runs are forgotten. The dashboard and the channels stay."
          footer={
            <>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() =>
                  remove.mutate(deleting.id, {
                    onSuccess: () => {
                      toast('Subscription deleted');
                      setDeleting(null);
                    },
                    onError: (e) => toast(reason(e, 'Could not delete the subscription.'), { kind: 'error' }),
                  })
                }
              >
                Delete
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
