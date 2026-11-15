// Admin → AI → Fingerprint model for meaning search (docs/ai-models/00-plan.md
// "Meaning search"): the org's embedding model, from a connected OpenAI,
// Gemini or gateway key. OFF until an admin picks one here; saving sends
// nothing, Test fingerprints one short sample and shows the server's size and
// latency (or the provider's sentence). Anthropic has no embedding API. Below the pick, whether the database can hold
// fingerprints and how far the job has got (./FingerprintCoverage).

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Select, type SelectOption } from '../../ui/Select';
import { EmptyState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { PROVIDER_LABEL } from '../assistant/api';
import { aiWhy, useAiWrite, type AiAdmin, type AiOutcome } from './api';
import { FingerprintCoverage } from './FingerprintCoverage';
import s from './Admin.module.css';

type Pick = NonNullable<RpcInput<'ai:setFingerprintModel'>['pick']>;
type Tested = { ok: true; dimensions: number; ms: number } | (AiOutcome & { ok: false });

/** The named models, as the contract allows them (src/api/ai.ts FINGERPRINT_MODELS). */
const NAMED: readonly Pick[] = [
  { provider: 'openai', model: 'text-embedding-3-small' },
  { provider: 'openai', model: 'text-embedding-3-large' },
  { provider: 'gemini', model: 'gemini-embedding-001' },
  { provider: 'gemini', model: 'gemini-embedding-2' },
];
const OFF = 'off';
const GATEWAY = 'gateway';
const valueOf = (p: { provider: string; model: string } | null): string => (!p ? OFF : p.provider === 'gateway' ? GATEWAY : `${p.provider}:${p.model}`);

export function AiFingerprintCard({ data }: { data: AiAdmin }) {
  const saved = data.fingerprintModel;
  const [choice, setChoice] = useState(valueOf(saved));
  const [typed, setTyped] = useState(saved?.provider === 'gateway' ? saved.model : '');
  const [error, setError] = useState('');
  const usable = new Set(data.providers.filter((p) => p.connected || p.provider === saved?.provider).map((p) => p.provider));
  const pick: Pick | null =
    choice === OFF ? null : choice === GATEWAY ? (typed.trim() ? { provider: 'gateway', model: typed.trim() } : null) : (NAMED.find((p) => valueOf(p) === choice) ?? null);
  const save = useAiWrite('ai:setFingerprintModel', (r) => {
    if (!r.ok) return setError(aiWhy(r));
    toast(pick ? `Meaning search now uses ${pick.model}.` : 'Meaning search is off.', { kind: 'success' });
  });
  const test = useMutation({ mutationFn: async (p: Pick) => (await rpc('ai:testFingerprint', { pick: p })) as Tested });

  if (!usable.has('openai') && !usable.has('gemini') && !usable.has('gateway')) {
    return (
      <div className={s.group}>
        <h3 className={s.groupTitle}>Fingerprint model for meaning search</h3>
        <EmptyState compact heading={4} icon="sparkles" title="Meaning search needs an OpenAI, Gemini or gateway key">
          Anthropic has no fingerprint model. Connect OpenAI, Google Gemini or an OpenAI-compatible gateway above, then pick its model here. Until then,
          the Assistant finds items by their words.
        </EmptyState>
      </div>
    );
  }

  const options: SelectOption[] = [
    { value: OFF, label: 'Off', hint: 'words only' },
    ...NAMED.filter((p) => usable.has(p.provider)).map((p) => ({ value: valueOf(p), label: `${PROVIDER_LABEL[p.provider]} · ${p.model}` })),
    ...(usable.has('gateway') ? [{ value: GATEWAY, label: `${PROVIDER_LABEL.gateway} · enter a model id` }] : []),
  ];
  const changed = valueOf(pick) !== valueOf(saved) || (pick?.provider === 'gateway' && pick.model !== saved?.model);
  const edited = () => {
    setError('');
    test.reset();
  };
  const result = test.data;
  return (
    <div className={s.group}>
      <div className={s.aiHead}>
        <h3 className={s.groupTitle}>Fingerprint model for meaning search</h3>
        {saved ? <Badge tone="ok" icon="circle-check">{`On · ${saved.model}`}</Badge> : <Badge>Off</Badge>}
      </div>
      <p className={s.lead}>
        Meaning search finds a dataset, metric or term by what a question means, not only by its words. It stays off until you pick a model. Item names and
        descriptions are then sent to that provider with your organization’s key.
      </p>
      <div className={s.aiPick}>
        <div className={s.aiGrow}>
          <Select
            label="Model"
            value={choice}
            onValueChange={(v) => {
              setChoice(v);
              edited();
            }}
            options={options}
          />
        </div>
        {choice === GATEWAY && (
          <div className={s.aiGrow}>
            <Input
              label="Gateway model id"
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                edited();
              }}
              placeholder="openai/text-embedding-3-small"
              spellCheck={false}
            />
          </div>
        )}
        <div className={s.aiFormActions}>
          <Button icon="play" disabled={!pick} loading={test.isPending} onClick={() => pick && test.mutate(pick)}>
            Test
          </Button>
          <Button
            variant="primary"
            icon="check"
            disabled={!changed || (choice === GATEWAY && !pick)}
            loading={save.isPending}
            onClick={() => {
              setError('');
              save.mutate({ pick });
            }}
          >
            Save
          </Button>
        </div>
      </div>
      {result?.ok && (
        <span>
          <Badge tone="ok" icon="circle-check">{`${result.dimensions.toLocaleString()} dimensions · ${result.ms.toLocaleString()} ms`}</Badge>
        </span>
      )}
      {(error || (result && !result.ok) || test.isError) && (
        <p className={s.warn} role="alert">
          <Icon name="alert" size={12} />
          {error || (result && !result.ok ? aiWhy(result) : `The test did not run: ${test.error?.message ?? ''}`)}
        </p>
      )}
      <FingerprintCoverage model={saved ? `${saved.provider}:${saved.model}` : null} />
      <p className={s.fpStatus}>Picking another model later fingerprints every item again in the background. Until it has, items are found by their words.</p>
    </div>
  );
}
