// "Remember" on an answer card. The model said a name the data does not have
// ("sales"), the person picked the column it meant from "Did you mean", and
// this keeps that name as one more "Also called" name of the column
// (`catalog:addAlias`) — so the next question that says it, anyone's in the
// project, resolves the first time. A value ("tech" for Technology) is never
// remembered: only a column's name.
//
// Whether the name is still to offer is the SERVER's (`answer:card` replies
// `learn.state`): a name taught in the Columns tab reads as known here too, and
// after a save the card is fetched again rather than flipped in the browser.
//
// Teaching a name changes the project, so only an editor is offered it (the
// server refuses anyone else); anyone sees that it is known.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { useCanEdit } from '../projects/api';
import s from './AnswerCard.module.css';

export interface CardLearn {
  said: string;
  column: string;
  /** The column as it is shown: its display name, else its name. */
  label: string;
  state: 'offer' | 'known';
}

const FAILED = 'Could not remember that name.';

export function RememberName({
  projectId,
  datasetId,
  learn,
  onTaught,
}: {
  projectId: string;
  datasetId: string;
  learn: CardLearn;
  /** Fetch the card again: its `learn.state` is the server's to say. */
  onTaught: () => Promise<unknown>;
}) {
  const canEdit = useCanEdit(projectId);
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (learn.state === 'known') {
    return (
      <span className={s.learnt} role="status">
        “{learn.said}” now means {learn.label} in this project.
      </span>
    );
  }
  if (!canEdit) return null;

  async function remember(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const r = (await rpc('catalog:addAlias', { projectId, datasetId, column: learn.column, alias: learn.said })) as
        | { ok: true }
        | { ok: false; error?: string };
      if (!r.ok) return setError(r.error || FAILED);
      void qc.invalidateQueries({ queryKey: ['catalog:columns', projectId, datasetId] }); // the Columns tab's "Also called"
      await onTaught();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : FAILED);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" loading={saving} onClick={() => void remember()}>
        {saving ? 'Remembering…' : `Remember “${learn.said}” as ${learn.label}`}
      </Button>
      {error && (
        <span className={s.saveError} role="alert">
          {error}
        </span>
      )}
    </>
  );
}
