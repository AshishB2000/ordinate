// "Add to dashboard" for a metric tree: pick a dashboard — or name a new one.
// The card stores the metric's id; its tree stays on the metric, so editing it
// here updates every card (metricTree:addToDashboard merges it server side).
// It writes a dashboard: a viewer is not offered it.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../../api/client';
import { Button } from '../../../../ui/Button';
import { Dialog, DialogClose } from '../../../../ui/Dialog';
import { Input } from '../../../../ui/Field';
import { Select } from '../../../../ui/Select';
import { toast } from '../../../../ui/Toast';
import { useCanEdit } from '../../../projects/api';
import s from './MetricTreePage.module.css';

const NEW = '__new__';

export function AddTreeToDashboard({ projectId, metricId, disabled }: { projectId: string; metricId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const boards = useQuery({
    queryKey: ['stats:dashboards', projectId],
    queryFn: async () => (await rpc('stats:dashboards', { projectId })) as Array<{ id: string; name: string }>,
    enabled: open,
  });
  const canEdit = useCanEdit(projectId);
  const list = boards.data ?? [];
  const picked = choice ?? (list[0]?.id || NEW);

  async function add() {
    setBusy(true);
    const isNew = picked === NEW;
    const r = (await rpc('metricTree:addToDashboard', { projectId, id: metricId, ...(isNew ? { name: name.trim() || 'Untitled dashboard' } : { analysisId: picked }) }).catch(
      (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : '' }),
    )) as { ok: boolean; error?: string; analysisId?: string; name?: string };
    setBusy(false);
    if (!r.ok || !r.analysisId) return toast(r.error || 'Could not add it to that dashboard.', { kind: 'error' });
    setOpen(false);
    const to = `/analyses/${projectId}/${r.analysisId}`;
    toast(`Added to ${r.name}`, { kind: 'success', action: { label: 'Open it', onClick: () => void navigate(to) } });
  }

  if (!canEdit) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="sm"
      title="Add to dashboard"
      description="A Metric tree card, full width at the foot of the last sheet. It follows the dashboard’s date filter and Compare."
      trigger={
        <Button icon="layout-dashboard" disabled={disabled}>
          Add to dashboard
        </Button>
      }
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
      <div className={s.addForm}>
        <Select
          label="Dashboard"
          value={picked}
          disabled={boards.isPending}
          options={[...list.map((d) => ({ value: d.id, label: d.name || 'Untitled dashboard' })), { value: NEW, label: 'New dashboard…' }]}
          onValueChange={setChoice}
        />
        {picked === NEW && <Input label="Name the dashboard" placeholder="Untitled dashboard" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
      </div>
    </Dialog>
  );
}
