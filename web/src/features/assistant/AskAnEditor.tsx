// "Ask an editor" (docs/assistant/00-design.md, phase G): where the Assistant tells a VIEWER the
// data isn't theirs to have yet — nothing in the project has it (outcome D), it needs a link nobody
// defined (E), or its table must be copied first (a connection that is not live-capable) — the
// reason and one button. The button opens a small composer: the question as they asked it, the
// reason, and an optional note. Sending (`editors:ask`, src/server/mentions/asks.ts) tells the
// project's editors and admins in their bell, and by email for those who turned it on; never another
// viewer. The same question again the same day is "already sent", and a person may send 10 a day:
// both are the server's to decide, and its sentence is shown as it is.
//
// An editor never sees this: they get the editor's way out instead (Import, Connect, the link card).
// Shown only once the roles say viewer, so it never flashes for an editor.

import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Textarea } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { useRoles } from '../projects/api';
import s from './AskEditor.module.css';

export type AskReason = 'missing' | 'link' | 'copy';

/** The reason as the viewer reads it; the editor's copy is the server's words for the same code. */
export const ASK_REASON: Record<AskReason, string> = {
  missing: 'This data isn’t in Ordinate yet.',
  link: 'These can’t be combined yet.',
  copy: 'This data has to be copied into Ordinate first.',
};
const MAX = 1000;

type Reply = { ok: true; already?: true } | { ok: false; error?: string; code?: string };
type Sent = 'sent' | 'already';

export function AskAnEditor({ projectId, question, reason }: { projectId: string; question: string; reason: AskReason }) {
  const role = useRoles().data?.[projectId];
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  if (role !== 'viewer') return null;
  return (
    <div className={s.offer} data-testid="ask-editor">
      <span className={s.reason}>
        <Icon name="info" size={16} />
        {ASK_REASON[reason]}
      </span>
      {sent ? (
        <span className={s.sent} role="status" data-testid="ask-editor-sent">
          <Icon name="circle-check" size={16} />
          {sent === 'already' ? 'Already sent to the project’s editors today' : 'Sent to the project’s editors'}
        </span>
      ) : (
        <Button size="sm" variant="secondary" icon="send" onClick={() => setOpen(true)}>
          Ask an editor
        </Button>
      )}
      {open && <Composer projectId={projectId} question={question} reason={reason} onClose={() => setOpen(false)} onSent={setSent} />}
    </div>
  );
}

function Composer({ projectId, question, reason, onClose, onSent }: { projectId: string; question: string; reason: AskReason; onClose: () => void; onSent: (s: Sent) => void }) {
  const [q, setQ] = useState(question.trim().slice(0, MAX));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; limit: boolean } | null>(null);

  async function send(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const r = (await rpc('editors:ask', { projectId, question: q.trim(), reason, ...(note.trim() ? { note: note.trim() } : {}) })) as Reply;
      if (r.ok) {
        onSent(r.already ? 'already' : 'sent');
        onClose();
        return;
      }
      setProblem({ text: r.error || 'Could not send that to the editors.', limit: r.code === 'rate_limited' });
    } catch (e) {
      setProblem({ text: e instanceof Error && e.message ? e.message : 'Could not send that to the editors.', limit: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Ask an editor"
      description="The project’s editors and admins get this in their notifications. Other viewers never see it."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" icon="send" loading={busy} disabled={!q.trim() || problem?.limit} onClick={() => void send()}>
            Send
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Textarea label="Your question" rows={2} maxLength={MAX} value={q} onChange={(e) => setQ(e.target.value)} required />
        <p className={s.why}>
          <Icon name="info" size={16} />
          <span>
            <span className={s.whyLabel}>Why it can’t be answered: </span>
            {ASK_REASON[reason]}
          </span>
        </p>
        <Textarea
          label="Note (optional)"
          hint="What you need it for, or where the data lives."
          rows={3}
          maxLength={MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {problem && (
          <p className={problem.limit ? s.limit : s.error} role="alert" data-testid="ask-editor-problem">
            <Icon name={problem.limit ? 'history' : 'alert'} size={16} />
            {problem.text}
          </p>
        )}
      </div>
    </Dialog>
  );
}
