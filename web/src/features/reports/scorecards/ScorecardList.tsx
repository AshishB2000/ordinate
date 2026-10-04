// The Scorecards tab (scorecardList.ts): a card per scorecard — rows of status
// dots drawn small, its name, cadence, how many metrics and the groups they fall
// into. A new scorecard is seeded with up to eight of the project's most
// recently edited metrics and opens straight on its targets.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { EmptyState, ErrorState } from '../../../app/blocks';
import { shortTime } from '../../../app/when';
import { Button, IconButton } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Menu } from '../../../ui/Menu';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import type { MetricSummary } from '../../analyses/metrics/api';
import { failure, PERIOD_WORD, useScorecards, type Scorecard, type ScorecardSummary } from '../api';
import s from '../Reports.module.css';

export function ScorecardList({ projectId }: { projectId: string }) {
  const q = useScorecards(projectId);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('Monthly scorecard');
  const [deleting, setDeleting] = useState<ScorecardSummary | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ['scorecard:list', projectId] });
  const open = (id: string, edit = false) => void navigate(`/scorecards/${projectId}/${id}${edit ? '?edit=1' : ''}`);

  const create = async () => {
    setNaming(false);
    try {
      const list = (await rpc('metric:list', { projectId })) as { ok: boolean; metrics?: MetricSummary[] };
      // The metrics touched most recently first — the ones being worked on now.
      const rows = (list.metrics ?? [])
        .slice()
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, 8)
        .map((m) => ({ metricId: m.id }));
      const r = (await rpc('scorecard:create', { projectId, name: name.trim() || 'Monthly scorecard', period: 'month', rows })) as { ok: boolean; scorecard?: Scorecard; error?: string };
      if (!r.ok || !r.scorecard) throw new Error(failure(r, 'Could not create the scorecard.'));
      // A scorecard is only as good as its targets — go straight to setting them.
      open(r.scorecard.id, rows.length > 0);
    } catch (err) {
      toast(failure(err, 'Could not create the scorecard.'), { kind: 'error' });
    }
  };
  const duplicate = async (sc: ScorecardSummary) => {
    const r = (await rpc('scorecard:duplicate', { projectId, id: sc.id }).catch((e: unknown) => e)) as { ok?: boolean };
    if (!r || r.ok === false || r instanceof Error) toast('Could not duplicate the scorecard.', { kind: 'error' });
    refresh();
  };
  const remove = async () => {
    const sc = deleting;
    setDeleting(null);
    if (!sc) return;
    await rpc('scorecard:delete', { projectId, id: sc.id }).catch(() => toast('Could not delete the scorecard.', { kind: 'error' }));
    toast(`Deleted “${sc.name}”`);
    refresh();
  };

  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setNaming(true)}>
      New scorecard
    </Button>
  );
  let body;
  if (q.isPending) {
    body = (
      <ul className={s.grid} aria-busy="true" aria-label="Loading scorecards">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className={s.card} aria-hidden="true">
            <Skeleton className={s.skBand} />
            <Skeleton className={s.skLine} />
            <Skeleton className={s.skMeta} />
          </li>
        ))}
      </ul>
    );
  } else if (q.isError) {
    body = <ErrorState title="Scorecards could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  } else if (!q.data.length) {
    body = (
      <EmptyState icon="target" title="No scorecards yet" actions={newButton}>
        A scorecard reads your metrics one period at a time against their targets: on track, at risk or off track, the change on the last period, and a
        twelve-period trend. Every figure is recomputed by the app — nothing is stored.
      </EmptyState>
    );
  } else {
    body = (
      <ul className={s.grid} aria-label="Scorecards">
        {q.data.map((sc) => (
          <li key={sc.id} className={s.card} data-scorecard-id={sc.id}>
            <button type="button" className={s.cardOpen} onClick={() => open(sc.id)} aria-label={`Open ${sc.name}`}>
              <span className={s.band}>
                <span className={s.art} aria-hidden="true">
                  {(['good', 'warn', 'good', 'off'] as const).map((st, i) => (
                    <span key={i} className={s.artRow}>
                      <span className={`${s.dot} ${s[st]}`} />
                      <span className={`${s.artBar} ${s[`artBar${i + 1}`]}`} />
                    </span>
                  ))}
                </span>
              </span>
              <span className={s.cardBody}>
                <span className={s.cardName}>{sc.name || 'Untitled scorecard'}</span>
                <span className={s.cardLine}>
                  {PERIOD_WORD[sc.period] || 'Monthly'} · {sc.rowCount === 1 ? '1 metric' : `${sc.rowCount} metrics`} · Edited {shortTime(sc.updatedAt)}
                </span>
                {!!sc.groups.length && (
                  <span className={s.chips}>
                    {sc.groups.slice(0, 4).map((g) => (
                      <span key={g} className={s.chip}>{g}</span>
                    ))}
                  </span>
                )}
              </span>
            </button>
            <span className={s.cardMenu}>
              <Menu
                label={`${sc.name} options`}
                align="end"
                trigger={<IconButton icon="more-horizontal" label="Scorecard actions" size="sm" />}
                items={[
                  { label: 'Open', icon: 'target', onSelect: () => open(sc.id) },
                  { label: 'Duplicate', icon: 'copy', onSelect: () => void duplicate(sc) },
                  { kind: 'separator' },
                  { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(sc) },
                ]}
              />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={s.tab}>
      {!!q.data?.length && (
        <div className={s.bar}>
          <span className={s.count}>{q.data.length === 1 ? '1 scorecard' : `${q.data.length} scorecards`}</span>
          {newButton}
        </div>
      )}
      {body}
      <Dialog
        open={naming}
        onOpenChange={setNaming}
        size="sm"
        title="Name the scorecard"
        description="It starts monthly, with your most recently edited metrics. You set the targets next."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" onClick={() => void create()}>
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
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
        </form>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        size="sm"
        title="Delete this scorecard?"
        description={deleting ? `“${deleting.name}” will be deleted. The metrics it shows are not.` : undefined}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}
