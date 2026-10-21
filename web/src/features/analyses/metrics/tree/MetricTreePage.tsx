// /data/metrics/:projectId/:metricId/tree — "why did this number move", one
// picture (docs/metric-tree/00-design.md). A period and the same Compare a
// dashboard uses; the server's headline; the tree. Every figure, share and
// sentence is metricTree:compute's — this page places them. A viewer picks the
// period and Compare; building, editing and adding a tree are an editor's, so a
// viewer's tree-less metric asks the server for no suggestions.

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Page } from '../../../../app/blocks';
import { Button } from '../../../../ui/Button';
import { Input } from '../../../../ui/Field';
import { Select } from '../../../../ui/Select';
import { EmptyState, ErrorState } from '../../../../ui/States';
import { toast } from '../../../../ui/Toast';
import { Icon } from '../../../../ui/icons/Icon';
import { CompareControl, usable } from '../../../dashboards/CompareBar';
import type { Compare } from '../../../dashboards/useViewer';
import { LiveRefusal } from '../../../live/LiveOff';
import { liveRefusalOf } from '../../../live/refusal';
import { useRoles } from '../../../projects/api';
import { saveTree, useSuggest, useTree, type ComputeInput, type PeriodKey, type TreeSpec } from './api';
import { isRecordChanged } from '../../../editConflicts/useEditGuard';
import { AddTreeToDashboard } from './AddTreeToDashboard';
import { TreeEditor, describe } from './TreeEditor';
import { TreeSkeleton, TreeView } from './TreeView';
import s from './MetricTreePage.module.css';

const PERIODS: { value: PeriodKey; label: string }[] = [
  { value: 'latest_month', label: 'Latest month in the data' },
  { value: 'latest_quarter', label: 'Latest quarter in the data' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'custom', label: 'Custom dates…' },
];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** No tree yet: one-click breakdowns read from the formulas, a split, or the editor. */
function StartHere({ projectId, metricId, name, tag, onEdit, onSaved, onChanged }: {
  projectId: string;
  metricId: string;
  name: string;
  /** The metric's tag this "no tree yet" was read with: a one-click save sends it (docs/edit-conflicts). */
  tag?: string;
  onEdit: () => void;
  onSaved: () => void;
  /** Saved elsewhere meanwhile: nothing typed is lost — say so and read the metric again. */
  onChanged: () => void;
}) {
  const q = useSuggest(projectId, metricId);
  const [busy, setBusy] = useState(false);
  const metricName = (id: string) => q.data?.metrics.find((m) => m.id === id)?.name ?? '—';
  const apply = async (tree: TreeSpec) => {
    setBusy(true);
    let changed = false;
    const r = await saveTree(projectId, metricId, tree, tag).catch((e: Error) => ((changed = isRecordChanged(e)), { error: e.message }));
    setBusy(false);
    if (r.error) toast(r.error, { kind: 'error' });
    if (changed) onChanged();
    else if (!r.error) onSaved();
  };
  const ideas = q.data?.suggestions[metricId] ?? [];
  const columns = (q.data?.columns ?? []).slice(0, 4);
  return (
    <EmptyState
      icon="lineage"
      title={`Break ${name} down`}
      heading={2}
      actions={
        <div className={s.starts}>
          {ideas.map((x, i) => (
            <Button
              key={i}
              variant={i === 0 ? 'primary' : 'secondary'}
              icon="function"
              disabled={busy}
              onClick={() => void apply({ id: crypto.randomUUID(), metricId, relation: x.relation, children: x.children.map((c) => ({ id: crypto.randomUUID(), ...c })) })}
            >
              {describe({ id: '', metricId: '', relation: x.relation, children: x.children.map((c) => ({ id: '', ...c })) }, metricName)}
            </Button>
          ))}
          {columns.map((c) => (
            <Button key={c} icon="layers" disabled={busy} onClick={() => void apply({ id: crypto.randomUUID(), metricId, split: c })}>
              Split by {c}
            </Button>
          ))}
          <Button variant="ghost" icon="pencil" onClick={onEdit}>
            Build it yourself
          </Button>
        </div>
      }
    >
      A tree shows which parts moved {name}: a product like Orders × Avg order value, a sum, a ratio, or its segments by a column — each with its share of the change.
    </EmptyState>
  );
}

