// Admin → AI (docs/ai-models/00-plan.md §5): connect each provider once, then
// choose the exact models members may use and the one they get by default.
// It is an allow-list: a model a provider releases tomorrow stays hidden until
// an admin adds it here. Everything is the server's (`ai:admin`); this screen
// only shows it and sends changes.
//
// The key field is WRITE-ONLY: a password input, never prefilled, cleared the
// moment it is sent. The server stores it encrypted and only ever answers with
// a has-key flag.

import { useState, type FormEvent } from 'react';
import { ago } from '../../app/when';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { PROVIDER_LABEL } from '../assistant/api';
import { AiModelsDialog } from './AiModelsDialog';
import { aiWhy, useAiAdmin, useAiWrite, type AiAdmin, type AiModelRow, type AiProviderState } from './api';
import s from './Admin.module.css';

type Mode = 'connect' | 'replace' | null;

/** The inline form under a provider row: a write-only key, and the endpoint the provider needs. */
function ConnectForm({ p, mode, onDone }: { p: AiProviderState; mode: 'connect' | 'replace'; onDone: () => void }) {
  const gateway = p.provider === 'gateway';
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [advanced, setAdvanced] = useState(gateway);
  const [error, setError] = useState('');
  const connect = useAiWrite('ai:connect', (r) => {
    if (r.ok) {
      toast(`${PROVIDER_LABEL[p.provider]} is connected.`, { kind: 'success' });
      onDone();
    } else setError(aiWhy(r));
  });
  const needsKey = !gateway && (mode === 'replace' || !p.hasKey);
  const ready = (!needsKey || key.trim()) && (!gateway || mode === 'replace' || (baseUrl.trim() && model.trim()));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || connect.isPending) return;
    setError('');
    connect.mutate({
      provider: p.provider,
      ...(key.trim() ? { apiKey: key.trim() } : {}),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    });
    setKey(''); // sent: the browser keeps no copy
  };
  return (
    <form className={s.aiForm} onSubmit={submit} aria-label={`Connect ${PROVIDER_LABEL[p.provider]}`}>
      <div className={s.aiGrow}>
        <Input
          label={gateway ? 'API key (if the gateway needs one)' : 'API key'}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={mode === 'replace' ? 'Paste the new key' : 'Paste the key'}
          error={error || undefined}
          autoFocus
        />
      </div>
      {advanced ? (
        <>
          <div className={s.aiGrow}>
            <Input
              label={gateway ? 'Base URL' : 'Base URL (optional)'}
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={gateway ? 'https://gateway.example.com/v1' : 'The provider’s own, unless you proxy it'}
            />
          </div>
          {gateway && (
            <div className={s.aiGrow}>
              <Input label="Model id to test with" value={model} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-4o-mini" />
            </div>
          )}
        </>
      ) : (
        <Button variant="ghost" size="sm" icon="sliders" onClick={() => setAdvanced(true)}>
          Advanced
        </Button>
      )}
      <div className={s.aiFormActions}>
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" icon="plug" loading={connect.isPending} disabled={!ready}>
          {mode === 'replace' ? 'Replace and test' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}

function DisconnectDialog({ p, losing, onOpenChange }: { p: AiProviderState; losing: number; onOpenChange: (o: boolean) => void }) {
  const disconnect = useAiWrite('ai:disconnect', (r) => r.ok && onOpenChange(false));
  const name = PROVIDER_LABEL[p.provider];
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="sm"
      title={`Disconnect ${name}?`}
      description={
        losing === 0
          ? 'Its key is deleted from this server. No member is using its models.'
          : `Its key is deleted from this server, and members lose ${losing === 1 ? '1 model' : `${losing} models`}. Anyone who picked one gets the default.`
      }
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="danger" icon="trash" loading={disconnect.isPending} onClick={() => disconnect.mutate({ provider: p.provider })}>
            Disconnect
          </Button>
        </>
      }
    />
  );
}

function ProviderRow({ p, models }: { p: AiProviderState; models: readonly AiModelRow[] }) {
  const [mode, setMode] = useState<Mode>(null);
  const [confirming, setConfirming] = useState(false);
  const test = useAiWrite('ai:connect', (r) => toast(r.ok ? `${PROVIDER_LABEL[p.provider]} answered.` : aiWhy(r), { kind: r.ok ? 'success' : 'error' }));
  const status = p.connected ? (
    <Badge tone="ok" icon="circle-check">{`Connected · tested ${ago(p.verifiedAt ?? undefined)}`}</Badge>
  ) : p.saved ? (
    <Badge tone="error" icon="alert">
      Test failed
    </Badge>
  ) : (
    <Badge>Not connected</Badge>
  );
  return (
    <li className={s.aiRow}>
      <span className={s.strong}>{PROVIDER_LABEL[p.provider]}</span>
      <span>{status}</span>
      <span className={s.aiActions}>
        {p.saved ? (
          <>
            <Button size="sm" icon="refresh" loading={test.isPending} onClick={() => test.mutate({ provider: p.provider })}>
              Test again
            </Button>
            <Button size="sm" icon="lock" onClick={() => setMode(mode === 'replace' ? null : 'replace')} aria-expanded={mode === 'replace'}>
              Replace key
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          </>
        ) : (
          mode === null && (
            <Button size="sm" icon="plug" onClick={() => setMode('connect')}>
              Connect
            </Button>
          )
        )}
      </span>
      {mode && <ConnectForm p={p} mode={mode} onDone={() => setMode(null)} />}
      {confirming && <DisconnectDialog p={p} losing={models.filter((m) => m.provider === p.provider).length} onOpenChange={setConfirming} />}
    </li>
  );
}

