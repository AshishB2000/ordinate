// A dataset's mode (docs/live-data/00-plan.md L2.1): "Copy the data" (an
// extract, the rows kept here) or "Live" (the schema only — charts, KPI tiles
// and answers ask the warehouse each time, L2.4). The switch, its confirm, and
// what the Data tab says in place of rows a Live dataset does not keep.
// Every figure here (the cache age) arrives from the server; this only words it.

import { useState } from 'react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { EmptyState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useWrite } from './api';
import { formatNumber, rowsText } from './format';
import s from './Data.module.css';

/** What a mode switch changes on screen. */
const REFRESH = ['dataset:list', 'dataset:columns', 'dataset:source', 'dataset:page', 'dataset:stats', 'lineage:get'] as const;

type ModeReply = { ok?: boolean; error?: string; code?: string };

/** "always asked" / "cached up to 5 min" — the server's cache age in words. */
export function cacheText(sec: number | undefined): string {
  if (sec === undefined) return '';
  if (sec === 0) return 'always asked';
  const [n, unit] = sec % 86_400 === 0 ? [sec / 86_400, 'day'] : sec % 3_600 === 0 ? [sec / 3_600, 'h'] : sec % 60 === 0 ? [sec / 60, 'min'] : [sec, 's'];
  return `cached up to ${formatNumber(n)} ${unit === 'day' && n !== 1 ? 'days' : unit}`;
}

/** The header's badge: "Live · cached up to 5 min". */
export function LiveBadge({ maxCacheAgeSec }: { maxCacheAgeSec?: number }) {
  const cache = cacheText(maxCacheAgeSec);
  return (
    <span title="Charts, KPI tiles and answers on this dataset ask its warehouse. No rows are stored here.">
      <Badge tone="accent" icon="zap">
        {cache ? `Live · ${cache}` : 'Live'}
      </Badge>
    </span>
  );
}

/** extract → Live: the stored copy is deleted, so it is said before it happens. */
export function SwitchToLiveDialog({ projectId, datasetId, name, rowCount, onClose }: {
  projectId: string;
  datasetId: string;
  name: string;
  rowCount: number;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  const set = useWrite('dataset:setMode', REFRESH, {
    quiet: true,
    onDone: (r: ModeReply) => {
      if (r.ok === false) return setError(r.error || 'The dataset could not be switched to Live.');
      toast(`“${name}” is Live.`, { kind: 'success' });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Switch to Live?"
      description="Charts, KPI tiles and answers on this dataset will ask its warehouse each time, so they show the numbers as they are now."
      footer={
        <>
          <DialogClose asChild>
            <Button>Keep the copy</Button>
          </DialogClose>
          <Button variant="danger" icon="zap" loading={set.isPending} onClick={() => (setError(''), set.mutate({ projectId, datasetId, mode: 'live', confirmDrop: true }))}>
            Delete the copy and go Live
          </Button>
        </>
      }
    >
      <p>
        The stored copy of {rowsText(rowCount)} is deleted. Answers are cached for 5 minutes by default. Browsing rows, prepare steps, quality checks,
        insights and snapshots work on a copy, so they are off while the dataset is Live — switch back with “Copy the data”.
      </p>
      {error && (
        <p role="alert" className={s.rowError}>
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** The Data tab of a Live dataset: no rows are kept here to page through. */
export function LiveNotice({ projectId, datasetId, maxCacheAgeSec }: { projectId: string; datasetId: string; maxCacheAgeSec?: number }) {
  const set = useWrite('dataset:setMode', REFRESH, {
    onDone: (r: ModeReply) => r.ok !== false && toast('Copied — the rows are stored here now.', { kind: 'success' }),
  });
  const cache = cacheText(maxCacheAgeSec);
  return (
    <EmptyState
      icon="zap"
      title="Live — the rows stay in the warehouse"
      actions={
        <Button icon="download" loading={set.isPending} onClick={() => set.mutate({ projectId, datasetId, mode: 'extract' })}>
          Copy the data instead
        </Button>
      }
    >
      {`Charts, KPI tiles and answers on this dataset ask its warehouse${cache ? ` (${cache})` : ''}. Browsing rows, prepare steps and the other tools need a copy.`}
    </EmptyState>
  );
}