function TreePage({ projectId, metricId }: { projectId: string; metricId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<{ key: PeriodKey; from?: string; to?: string }>({ key: 'latest_month' });
  const [compare, setCompare] = useState<Compare>({ mode: 'previous_period' });
  const [editing, setEditing] = useState(false);
  // A new editor (the banner's Reload) on the tree as it is now.
  const [editorGen, setEditorGen] = useState(0);
  // The empty tree's offers depend on the role: nothing is mounted for it until the role is known.
  const roles = useRoles();
  const role = roles.data?.[projectId];
  const canEdit = role === 'editor' || role === 'admin';
  const cmp = usable(compare);
  const periodReady = period.key !== 'custom' || (ISO.test(period.from ?? '') && ISO.test(period.to ?? ''));
  const input: ComputeInput | null = cmp && periodReady ? { projectId, id: metricId, period, compare: cmp } : null;
  const q = useTree(input);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['metricTree:compute'] });
    void client.invalidateQueries({ queryKey: ['metric:table', projectId] });
    toast('Tree saved', { kind: 'success' });
  };
  const data = q.data;
  const name = data?.root.name ?? 'Metric tree';
  const live = q.isError ? liveRefusalOf(q.error) : null;

  let body;
  if (!input) body = <p className={s.wait}>Pick both dates to compare.</p>;
  else if (q.isPending || roles.isPending) body = <TreeSkeleton />;
  else if (q.isError && live) body = <LiveRefusal projectId={projectId} refusal={q.error} />;
  else if (q.isError) body = <ErrorState title="The tree could not be computed" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (data) {
    body = (
      <div className={q.isFetching ? `${s.canvas} ${s.fetching}` : s.canvas} aria-busy={q.isFetching || undefined}>
        <TreeView key={JSON.stringify(data.tree)} root={data.root} label={`${data.root.name}, ${data.period.label} ${data.compareLabel}`} />
        {!data.tree &&
          (canEdit ? (
            <StartHere
              projectId={projectId}
              metricId={metricId}
              name={data.root.name}
              tag={data.tag}
              onEdit={() => setEditing(true)}
              onSaved={refresh}
              onChanged={() => void client.invalidateQueries({ queryKey: ['metricTree:compute'] })}
            />
          ) : (
            <EmptyState compact icon="lineage" title="No tree yet" heading={2}>
              {`A tree shows which parts moved ${data.root.name}, each with its share of the change. An editor of this project can break it down. You have view-only access.`}
            </EmptyState>
          ))}
      </div>
    );
  }

  return (
    <Page title={name} sub="Why it moved: the parts it is made of, and how much of the change each one explains.">
      <Link className={s.back} to={`/data/metrics?project=${projectId}`}>
        <Icon name="arrow-left" size={16} /> Metrics
      </Link>
      <div className={s.toolbar} role="toolbar" aria-label="Period">
        <Select size="sm" aria-label="Period" value={period.key} options={PERIODS} onValueChange={(k) => setPeriod((p) => ({ ...p, key: k as PeriodKey }))} />
        {period.key === 'custom' && (
          <>
            <Input size="sm" type="date" aria-label="Period from" value={period.from ?? ''} max={period.to} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
            <Input size="sm" type="date" aria-label="Period to" value={period.to ?? ''} min={period.from} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
          </>
        )}
        <CompareControl required label="Compare the period with" value={compare} onChange={(c) => c && setCompare(c)} />
        <span className={s.grow} />
        {canEdit && (
          <Button icon="pencil" disabled={!data} onClick={() => setEditing(true)}>
            Edit tree
          </Button>
        )}
        <AddTreeToDashboard projectId={projectId} metricId={metricId} disabled={!data?.tree} />
      </div>
      {data && input && (
        <section className={s.headline} aria-live="polite">
          <span className={s.periods}>
            <span className={s.periodChip}>{data.period.label}</span>
            <span className={s.vs}>vs</span>
            <span className={s.periodChip}>{data.prior.label}</span>
          </span>
          <p className={s.sentence}>{data.headline}</p>
        </section>
      )}
      {body}
      {editing && canEdit && data && (
        <TreeEditor
          key={editorGen}
          projectId={projectId}
          metricId={metricId}
          metricName={data.root.name}
          initial={data.tree}
          tag={data.tag}
          open={editing}
          onOpenChange={setEditing}
          onSaved={refresh}
          onReload={() => void client.refetchQueries({ queryKey: ['metricTree:compute'] }).then(() => setEditorGen((g) => g + 1))}
          onCopied={(id) => void navigate(`/data/metrics/${projectId}/${id}/tree`)}
        />
      )}
    </Page>
  );
}

export default function MetricTreePage() {
  const { projectId = '', metricId = '' } = useParams();
  return <TreePage key={`${projectId}/${metricId}`} projectId={projectId} metricId={metricId} />;
}
