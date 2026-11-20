// Admin → Slack (docs/slack/00-design.md): people ask the Assistant from Slack. An org admin creates the Slack app from
// a manifest this server generates (its address filled in), pastes the app's keys back, and picks how Slack reaches
// Ordinate: Slack calls Ordinate (needs a public address; the default) or Ordinate calls Slack (Socket Mode; works
// behind a firewall). The keys go to the server's encrypted store and are never shown again: a stored key reads
// "Stored" and a blank field keeps it. Below: who sees what when an answer is posted in a channel.

import { useState, type FormEvent } from 'react';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Switch } from '../../../ui/Choice';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { copy } from '../../embed/EmbedSnippets';
import { Segmented } from '../../settings/Rows';
import { useSlackInstall, useSlackSettings, useSlackStatus, useSlackUninstall, type SlackMode, type SlackStatus } from './api';
import a from '../Admin.module.css';
import s from './Slack.module.css';

const reason = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

function Hero({ st }: { st: SlackStatus }) {
  const i = st.install;
  const steps = [
    { done: !!i, label: i ? `Connected to ${i.teamName || 'Slack'}` : 'App not connected' },
    { done: !!i?.enabled, label: i?.enabled ? 'Answering' : 'Off' },
    { done: st.linked > 0, label: st.linked === 1 ? '1 person linked' : `${st.linked} people linked` },
  ];
  return (
    <div className={s.hero}>
      <span className={s.heroIcon} aria-hidden="true">
        <Icon name="message-square" size={20} />
      </span>
      <div className={s.heroText}>
        <h3 className={s.heroTitle}>Ask Ordinate from Slack</h3>
        <p className={s.lead}>
          People ask in a channel you connect to an agent, or in a direct message. Each answer is the Assistant’s own, as that person, and goes in the channel only when everyone there may see it.
        </p>
      </div>
      <ul className={s.steps} aria-label="Status">
        {steps.map((x) => (
          <li key={x.label} className={x.done ? `${s.step} ${s.stepDone}` : s.step}>
            <Icon name={x.done ? 'circle-check' : 'circle'} size={12} />
            {x.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The ONE place the choice of mode is made: it decides which manifest is shown and which keys are needed. */
function ModeChoice({ mode, onChange, st, disabled }: { mode: SlackMode; onChange: (m: SlackMode) => void; st: SlackStatus; disabled?: boolean }) {
  return (
    <div className={s.stack}>
      <Segmented<SlackMode>
        label="How Slack reaches Ordinate"
        value={mode}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: 'events', label: 'Slack calls Ordinate', hint: 'Needs this server to be reachable from the internet.' },
          { value: 'socket', label: 'Ordinate calls Slack (Socket Mode)', hint: 'Works behind a firewall: no public address needed.' },
        ]}
      />
      <p className={s.note}>
        <Icon name="info" size={12} />
        <span>
          {mode === 'events'
            ? st.publicUrl
              ? `Slack will call ${st.publicUrl}. Keep it reachable.`
              : 'This server does not know its public address (ORDINATE_PUBLIC_URL), so Slack cannot call it. Choose Socket Mode, or set the address.'
            : 'The server opens the connection to Slack itself, from every pod. You need the app-level token (xapp-…) from the app’s Basic Information page.'}
        </span>
      </p>
    </div>
  );
}

function CreateApp({ st, mode }: { st: SlackStatus; mode: SlackMode }) {
  const text = mode === 'events' ? st.manifest.events : st.manifest.socket;
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>
          <Icon name="code" size={16} /> 1. Create the Slack app
        </h3>
      </div>
      <p className={s.lead}>
        In Slack, choose <strong>Create New App → From a manifest</strong>, pick your workspace and paste this. Then <strong>Install to Workspace</strong>. Each company creates its own app, so no
        outside service sits between Slack and your data.
      </p>
      {text ? (
        <>
          <pre className={s.manifest} tabIndex={0} aria-label="Slack app manifest" data-testid="slack-manifest">
            {text}
          </pre>
          <div className={s.actions}>
            <Button icon="copy" onClick={() => copy(text, 'The manifest')}>
              Copy manifest
            </Button>
            <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer noopener">
              Open Slack’s app page
            </a>
          </div>
          {mode === 'events' && (
            <p className={s.note}>
              <Icon name="info" size={12} />
              <span>Slack checks the request URL when the app is created, before this server has its signing secret. After saving the keys below, open the app’s Event Subscriptions page and press Retry.</span>
            </p>
          )}
        </>
      ) : (
        <p className={s.note} role="note">
          <Icon name="info" size={12} />
          <span>The manifest for “Slack calls Ordinate” needs this server’s public address. Set ORDINATE_PUBLIC_URL and restart, or choose Socket Mode.</span>
        </p>
      )}
    </div>
  );
}

function Keys({ st, mode }: { st: SlackStatus; mode: SlackMode }) {
  const install = useSlackInstall();
  const i = st.install;
  const [f, setF] = useState({ botToken: '', signingSecret: '', clientId: i?.clientId ?? '', clientSecret: '', appToken: '' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    install.mutate(
      {
        botToken: f.botToken.trim(), mode, ...(f.signingSecret.trim() ? { signingSecret: f.signingSecret.trim() } : {}), ...(f.clientId.trim() ? { clientId: f.clientId.trim() } : {}),
        ...(f.clientSecret.trim() ? { clientSecret: f.clientSecret.trim() } : {}), ...(f.appToken.trim() ? { appToken: f.appToken.trim() } : {}),
      },
      {
        onSuccess: (r) => {
          if (!r.ok) return setError(r.error);
          setF({ botToken: '', signingSecret: '', clientId: r.install.clientId, clientSecret: '', appToken: '' });
          toast(`Connected to ${r.install.teamName || 'Slack'}.`, { kind: 'success' });
        },
        onError: (err) => setError(reason(err, 'The keys were not saved.')),
      },
    );
  };
  const stored = (has: boolean | undefined) => (has ? 'Stored. Leave blank to keep it.' : undefined);
  const needSocket = mode === 'socket';
  return (
    <form className={s.card} onSubmit={submit} aria-label="Slack keys">
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>
          <Icon name="lock" size={16} /> 2. Paste the app’s keys
        </h3>
        {i ? <Badge tone="ok" icon="lock">Stored</Badge> : <Badge tone="warn">Not set</Badge>}
      </div>
      <p className={s.lead}>Install the app first: Slack then shows the bot token under <strong>OAuth & Permissions</strong>, and the rest under <strong>Basic Information</strong>. They are kept encrypted and never shown again.</p>
      <div className={s.fields}>
        <div className={s.wide}>
          <Input label="Bot token" type="password" placeholder="xoxb-…" value={f.botToken} onChange={set('botToken')} autoComplete="off" spellCheck={false} required
            hint={i?.hasBotToken ? 'Paste it again to replace it, or to save other changes.' : 'Starts with xoxb-.'} />
        </div>
        {!needSocket && (
          <div className={s.wide}>
            <Input label="Signing secret" type="password" value={f.signingSecret} onChange={set('signingSecret')} autoComplete="off" spellCheck={false} hint={stored(i?.hasSigningSecret) ?? 'Verifies that a request really comes from Slack.'} />
          </div>
        )}
        {needSocket && (
          <div className={s.wide}>
            <Input label="App-level token" type="password" placeholder="xapp-…" value={f.appToken} onChange={set('appToken')} autoComplete="off" spellCheck={false} hint={stored(i?.hasAppToken) ?? 'Create it with the connections:write scope.'} />
          </div>
        )}
        <Input label="Client ID" value={f.clientId} onChange={set('clientId')} autoComplete="off" spellCheck={false} hint="For “Sign in with Slack”, which links a person to their account." />
        <Input label="Client secret" type="password" value={f.clientSecret} onChange={set('clientSecret')} autoComplete="off" spellCheck={false} hint={stored(i?.hasClientSecret)} />
      </div>
      {error && (
        <p className={`${s.note} ${s.warn}`} role="alert">
          <Icon name="alert" size={12} /> {error}
        </p>
      )}
      {!st.canSave && (
        <p className={s.note} role="note">
          <Icon name="lock" size={12} />
          <span>This server cannot keep keys yet: set DATABASE_URL and ORDINATE_MASTER_KEY, then restart it.</span>
        </p>
      )}
      <div className={s.actions}>
        <Button type="submit" variant="primary" icon="circle-check" loading={install.isPending} disabled={!st.canSave || !f.botToken.trim()}>
          {i ? 'Save and check' : 'Connect to Slack'}
        </Button>
        <span className={s.pickMeta}>Slack is asked who the bot is, so a wrong token is caught here.</span>
      </div>
    </form>
  );
}

function Behaviour({ st }: { st: SlackStatus }) {
  const settings = useSlackSettings();
  const uninstall = useSlackUninstall();
  const [confirm, setConfirm] = useState(false);
  const i = st.install;
  if (!i) return null;
  const change = (patch: Parameters<typeof settings.mutate>[0], done: string) =>
    settings.mutate(patch, { onSuccess: (r) => (r.ok ? toast(done, { kind: 'success' }) : toast(r.error, { kind: 'error' })), onError: (e) => toast(reason(e, 'The change did not go through.'), { kind: 'error' }) });
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>
          <Icon name="shield" size={16} /> Who gets an answer
        </h3>
        <Badge tone={i.enabled ? 'ok' : 'neutral'}>{i.enabled ? 'On' : 'Off'}</Badge>
      </div>
      <dl className={s.kv}>
        <dt>Workspace</dt>
        <dd>{i.teamName || i.teamId}</dd>
        <dt>Linked people</dt>
        <dd>{st.linked}</dd>
      </dl>
      <Switch label="Answer questions in Slack" hint={i.enabled ? 'Off: every question is dropped, nothing is read.' : 'Questions are dropped until this is on.'} checked={i.enabled} disabled={settings.isPending}
        onCheckedChange={(on) => change({ enabled: on }, on ? 'Slack answers are on.' : 'Slack answers are off.')} />
      <Switch label="Count guests as channel members" hint="A channel with a guest in it gets figures from restricted data only when this is on. Off: guests make the answer private." checked={i.allowGuests} disabled={settings.isPending}
        onCheckedChange={(on) => change({ allowGuests: on }, on ? 'Guests no longer block a channel post.' : 'Guests now make a restricted answer private.')} />
      <Switch label="Let an asker share past a failed check" hint="Off by default. On: the asker may press Share to channel even when someone there may not see the data. Never for channels shared with another company." checked={i.allowShareOverride} disabled={settings.isPending}
        onCheckedChange={(on) => change({ allowShareOverride: on }, on ? 'Askers may share past the check.' : 'Share to channel now repeats the check.')} />
      <div className={s.actions}>
        <Dialog
          open={confirm}
          onOpenChange={setConfirm}
          size="sm"
          trigger={<Button icon="trash" variant="danger">Disconnect Slack…</Button>}
          title="Disconnect Slack?"
          description="The keys, every linked person and every channel tied to an agent are removed. Slack stops getting answers at once. You can connect again later."
          footer={
            <>
              <DialogClose asChild>
                <Button>Keep it</Button>
              </DialogClose>
              <Button variant="danger" loading={uninstall.isPending} onClick={() => uninstall.mutate(undefined, { onSuccess: () => { setConfirm(false); toast('Slack is disconnected.', { kind: 'success' }); } })}>
                Disconnect
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}

export function SlackTab() {
  const q = useSlackStatus();
  const [picked, setPicked] = useState<SlackMode | null>(null);
  const settings = useSlackSettings();
  if (q.isPending) return <SkeletonBlock label="Loading Slack settings" />;
  if (q.isError) return <ErrorState heading={3} title="Slack settings could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const st = q.data;
  if (!st.ok) {
    return (
      <div className={a.notice} role="note">
        <Icon name="database" />
        <div>
          <h3 className={a.noticeTitle}>Slack needs accounts</h3>
          <p className={a.lead}>{st.error}</p>
        </div>
      </div>
    );
  }
  const mode: SlackMode = picked ?? st.install?.mode ?? (st.publicUrl ? 'events' : 'socket');
  return (
    <section className={a.section} aria-label="Slack">
      <Hero st={st} />
      <div className={s.card}>
        <ModeChoice
          mode={mode}
          st={st}
          disabled={settings.isPending}
          onChange={(m) => {
            setPicked(m);
            // Already connected: the choice is saved at once (the server asks for the key the mode needs).
            if (st.install) settings.mutate({ mode: m }, { onSuccess: (r) => { if (!r.ok) { setPicked(null); toast(r.error, { kind: 'error' }); } } });
          }}
        />
      </div>
      <div className={s.grid}>
        <div className={s.stack}>
          <CreateApp st={st} mode={mode} />
        </div>
        <div className={s.stack}>
          <Keys key={st.install?.teamId ?? 'new'} st={st} mode={mode} />
          <Behaviour st={st} />
        </div>
      </div>
    </section>
  );
}
