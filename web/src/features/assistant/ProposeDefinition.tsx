// "Propose a definition" under a refused answer whose name nobody defined (docs/metric-proposals/00-design.md). One press
// asks the server to draft the missing metric or term and queue it for an editor; the server checks the draft and says
// why if it cannot be used. Anyone who reads the project may press it; the button says what an editor will see.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { proposeDefinition } from '../model/proposals/api';
import s from '../model/proposals/Proposals.module.css';

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; raised: boolean; asks: number } | { kind: 'error'; message: string };

export function ProposeDefinition({ projectId, threadId, turnId }: { projectId: string; threadId: string; turnId: string }) {
  const [st, setSt] = useState<State>({ kind: 'idle' });
  async function press(): Promise<void> {
    setSt({ kind: 'busy' });
    try {
      const r = await proposeDefinition(projectId, threadId, turnId);
      setSt(r.ok ? { kind: 'done', raised: r.raised, asks: r.asks } : { kind: 'error', message: r.error || 'The definition could not be proposed.' });
    } catch (e) {
      setSt({ kind: 'error', message: e instanceof Error && e.message ? e.message : 'The definition could not be proposed.' });
    }
  }
  if (st.kind === 'done') {
    return (
      <p className={s.proposeDone} role="status" data-testid="propose-done">
        {st.raised ? `Someone already proposed this. Your question was added (${st.asks} so far).` : 'Proposed. An editor will review it, and you will be told when it is decided.'}
      </p>
    );
  }
  return (
    <div className={s.propose} data-testid="propose-definition">
      <Button size="sm" icon="sparkles" loading={st.kind === 'busy'} onClick={() => void press()}>
        Propose a definition
      </Button>
      <p className={s.proposeNote}>The Assistant drafts what is missing for an editor to review. The editor sees your question, never your figures.</p>
      {st.kind === 'error' && <p className={s.proposeError} role="alert">{st.message}</p>}
    </div>
  );
}
