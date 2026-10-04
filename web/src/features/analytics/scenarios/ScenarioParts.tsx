// What the three scenario pages share (scenarioList.ts / scenarioCompare.ts):
// the card art (a small tornado), the driver chips, "New scenario" (named,
// seeded with the project's first metrics so it opens on figures) and the
// delete confirmation.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { toast } from '../../../ui/Toast';
import { call, type Scenario, type ScenarioMetric } from '../api';
import s from './Scenarios.module.css';

/** The card's picture: bars of different lengths about one line. Decoration only. */
export function TornadoArt({ className }: { className?: string }) {
  const rows: Array<[string, string]> = [
    ['w38', 'w44'],
    ['w26', 'w30'],
    ['w16', 'w12'],
    ['w8', 'w10'],
  ];
  return (
    <div className={className ? `${s.art} ${className}` : s.art} aria-hidden="true">
      {rows.map(([lo, hi]) => (
        <div key={lo} className={s.artRow}>
          <span className={`${s.artBar} ${s.artLow} ${s[lo]}`} />
          <span className={`${s.artBar} ${s.artHigh} ${s[hi]}`} />
        </div>
      ))}
    </div>
  );
}

/** Up to three driver chips, then "+N". */
export function DriverChips({ names, none }: { names: readonly string[]; none: string }) {
  if (!names.length) return <span className={s.none}>{none}</span>;
  return (
    <>
      {names.slice(0, 3).map((n, i) => (
        <span key={i} className={s.chip}>
          {n}
        </span>
      ))}
      {names.length > 3 && <span className={`${s.chip} ${s.chipMore}`}>{`+${names.length - 3}`}</span>}
    </>
  );
}

/**
 * A new scenario's metrics: up to four — the ones a column driver moves
 * directly (sum/avg/min/max) first, then a formula built on them, counts last
 * (no value driver moves a count). Choosing, not computing.
 */
export function seedMetrics(list: readonly ScenarioMetric[]): string[] {
  const rank = (m: ScenarioMetric) => (m.kind === 'formula' ? 1 : m.kind === 'count' ? 2 : 0);
  const simple = list.filter((m) => rank(m) === 0).slice(0, 3);
  const rest = list.filter((m) => rank(m) > 0).sort((a, b) => rank(a) - rank(b));
  return [...simple, ...rest].slice(0, 4).map((m) => m.id);
}

/** "New scenario": a name dialog, then the editor on the new record. */
export function NewScenario({ projectId, label = 'New scenario', size = 'md' }: { projectId: string; label?: string; size?: 'sm' | 'md' | 'lg' }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Price +5%');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const client = useQueryClient();
  async function create() {
    setBusy(true);
    let metrics: ScenarioMetric[] = [];
    try {
      metrics = (await rpc('scenario:metrics', { projectId })) as ScenarioMetric[];
    } catch {
      metrics = [];
    }
    const res = await call<{ ok: true; scenario: Scenario }>(
      rpc('scenario:create', { projectId, input: { name: name.trim() || 'Untitled scenario', baseMetricIds: seedMetrics(metrics), drivers: [] } }),
      'Could not create the scenario.',
    );
    setBusy(false);
    if (!res.ok) {
      toast(res.error, { kind: 'error' });
      return;
    }
    setOpen(false);
    void client.invalidateQueries({ queryKey: ['scenario:list', projectId] });
    void nav(`/analytics/scenarios/${projectId}/${res.scenario.id}`);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="sm"
      title="Name the scenario"
      trigger={
        <Button variant="primary" size={size}>
          {label}
        </Button>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={busy} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input label="Name" value={name} maxLength={200} autoFocus onChange={(e) => setName(e.target.value)} />
      </form>
    </Dialog>
  );
}

/** Delete, after a confirmation that says what is NOT touched. */
export function DeleteScenario({
  projectId,
  scenario,
  open,
  onOpenChange,
  onDeleted,
}: {
  projectId: string;
  scenario: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  async function remove() {
    if (!scenario) return;
    setBusy(true);
    const res = await call<{ ok: boolean }>(rpc('scenario:delete', { projectId, id: scenario.id }), 'Could not delete the scenario.');
    setBusy(false);
    onOpenChange(false);
    if (!res.ok) {
      toast('error' in res ? res.error : 'Could not delete the scenario.', { kind: 'error' });
      return;
    }
    void client.invalidateQueries({ queryKey: ['scenario:list', projectId] });
    onDeleted();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Delete scenario"
      description={scenario ? `Delete “${scenario.name}”? The metrics and data it reads are not changed.` : undefined}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            Delete
          </Button>
        </>
      }
    />
  );
}

/** Duplicate, then refresh the list. */
export async function duplicateScenario(projectId: string, id: string, refresh: () => void): Promise<void> {
  const res = await call<{ ok: true }>(rpc('scenario:duplicate', { projectId, id }), 'Could not duplicate the scenario.');
  if (!res.ok) toast('Could not duplicate the scenario.', { kind: 'error' });
  refresh();
}
