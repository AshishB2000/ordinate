// Editing a scorecard's ROWS (scorecardEditor.ts): which metrics, and for each
// its target — none, a fixed figure, or another metric read over the same
// period — owner, group and thresholds (percent of target). Save writes the
// rows through `scorecard:update`, sanitized by scorecardModel on the server.

import { useMemo, useState } from 'react';
import { rpc } from '../../../api/client';
import { Button, IconButton } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Select } from '../../../ui/Select';
import { SkeletonRows } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { useMetricList } from '../../analyses/metrics/api';
import { failure, type Scorecard, type ScorecardRowDef } from '../api';
import { ChooseMetrics } from '../stories/Choosers';
import s from './RowsEditor.module.css';

export interface EditRow {
  metricId: string;
  targetMode: 'none' | 'number' | 'metric';
  target: string;
  targetMetric: string;
  owner: string;
  group: string;
  good: string;
  warn: string;
}

export function toEditRow(r: ScorecardRowDef): EditRow {
  const t = r.target;
  return {
    metricId: r.metricId,
    targetMode: typeof t === 'number' ? 'number' : t && typeof t === 'object' ? 'metric' : 'none',
    target: typeof t === 'number' ? String(t) : '',
    targetMetric: t && typeof t === 'object' ? t.metricId : '',
    owner: r.owner || '',
    group: r.group || '',
    good: r.thresholds ? String(r.thresholds.good) : '',
    warn: r.thresholds ? String(r.thresholds.warn) : '',
  };
}

/** A row as the record stores it: only what was set, numbers parsed (the server re-checks every field). */
export function fromEditRow(e: EditRow): ScorecardRowDef {
  const row: ScorecardRowDef = { metricId: e.metricId };
  const n = Number(e.target);
  if (e.targetMode === 'number' && e.target.trim() !== '' && Number.isFinite(n)) row.target = n;
  if (e.targetMode === 'metric' && e.targetMetric) row.target = { metricId: e.targetMetric };
  if (e.owner.trim()) row.owner = e.owner.trim();
  if (e.group.trim()) row.group = e.group.trim();
  const g = Number(e.good);
  const w = Number(e.warn);
  if (e.good.trim() !== '' && e.warn.trim() !== '' && Number.isFinite(g) && Number.isFinite(w)) row.thresholds = { good: g, warn: w };
  return row;
}

export function RowsEditor({ projectId, sc, onClose, onSaved }: { projectId: string; sc: Scorecard; onClose: () => void; onSaved: () => void }) {
  const metrics = useMetricList(projectId);
  const byId = useMemo(() => new Map((metrics.data ?? []).map((m) => [m.id, m])), [metrics.data]);
  const [rows, setRows] = useState<EditRow[]>(() => sc.rows.map(toEditRow));
  const [picking, setPicking] = useState<{ kind: 'add' } | { kind: 'target'; index: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (i: number, patch: Partial<EditRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const groups = Array.from(new Set(rows.map((r) => r.group.trim()).filter(Boolean)));

  const save = async () => {
    setSaving(true);
    try {
      const r = (await rpc('scorecard:update', { projectId, id: sc.id, patch: { rows: rows.map(fromEditRow) } })) as { ok: boolean; error?: string };
      if (!r.ok) throw new Error(failure(r, 'Could not save the scorecard.'));
      onSaved();
    } catch (err) {
      toast(failure(err, 'Could not save the scorecard.'), { kind: 'error' });
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog
        open={!picking}
        onOpenChange={(o) => !o && !picking && onClose()}
        size="lg"
        title="Metrics, targets and owners"
        description="Thresholds are percent of target. Leave them empty for the defaults: at or over target is on track, within 10% at risk (reversed for a metric where down is good)."
        footer={
          <>
            <Button icon="plus" onClick={() => setPicking({ kind: 'add' })} className={s.addMetric}>
              Add metric
            </Button>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      >
        {metrics.isPending ? (
          <SkeletonRows rows={4} label="Loading metrics" />
        ) : !rows.length ? (
          <p className={s.edEmpty}>No metrics yet — add the numbers this scorecard should track.</p>
        ) : (
          <div className={s.edScroll}>
          <table className={s.edTable}>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Target</th>
                <th scope="col">Owner</th>
                <th scope="col">Group</th>
                <th scope="col">Good %</th>
                <th scope="col">Warn %</th>
                <th scope="col"><span className={s.srOnly}>Order</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const m = byId.get(r.metricId);
                const down = m?.direction === 'down_good';
                return (
                  <tr key={r.metricId + i}>
                    <th scope="row">
                      <span className={s.edName}>{m ? m.name : 'Missing metric'}</span>
                      {m?.direction && <span className={s.edDir}>{down ? 'Down is good' : 'Up is good'}</span>}
                    </th>
                    <td>
                      <div className={s.edTarget}>
                        <Select
                          size="sm"
                          aria-label={`Target type for ${m ? m.name : 'metric'}`}
                          value={r.targetMode}
                          onValueChange={(v) => (v === 'metric' ? setPicking({ kind: 'target', index: i }) : set(i, { targetMode: v as EditRow['targetMode'] }))}
                          options={[
                            { value: 'none', label: 'None' },
                            { value: 'number', label: 'Number' },
                            { value: 'metric', label: 'Metric' },
                          ]}
                        />
                        {r.targetMode === 'number' && (
                          <input className={s.edInput} type="number" step="any" aria-label="Target value" placeholder="e.g. 250000" value={r.target} onChange={(e) => set(i, { target: e.target.value })} />
                        )}
                        {r.targetMode === 'metric' && <span className={s.chip}>{byId.get(r.targetMetric)?.name ?? 'Missing metric'}</span>}
                      </div>
                    </td>
                    <td>
                      <input className={s.edInput} aria-label="Owner" placeholder="Owner" value={r.owner} maxLength={80} onChange={(e) => set(i, { owner: e.target.value })} />
                    </td>
                    <td>
                      <input className={s.edInput} aria-label="Group" placeholder="Group" list="sc-ed-groups" value={r.group} maxLength={80} onChange={(e) => set(i, { group: e.target.value })} />
                    </td>
                    <td>
                      <input className={s.edNum} type="number" step="any" aria-label="Good threshold, percent of target" placeholder="100" value={r.good} onChange={(e) => set(i, { good: e.target.value })} />
                    </td>
                    <td>
                      <input className={s.edNum} type="number" step="any" aria-label="Warning threshold, percent of target" placeholder={down ? '110' : '90'} value={r.warn} onChange={(e) => set(i, { warn: e.target.value })} />
                    </td>
                    <td className={s.edActs}>
                      <IconButton
                        icon="arrow-up"
                        size="sm"
                        label="Move up"
                        disabled={i === 0}
                        onClick={() => setRows((rs) => rs.map((x, j) => (j === i - 1 ? rs[i] : j === i ? rs[i - 1] : x)))}
                      />
                      <IconButton icon="x" size="sm" label={`Remove ${m ? m.name : 'row'}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        <datalist id="sc-ed-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Dialog>
      {picking && (
        <ChooseMetrics
          projectId={projectId}
          max={1}
          onDone={(ids) => {
            const p = picking;
            setPicking(null);
            if (!ids[0]) return;
            if (p.kind === 'add') setRows((rs) => [...rs, toEditRow({ metricId: ids[0] })]);
            else set(p.index, { targetMode: 'metric', targetMetric: ids[0] });
          }}
        />
      )}
    </>
  );
}
