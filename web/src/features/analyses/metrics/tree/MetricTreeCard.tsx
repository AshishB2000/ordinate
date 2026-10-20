// The "Metric tree" dashboard card: a saved metric's tree under the sheet's
// filters — its date filter is the period, and the sheet's Compare (else the
// card's own, default vs previous period) is the comparison. The tree lives on
// the metric, so editing it there updates every card. Batched with the sheet's
// tiles (`analysis:tiles` → metricTree:compute); every figure the server's.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button, buttonClass } from '../../../../ui/Button';
import { Dialog, DialogClose } from '../../../../ui/Dialog';
import { Select } from '../../../../ui/Select';
import { EmptyState, ErrorState } from '../../../../ui/States';
import { Icon } from '../../../../ui/icons/Icon';
import { usable } from '../../../dashboards/CompareBar';
import { LiveRefusal } from '../../../live/LiveOff';
import { isRowRefusal, liveRefusalOf } from '../../../live/refusal';
import { useTile, type Card, type TileRequest } from '../../api';
import type { Doc } from '../../editor/doc';
import { useEditor } from '../../editor/context';
import { uuid } from '../../editor/doc';
import { findSlot } from '../../editor/geometry';
import { useMetricList } from '../api';
import type { CompareMode, TreeReply } from './api';
import { TreeSkeleton, TreeView } from './TreeView';
import s from './MetricTreeCard.module.css';

type TreeCard = { metricId: string; compare?: { mode: CompareMode; from?: string; to?: string } };
type TreeTile = TreeReply | { ok: false; error: string; code?: string };

const treeOf = (card: Card): TreeCard | undefined => card.metricTree as TreeCard | undefined;

export function MetricTreeBody({ card }: { card: Card }) {
  const ed = useEditor();
  const spec = treeOf(card);
  // The sheet's Compare when it is usable (a custom one needs both dates), else the card's own.
  const compare = usable(ed.view.compare) ?? spec?.compare;
  const req = useMemo<TileRequest | undefined>(
    () => (spec ? { kind: 'metricTree', metricId: spec.metricId, filters: ed.filters, ...(compare ? { compare } : {}) } : undefined),
    [spec, ed.filters, compare],
  );
  const q = useTile<TreeTile>(ed.projectId, ed.params, req);
  if (!spec) return <p className={s.note}>This card has no metric.</p>;
  if (q.isPending) return <TreeSkeleton compact />;
  const live = q.isError ? null : liveRefusalOf(q.data);
  if (live) return <LiveRefusal projectId={ed.projectId} message={live} row={isRowRefusal(q.data)} />;
  if (q.isError || !q.data.ok) {
    return <ErrorState compact heading={3} title="Could not compute this tree" message={q.isError ? q.error.message : q.data.ok ? '' : q.data.error} onRetry={() => void q.refetch()} />;
  }
  const t = q.data;
  return (
    <div className={s.body}>
      <div className={s.head}>
        <span className={s.periods}>
          {t.period.label} <span className={s.vs}>vs</span> {t.prior.label}
        </span>
        <p className={s.sentence}>{t.headline}</p>
        {ed.view.asOf && <p className={s.note}>The tree compares today’s periods, not the As of time.</p>}
      </div>
      {t.tree ? (
        <div className={s.treeBox}>
          <TreeView root={t.root} label={`${t.root.name}, ${t.period.label} ${t.compareLabel}`} />
        </div>
      ) : (
        <EmptyState
          compact
          heading={3}
          icon="lineage"
          title={`${t.root.name} has no tree yet`}
          actions={
            !ed.readOnly && (
              <Link className={buttonClass('secondary', 'sm')} to={`/data/metrics/${ed.projectId}/${spec.metricId}/tree`}>
                Break it down
              </Link>
            )
          }
        >
          {ed.readOnly
            ? 'An editor of this project can break the metric into its parts; this card follows.'
            : 'Break the metric into its parts on its tree page; this card follows.'}
        </EmptyState>
      )}
    </div>
  );
}

const MODES = [
  { value: 'previous_period', label: 'vs previous period' },
  { value: 'previous_year', label: 'vs same period last year' },
];

/** The card's Properties: its own comparison (when the sheet's Compare is off) and a way to its tree. */
export function MetricTreeProps({ card, set }: { card: Card; set: (label: string, fn: (c: Card, d: Doc) => void) => void }) {
  const ed = useEditor();
  const spec = treeOf(card);
  if (!spec) return null;
  return (
    <>
      <Select
        label="Compare"
        hint={ed.view.compare ? 'The dashboard’s Compare is on, and this card follows it.' : 'When the dashboard’s Compare is off.'}
        value={spec.compare?.mode === 'previous_year' ? 'previous_year' : 'previous_period'}
        options={MODES}
        onValueChange={(v) => set('Change the tree’s comparison', (c) => void (c.metricTree = { ...spec, compare: { mode: v as CompareMode } }))}
      />
      <p className={s.propNote}>The period is the sheet’s date filter — the newest closed month when it has none.</p>
      <Link className={buttonClass('secondary', 'sm')} to={`/data/metrics/${ed.projectId}/${spec.metricId}/tree`}>
        <Icon name="lineage" />
        <span>Edit the tree</span>
      </Link>
    </>
  );
}

/** Add a Metric tree card: pick the metric (those with a tree first). */
export function AddTreeCardDialog({ onClose }: { onClose: () => void }) {
  const ed = useEditor();
  const list = useMetricList(ed.projectId);
  const sorted = useMemo(() => [...(list.data ?? [])].sort((a, b) => Number(!!b.hasTree) - Number(!!a.hasTree)), [list.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked ?? sorted[0]?.id ?? null;
  const add = () => {
    if (!id) return;
    const cid = uuid();
    ed.edit('Add metric tree', (d) => {
      const sh = d.sheets[ed.sheet];
      sh.cards.push({ id: cid, type: 'metricTree', layout: { ...findSlot(sh.cards, 12, 11), w: 12, h: 11 }, metricTree: { metricId: id } });
    });
    ed.select(cid);
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a metric tree"
      description="Why a metric moved, broken into its parts — under this sheet’s date filter and Compare."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" disabled={!id} onClick={add}>
            Add
          </Button>
        </>
      }
    >
      {list.isError ? (
        <ErrorState compact heading={3} title="The metrics could not be loaded" message={list.error.message} onRetry={() => void list.refetch()} />
      ) : !list.isPending && !sorted.length ? (
        <EmptyState compact heading={3} icon="target" title="No metrics yet">
          A tree breaks down a saved metric. Define one on the Metrics page first.
        </EmptyState>
      ) : (
        <Select
          label="Metric"
          value={id}
          disabled={list.isPending}
          placeholder="Loading the metrics…"
          options={sorted.map((m) => ({ value: m.id, label: m.hasTree ? `${m.name} · has a tree` : m.name }))}
          onValueChange={setPicked}
        />
      )}
    </Dialog>
  );
}
