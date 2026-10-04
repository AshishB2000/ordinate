// An empty sheet says how to fill it (legacy dashboards.ts empty state +
// dashAdd.ts applyStarter): add a card, or lay down a starter built from a
// dataset's own columns — real tiles, built by the server through the same
// plan → records path the Assistant's plans use.

import { useState } from 'react';
import { rpc } from '../../../api/client';
import { useDatasets } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import { Skeleton } from '../../../ui/Skeleton';
import { EmptyState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { failure, type Card, type OpenReply } from '../api';
import { useEditor } from './context';
import s from './Canvas.module.css';

export function EmptySheet() {
  const ed = useEditor();
  const sets = useDatasets(ed.projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const ds = picked ?? sets.data?.[0]?.id ?? null;

  const starter = async (kind: 'kpis' | 'twoup') => {
    if (!ds) return;
    setBusy(kind);
    try {
      const r = (await rpc('analysis:starterCards', { projectId: ed.projectId, kind, datasetId: ds })) as {
        ok: boolean;
        cards?: Card[];
        dropped?: unknown[];
        error?: string;
      };
      if (!r.ok || !r.cards?.length) throw new Error(r.error || 'Could not build a starter layout.');
      // The starter made new visuals: read their definitions so the cards draw.
      const open = (await rpc('analysis:open', { projectId: ed.projectId, id: ed.analysisId })) as OpenReply;
      if (open.ok) ed.addVisuals(open.visuals);
      const cards = r.cards;
      ed.edit('Add cards', (d) => {
        d.sheets[ed.sheet].cards.push(...cards);
      });
      const n = r.dropped?.length ?? 0;
      if (n) toast(n === 1 ? 'One tile could not be built.' : `${n} tiles could not be built.`);
    } catch (err) {
      toast(failure(err, 'Could not build a starter layout.'), { kind: 'error' });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={s.empty}>
      <EmptyState
        icon="layout-dashboard"
        title="This sheet is empty"
        actions={
          <>
            <Button variant="primary" icon="chart-bar" onClick={() => ed.openAdd('visual')}>
              Add a visual
            </Button>
            <Button icon="target" onClick={() => ed.openAdd('kpi')}>
              Add a KPI
            </Button>
            <Button icon="file-text" onClick={() => ed.openAdd('text')}>
              Add text
            </Button>
          </>
        }
      >
        Add cards from the bar above, or start from a layout built from one of your datasets.
      </EmptyState>
      {sets.isPending && <Skeleton className={s.starterSk} />}
      {sets.isError && (
        <p className={s.starterNote} role="alert">
          The layouts built from your data are unavailable: the datasets could not be listed.
        </p>
      )}
      {!!sets.data?.length && (
        <div className={s.starters}>
          {sets.data.length > 1 && (
            <Select
              size="sm"
              aria-label="Build the starter from"
              value={ds}
              options={sets.data.map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
              onValueChange={setPicked}
            />
          )}
          <Button size="sm" loading={busy === 'kpis'} disabled={!!busy} onClick={() => void starter('kpis')}>
            KPIs + chart
          </Button>
          <Button size="sm" loading={busy === 'twoup'} disabled={!!busy} onClick={() => void starter('twoup')}>
            Two-up
          </Button>
        </div>
      )}
    </div>
  );
}
