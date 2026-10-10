// Admin → AI → Add models: pick a connected provider, tick models from its live
// list (`ai:providerModels`, fetched on the server with the stored key), or
// type an id the list does not have (a gateway's, or an unlisted one). Saving
// appends them to the allow-list; the default stays where it was, or is the
// first model when there was none.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { PROVIDER_LABEL } from '../assistant/api';
import { aiWhy, useAiWrite, type AiAdmin, type AiProviderState, type ProviderModels } from './api';
import s from './Admin.module.css';

type Provider = AiProviderState['provider'];
type Pick = { model: string; label: string };

const LIST_FAILED: Record<string, string> = {
  auth: 'The provider refused the stored key.',
  network: 'The provider could not be reached.',
  no_key: 'This provider has no key stored.',
};

export function AiModelsDialog({ data, onOpenChange }: { data: AiAdmin; onOpenChange: (o: boolean) => void }) {
  const connected = data.providers.filter((p) => p.connected).map((p) => p.provider);
  const [provider, setProvider] = useState<Provider>(connected[0] ?? 'anthropic');
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [picked, setPicked] = useState<Map<string, Pick[]>>(new Map());
  const [error, setError] = useState('');
  const live = useQuery({
    queryKey: ['ai:providerModels', provider],
    queryFn: async () => (await rpc('ai:providerModels', { provider })) as ProviderModels,
    staleTime: 60_000,
  });
  const save = useAiWrite('ai:setModels', (r) => (r.ok ? onOpenChange(false) : setError(aiWhy(r))));

  const enabled = new Set(data.models.filter((m) => m.provider === provider).map((m) => m.model));
  const mine = picked.get(provider) ?? [];
  const toggle = (p: Pick, on: boolean) =>
    setPicked((cur) => new Map(cur).set(provider, on ? [...mine, p] : mine.filter((x) => x.model !== p.model)));
  const addTyped = () => {
    const id = typed.trim();
    if (!id || enabled.has(id) || mine.some((x) => x.model === id)) return;
    toggle({ model: id, label: id }, true);
    setTyped('');
  };
  const additions = [...picked].flatMap(([p, list]) => list.map((m) => ({ provider: p as Provider, ...m })));
  const submit = () => {
    const before = data.models.map(({ provider: p, model, label }) => ({ provider: p, model, label }));
    const def = data.models.findIndex((m) => m.isDefault);
    save.mutate({ models: [...before, ...additions], defaultIndex: def >= 0 ? def : 0 });
  };

  // Ids typed in by hand: always listed, whatever the provider's own list did.
  const listed = new Set(live.data?.ok ? live.data.models.map((m) => m.id) : []);
  const typedIn = mine.filter((p) => !listed.has(p.model));
  let list;
  if (live.isPending) list = <SkeletonRows rows={4} label="Loading the provider’s models" />;
  else if (live.isError) list = <ErrorState compact heading={4} title="The model list could not be loaded" message={live.error.message} onRetry={() => void live.refetch()} />;
  else if (!live.data.ok) {
    list = (
      <EmptyState compact heading={4} icon="alert" title="No list from this provider">
        {`${LIST_FAILED[live.data.errorType ?? ''] ?? 'The provider did not answer with a model list.'} Enter a model id below instead.`}
      </EmptyState>
    );
  } else {
    const q = search.trim().toLowerCase();
    const rows = live.data.models.map((m) => ({ model: m.id, label: m.label })).filter((m) => !q || m.model.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
    list =
      rows.length === 0 ? (
        <EmptyState compact heading={4} icon="search" title={q ? 'No model matches' : 'The provider listed no models'}>
          Enter a model id below.
        </EmptyState>
      ) : (
        <div className={s.checkList}>
          {rows.map((m) => (
            <Checkbox
              key={m.model}
              label={m.label}
              hint={enabled.has(m.model) ? 'Already enabled' : m.label !== m.model ? m.model : undefined}
              checked={enabled.has(m.model) || mine.some((x) => x.model === m.model)}
              disabled={enabled.has(m.model)}
              onCheckedChange={(on) => toggle(m, on)}
            />
          ))}
        </div>
      );
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Add models"
      description="Members can pick any model you add. Nothing else from the provider is offered."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" icon="check" loading={save.isPending} disabled={additions.length === 0} onClick={submit}>
            {additions.length > 1 ? `Add ${additions.length} models` : 'Add model'}
          </Button>
        </>
      }
    >
      <div className={s.dialogBody}>
        <Select
          label="Provider"
          value={provider}
          onValueChange={(v) => {
            setProvider(v as Provider);
            setSearch('');
          }}
          options={connected.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
        />
        <Input label="Search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter the provider’s models" />
        {list}
        {typedIn.length > 0 && (
          <div className={s.checkList} aria-label="Entered by id">
            {typedIn.map((m) => (
              <Checkbox key={m.model} label={m.model} hint="Entered by id" checked onCheckedChange={(on) => toggle(m, on)} />
            ))}
          </div>
        )}
        <div className={s.tempRow}>
          <Input
            label="Enter a model id"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTyped();
              }
            }}
            placeholder={provider === 'gateway' ? 'openai/gpt-4o-mini' : 'An id the list does not show'}
          />
          <Button icon="plus" disabled={!typed.trim()} onClick={addTyped}>
            Add
          </Button>
        </div>
        {error && (
          <p className={s.warn} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
