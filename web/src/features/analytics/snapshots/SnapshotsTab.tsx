// The dataset page's Snapshots tab (snapshots.ts): the versions kept each time
// a refresh replaces the table, how many to keep, Compare (./SnapshotDiff) and
// Restore. Every figure is the server's — row counts off the snapshot index,
// "vs now" (`delta`) from snapshots:list, and a restore goes through the
// server's refresh path, keeping the current table as a snapshot first.

import { useState } from 'react';
import { formatNumber } from '../../../../../src/app/format.ts';
import { ago } from '../../../app/when';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Icon } from '../../../ui/icons/Icon';
import { Select } from '../../../ui/Select';
import { SkeletonTable } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { restore, setKeep, useSnapshotRefresh, useSnapshots, when, whenAll, type SnapshotItem, type SnapshotList } from './api';
import { SnapshotDiff } from './SnapshotDiff';
import s from './Snapshots.module.css';

const KEEP_CHOICES = [0, 3, 5, 10, 20, 50, 100];
const rowsText = (n: number) => `${formatNumber(n)} ${n === 1 ? 'row' : 'rows'}`;

function KeepSelect({ projectId, datasetId, keep, onDone }: { projectId: string; datasetId: string; keep: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const choices = KEEP_CHOICES.includes(keep) ? KEEP_CHOICES : [...KEEP_CHOICES, keep].sort((a, b) => a - b);
  const change = async (n: number) => {
    setBusy(true);
    try {
      const r = await setKeep(projectId, datasetId, n);
      if (r.removed) toast(`Removed ${r.removed} older ${r.removed === 1 ? 'snapshot' : 'snapshots'}.`, { kind: 'info' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change how many snapshots are kept.', { kind: 'error' });
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className={s.keep}>
      <Select
        label="Keep"
        size="sm"
        disabled={busy}
        value={String(keep)}
        options={choices.map((n) => ({ value: String(n), label: n === 0 ? 'none (off)' : `the last ${n}` }))}
        onValueChange={(v) => void change(Number(v))}
      />
    </div>
  );
}

function RestoreDialog({ projectId, datasetId, item, onClose, onDone }: { projectId: string; datasetId: string; item: SnapshotItem; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await restore(projectId, datasetId, item.stamp);
      toast(`Restored the data as of ${when(item.at)}.`, { kind: 'success' });
      onDone();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not restore the snapshot.', { kind: 'error' });
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Restore this snapshot?"
      description={`The data goes back to how it was on ${when(item.at)} — ${rowsText(item.rowCount)}. Charts and dashboards on this dataset follow.`}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            icon="rotate-ccw"
            loading={busy}
            onClick={() => void run()}
          >
            Restore
          </Button>
        </>
      }
    >
      <p className={s.dialogNote}>The data as it is now is kept as a snapshot first, so you can come back to it.</p>
    </Dialog>
  );
}

function Table({ list, open, onCompare, onRestore }: { list: SnapshotList; open: string | null; onCompare: (s: SnapshotItem) => void; onRestore: (s: SnapshotItem) => void }) {
  const labels = whenAll([list.current.at, ...list.items.map((x) => x.at)]);
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className={s.sr}>Kept snapshots of this dataset, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Data as of</th>
            <th scope="col" className={s.num}>
              Rows
            </th>
            <th scope="col">vs now</th>
            <th scope="col">
              <span className={s.sr}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className={s.current}>
            <th scope="row">
              <span className={s.when}>{labels[0]}</span>
              <span className={s.tag}>Current</span>
            </th>
            <td className={s.num}>{rowsText(list.current.rowCount)}</td>
            <td className={s.muted}>—</td>
            <td />
          </tr>
          {list.items.map((it, i) => (
            <tr key={it.stamp} className={open === it.stamp ? s.open : undefined}>
              <th scope="row">
                <span className={s.when}>{labels[i + 1]}</span>
                <span className={s.ago}>{ago(it.at)}</span>
              </th>
              <td className={s.num}>{rowsText(it.rowCount)}</td>
              <td className={it.delta > 0 ? s.up : it.delta < 0 ? s.down : s.muted}>
                {it.delta === 0 ? 'same rows' : `${it.delta > 0 ? '+' : '−'}${formatNumber(Math.abs(it.delta))} since`}
              </td>
              <td>
                <div className={s.actions}>
                  <Button size="sm" icon="layers" onClick={() => onCompare(it)} aria-pressed={open === it.stamp}>
                    Compare
                  </Button>
                  <Button size="sm" icon="rotate-ccw" onClick={() => onRestore(it)}>
                    Restore…
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SnapshotsTab({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const q = useSnapshots(projectId, datasetId);
  const refresh = useSnapshotRefresh(projectId, datasetId);
  const [compare, setCompare] = useState<SnapshotItem | null>(null);
  const [restoring, setRestoring] = useState<SnapshotItem | null>(null);

  if (q.isPending) return <SkeletonTable rows={4} cols={4} label="Loading the snapshots" />;
  if (q.isError) return <ErrorState title="Could not read the snapshots" message={q.error.message} onRetry={() => void q.refetch()} heading={3} />;
  const list = q.data;
  const shown = compare && list.items.some((x) => x.stamp === compare.stamp) ? compare : null;
  return (
    <section className={s.body} aria-label="Snapshots">
      <div className={s.head}>
        <div>
          <h2 className={s.h}>Snapshots</h2>
          <p className={s.sub}>
            {list.items.length
              ? `${formatNumber(list.items.length)} kept · each is the table as it was before a refresh replaced it`
              : 'A copy of the table, kept each time a refresh replaces it'}
          </p>
        </div>
        {(list.eligible || list.items.length > 0) && <KeepSelect projectId={projectId} datasetId={datasetId} keep={list.keep} onDone={refresh} />}
      </div>
      {!list.eligible && (
        <div className={s.notice} role="note">
          <Icon name="calendar" />
          <div>
            <strong>Only datasets with a schedule or a connection keep snapshots.</strong>
            <span>
              {list.refreshable
                ? ' Turn on Auto-refresh above to keep a copy each time this dataset refreshes.'
                : ' This dataset has no source to refresh from, so it never changes on its own.'}
            </span>
          </div>
        </div>
      )}
      {list.items.length > 0 ? (
        <>
          <Table list={list} open={shown?.stamp ?? null} onCompare={(x) => setCompare(shown?.stamp === x.stamp ? null : x)} onRestore={setRestoring} />
          {shown && <SnapshotDiff projectId={projectId} datasetId={datasetId} item={shown} current={list.current} onClose={() => setCompare(null)} />}
        </>
      ) : (
        list.eligible && (
          <EmptyState icon="history" title="Snapshots start with the next refresh" heading={3}>
            {list.keep > 0
              ? `When a refresh replaces this table, the table it replaces is kept here — the last ${list.keep}, oldest dropped first. Compare any of them with now, or restore one.`
              : 'Keeping is off for this dataset. Choose how many to keep above to start.'}
          </EmptyState>
        )
      )}
      {restoring && (
        <RestoreDialog
          projectId={projectId}
          datasetId={datasetId}
          item={restoring}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setCompare(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}
