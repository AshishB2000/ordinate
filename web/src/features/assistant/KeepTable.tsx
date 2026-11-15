// "Keep as a dataset" on an answer read straight from a warehouse table (docs/assistant/00-design.md, "Asking needs no
// dataset; keeping makes one"). Asking made nothing; this click makes the table's Live dataset (`answer:keepTable`,
// src/ipc/sourceKeep.ts) and re-points the answer's turn at it, so the card then offers Save as visual and Verify as on
// any dataset. The conversation the server hands back replaces the one on screen. An editor's: a viewer is never
// offered it (the server would refuse one anyway).

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { useCanEdit } from '../projects/api';
import s from './AnswerCard.module.css';

type Reply = { ok: true; datasetId: string } | { ok: false; reason?: string };

const FAILED = 'Could not keep this answer as a dataset.';

export function KeepTable({ projectId, turn }: { projectId: string; turn?: { threadId: string; turnId: string } }) {
  const canEdit = useCanEdit(projectId);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!canEdit || !turn) return null;

  async function keep(): Promise<void> {
    if (!turn) return;
    setBusy(true);
    setError('');
    try {
      const r = (await rpc('answer:keepTable', { projectId, ...turn })) as Reply;
      if (!r.ok) return setError(r.reason || FAILED);
      void qc.invalidateQueries({ queryKey: ['dataset:list', projectId] }); // the Data page has one more
      qc.removeQueries({ queryKey: ['answer:refresh', projectId, turn.threadId, turn.turnId] }); // a card drawn from the table is not the dataset's
      await qc.invalidateQueries({ queryKey: ['copilot:history', projectId] }); // the turn names the dataset now
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void keep()} data-testid="answer-keep-table">
        {busy ? 'Keeping…' : 'Keep as a dataset'}
      </Button>
      {error && (
        <span className={s.saveError} role="alert">
          {error}
        </span>
      )}
    </>
  );
}
