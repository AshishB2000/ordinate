// Admin → Channels: the Slack, Teams and email destinations this organization
// can send to. A channel is a way for data to leave the server, so it is made
// here, by an admin, and nowhere else. The webhook URL is write-only: it is
// pasted once, sealed by the server, and never shown again — the list says
// "Stored". An email list names the org's people and teams (EmailRecipients);
// the server decides at each send which of them may read what is sent.

import { useState, type FormEvent } from 'react';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { RadioGroup } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Menu } from '../../ui/Menu';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { ChannelMark, KIND_LABEL } from '../subscriptions/ChannelMark';
import { reason, useChannelUsage, useChannelWrites, useChannels, type Channel, type ChannelKind, type EmailTo } from '../subscriptions/api';
import { EmailRecipients, recipientsText } from './EmailRecipients';
import s from './Admin.module.css';
import c from './Channels.module.css';

const HOW_TO: Record<'slack' | 'teams', { lead: string; steps: string[]; looks: string }> = {
  slack: {
    lead: 'In Slack, an incoming webhook posts to one channel.',
    steps: [
      'Open api.slack.com/apps and create an app (From scratch) in your workspace.',
      'Under Incoming Webhooks, switch them on, then Add New Webhook to Workspace.',
      'Pick the channel, allow, and copy the Webhook URL.',
    ],
    looks: 'https://hooks.slack.com/services/…',
  },
  teams: {
    lead: 'In Teams, a workflow posts to one channel.',
    steps: [
      'On the channel, open ⋯ → Workflows.',
      'Choose “Post to a channel when a webhook request is received”, name it, and pick the team and channel.',
      'Add the workflow and copy the URL it shows.',
    ],
    looks: 'https://….logic.azure.com/workflows/…',
  },
};

const EMAIL_HOW = [
  'Pick the people and teams to send to. Addresses come from their Ordinate accounts; none can be typed.',
  'Each dashboard or alert sent here reaches only those of them who can open its project at that moment.',
  'Someone who has not signed in yet, or whose account is turned off, gets nothing.',
];

