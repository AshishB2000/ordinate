// Admin → Integrations (docs/issues-board/00-design.md): connect Linear or Jira Cloud so an editor can send an issue as a ticket. A ticket
// holds the title, a summary and a link back: no question text leaves Ordinate. The token is kept encrypted and never shown again; a stored
// one reads "Stored". Nothing is sent until an admin connects here AND an editor presses Send on an issue.

import { useState, type FormEvent } from 'react';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { useConnect, useDisconnect, useTrackers, type Provider, type ProviderView } from './api';
import s from './Integrations.module.css';
import a from '../Admin.module.css';

const reason = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

function Connected({ v, name }: { v: ProviderView; name: string }) {
  const off = useDisconnect();
  const rows = v.provider === 'linear'
    ? [['Team', v.settings.teamKey]]
    : [['Site', v.settings.site], ['Account', v.settings.email], ['Project', v.settings.projectKey], ['Issue type', v.settings.issueType]];
  return (
    <>
      <dl className={s.kv}>
        {rows.filter(([, val]) => val).map(([k, val]) => (
          <div key={k} className={s.pair}>
            <dt>{k}</dt>
            <dd>{val}</dd>
          </div>
        ))}
      </dl>
      <div className={s.actions}>
        <Button
          variant="ghost" icon="x" loading={off.isPending}
          onClick={() => off.mutate(v.provider, { onSuccess: () => toast(`${name} disconnected.`, { kind: 'success' }), onError: (e) => toast(reason(e, 'It was not disconnected.'), { kind: 'error' }) })}
        >
          Disconnect
        </Button>
      </div>
    </>
  );
}

function Form({ provider, name, canSave }: { provider: Provider; name: string; canSave: boolean }) {
  const connect = useConnect();
  const [f, setF] = useState({ apiToken: '', teamKey: '', site: '', email: '', projectKey: '' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ready = f.apiToken.trim() && (provider === 'linear' ? f.teamKey.trim() : f.site.trim() && f.email.trim() && f.projectKey.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const input = provider === 'linear'
      ? { provider, apiToken: f.apiToken.trim(), teamKey: f.teamKey.trim() }
      : { provider, apiToken: f.apiToken.trim(), site: f.site.trim(), email: f.email.trim(), projectKey: f.projectKey.trim() };
    connect.mutate(input, {
      onSuccess: (r) => {
        if (!r.ok) return setError(r.error);
        setF({ apiToken: '', teamKey: '', site: '', email: '', projectKey: '' });
        toast(`Connected to ${name}.`, { kind: 'success' });
      },
      onError: (err) => setError(reason(err, 'It was not connected.')),
    });
  };
  return (
    <form onSubmit={submit} aria-label={`Connect ${name}`} className={s.form}>
      <div className={s.fields}>
        {provider === 'linear' ? (
          <>
            <Input label="Team key" placeholder="DATA" value={f.teamKey} onChange={set('teamKey')} autoComplete="off" spellCheck={false} hint="The letters before a ticket’s number, like DATA in DATA-142." />
            <Input label="API key" type="password" value={f.apiToken} onChange={set('apiToken')} autoComplete="off" spellCheck={false} hint="A personal API key from Linear: Settings, then Security & access." />
          </>
        ) : (
          <>
            <Input label="Jira site" placeholder="acme.atlassian.net" value={f.site} onChange={set('site')} autoComplete="off" spellCheck={false} hint="Jira Cloud only." />
            <Input label="Project key" placeholder="DATA" value={f.projectKey} onChange={set('projectKey')} autoComplete="off" spellCheck={false} hint="A ticket uses the project’s default issue type." />
            <Input label="Account email" type="email" value={f.email} onChange={set('email')} autoComplete="off" spellCheck={false} />
            <Input label="API token" type="password" value={f.apiToken} onChange={set('apiToken')} autoComplete="off" spellCheck={false} hint="From id.atlassian.com, under Security, API tokens." />
          </>
        )}
      </div>
      {error && <p className={s.problem} role="alert">{error}</p>}
      {!canSave && (
        <p className={s.note} role="note">
          <Icon name="lock" size={12} />
          <span>This server cannot keep a token yet: set DATABASE_URL and ORDINATE_MASTER_KEY, then restart it.</span>
        </p>
      )}
      <div className={s.actions}>
        <Button type="submit" variant="primary" icon="circle-check" loading={connect.isPending} disabled={!canSave || !ready}>Connect {name}</Button>
        <span className={s.note}>{name} is asked once to prove the token. Nothing else is sent.</span>
      </div>
    </form>
  );
}

const COPY: Record<Provider, { name: string; lead: string }> = {
  linear: { name: 'Linear', lead: 'Send an issue from the Assistant’s Issues board as a Linear ticket.' },
  jira: { name: 'Jira', lead: 'Send an issue from the Assistant’s Issues board as a Jira Cloud ticket. Jira Server and Data Center are not supported.' },
};

export function IntegrationsTab() {
  const q = useTrackers();
  if (q.isPending) return <SkeletonBlock label="Loading integrations" />;
  if (q.isError) return <ErrorState heading={3} title="Integrations could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  if (!q.data.ok || !q.data.available) {
    return (
      <div className={a.notice} role="note">
        <Icon name="database" />
        <div>
          <h3 className={a.noticeTitle}>Integrations need the server’s database</h3>
          <p className={a.lead}>Set DATABASE_URL and restart the server.</p>
        </div>
      </div>
    );
  }
  const st = q.data;
  return (
    <section className={a.section} aria-label="Integrations">
      <p className={s.lead}>
        A ticket holds the issue’s title, a summary and a link back to Ordinate. No question text leaves Ordinate, and nothing is sent until an editor presses Send.
      </p>
      <div className={s.grid}>
        {st.providers.map((v) => (
          <div key={v.provider} className={s.card} data-testid={`integration-${v.provider}`}>
            <div className={s.head}>
              <h3 className={s.title}><Icon name="send" size={16} /> {COPY[v.provider].name}</h3>
              {v.connected ? <Badge tone="ok" icon="lock">Stored</Badge> : <Badge tone="warn">Not connected</Badge>}
            </div>
            <p className={s.lead}>{COPY[v.provider].lead}</p>
            {v.connected ? <Connected v={v} name={COPY[v.provider].name} /> : <Form provider={v.provider} name={COPY[v.provider].name} canSave={st.canSave} />}
          </div>
        ))}
      </div>
    </section>
  );
}
