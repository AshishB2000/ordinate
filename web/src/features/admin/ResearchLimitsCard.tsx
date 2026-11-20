// Admin → AI → Deep research limits (docs/deep-research/00-design.md, "Limits"): how far one run may go — model steps, engine queries
// and minutes — each within a ceiling the server holds. A run stops at the first it reaches. Org admins only (`research:setLimits`).

import { useState } from 'react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useResearchLimits, useSetResearchLimits, type AdminLimits, type Limits } from '../assistant/research/api';
import r from '../assistant/research/Research.module.css';
import s from './Admin.module.css';

const FIELDS: ReadonlyArray<{ key: keyof Limits; label: string; what: string }> = [
  { key: 'steps', label: 'Steps', what: 'Model calls choosing the next step' },
  { key: 'queries', label: 'Engine queries', what: 'Questions the engine computes' },
  { key: 'minutes', label: 'Minutes', what: 'Time one run may take' },
];

function Form({ data }: { data: AdminLimits }) {
  const [draft, setDraft] = useState<Record<keyof Limits, string>>({ steps: String(data.limits.steps), queries: String(data.limits.queries), minutes: String(data.limits.minutes) });
  const [error, setError] = useState('');
  const save = useSetResearchLimits((res) => {
    if (res.ok) toast('Deep research limits saved.', { kind: 'success' });
    else setError(res.error || 'The limits could not be saved.');
  });
  const value = (k: keyof Limits): number => Number(draft[k]);
  const bad = (k: keyof Limits): string | undefined =>
    !Number.isInteger(value(k)) || value(k) < 1 || value(k) > data.ceilings[k] ? `A whole number from 1 to ${data.ceilings[k]}.` : undefined;
  const invalid = FIELDS.some((f) => bad(f.key));
  const changed = FIELDS.some((f) => value(f.key) !== data.limits[f.key]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid || !changed || save.isPending) return;
        setError('');
        save.mutate({ steps: value('steps'), queries: value('queries'), minutes: value('minutes') });
      }}
      aria-label="Deep research limits"
    >
      <div className={r.limits}>
        {FIELDS.map((f) => (
          <Input
            key={f.key}
            label={f.label}
            type="number"
            inputMode="numeric"
            min={1}
            max={data.ceilings[f.key]}
            value={draft[f.key]}
            hint={`${f.what}. Up to ${data.ceilings[f.key]}; the default is ${{ steps: 8, queries: 12, minutes: 10 }[f.key]}.`}
            error={bad(f.key)}
            onChange={(e) => {
              setError('');
              setDraft({ ...draft, [f.key]: e.target.value });
            }}
          />
        ))}
      </div>
      {error && <p className={s.lead} role="alert">{error}</p>}
      <div className={s.aiFormActions}>
        <Button type="submit" variant="primary" icon="check" disabled={invalid || !changed} loading={save.isPending}>
          Save limits
        </Button>
      </div>
    </form>
  );
}

export function ResearchLimitsCard() {
  const q = useResearchLimits();
  return (
    <div className={s.group}>
      <div className={s.aiHead}>
        <h3 className={s.groupTitle}>Deep research limits</h3>
        <Badge>Editors and admins</Badge>
      </div>
      <p className={s.lead}>
        A deep-research run plans, then computes one step at a time with the engine, and writes a report. It stops at whichever limit it reaches first; Stop works at any time.
        One person can have one run going, and each server runs two at once.
      </p>
      {q.isPending && <SkeletonRows rows={2} label="Loading the limits" />}
      {q.isError && <ErrorState compact heading={4} title="The limits could not load" message={q.error.message} onRetry={() => void q.refetch()} />}
      {q.data && <Form key={JSON.stringify(q.data.limits)} data={q.data} />}
    </div>
  );
}