function ModelsCard({ data }: { data: AiAdmin }) {
  const [adding, setAdding] = useState(false);
  const save = useAiWrite('ai:setModels', (r) => !r.ok && toast(aiWhy(r), { kind: 'error' }));
  const list = data.models.map(({ provider, model, label }) => ({ provider, model, label }));
  const def = Math.max(0, data.models.findIndex((m) => m.isDefault));
  // A default being saved shows at once (the same list, a new default), not after the refetch.
  const pending = save.isPending && save.variables?.models.length === list.length ? save.variables.defaultIndex : null;
  const connected = data.providers.filter((p) => p.connected);
  const remove = (i: number) => save.mutate({ models: list.filter((_, j) => j !== i), defaultIndex: i === def ? 0 : def > i ? def - 1 : def });
  const add = (
    <Button icon="plus" disabled={connected.length === 0} title={connected.length === 0 ? 'Connect a provider first' : undefined} onClick={() => setAdding(true)}>
      Add models
    </Button>
  );
  return (
    <div className={s.group}>
      <div className={s.aiHead}>
        <h3 className={s.groupTitle}>Models members can use</h3>
        {add}
      </div>
      {data.models.length === 0 ? (
        <EmptyState compact heading={4} icon="sparkles" title="No models yet">
          Connect a provider, then add the models your team may use. Until then, AI features are off for members.
        </EmptyState>
      ) : (
        <div className={s.card}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Provider</th>
                <th scope="col">Default</th>
                <th scope="col" className={s.actions}>
                  <span className={s.srOnly}>Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m, i) => {
                const on = connected.some((p) => p.provider === m.provider);
                return (
                  <tr key={`${m.provider}/${m.model}`}>
                    <td>
                      <span className={s.stack}>
                        <span className={s.strong}>{m.label}</span>
                        {m.label !== m.model && <span className={`${s.meta} ${s.mono}`}>{m.model}</span>}
                      </span>
                    </td>
                    <td className={s.meta}>
                      {PROVIDER_LABEL[m.provider]}
                      {!on && ' · not connected, hidden from members'}
                    </td>
                    <td>
                      <input
                        type="radio"
                        className={s.aiRadio}
                        name="ai-default"
                        aria-label={`Make ${m.label} the default`}
                        checked={pending === null ? m.isDefault : pending === i}
                        disabled={save.isPending}
                        onChange={() => save.mutate({ models: list, defaultIndex: i })}
                      />
                    </td>
                    <td className={s.actions}>
                      <IconButton icon="x" size="sm" label={`Remove ${m.label}`} disabled={save.isPending} onClick={() => remove(i)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={s.lead}>Members choose among these in the Assistant. A new model a provider releases stays off until you add it here.</p>
      {adding && <AiModelsDialog data={data} onOpenChange={setAdding} />}
    </div>
  );
}

export function AiTab() {
  const ai = useAiAdmin();
  let body;
  if (ai.isPending) body = <SkeletonTable cols={3} rows={4} label="Loading AI providers" />;
  else if (ai.isError) {
    body = <ErrorState heading={3} title="AI settings could not be loaded" message={ai.error.message} onRetry={() => void ai.refetch()} />;
  } else if (ai.data.keyStore) {
    body = (
      <div className={s.notice} role="note">
        <Icon name="lock" />
        <div>
          <h3 className={s.noticeTitle}>This server can’t store API keys</h3>
          <p className={s.lead}>
            {ai.data.keyStore} AI needs both DATABASE_URL (Postgres) and ORDINATE_MASTER_KEY. An operator sets them — see docs/server/configuration.md — and
            this page then lets you connect providers.
          </p>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div className={s.group}>
          <div className={s.aiHead}>
            <h3 className={s.groupTitle}>Providers</h3>
            <span className={s.meta}>
              <Icon name="lock" size={12} /> Keys are encrypted with this server’s master key and never shown again
            </span>
          </div>
          <ul className={s.aiList} aria-label="Providers">
            {ai.data.providers.map((p) => (
              <ProviderRow key={p.provider} p={p} models={ai.data.models} />
            ))}
          </ul>
        </div>
        <ModelsCard data={ai.data} />
      </>
    );
  }
  return (
    <section className={s.section} aria-label="AI">
      <p className={s.lead}>Connect your providers once, then choose the exact models members may use. Members pick among them in the Assistant.</p>
      {body}
    </section>
  );
}