/** Add (no `channel`) or edit: kind, name, and the URL (required to add, optional to replace) — or, for email, the recipients. */
function ChannelDialog({ channel, canStore, canEmail, onClose }: { channel?: Channel; canStore: boolean; canEmail: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? (canStore ? 'slack' : 'email'));
  const [name, setName] = useState(channel?.name ?? '');
  const [url, setUrl] = useState('');
  const [to, setTo] = useState<EmailTo>(channel?.to ?? { userIds: [], teamIds: [] });
  const [error, setError] = useState('');
  const { save } = useChannelWrites();
  const email = kind === 'email';
  const how = email ? null : HOW_TO[kind];
  const platforms = [
    ...(canStore ? [{ value: 'slack', label: 'Slack' }, { value: 'teams', label: 'Microsoft Teams' }] : []),
    ...(canEmail ? [{ value: 'email', label: 'Email' }] : []),
  ];
  const ready = !!name.trim() && (email ? to.userIds.length + to.teamIds.length > 0 : !!channel || !!url.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    save.mutate(
      { ...(channel ? { id: channel.id } : {}), name: name.trim(), kind, ...(email ? { to } : url.trim() ? { webhookUrl: url.trim() } : {}) },
      {
        onSuccess: () => {
          toast(channel ? 'Channel saved' : `Added ${name.trim()}. Send a test message to check it.`, { kind: 'success' });
          onClose();
        },
        // The server's sentence (https only, no store, …) belongs beside the field it is about.
        onError: (err) => setError(reason(err, 'The channel could not be saved.')),
      },
    );
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={channel ? `Edit ${channel.name}` : 'Add a channel'}
      description={email ? 'Members will be able to send dashboards and alerts to it. They never see who is on it.' : 'Members will be able to send dashboards and alerts to it. They never see the URL.'}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="channel-form" loading={save.isPending} disabled={!ready}>
            {channel ? 'Save' : 'Add channel'}
          </Button>
        </>
      }
    >
      <form id="channel-form" className={c.form} onSubmit={submit}>
        <div className={c.fields}>
          {!channel && (
            <RadioGroup
              label="Platform"
              orientation="horizontal"
              value={kind}
              onValueChange={(v) => setKind(v as ChannelKind)}
              options={platforms}
            />
          )}
          <Input
            label="Name"
            value={name}
            maxLength={80}
            placeholder={kind === 'slack' ? '#sales-weekly' : email ? 'Sales leadership' : 'Sales › Weekly'}
            hint={email ? 'What members pick from, and what the email says it was sent to.' : 'What members pick from. Use the channel’s own name.'}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {email ? (
            <EmailRecipients value={to} onChange={setTo} error={error || undefined} />
          ) : (
            <Input
              label="Webhook URL"
              value={url}
              type="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={2048}
              placeholder={channel ? 'Stored — paste a new URL to replace it' : how?.looks}
              hint="https only. It is encrypted on the server and never shown again."
              error={error || undefined}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </div>
        {how ? (
          <aside className={c.how} aria-label={`How to get a ${KIND_LABEL[kind]} webhook URL`}>
            <h3 className={c.howTitle}>
              <ChannelMark kind={kind} />
              Getting the URL
            </h3>
            <p className={c.howLead}>{how.lead}</p>
            <ol className={c.howSteps}>
              {how.steps.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ol>
            <p className={c.howLead}>Whoever has this URL can post to that channel, so treat it like a password.</p>
          </aside>
        ) : (
          <aside className={c.how} aria-label="How email lists work">
            <h3 className={c.howTitle}>
              <ChannelMark kind="email" />
              How email works
            </h3>
            <p className={c.howLead}>Ordinate sends through this server’s mail relay, from its sender address.</p>
            <ol className={c.howSteps}>
              {EMAIL_HOW.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ol>
            <p className={c.howLead}>Send a test email goes to you alone.</p>
          </aside>
        )}
      </form>
    </Dialog>
  );
}

/** Delete, naming what posts to the channel today. */
function DeleteDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const usage = useChannelUsage(channel.id);
  const { remove } = useChannelWrites();
  const uses = usage.data ? [...usage.data.subscriptions.map((u) => ({ ...u, what: 'subscription' })), ...usage.data.alerts.map((u) => ({ ...u, what: 'alert' }))] : [];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Remove ${channel.name}?`}
      description="The stored webhook URL is deleted with it. This cannot be undone."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            variant="danger"
            loading={remove.isPending}
            disabled={usage.isPending}
            onClick={() =>
              remove.mutate(channel.id, {
                onSuccess: () => {
                  toast(`Removed ${channel.name}`);
                  onClose();
                },
                onError: (e) => toast(reason(e, 'Could not remove the channel.'), { kind: 'error' }),
              })
            }
          >
            Remove channel
          </Button>
        </>
      }
    >
      {usage.isPending ? (
        <SkeletonTable cols={1} rows={2} label="Checking what uses this channel" />
      ) : usage.isError ? (
        <ErrorState compact heading={3} title="Could not check what uses this channel" message={usage.error.message} onRetry={() => void usage.refetch()} />
      ) : uses.length === 0 ? (
        <p className={s.lead}>Nothing posts to this channel right now.</p>
      ) : (
        <div className={c.warn} role="alert">
          <Icon name="alert" />
          <div>
            <p className={c.warnTitle}>{uses.length === 1 ? '1 thing posts to this channel and will stop sending here:' : `${uses.length} things post to this channel and will stop sending here:`}</p>
            <ul className={c.uses}>
              {uses.map((u) => (
                <li key={`${u.what}-${u.id}`}>
                  <strong>{u.name}</strong> <span className={s.meta}>· {u.what} in {u.project}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function ChannelsTab() {
  const q = useChannels();
  const { test } = useChannelWrites();
  const [editing, setEditing] = useState<{ channel?: Channel } | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [testing, setTesting] = useState('');
  const sendTest = (ch: Channel) => {
    setTesting(ch.id);
    test.mutate(ch.id, {
      onSuccess: () => toast(ch.kind === 'email' ? 'Test email sent to you' : `Test message sent to ${ch.name}`, { kind: 'success' }),
      onError: (e) => toast(reason(e, 'The test message could not be sent.'), { kind: 'error' }),
      onSettled: () => setTesting(''),
    });
  };
  const canStore = q.data?.canStore !== false;
  const canEmail = q.data?.canEmail === true;
  let body;
  if (q.isPending) body = <SkeletonTable cols={4} rows={3} label="Loading channels" />;
  else if (q.isError) body = <ErrorState heading={3} title="Channels could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (q.data.channels.length === 0) {
    body = (
      <EmptyState
        heading={3}
        icon="send"
        title="No channels yet"
        actions={
          (canStore || canEmail) && (
            <Button variant="primary" icon="plus" onClick={() => setEditing({})}>
              Add a channel
            </Button>
          )
        }
      >
        Connect a Slack or Teams channel and members can schedule dashboards to it, and point alerts at it. You paste a webhook URL once; Ordinate encrypts it and
        posts through it from then on.{canEmail && ' Or make an email list of your people and teams: no address is ever typed.'}
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col">Platform</th>
              <th scope="col">Sends to</th>
              <th scope="col" className={s.actions}>
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.channels.map((ch) => (
              <tr key={ch.id}>
                <td>
                  <span className={s.cellRow}>
                    <ChannelMark kind={ch.kind} />
                    <span className={s.strong}>{ch.name}</span>
                  </span>
                </td>
                <td className={s.meta}>{KIND_LABEL[ch.kind]}</td>
                <td>
                  {ch.kind === 'email' ? (
                    <span className={s.cellRow}>
                      <span className={s.meta}>{recipientsText(ch.to)}</span>
                      {!ch.ready && <Badge tone="warn">Email off</Badge>}
                    </span>
                  ) : ch.secretSet ? (
                    <Badge tone="ok" icon="lock">Stored</Badge>
                  ) : (
                    <Badge tone="error">Missing</Badge>
                  )}
                </td>
                <td className={s.actions}>
                  <span className={`${s.cellRow} ${c.actionsEnd}`}>
                    <Button size="sm" icon="send" loading={testing === ch.id} disabled={!ch.ready} onClick={() => sendTest(ch)}>
                      {ch.kind === 'email' ? 'Send a test email' : 'Send a test message'}
                    </Button>
                    <Menu
                      align="end"
                      trigger={<IconButton icon="more-horizontal" label={`Actions for ${ch.name}`} size="sm" />}
                      items={[
                        { label: 'Edit…', icon: 'pencil', onSelect: () => setEditing({ channel: ch }) },
                        { kind: 'separator' },
                        { label: 'Remove…', icon: 'trash', danger: true, onSelect: () => setDeleting(ch) },
                      ]}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section className={s.section} aria-label="Channels">
      <div className={s.bar}>
        <p className={s.lead}>
          {canEmail ? 'Slack and Teams channels and email lists' : 'Slack and Teams channels'} members can send dashboards and alerts to. What is sent: KPI figures and chart rows as
          text, shaped by each project’s share policy — never a file, never a connection’s credentials.
        </p>
        <div className={s.barEnd}>
          <Button variant="primary" icon="plus" disabled={!canStore && !canEmail} onClick={() => setEditing({})}>
            Add a channel
          </Button>
        </div>
      </div>
      {q.data && !canStore && (
        <div className={s.notice} role="note">
          <Icon name="lock" />
          <div>
            <h3 className={s.noticeTitle}>This server cannot keep webhook URLs yet</h3>
            <p className={s.lead}>
              A webhook URL is a credential, so it is only ever stored encrypted — and that needs a database and a master key. Set DATABASE_URL and ORDINATE_MASTER_KEY on the
              server, restart it, and channels can be added here.{' '}
              {canEmail ? 'Email lists work without them.' : 'Email lists need the database too, and a mail relay (SMTP_HOST).'}
            </p>
          </div>
        </div>
      )}
      {body}
      {editing && <ChannelDialog channel={editing.channel} canStore={canStore} canEmail={canEmail} onClose={() => setEditing(null)} />}
      {deleting && <DeleteDialog channel={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}
