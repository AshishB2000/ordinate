// "Request a dashboard" (docs/team-folders/00-design.md, "Dashboard requests"): a VIEWER's Add to dashboard. A viewer
// cannot keep an answer, so on an answer card they ask the editors for a dashboard of it: the answers it holds (this
// one, and any other chart in the conversation), a new dashboard — its name, and a folder they open to suggest — or
// one already there that they open, and a note. Sending (`request:create`, src/server/requests) stores the answers'
// chart forms — never a figure — and tells the editors who can approve it; nothing is made until one does. An SQL
// answer, or one read straight from a warehouse table, is listed but cannot be ticked, with why. The same charts
// again the same day are "already sent", a person may send 10 a day and have 20 waiting in a project: the server's to
// decide, its sentence shown as it is. The bell lists a sent request, to withdraw it.
//
// An editor never sees this (Save as visual is theirs). Shown only once the roles say viewer, and only on a stored turn.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Checkbox, RadioGroup } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input, Textarea } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Icon } from '../../ui/icons/Icon';
import { useRoles } from '../projects/api';
import { useAnalysisNames } from './api';
import s from './AskEditor.module.css';

/** An answer of the conversation the dialog lists: a chart to put on the dashboard, or (`kind`) one it cannot take. */
export interface ChartAnswer {
  turnId: string;
  title: string;
  /** An SQL answer, or a source table's: listed, never ticked. */
  kind?: 'sql' | 'table';
}

type Reply = { ok: true; already?: true } | { ok: false; error?: string; code?: string };
type Sent = 'sent' | 'already';
const MAX_NOTE = 2000;
/** Why an answer cannot go on a dashboard, under its box. */
const CANNOT: Record<NonNullable<ChartAnswer['kind']>, string> = {
  sql: 'An answer written as SQL can’t go on a dashboard: only charts can.',
  table: 'An editor must keep this table first.',
};

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
  const [onto, setOnto] = useState<'new' | 'existing'>('new');
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [folderId, setFolderId] = useState(''); // '': no suggestion — it goes where its data is
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; limit: boolean } | null>(null);
  const boards = useAnalysisNames(projectId).data ?? [];
  const folders = useQuery({
    queryKey: ['request:folders', projectId],
    queryFn: async () => ((await rpc('request:folders', { projectId })) as { ok: boolean; folders?: { id: string; name: string }[] }).folders ?? [],
  }).data ?? [];
  const board = onto === 'existing' ? boards.find((b) => b.id === dashboardId) : undefined;
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
      const turnIds = answers.filter((a) => !a.kind && picked.has(a.turnId)).map((a) => a.turnId); // in the conversation's order
      const where = board ? { dashboardId: board.id } : folderId ? { folderId } : {};
      const r = (await rpc('request:create', { projectId, threadId, turnIds, title: (board?.name ?? title).trim().slice(0, 120), ...(note.trim() ? { note: note.trim() } : {}), ...where })) as Reply;
      if (r.ok) {
        onSent(r.already ? 'already' : 'sent');
        onClose();
        return;
      }
      setProblem({ text: r.error || 'Could not send the request.', limit: r.code === 'rate_limited' || r.code === 'too_many_open' });
    } catch (e) {
      setProblem({ text: e instanceof Error && e.message ? e.message : 'Could not send the request.', limit: false });
    } finally {
      setBusy(false);
    }
  }

  const named = onto === 'existing' ? !!board : !!title.trim();
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
          <Button variant="primary" icon="send" loading={busy} disabled={!named || picked.size === 0 || problem?.limit} onClick={() => void send()}>
            Send request
          </Button>
        </>
      }
    >
      <div className={s.form}>
        {boards.length > 0 && (
          <RadioGroup
            label="Put the charts on"
            orientation="horizontal"
            value={onto}
            onValueChange={(v) => setOnto(v === 'existing' ? 'existing' : 'new')}
            options={[{ value: 'new', label: 'A new dashboard' }, { value: 'existing', label: 'A dashboard already there' }]}
          />
        )}
        {onto === 'existing' ? (
          <Select
            label="Dashboard"
            hint="The charts go on a sheet of their own."
            placeholder="Pick a dashboard…"
            value={dashboardId}
            onValueChange={setDashboardId}
            options={boards.map((b) => ({ value: b.id, label: b.name }))}
          />
        ) : (
          <>
            <Input label="Dashboard name" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} required />
            {folders.length > 1 && (
              <Select
                label="Folder (optional)"
                hint="A suggestion: the editor who approves it picks where it goes."
                value={folderId}
                onValueChange={setFolderId}
                options={[{ value: '', label: 'Where its data is' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
              />
            )}
          </>
        )}
        <fieldset className={s.charts}>
          <legend className={s.whyLabel}>Charts on it</legend>
          {answers.map((a) => (
            <Checkbox
              key={a.turnId}
              label={a.title}
              checked={!a.kind && picked.has(a.turnId)}
              disabled={!!a.kind}
              hint={a.kind ? CANNOT[a.kind] : undefined}
              onCheckedChange={(on) => toggle(a.turnId, on)}
            />
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
