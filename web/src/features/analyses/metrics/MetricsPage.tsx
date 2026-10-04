// /data/metrics?project=<id> — the project's metrics (legacy metricsPage.ts,
// a tab under Data): what the project's data MEANS — "Revenue", not "sum of
// the revenue column". One row per metric: its definition in words, format,
// current figure, trend and where it is used, every one of them the server's
// (`metric:table`, one call). Seeding from the columns is an explicit button,
// so a viewer's visit never writes.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { EmptyState, ErrorState, Page } from '../../../app/blocks';
import { Button, IconButton } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Menu } from '../../../ui/Menu';
import { SkeletonTable } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { ProjectGate } from '../../import/ProjectGate';
import { toastMovedToTrash } from '../../projects/trashToast';
import { failure } from '../api';
import { formatBadge, type Metric, type MetricSummary, type Usage } from './api';
import { MetricEditor, type MetricDraft } from './MetricEditor';
import { Sparkline } from './Sparkline';
import s from './Metrics.module.css';

interface Row {
  display: string | null;
  series: (number | null)[] | null;
  usage: Usage | null;
}
type Table = { ok: true; metrics: MetricSummary[]; rows: Record<string, Row> } | { ok: false; error: string };

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

function Metrics({ projectId }: { projectId: string }) {
  const q = useTable(projectId);
  const client = useQueryClient();
  const [editing, setEditing] = useState<MetricDraft | null>(null);
  const [deleting, setDeleting] = useState<MetricSummary | null>(null);
  const [seeding, setSeeding] = useState(false);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['metric:table', projectId] });
    void client.invalidateQueries({ queryKey: ['metric:list', projectId] });
  };

  // The editor takes the FULL record: a summary has no filters, and saving it would drop them.
  const open = async (m: MetricSummary | null) => {
    if (!m) return setEditing({});
    try {
      const r = (await rpc('metric:get', { projectId, id: m.id })) as { ok: boolean; metric?: Metric; error?: string };
      if (!r.ok || !r.metric) throw new Error(r.error || 'That metric could not be read.');
      setEditing(r.metric);
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
  if (q.isPending) body = <SkeletonTable rows={6} cols={7} label="Loading metrics" />;
  else if (q.isError) body = <ErrorState title="Metrics could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (count === 0) {
    body = (
      <EmptyState
        icon="target"
        title="No metrics yet"
        actions={
          <>
            <Button variant="primary" size="lg" onClick={() => void open(null)}>
              New metric
            </Button>
            <Button variant="ghost" size="lg" icon="sparkles" loading={seeding} onClick={() => void seed()}>
              Suggest metrics from my columns
            </Button>
          </>
        }
      >
        A metric names a number once — Revenue, Margin %, Orders — so every KPI card, alert and chart that shows it agrees. Define it from a column or as a
        formula of other metrics.
      </EmptyState>
    );
  } else {
    const rows = q.data.rows;
    body = (
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Dataset</th>
              <th scope="col">Definition</th>
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
            {q.data.metrics.map((m) => {
              const row = rows[m.id];
              return (
                <tr key={m.id}>
                  <td>
                    <button type="button" className={s.name} title={m.description || undefined} onClick={() => void open(m)}>
                      {m.name}
                    </button>
                  </td>
                  <td className={s.dim}>{m.datasetName ?? '(missing dataset)'}</td>
                  <td className={s.def} title={m.definitionText}>
                    {m.definitionText}
                  </td>
                  <td>
                    <span className={s.badge}>{formatBadge(m.format)}</span>
                  </td>
                  <td className={s.num}>{row?.display ?? '—'}</td>
                  <td>{row?.series && <Sparkline values={row.series} label={`${m.name} trend`} />}</td>
                  <td className={row?.usage?.total ? s.dim : s.unused}>{row?.usage ? (row.usage.total ? row.usage.summary : 'Not used yet') : '—'}</td>
                  <td className={s.actions}>
                    <Menu
                      label={`Actions for ${m.name}`}
                      align="end"
                      trigger={<IconButton icon="more-horizontal" size="sm" label={`Actions for ${m.name}`} />}
                      items={[
                        { label: 'Edit', icon: 'pencil', onSelect: () => void open(m) },
                        { label: 'Duplicate', icon: 'copy', onSelect: () => void duplicate(m) },
                        { kind: 'separator' },
                        { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(m) },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const usage = deleting ? q.data?.rows[deleting.id]?.usage : null;
  return (
    <Page title="Metrics" sub="What this project's numbers mean, defined once.">
      <div className={s.head}>
        {count > 0 ? <span className={s.count}>{count === 1 ? '1 metric' : `${count} metrics`}</span> : <span />}
        <Button variant="primary" icon="plus" onClick={() => void open(null)}>
          New metric
        </Button>
      </div>
      {body}
      {editing && <MetricEditor projectId={projectId} existing={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
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
    </Page>
  );
}

export default function MetricsPage() {
  return (
    <ProjectGate title="Metrics" why="Metrics belong to a project.">
      {(projectId) => <Metrics key={projectId} projectId={projectId} />}
    </ProjectGate>
  );
}
