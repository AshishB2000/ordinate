// Beside a test answer: how it was found (semantic part 3 D11). Worded here from the turn's `guidance`, which holds
// ids and counts only: a verified question (no model call, or a model that only narrated it), or the model with N
// instructions and these examples. Then the stored spec in words and, folded, as JSON. A turn with no guidance (a
// chip, a follow-up, an older turn) says nothing about how, but its spec is still there.

import type { Turn } from '../../assistant/api';
import { specWords } from './specWords';
import type { VerifiedRow } from './api';
import t from './TestChat.module.css';

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

export function HowAnswered({ turn, verified, terms }: { turn: Turn; verified: readonly VerifiedRow[]; terms?: Record<string, string> }) {
  const g = turn.guidance;
  const byId = (id: string) => verified.find((v) => v.id === id)?.question;
  const dataset = turn.provenance?.kind === 'dataset' && turn.provenance.name ? turn.provenance.name : 'The dataset';
  const examples = g && !g.verifiedId ? g.examples.flatMap((id) => byId(id) ?? []) : [];
  return (
    <div className={t.how} data-testid="how-answered">
      {g?.verifiedId && (
        <p className={t.howLine}>
          <strong>{g.narrated ? 'A verified question — the app drew it; a model only wrote the words.' : 'A verified question — no model call.'}</strong>
          <span>{byId(g.verifiedId) ?? 'a verified question since removed'}</span>
        </p>
      )}
      {g && !g.verifiedId && (
        <p className={t.howLine}>
          <strong>{`The model, with ${plural(g.instructions, 'instruction')} and ${plural(g.examples.length, 'verified example')}.`}</strong>
          {examples.map((q) => (
            <span key={q}>{q}</span>
          ))}
        </p>
      )}
      {turn.answer && <p className={t.spec}>{`Spec: ${specWords(turn.answer, dataset, terms)}`}</p>}
      {turn.answer && (
        <details className={t.json}>
          <summary>Spec as JSON</summary>
          <pre>{JSON.stringify(turn.answer, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
