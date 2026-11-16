// "Request a dashboard" (docs/team-folders/00-design.md, "Dashboard requests"): a VIEWER's Add to dashboard. A viewer
// cannot keep an answer, so on an answer card they ask the editors for a dashboard of it: the answers it holds (this
// one, and any other chart in the conversation), a name and a note. Sending (`request:create`, src/server/requests)
// stores the answers' chart forms — never a figure — and tells the editors who can approve it; nothing is made until
// one does. The same charts again the same day are "already sent", and a person may send 10 a day: the server's to
// decide, its sentence shown as it is.
//
// An editor never sees this (Save as visual is theirs). Shown only once the roles say viewer, and only on a stored turn.

import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input, Textarea } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { useRoles } from '../projects/api';
import s from './AskEditor.module.css';

/** A chart answer of the conversation: what the dialog offers to put on the dashboard. */
export interface ChartAnswer {
  turnId: string;
  title: string;
}

type Reply = { ok: true; already?: true } | { ok: false; error?: string; code?: string };
type Sent = 'sent' | 'already';
const MAX_NOTE = 2000;

export function RequestDashboard({ projectId, turn, answers }: { projectId: string; turn?: { threadId: string; turnId: string }; answers: readonly ChartAnswer[] }) {
  const role = useRoles().data?.[projectId];
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  if (role !== 'viewer' || !turn) return null;
  if (sent) {
    return (
      <span className={s.sent} role="status" data-testid="request-sent">
        <Icon name="circle-check" size={16} />
        {sent === 'already' ? 'Already sent to the editors today' : 'Sent to the editors'}
      </span>
    );
  }
  const offered = answers.some((a) => a.turnId === turn.turnId) ? answers : [{ turnId: turn.turnId, title: 'This answer' }, ...answers];
  return (
    <>
      <Button size="sm" variant="ghost" icon="layout-dashboard" onClick={() => setOpen(true)}>
        Request a dashboard
      </Button>
      {open && <Composer projectId={projectId} threadId={turn.threadId} first={turn.turnId} answers={offered} onClose={() => setOpen(false)} onSent={setSent} />}
    </>
  );
}

function Composer({ projectId, threadId, first, answers, onClose, onSent }: {
  projectId: string;
  threadId: string;
  first: string;
  answers: readonly ChartAnswer[];
  onClose: () => void;
  onSent: (s: Sent) => void;
}) {
  const [title, setTitle] = useState((answers.find((a) => a.turnId === first)?.title ?? '').slice(0, 120));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set([first]));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; limit: boolean } | null>(null);
  const toggle = (id: string, on: boolean) => setPicked((p) => {
    const next = new Set(p);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

  async function send(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const turnIds = answers.map((a) => a.turnId).filter((id) => picked.has(id)); // in the conversation's order
      const r = (await rpc('request:create', { projectId, threadId, turnIds, title: title.trim(), ...(note.trim() ? { note: note.trim() } : {}) })) as Reply;
      if (r.ok) {
        onSent(r.already ? 'already' : 'sent');
        onClose();
        return;
      }
      setProblem({ text: r.error || 'Could not send the request.', limit: r.code === 'rate_limited' });
    } catch (e) {
      setProblem({ text: e instanceof Error && e.message ? e.message : 'Could not send the request.', limit: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Request a dashboard"
      description="The editors who can approve it get this in their notifications. Nothing is made until one of them approves it, and you’re told either way."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" icon="send" loading={busy} disabled={!title.trim() || picked.size === 0 || problem?.limit} onClick={() => void send()}>
            Send request
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Input label="Dashboard name" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} required />
        <fieldset className={s.charts}>
          <legend className={s.whyLabel}>Charts on it</legend>
          {answers.map((a) => (
            <Checkbox key={a.turnId} label={a.title} checked={picked.has(a.turnId)} onCheckedChange={(on) => toggle(a.turnId, on)} />
          ))}
        </fieldset>
        <Textarea
          label="Note (optional)"
          hint="What it’s for, or who else needs it."
          rows={3}
          maxLength={MAX_NOTE}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {problem && (
          <p className={problem.limit ? s.limit : s.error} role="alert" data-testid="request-problem">
            <Icon name={problem.limit ? 'history' : 'alert'} size={16} />
            {problem.text}
          </p>
        )}
      </div>
    </Dialog>
  );
}
