// "Add to dashboard" (statsTile.ts swAddToDashboard): pick a dashboard — or
// name a new one — and how the card shows the result. The card stores only the
// spec; the server merges it into the dashboard's last sheet
// (`stats:addToDashboard`) and every render recomputes it.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { toast } from '../../../ui/Toast';
import { call, type StatsSpec } from '../api';
import { Seg } from './StatsControls';
import s from './Stats.module.css';

const NEW = '__new__';

export function AddToDashboard({ projectId, spec }: { projectId: string; spec: StatsSpec }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const boards = useQuery({
    queryKey: ['stats:dashboards', projectId],
    queryFn: async () => (await rpc('stats:dashboards', { projectId })) as Array<{ id: string; name: string }>,
    enabled: open,
  });
  const list = boards.data ?? [];
  const picked = choice ?? (list[0]?.id || NEW);

  async function add() {
    setBusy(true);
    const isNew = picked === NEW;
    const res = await call<{ ok: true; name: string }>(
      rpc('stats:addToDashboard', { projectId, spec, view, ...(isNew ? { name: name.trim() || 'Untitled dashboard' } : { analysisId: picked }) }),
      'Could not add it to that dashboard.',
    );
    setBusy(false);
    if (!res.ok) {
      toast(res.error, { kind: 'error' });
      return;
    }
    setOpen(false);
    void client.invalidateQueries({ queryKey: ['stats:dashboards', projectId] });
    toast(`Added to ${res.name}`, { kind: 'success' });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="sm"
      title="Add to dashboard"
      description="The card keeps the analysis, not its figures: it recomputes under the dashboard’s filters."
      trigger={
        <Button size="sm" icon="layout-dashboard">
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
        <div className={s.addView}>
          <span className={s.ctlLabel}>Show as</span>
          <Seg label="Show the result as" options={[['table', 'Table'], ['chart', 'Chart']]} value={view} onChange={(v) => setView(v as 'table' | 'chart')} />
        </div>
      </div>
    </Dialog>
  );
}
