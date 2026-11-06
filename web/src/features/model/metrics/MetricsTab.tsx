// The Data model's Metrics tab (moved from /data/metrics, which redirects here): what the project's data
// MEANS — "Revenue", not "sum of the revenue column". One row per metric: its definition in words, the date
// it counts by, whether it can be added up, its format, current figure, trend and where it is used, every
// one of them the server's (`metric:table`, one call). Seeding from the columns is an explicit button, so a
// viewer's visit never writes. A viewer reads the table and opens a metric's tree; defining, editing,
// duplicating and deleting are an editor's. "New metric" is the page header's (DataModelPage).

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { EmptyState, ErrorState } from '../../../app/blocks';
import { Badge } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Menu } from '../../../ui/Menu';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonTable } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { useTags } from '../../data/api';
import { formatNumber } from '../../data/format';
import { TagChips, TagFilterBar, tagsOf, useActiveTag } from '../../data/tags';
import { useCanEdit } from '../../projects/api';
import { toastMovedToTrash } from '../../projects/trashToast';
import { failure } from '../../analyses/api';
import { formatBadge, isExternal, isFunnel, isPeriod, type Metric, type MetricSummary, type Usage } from '../../analyses/metrics/api';
import { MetricEditor, type MetricDraft } from '../../analyses/metrics/MetricEditor';
import { Sparkline } from '../../analyses/metrics/Sparkline';
import { StatusActions } from '../status/StatusActions';
import { StatusBadge } from '../status/StatusBadge';
import { AddsUp, CountsBy, type Additivity } from './MetricCells';
import type { NavTopic } from '../navigation';
import { inOrder } from '../topics/api';
import { TopicLine } from '../topics/TopicPicker';
import d from '../../data/Data.module.css';
import s from '../../analyses/metrics/Metrics.module.css';

interface Row {
  display: string | null;
  series: (number | null)[] | null;
  usage: Usage | null;
  /** The server's rule (Task 3); absent from an older pod, null when unknown. */
  additivity?: Additivity | null;
  /** A layer's metric (part 7): its layer by name, and the door's sentence when it has no figure. */
  layer?: string;
  refused?: { code: string; reason?: string; error: string };
}
type Table = { ok: true; metrics: MetricSummary[]; rows: Record<string, Row> } | { ok: false; error: string };

/** The charts that follow this metric now and so drew other numbers before (the server marks them). */
function ChangedCharts({ usage }: { usage: Usage }) {
  const names = usage.refs.filter((r) => r.change).map((r) => r.name);
  if (!names.length) return null;
  return (
    <span className={s.changed} title={names.join(', ')}>
      <Badge tone="warn">{`${names.length} ${names.length === 1 ? 'chart' : 'charts'} changed`}</Badge>
      <span className={s.srOnly}>{`Changed charts: ${names.join(', ')}`}</span>
    </span>
  );
}

function useTable(projectId: string) {
  return useQuery({
    queryKey: ['metric:table', projectId],
    queryFn: async () => {
      const r = (await rpc('metric:table', { projectId })) as Table;
      if (!r.ok) throw new Error(r.error || 'Metrics could not be loaded.');
      return r;
    },
  });
}

