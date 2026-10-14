// "Save as visual" on an answer card: a good answer kept as an ordinary saved
// Visual. The browser sends the stored SPEC and nothing else — the server
// rebuilds the encoding and the filter steps from it (`answer:saveVisual`,
// src/ipc/answerSave.ts) — and once it is saved the button gives way to a link
// to the visual's own page, which takes the focus the button had.
//
// What was saved is held in the query cache by project and spec, never
// fetched: closing the dock or switching conversations unmounts every card, and
// a card that forgot would offer to save the same answer again. ponytail: for
// this page's life only — a reload forgets; the turn can record the visual's id
// once the answer is "remembered".
//
// Saving changes the project, so it is an editor's: a viewer is never offered
// it (the server would refuse one anyway). False until the roles are known, so
// the button never flashes for someone who may not use it.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../api/client';
import { Button, buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { useCanEdit } from '../projects/api';
import s from './AnswerCard.module.css';

type State = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; id: string } | { kind: 'error'; message: string };
type Saved = { id: string };
type Reply = { ok: true; visual: { id: string; name: string } } | { ok: false; reason?: string };

const FAILED = 'Could not save this answer as a visual.';

export function SaveAsVisual({ projectId, spec }: { projectId: string; spec: { datasetId: string } & Record<string, unknown> }) {
  const canEdit = useCanEdit(projectId);
  const qc = useQueryClient();
  const key = ['answer:saved', projectId, JSON.stringify(spec)];
  const saved = useQuery({
    queryKey: key,
    queryFn: () => qc.getQueryData<Saved | null>(key) ?? null, // never fetched: only a save writes it
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data;
  const [state, setState] = useState<State>({ kind: 'idle' });
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (state.kind === 'saved') link.current?.focus(); // only after a save made here, not on a remount
  }, [state.kind]);
  if (!canEdit) return null;

  const id = state.kind === 'saved' ? state.id : saved?.id;
  if (id) {
    return (
      <Link ref={link} className={buttonClass('ghost', 'sm')} to={`/visuals/${projectId}/${id}`} data-testid="answer-saved">
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
      qc.setQueryData<Saved>(key, { id: r.visual.id });
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
