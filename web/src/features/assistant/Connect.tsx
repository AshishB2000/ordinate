// "Connect a provider" — the dock's not-ready state on the server, standing in
// for the desktop's "Set up the Assistant" button (execMenu.ts aiSetupNotice)
// until T2.14 ports the full Settings pane. An org admin connects one of the
// providers the org allows; everyone else is told who can.
//
// The key field is WRITE-ONLY: never prefilled, cleared once sent, and the
// server keeps the key in its encrypted store and never returns it (key:status
// carries a has-key flag). The endpoint and model are not secret.

import { useState, type FormEvent } from 'react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { connectProvider, PROVIDER_LABEL, type KeyStatus, type Provider } from './api';
import s from './Connect.module.css';

export function Connect({ status, isAdmin, onConnected }: { status: KeyStatus; isAdmin: boolean; onConnected: (p: Provider) => void }) {
  const allowed = status.allowedProviders;
  const [provider, setProvider] = useState<Provider>(allowed[0] ?? 'anthropic');
  const cur = status.byok.providers[provider];
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!allowed.length) {
    return <p className={s.line}>Your organization allows no AI provider. An org admin can change that in Admin → Settings.</p>;
  }
  if (!isAdmin) {
    return <p className={s.line}>An org admin connects a provider for everyone. Ask one to set up the Assistant.</p>;
  }
  if (status.keyStore) {
    return <p className={s.line}>{`${status.keyStore} An operator sets DATABASE_URL and ORDINATE_MASTER_KEY to connect a provider.`}</p>;
  }

  const gateway = provider === 'gateway';
  const endpoint = baseUrl ?? cur?.baseUrl ?? '';
  const modelId = model ?? cur?.model ?? '';

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError('');
    const r = await connectProvider(provider, {
      apiKey: key.trim(),
      ...(baseUrl !== null || gateway ? { baseUrl: endpoint.trim() } : {}),
      ...(model !== null || gateway ? { model: modelId.trim() } : {}),
    }).catch(() => ({ ok: false, message: 'Could not reach the Ordinate server.' }));
    setKey('');
    setBusy(false);
    if (r.ok) onConnected(provider);
    else setError(r.message || 'The provider could not be connected.');
  }

  return (
    <form className={s.form} onSubmit={(e) => void submit(e)} aria-label="Connect a provider">
      <p className={s.line}>Connect a model provider for your organization. Every member's questions use it.</p>
      <Select
        label="Provider"
        size="sm"
        value={provider}
        onValueChange={(v) => {
          setProvider(v as Provider);
          setBaseUrl(null);
          setModel(null);
          setError('');
        }}
        options={allowed.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
      />
      <Input
        label="API key"
        size="sm"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={cur?.hasKey ? 'A key is saved — enter a new one to replace it' : 'Paste the key'}
        hint="Stored encrypted on the server and never shown again."
        error={error || undefined}
      />
      <Input
        label={gateway ? 'Endpoint' : 'Endpoint (optional)'}
        size="sm"
        type="url"
        value={endpoint}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="https://"
      />
      {gateway && <Input label="Model id" size="sm" value={modelId} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-4o-mini" />}
      <div className={s.actions}>
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!key.trim()}>
          Connect
        </Button>
      </div>
    </form>
  );
}