/** `topic`: its metrics only, in its order (part 6 step 07). */
export function MetricsTab({ projectId, topic }: { projectId: string; topic?: NavTopic }) {
  const q = useTable(projectId);
  const tags = useTags(projectId);
  const [tag, setTag] = useActiveTag();
  const client = useQueryClient();
  const [editing, setEditing] = useState<MetricDraft | null>(null);
  const [deleting, setDeleting] = useState<MetricSummary | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [state, setState] = useState<'all' | 'certified' | 'retired'>('all'); // the status filter
  const navigate = useNavigate();
  const canEdit = useCanEdit(projectId);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['metric:table', projectId] });
    void client.invalidateQueries({ queryKey: ['metric:list', projectId] });
  };

  // The editor takes the FULL record: a summary has no filters, and saving it would drop them.
  const open = async (m: MetricSummary) => {
    try {
      const r = (await rpc('metric:get', { projectId, id: m.id })) as { ok: boolean; metric?: Metric; error?: string; tag?: string };
      if (!r.ok || !r.metric) throw new Error(r.error || 'That metric could not be read.');
      setEditing({ ...r.metric, tag: r.tag, ...(m.status && { status: m.status }) }); // the tag: the editor's base (docs/edit-conflicts)
    } catch (err) {
      toast(failure(err, 'That metric could not be read.'), { kind: 'error' });
    }
  };
  const duplicate = async (m: MetricSummary) => {
    try {
      const r = (await rpc('metric:duplicate', { projectId, id: m.id })) as { ok: boolean; error?: string };
      if (!r.ok) throw new Error(r.error);
    } catch (err) {
      toast(failure(err, 'The metric could not be duplicated.'), { kind: 'error' });
    }
    refresh();
  };
  const remove = async (m: MetricSummary) => {
    setDeleting(null);
    let reply: { ok?: boolean } | null = null;
    try {
      reply = (await rpc('metric:delete', { projectId, id: m.id })) as { ok?: boolean };
    } catch {
      reply = null;
    }
    toastMovedToTrash(client, { projectId, type: 'metric', id: m.id, name: m.name }, reply);
    refresh();
  };
  const seed = async () => {
    setSeeding(true);
    try {
      const r = (await rpc('metric:ensureDefaults', { projectId })) as { ok: boolean; metrics?: unknown[]; error?: string };
      if (!r.ok) throw new Error(r.error);
      if (!r.metrics?.length) toast('There is no dataset with numbers to propose metrics from yet.');
    } catch (err) {
      toast(failure(err, 'Metrics could not be proposed.'), { kind: 'error' });
    } finally {
      setSeeding(false);
      refresh();
    }
  };

  const count = q.data?.metrics.length ?? 0;
  let body;
  if (q.isPending) body = <SkeletonTable rows={6} cols={9} label="Loading metrics" />;
  else if (q.isError) body = <ErrorState heading={3} title="Metrics could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (count === 0) {
    // The header holds New metric: the empty state offers only what the header does not (one door, never two).
    body = (
      <EmptyState
        icon="target"
        heading={3}
        title="No metrics yet"
        actions={
          canEdit && (
            <Button variant="ghost" size="lg" icon="sparkles" loading={seeding} onClick={() => void seed()}>
              Suggest metrics from my columns
            </Button>
          )
        }
      >
        A metric names a number once (Revenue, Margin %, Orders), so every KPI card, alert and chart that shows it agrees.
        {canEdit ? ' Use New metric to define one from a column or as a formula of other metrics.' : ' An editor of this project can define one. You have view-only access.'}
      </EmptyState>
    );
  } else if (topic && !inOrder(q.data.metrics, topic.metricIds).length) {
    body = (
      <EmptyState icon="target" heading={3} title={`${topic.name} lists no metrics`}>
        {canEdit ? `Choose Edit ${topic.name}… in the Topic menu to add some.` : 'Show all lists every metric in this project.'}
      </EmptyState>
    );
  } else {
    const rows = q.data.rows;
    const base = topic ? inOrder(q.data.metrics, topic.metricIds) : q.data.metrics;
    // Catalog tags on each row and the tag filter bar over the list (catalogUi.ts ctDecorate / ctAfterPaint).
    const tagged = (m: MetricSummary) => tagsOf(tags.data, `metric:${m.id}`);
    const present = [...new Set(base.flatMap((m) => tagged(m).map((t) => t.name)))];
    const byTag = tag ? base.filter((m) => tagged(m).some((t) => t.name === tag)) : base;
    const shown = state === 'all' ? byTag : byTag.filter((m) => (state === 'retired' ? m.status?.state === 'retired' : m.status?.state === 'certified'));
    const tree = (m: MetricSummary) => void navigate(`/data/metrics/${projectId}/${m.id}/tree`);
    body = (
      <>
        <TagFilterBar present={present} index={tags.data} active={tag} onPick={setTag} empty={byTag.length === 0} />
        {q.data.metrics.some((m) => m.status) && (
          <div className={s.stateFilter} role="group" aria-label="Status">
            {(['all', 'certified', 'retired'] as const).map((k) => (
              <Button key={k} size="sm" variant={state === k ? 'primary' : 'ghost'} aria-pressed={state === k} onClick={() => setState(k)}>
                {k === 'all' ? 'All' : k === 'certified' ? 'Certified' : 'Retired'}
              </Button>
            ))}
          </div>
        )}
        {shown.length === 0 && state !== 'all' && <EmptyState icon="archive" heading={3} title={state === 'retired' ? 'Nothing is retired' : 'Nothing is certified yet'}>{state === 'retired' ? 'A retired metric stays where it is used, with a note that names its replacement.' : 'An admin certifies a metric after reviewing its definition.'}</EmptyState>}
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Dataset</th>
                <th scope="col">Definition</th>
                <th scope="col">Counts by</th>
                <th scope="col">Adds up</th>
                <th scope="col">Format</th>
                <th scope="col" className={s.num}>
                  Value
                </th>
                <th scope="col">Trend</th>
                <th scope="col">Used in</th>
                <th scope="col">
                  <span className={s.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const row = rows[m.id];
                const mirror = !!m.definition && isExternal(m.definition); // its definition is its layer's: a badge, never math
                return (
                  <tr key={m.id}>
                    <td>
                      {canEdit ? (
                        <button type="button" className={s.name} title={m.description || undefined} onClick={() => void open(m)}>
                          {m.name}
                        </button>
                      ) : (
                        <span className={s.nameText} title={m.description || undefined}>
                          {m.name}
                        </span>
                      )}
                      {m.hasTree && (
                        <button type="button" className={s.treeLink} onClick={() => tree(m)} aria-label={`Open ${m.name}’s tree`}>
                          <Icon name="lineage" size={12} /> Tree
                        </button>
                      )}
                      <TagChips tags={tagged(m)} />
                      {m.status && (
                        <div className={s.status}>
                          <StatusBadge status={m.status} />
                        </div>
                      )}
                    </td>
                    <td className={s.dim}>{m.datasetName ?? '(missing dataset)'}</td>
                    {mirror ? (
                      <td className={s.def}>
                        <span title={`${m.definitionText}: edit it there.`}>
                          <Badge tone="accent" icon="layers">
                            {m.definitionText}
                          </Badge>
                        </span>
                        {row?.refused?.reason === 'metricMissing' && (
                          <span className={s.status} title={row.refused.error}>
                            <Badge tone="warn" icon="alert">{`Missing in ${row.layer ?? 'its layer'}`}</Badge>
                          </span>
                        )}
                      </td>
                    ) : (
                      <td className={s.def} title={m.definitionText}>
                        {m.definitionText}
                      </td>
                    )}
                    <td>
                      <CountsBy m={m} list={q.data.metrics} />
                    </td>
                    <td>
                      <AddsUp a={row?.additivity} period={!!m.definition && isPeriod(m.definition)} funnel={!!m.definition && isFunnel(m.definition)} />
                    </td>
                    <td>
                      <span className={s.badge}>{formatBadge(m.format)}</span>
                    </td>
                    <td className={s.num} title={row?.refused?.error}>
                      {row?.display ?? '—'}
                    </td>
                    <td className={s.trend}>{row?.series && <Sparkline values={row.series} label={`${m.name} trend`} />}</td>
                    <td className={row?.usage?.total ? s.dim : s.unused}>
                      {row?.usage ? (row.usage.total ? row.usage.summary : 'Not used yet') : '—'}
                      {row?.usage && <ChangedCharts usage={row.usage} />}
                    </td>
                    <td className={s.actions}>
                      <StatusActions projectId={projectId} kind="metric" id={m.id} name={m.name} status={m.status} compact />
                      {(canEdit || m.hasTree) && (
                        <Menu
                          label={`Actions for ${m.name}`}
                          align="end"
                          trigger={<IconButton icon="more-horizontal" size="sm" label={`Actions for ${m.name}`} />}
                          items={
                            canEdit
                              ? [
                                  { label: 'Edit', icon: 'pencil', onSelect: () => void open(m) },
                                  { label: m.hasTree ? 'Open tree' : 'Break it down…', icon: 'lineage', onSelect: () => tree(m) },
                                  ...(mirror ? [] : [{ label: 'Duplicate', icon: 'copy' as const, onSelect: () => void duplicate(m) }]), // a layer's definition has one home
                                  { kind: 'separator' },
                                  { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(m) },
                                ]
                              : [{ label: 'Open tree', icon: 'lineage', onSelect: () => tree(m) }]
                          }
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  const usage = deleting ? q.data?.rows[deleting.id]?.usage : null;
  return (
    <section className={d.section} aria-label="Metrics">
      <div className={d.listBar}>
        {topic && q.data ? (
          <TopicLine projectId={projectId} topic={topic} shown={inOrder(q.data.metrics, topic.metricIds).length} total={count} noun="metric" />
        ) : (
          count > 0 && <span className={d.muted}>{count === 1 ? '1 metric' : `${formatNumber(count)} metrics`}</span>
        )}
        <p className={d.lead}>What this project&apos;s numbers mean, defined once so every chart and KPI agrees.</p>
      </div>
      {body}
      {editing && canEdit && <MetricEditor projectId={projectId} existing={editing} used={editing.id ? q.data?.rows[editing.id]?.usage?.summary ?? undefined : undefined} onClose={() => setEditing(null)} onSaved={refresh} />}
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        size="sm"
        title={`Delete “${deleting?.name ?? ''}”?`}
        description={
          usage === undefined || usage === null
            ? 'Ordinate could not check what uses it.'
            : usage.total
              ? `Used by ${usage.summary}. Those keep working from their own saved column and aggregation, but they stop following this metric.`
              : 'Nothing uses it yet.'
        }
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete
            </Button>
          </>
        }
      />
    </section>
  );
}
