// "Add to dashboard" on an answer card (docs/assistant/00-design.md step 8): an EDITOR puts the answer on a dashboard
// they can edit, or on a new one. The browser sends the stored SPEC and which dashboard, nothing else: the server
// rebuilds the card, saves it as a visual and adds a tile of it to the dashboard's draft (`answer:addToDashboard`,
// src/ipc/answerDashboard.ts). It never publishes: viewers see the tile at the dashboard's next Publish. The picker is
// the house one (`stats:dashboards`), which lists only the dashboards the caller edits. Then the card says where the
// answer went, with a link to open it.
//
// A viewer has Request a dashboard instead (./RequestDashboard); false until the roles are known, so it never flashes.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../api/client';
import { Button, buttonClass } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { useCanEdit } from '../projects/api';
import s from './AskEditor.module.css';

const NEW = '__new__';
const FAILED = 'Could not add this answer to that dashboard.';
type Board = { id: string; name: string };
type Reply = { ok: true; dashboard: Board } | { ok: false; reason?: string; error?: string };

export function AddToDashboard({ projectId, spec }: { projectId: string; spec: { datasetId: string; title?: unknown } & Record<string, unknown> }) {
  const canEdit = useCanEdit(projectId);
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<Board | null>(null);
  if (!canEdit) return null;
  if (added) {
    return (
      <>
        <span className={s.sent} role="status" data-testid="answer-added">
          <Icon name="circle-check" size={16} />
          Added to {added.name}
        </span>
        <Link className={buttonClass('ghost', 'sm')} to={`/analyses/${projectId}/${added.id}`}>
          <Icon name="external-link" />
          <span>Open</span>
        </Link>
      </>
    );
  }
  return (
    <>
      <Button size="sm" variant="ghost" icon="layout-dashboard" onClick={() => setOpen(true)}>
        Add to dashboard
      </Button>
      {open && <Picker projectId={projectId} spec={spec} onClose={() => setOpen(false)} onAdded={setAdded} />}
    </>
  );
}

function Picker({ projectId, spec, onClose, onAdded }: {
  projectId: string;
  spec: Record<string, unknown>;
  onClose: () => void;
  onAdded: (b: Board) => void;
}) {
  const qc = useQueryClient();
  const boards = useQuery({
    queryKey: ['stats:dashboards', projectId],
    queryFn: async () => (await rpc('stats:dashboards', { projectId })) as Board[],
  });
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const list = boards.data ?? [];
  const picked = choice ?? (list[0]?.id || NEW);
  const title = typeof spec.title === 'string' && spec.title ? spec.title : 'Untitled dashboard';

  async function add(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const r = (await rpc('answer:addToDashboard', { projectId, spec: spec as { datasetId: string }, ...(picked === NEW ? (name.trim() ? { name: name.trim() } : {}) : { analysisId: picked }) })) as Reply;
      if (!r.ok) return setProblem(r.reason || r.error || FAILED);
      for (const key of ['stats:dashboards', 'analysis:gallery', 'visual:list']) void qc.invalidateQueries({ queryKey: [key, projectId] });
      onAdded(r.dashboard);
      onClose();
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Add to dashboard"
      description="The answer is saved as a visual and added to the dashboard’s draft. Viewers see it once the dashboard is published."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={busy} disabled={boards.isPending} onClick={() => void add()}>
            Add
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Select
          label="Dashboard"
          value={picked}
          disabled={boards.isPending}
          placeholder="Loading dashboards…"
          hint={boards.isSuccess && list.length === 0 ? 'No dashboard you can edit yet: this makes a new one.' : undefined}
          options={[...list.map((d) => ({ value: d.id, label: d.name || 'Untitled dashboard' })), { value: NEW, label: 'New dashboard…' }]}
          onValueChange={setChoice}
        />
        {picked === NEW && <Input label="Name the dashboard" placeholder={title} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
        {boards.isError && (
          <p className={s.error} role="alert">
            <Icon name="alert" size={16} />
            Could not list your dashboards. You can still add it to a new one.
          </p>
        )}
        {problem && (
          <p className={s.error} role="alert" data-testid="add-problem">
            <Icon name="alert" size={16} />
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}
