// The Relationships tab (relationshipsPage.ts): the project's data model as a
// canvas of dataset cards — a dataset sits one lane right of every dataset
// that looks rows up in it, so a fact table reads left of its lookups — with
// curves from each many side to its lookup, and the same relationships as a
// keyboard-first table under it. Match counts and rates are the server's,
// counted over the full tables when the relationship was saved.

import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useDatasets, type DatasetSummary } from '../../api/datasets';
import { Button, buttonClass, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { SkeletonBlock } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useRelationships, useWrite, type Relationship } from './api';
import { formatNumber, fromControl, pctText } from './format';
import { RelationshipDialog } from './RelationshipDialog';
import s from './Data.module.css';
import ms from './Model.module.css';

const kindShort = (c: Relationship['cardinality']) => (c === 'one_to_one' ? '1:1' : 'N:1');

/**
 * Lanes by depth: a lookup sits one lane right of whatever looks rows up in it.
 * Unrelated datasets get the last lane. Relaxation stops after N passes, which
 * also ends a one-to-one cycle. Layout only — no figure comes from here.
 */
export function laneLayout(ids: readonly string[], rels: readonly Relationship[]): { lanes: string[][]; loose: string[] } {
  const linked = new Set(rels.flatMap((r) => [r.from.datasetId, r.to.datasetId]));
  const rank = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const r of rels) {
      const want = (rank.get(r.from.datasetId) ?? 0) + 1;
      const cur = rank.get(r.to.datasetId);
      if (cur !== undefined && cur < want && want < ids.length) {
        rank.set(r.to.datasetId, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const lanes: string[][] = [];
  for (const id of ids) if (linked.has(id)) (lanes[rank.get(id) ?? 0] ??= []).push(id);
  return { lanes: lanes.filter(Boolean), loose: ids.filter((id) => !linked.has(id)) };
}

interface Edge {
  id: string;
  d: string;
  end: { x: number; y: number };
  mid: { x: number; y: number };
}

function Canvas({ datasets, rels, selected, onSelect }: {
  datasets: DatasetSummary[];
  rels: Relationship[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const { lanes, loose } = laneLayout(datasets.map((d) => d.id), rels);
  const all = loose.length ? [...lanes, loose] : lanes;
  const keys = (id: string) => [...new Set(rels.flatMap((r) => [r.from.datasetId === id ? r.from.column : '', r.to.datasetId === id ? r.to.column : '']).filter(Boolean))];

  // Edges follow the cards: measured after layout and on every resize.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const draw = () => {
      const box = el.getBoundingClientRect();
      const at = (id: string, column: string, side: 'l' | 'r') => {
        const card = el.querySelector<HTMLElement>(`[data-dataset-id="${id}"]`);
        if (!card) return null;
        const key = card.querySelector<HTMLElement>(`[data-column="${CSS.escape(column)}"]`) ?? card;
        const r = card.getBoundingClientRect();
        const k = key.getBoundingClientRect();
        return { x: (side === 'r' ? r.right : r.left) - box.left + el.scrollLeft, y: k.top + k.height / 2 - box.top + el.scrollTop };
      };
      const out: Edge[] = [];
      for (const r of rels) {
        const a = el.querySelector<HTMLElement>(`[data-dataset-id="${r.from.datasetId}"]`);
        const b = el.querySelector<HTMLElement>(`[data-dataset-id="${r.to.datasetId}"]`);
        if (!a || !b) continue;
        const back = b.getBoundingClientRect().left < a.getBoundingClientRect().left;
        const p = at(r.from.datasetId, r.from.column, back ? 'l' : 'r');
        const q = at(r.to.datasetId, r.to.column, back ? 'r' : 'l');
        if (!p || !q) continue;
        const dx = Math.max(40, Math.abs(q.x - p.x) / 2) * (back ? -1 : 1);
        out.push({ id: r.id, d: `M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x},${q.y}`, end: q, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } });
      }
      setEdges(out);
      setSize({ w: el.scrollWidth, h: el.scrollHeight });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rels, datasets]);

  const name = (id: string) => datasets.find((d) => d.id === id)?.name ?? 'A missing dataset';
  return (
    <div ref={ref} className={ms.relCanvas} role="group" aria-label="Data model diagram">
      <svg className={ms.relEdges} width={size.w} height={size.h} aria-hidden="true">
        {edges.map((e) => (
          <g key={e.id} className={e.id === selected ? ms.relEdgeOn : ms.relEdge}>
            <path d={e.d} />
            <circle cx={e.end.x} cy={e.end.y} r={4} />
          </g>
        ))}
      </svg>
      {all.map((lane, i) => (
        <div key={i} className={ms.relLane}>
          {loose.length > 0 && i === all.length - 1 && <div className={ms.relLaneCap}>{rels.length ? 'Not related yet' : 'Datasets'}</div>}
          {lane.map((id) => {
            const d = datasets.find((x) => x.id === id);
            return (
              <div key={id} className={ms.relNode} data-dataset-id={id} role="group" aria-label={`Dataset ${d?.name ?? ''}`}>
                <div className={ms.relNodeHead}>
                  <Icon name="database" size={16} />
                  <span className={ms.relNodeName}>{d?.name ?? 'Dataset'}</span>
                </div>
                <div className={s.meta}>
                  {formatNumber(d?.rowCount ?? 0)} rows · {formatNumber(d?.columnCount ?? 0)} columns
                </div>
                {keys(id).length > 0 && (
                  <div className={ms.relKeys}>
                    {keys(id).map((k) => (
                      <span key={k} className={ms.relKey} data-column={k}>
                        <Icon name="link" size={12} />
                        {k}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {edges.map((e) => {
        const r = rels.find((x) => x.id === e.id)!;
        return (
          <button
            key={e.id}
            type="button"
            className={`${ms.relLabel} ${e.id === selected ? ms.relLabelOn : ''}`}
            style={{ left: e.mid.x, top: e.mid.y }}
            aria-label={`${name(r.from.datasetId)}.${r.from.column} to ${name(r.to.datasetId)}.${r.to.column}, ${r.cardinality === 'one_to_one' ? 'one to one' : 'many to one'}, ${pctText(r.matchPct)} matched`}
            onClick={() => onSelect(e.id)}
          >
            {kindShort(r.cardinality)} · {pctText(r.matchPct)}
          </button>
        );
      })}
      {rels.length === 0 && <div className={ms.relHint}>No relationships yet. New relationship joins two of these on a key column.</div>}
    </div>
  );
}

function End({ name, column }: { name: string; column: string }) {
  return (
    <span className={ms.relEnd}>
      <span className={s.strong}>{name}</span>
      <span className={s.mono}>{column}</span>
    </span>
  );
}

function DeleteRel({ projectId, r, name, onClose }: { projectId: string; r: Relationship; name: (id: string) => string; onClose: () => void }) {
  const del = useWrite('relationship:delete', ['relationship:list'], {
    onDone: (res) => {
      if (res.ok) toast('Relationship deleted.', { kind: 'success' });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Delete this relationship?"
      description={`${name(r.from.datasetId)} → ${name(r.to.datasetId)}. Visuals using columns across it fall back to their own dataset's columns.`}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="danger" loading={del.isPending} onClick={() => del.mutate({ projectId, id: r.id })}>
            Delete
          </Button>
        </>
      }
    />
  );
}

export function RelationshipsTab({ projectId }: { projectId: string }) {
  const rels = useRelationships(projectId);
  const ds = useDatasets(projectId);
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Relationship | null>(null);
  const select = (id: string) => setSelected((cur) => (cur === id ? '' : id));

  if (rels.isPending || ds.isPending) return <SkeletonBlock label="Loading the data model" />;
  if (rels.isError || ds.isError) {
    const err = (rels.error ?? ds.error) as Error;
    return <ErrorState heading={3} title="The data model could not be loaded" message={err.message} onRetry={() => void Promise.all([rels.refetch(), ds.refetch()])} />;
  }
  const datasets = ds.data;
  const list = rels.data;
  const name = (id: string) => datasets.find((d) => d.id === id)?.name ?? 'A missing dataset';
  return (
    <section className={s.section} aria-label="Relationships">
      <div className={s.listBar}>
        <Button variant="primary" icon="plus" disabled={datasets.length < 2} onClick={() => setAdding(true)}>
          New relationship
        </Button>
        <span className={s.muted}>{list.length === 1 ? '1 relationship' : `${formatNumber(list.length)} relationships`}</span>
        <p className={s.lead}>A relationship joins live, at query time: nothing is copied, and every visual can use columns from both sides.</p>
      </div>
      {datasets.length < 2 ? (
        <EmptyState
          icon="link"
          heading={3}
          title="Relate two datasets"
          actions={
            <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
              Import file
            </Link>
          }
        >
          A relationship needs two datasets — say orders and the regions they ship to. Import a second one to start a data model.
        </EmptyState>
      ) : (
        <Canvas datasets={datasets} rels={list} selected={selected} onSelect={select} />
      )}
      {list.length === 0 ? (
        <p className={s.muted}>Relationships you add appear here with how many rows matched.</p>
      ) : (
        <div className={s.card}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Many side</th>
                <th scope="col">One side</th>
                <th scope="col">Kind</th>
                <th scope="col" className={s.num}>
                  Matched
                </th>
                <th scope="col" className={s.num}>
                  Unmatched
                </th>
                <th scope="col" className={s.actions}>
                  <span className={s.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className={`${s.clickRow} ${r.id === selected ? s.rowOn : ''}`} onClick={(e) => !fromControl(e.target) && select(r.id)}>
                  <td>
                    <End name={name(r.from.datasetId)} column={r.from.column} />
                  </td>
                  <td>
                    <End name={name(r.to.datasetId)} column={r.to.column} />
                  </td>
                  <td>{r.cardinality === 'one_to_one' ? 'One to one' : 'Many to one'}</td>
                  <td className={s.num}>
                    {formatNumber(r.verified.matched)} ({pctText(r.matchPct)})
                  </td>
                  <td className={`${s.num} ${r.verified.unmatchedFrom ? s.warnText : ''}`}>{formatNumber(r.verified.unmatchedFrom)}</td>
                  <td className={s.actions}>
                    <Menu
                      align="end"
                      trigger={<IconButton icon="more-horizontal" size="sm" label={`Actions for ${name(r.from.datasetId)} to ${name(r.to.datasetId)}`} />}
                      items={[
                        { label: 'Show on diagram', icon: 'eye', onSelect: () => setSelected(r.id) },
                        { kind: 'separator' },
                        { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(r) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <RelationshipDialog projectId={projectId} datasets={datasets} onClose={(id) => { setAdding(false); if (id) setSelected(id); }} />}
      {deleting && <DeleteRel projectId={projectId} r={deleting} name={name} onClose={() => setDeleting(null)} />}
    </section>
  );
}
