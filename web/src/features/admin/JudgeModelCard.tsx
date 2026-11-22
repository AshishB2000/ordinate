// Admin → AI → Judge model (docs/eval-suites/00-design.md, the owner's answer to Q4): the model that scores the WORDS of a test case
// (never a figure: the engine checks those). One optional setting; with none, the Assistant's own model judges and the results page says
// so. Only models already enabled in Admin → AI can be picked. Org admins only (`eval:setJudge`).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import type { AiAdmin } from './api';
import s from './Admin.module.css';

const NONE = '';
type Pick = { provider: string; model: string } | null;
const keyOf = (p: Pick): string => (p ? `${p.provider}/${p.model}` : NONE);

function Form({ saved, models }: { saved: Pick; models: AiAdmin['models'] }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState(keyOf(saved));
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: async (pick: Pick) => (await rpc('eval:setJudge', { pick })) as { ok: true; pick: Pick } | { ok: false; error?: string },
    onSuccess: (r) => {
      if (r.ok) {
        void qc.invalidateQueries({ queryKey: ['eval:judge'] });
        toast(r.pick ? 'Judge model saved.' : 'The Assistant’s own model will judge.', { kind: 'success' });
      } else setError(r.error || 'The judge model could not be saved.');
    },
  });
  const options = [{ value: NONE, label: 'The Assistant’s own model' }, ...models.map((m) => ({ value: keyOf(m), label: m.label || m.model })), ...(saved && !models.some((m) => keyOf(m) === keyOf(saved)) ? [{ value: keyOf(saved), label: `${saved.model} (no longer enabled)`, disabled: true }] : [])];
  return (
    <form
      aria-label="Judge model"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        save.mutate(models.find((m) => keyOf(m) === choice) ? { provider: models.find((m) => keyOf(m) === choice)!.provider, model: models.find((m) => keyOf(m) === choice)!.model } : null);
      }}
    >
      <Select label="Judged by" value={choice} options={options} hint="Scores only the words a test case should say. A model grading its own replies can be softer on them." onValueChange={(v) => { setError(''); setChoice(v); }} />
      {error && <p className={s.lead} role="alert">{error}</p>}
      <div className={s.aiFormActions}>
        <Button type="submit" variant="primary" icon="check" disabled={choice === keyOf(saved)} loading={save.isPending} aria-label="Save judge model">
          Save
        </Button>
      </div>
    </form>
  );
}

export function JudgeModelCard({ models }: { models: AiAdmin['models'] }) {
  const q = useQuery({
    queryKey: ['eval:judge'],
    queryFn: async () => {
      const r = (await rpc('eval:judge')) as { ok: true; pick: Pick } | { ok: false; error?: string };
      if (!r.ok) throw new Error(r.error || 'The judge model could not be loaded.');
      return r.pick;
    },
  });
  return (
    <div className={s.group}>
      <div className={s.aiHead}>
        <h3 className={s.groupTitle}>Judge model</h3>
      </div>
      <p className={s.lead}>
        When an editor runs a suite of tests, the engine checks every figure itself. A judge model only scores the words a test case should say. With none picked here, the Assistant’s own model judges, and the results page says so.
      </p>
      {q.isPending && <SkeletonRows rows={1} label="Loading the judge model" />}
      {q.isError && <ErrorState compact heading={4} title="The judge model could not load" message={q.error.message} onRetry={() => void q.refetch()} />}
      {q.data !== undefined && !q.isPending && <Form key={keyOf(q.data)} saved={q.data} models={models} />}
    </div>
  );
}
