// "Alert me" on an answer card (docs/assistant/00-design.md, The flow step 8): the answer's one
// number watched by an alert rule. The browser sends the stored SPEC and nothing else; the server
// (`alerts:fromAnswer`, src/ipc/answerAlert.ts) answers with the alert dialog's subject — the same
// fields a KPI card's "Alert me…" hands it — a threshold to start from, worked out from today's
// figure, and what the one number covers; or, for an answer no single number stands for, why not,
// said here beside the button. The dialog is the existing one (../dashboards/AlertDialog), so the
// rule saved, tested and delivered is every other rule.
//
// An alert is saved to the project (`alerts:save` is a write): a viewer is never offered it, as with
// Save as visual. False until the roles are known, so the button never flashes.

import { lazy, Suspense, useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { useCanEdit } from '../projects/api';
import type { AlertSubject } from '../dashboards/AlertDialog';
import s from './AskEditor.module.css';

const AlertDialog = lazy(() => import('../dashboards/AlertDialog').then((m) => ({ default: m.AlertDialog })));

type Reply =
  | { ok: true; subject: AlertSubject; suggest: { op: string; value: number } | null; scope: string }
  | { ok: false; reason?: string; error?: string };
type State = { kind: 'idle' } | { kind: 'asking' } | { kind: 'open'; subject: AlertSubject } | { kind: 'refused'; message: string };

const FAILED = 'Could not set an alert from this answer.';

export function AlertFromAnswer({ projectId, spec }: { projectId: string; spec: { datasetId: string } & Record<string, unknown> }) {
  const canEdit = useCanEdit(projectId);
  const [state, setState] = useState<State>({ kind: 'idle' });
  if (!canEdit) return null;

  async function start(): Promise<void> {
    setState({ kind: 'asking' });
    try {
      const r = (await rpc('alerts:fromAnswer', { projectId, spec })) as Reply;
      if (!r.ok) return setState({ kind: 'refused', message: r.reason || r.error || FAILED });
      setState({ kind: 'open', subject: { ...r.subject, ...(r.suggest ? { threshold: r.suggest } : {}), scope: r.scope } });
    } catch (e) {
      setState({ kind: 'refused', message: e instanceof Error && e.message ? e.message : FAILED });
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" icon="bell" loading={state.kind === 'asking'} onClick={() => void start()} data-testid="answer-alert">
        Alert me
      </Button>
      {state.kind === 'refused' && (
        <span className={s.alertWhy} role="status" data-testid="answer-alert-refused">
          {state.message}
        </span>
      )}
      {state.kind === 'open' && (
        <Suspense fallback={null}>
          <AlertDialog projectId={projectId} subject={state.subject} onClose={() => setState({ kind: 'idle' })} />
        </Suspense>
      )}
    </>
  );
}
