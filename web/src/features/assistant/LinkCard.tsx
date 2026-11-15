// The checked link (docs/assistant/00-design.md, outcome E): an answer needed two datasets no relationship joins, and
// Ordinate never guesses a join. The server checked one (src/ipc/answerLink.ts, the Relationships page's own check):
// *Link Shipments.country_id → Countries.country_id? Names match · Types match · 98% of sampled values found · Unique in
// Countries*. **Add link and answer** saves it through `relationship:save` (counted over the full tables again) and
// asks the question again; **Cancel** puts the card away. Every figure is the server's, shown as it came.
//
// An editor's: the server sends the card only to one who may add the link. Everyone else reads the turn's sentence.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { useCanEdit } from '../projects/api';
import type { AnswerLink } from './api';
import s from './LinkCard.module.css';

type Reply = { ok: true } | { ok: false; error?: string };

const FAILED = 'Could not add the link.';

/** The checks as the card says them, each the server's. */
export function linkChecks(l: AnswerLink): string[] {
  return [
    l.checks.names ? 'Names match' : 'Names differ',
    l.checks.types ? 'Types match' : 'Types differ',
    ...(l.checks.foundPct === null ? [] : [`${l.checks.foundPct}% of sampled values found`]),
    l.checks.unique ? `Unique in ${l.to.dataset}` : `Repeats in ${l.to.dataset}`,
  ];
}

export function LinkCard({ projectId, link, question, onAsk, busy }: {
  projectId: string;
  link: AnswerLink;
  /** What was asked: asked again once the link is added. */
  question: string;
  onAsk?: (question: string) => void;
  /** An ask is in flight: nothing to click meanwhile. */
  busy: boolean;
}) {
  const canEdit = useCanEdit(projectId);
  const qc = useQueryClient();
  const [state, setState] = useState<'open' | 'saving' | 'closed'>('open');
  const [error, setError] = useState('');
  if (!canEdit || state === 'closed') return null;

  async function add(): Promise<void> {
    setState('saving');
    setError('');
    try {
      const r = (await rpc('relationship:save', {
        projectId,
        relationship: { from: { datasetId: link.from.datasetId, column: link.from.column }, to: { datasetId: link.to.datasetId, column: link.to.column }, cardinality: link.cardinality },
      })) as Reply;
      if (!r.ok) {
        setState('open');
        return setError(r.error || FAILED);
      }
      setState('closed');
      void qc.invalidateQueries({ queryKey: ['relationship:list', projectId] });
      onAsk?.(question);
    } catch (e) {
      setState('open');
      setError(e instanceof Error && e.message ? e.message : FAILED);
    }
  }

  return (
    <div className={s.card} role="group" aria-label="Add a link" data-testid="answer-link">
      <div className={s.ask}>
        <Icon name="link" size={16} />
        <span>
          Link <span className={s.name}>{link.from.dataset}.{link.from.column}</span> → <span className={s.name}>{link.to.dataset}.{link.to.column}</span>?
        </span>
      </div>
      <ul className={s.checks}>
        {linkChecks(link).map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className={s.actions}>
        <Button size="sm" variant="primary" loading={state === 'saving'} disabled={busy || !question} onClick={() => void add()}>
          Add link and answer
        </Button>
        <Button size="sm" variant="ghost" disabled={state === 'saving'} onClick={() => setState('closed')}>
          Cancel
        </Button>
      </div>
      {error && (
        <div className={s.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
