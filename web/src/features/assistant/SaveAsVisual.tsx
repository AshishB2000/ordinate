// "Save as visual" on an answer card: a good answer kept as an ordinary saved
// Visual. The browser sends the stored SPEC and nothing else — the server
// rebuilds the encoding and the filter steps from it (`answer:saveVisual`,
// src/ipc/answerSave.ts) — and once it is saved the button gives way to a link
// to the visual's own page.
//
// Saving changes the project, so it is an editor's: a viewer is never offered
// it (the server would refuse one anyway). False until the roles are known, so
// the button never flashes for someone who may not use it.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../api/client';
import { Button, buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { useCanEdit } from '../projects/api';
import s from './AnswerCard.module.css';

type State = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; id: string } | { kind: 'error'; message: string };
type Reply = { ok: true; visual: { id: string; name: string } } | { ok: false; reason?: string };

const FAILED = 'Could not save this answer as a visual.';

export function SaveAsVisual({ projectId, spec }: { projectId: string; spec: { datasetId: string } & Record<string, unknown> }) {
  const canEdit = useCanEdit(projectId);
  const qc = useQueryClient();
  const [state, setState] = useState<State>({ kind: 'idle' });
  if (!canEdit) return null;

  if (state.kind === 'saved') {
    return (
      <Link className={buttonClass('ghost', 'sm')} to={`/visuals/${projectId}/${state.id}`} data-testid="answer-saved">
        <Icon name="external-link" />
        <span>Open in Visuals</span>
      </Link>
    );
  }

  async function save(): Promise<void> {
    setState({ kind: 'saving' });
    try {
      const r = (await rpc('answer:saveVisual', { projectId, spec })) as Reply;
      if (!r.ok) return setState({ kind: 'error', message: r.reason || FAILED });
      setState({ kind: 'saved', id: r.visual.id });
      void qc.invalidateQueries({ queryKey: ['visual:list', projectId] }); // the Visuals gallery has one more
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error && e.message ? e.message : FAILED });
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" loading={state.kind === 'saving'} onClick={() => void save()}>
        {state.kind === 'saving' ? 'Saving…' : 'Save as visual'}
      </Button>
      {state.kind === 'error' && (
        <span className={s.saveError} role="alert">
          {state.message}
        </span>
      )}
    </>
  );
}
