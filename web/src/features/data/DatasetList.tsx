// The Datasets tab (dsList.ts): one row per saved dataset — name (with the
// red quality dot and its tags), rows, source, "Data as of" with the refresh
// schedule and the anomaly watch, and the row's actions. A failed refresh
// leaves the stored table as it was; its reason stays on the row.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useDatasets, type AutoRefreshEvery, type DatasetSummary } from '../../api/datasets';
import { toastMovedToTrash } from '../projects/trashToast';
import { Button, buttonClass, IconButton } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useTags, useWrite } from './api';
import { freshness, fromControl, NOT_REFRESHABLE, rowsOf, SCHEDULES, sourceLabel } from './format';
import { BehindBadge, cadenceOptions } from './cadence';
import { TagChips, TagFilterBar, tagsOf, useActiveTag } from './tags';
import s from './Data.module.css';

type Outcome = { busy?: boolean; message?: string; error?: boolean };
type RefreshReply = { ok: boolean; error?: string; warnings?: string[]; alreadyRunning?: boolean };

/** The quality dot: FAIL rules failing in the latest run (a count the server made). */
export function QualityDot({ n }: { n: number | undefined }) {
  if (!n) return null;
  const label = `Data quality: ${n} ${n === 1 ? 'rule' : 'rules'} failing`;
  return <span className={s.dqDot} role="img" aria-label={label} title={label} />;
}

/** The schedule picker: one control in the list and on the dataset page, one channel. */
export function SchedulePicker({ projectId, d }: { projectId: string; d: DatasetSummary }) {
  const set = useWrite('dataset:update', ['dataset:list'], { onDone: (r) => r.ok === false && toast('Could not change the schedule.', { kind: 'error' }) });
  if (!d.originKind || d.mode === 'live') return null; // a Live dataset's cache age is its schedule
  return (
    <Select
      size="sm"
      aria-label={`Auto-refresh ${d.name}`}
      className={s.schedule}
      value={d.autoRefresh?.every ?? 'off'}
      options={cadenceOptions(SCHEDULES, !!d.incrementalOn)}
      disabled={set.isPending}
      onValueChange={(v) => set.mutate({ projectId, datasetId: d.id, autoRefresh: v === 'off' ? null : (v as AutoRefreshEvery) })}
    />
  );
}

/** "Watch for anomalies" — only where there is a schedule to hang it on. */
export function WatchToggle({ projectId, d }: { projectId: string; d: DatasetSummary }) {
  const set = useWrite('dataset:update', ['dataset:list']);
  if (!d.autoRefresh?.every) return null;
  const on = !!d.autoRefresh.watch;
  return (
    <button
      type="button"
      className={`${s.watch} ${on ? s.watchOn : ''}`}
      aria-pressed={on}
      title="Notify me when new anomalies appear after a refresh"
      disabled={set.isPending}
      onClick={() => set.mutate({ projectId, datasetId: d.id, watch: !on })}
    >
      {on ? 'Watching' : 'Watch'}
    </button>
  );
}

/**
 * A delete is a move to the Trash, taking the dataset's visuals with it — so
 * no confirm: the toast carries Undo (T2.2's trashToast, `trash:restore`).
 */
export function useDeleteDataset(projectId: string, then?: () => void) {
  const client = useQueryClient();
  const del = useWrite('dataset:delete', ['dataset:list', 'catalog:list', 'relationship:list', 'trash:list'], { quiet: true });
  return (d: DatasetSummary) =>
    del.mutate(
      { projectId, id: d.id },
      {
        onSuccess: (r) => {
          toastMovedToTrash(client, { projectId, type: 'dataset', id: d.id, name: d.name }, r as { ok?: boolean; cascaded?: number });
          if ((r as { ok?: boolean }).ok) then?.();
        },
      },
    );
}

/** One dataset's refresh, its outcome kept for the row. Never throws, never alerts. */
export function useRefresh(projectId: string) {
  const [state, setState] = useState<Record<string, Outcome>>({});
  const write = useWrite('dataset:refresh', ['dataset:list', 'dataset:columns', 'dataset:page', 'dataset:stats', 'dataset:profile'], { quiet: true });
  const run = async (id: string): Promise<boolean> => {
    setState((m) => ({ ...m, [id]: { busy: true, message: 'Refreshing…' } }));
    let r: RefreshReply;
    try {
      r = (await write.mutateAsync({ projectId, id })) as RefreshReply;
    } catch {
      r = { ok: false, error: 'Could not refresh this dataset.' };
    }
    // Warnings are not a failure — the data landed, but a step no longer fits it.
    // Nor is "already being refreshed" (another server got there first).
    const message = r.ok ? (r.warnings ?? []).join(' · ') : r.error || 'Could not refresh this dataset.';
    setState((m) => ({ ...m, [id]: { message, error: !r.ok && !r.alreadyRunning } }));
    return r.ok || r.alreadyRunning === true;
  };
  return { state, run };
}

function Row({ projectId, d, outcome, onRefresh, onDelete, tags }: {
  projectId: string;
  d: DatasetSummary;
  outcome: Outcome | undefined;
  onRefresh: () => void;
  onDelete: () => void;
  tags: ReturnType<typeof tagsOf>;
}) {
  const navigate = useNavigate();
  const href = `/data/${projectId}/${d.id}`;
  const failedHint = d.lastRefreshStatus === 'error' ? d.lastRefreshError || 'The last refresh failed.' : undefined;
  return (
    <tr className={s.clickRow} onClick={(e) => !fromControl(e.target) && void navigate(href)}>
      <td>
        <span className={s.nameCell}>
          <QualityDot n={d.qualityFailing} />
          <Link className={s.nameLink} to={href}>
            {d.name}
          </Link>
          <TagChips tags={tags} />
        </span>
      </td>
      <td className={s.num}>{rowsOf(d)}</td>
      <td>
        <span className={s.badge}>{sourceLabel(d.sourceKind)}</span>
      </td>
      <td>
        <span className={s.fresh} title={d.originKind ? failedHint : NOT_REFRESHABLE}>
          <span className={s.freshLine}>
            {d.lastRefreshStatus === 'error' && <span className={s.failDot} role="img" aria-label="Last refresh failed" />}
            <span>{freshness(d)}</span>
            <BehindBadge behind={d.behindSchedule} />
          </span>
          <span className={s.freshTools}>
            <SchedulePicker projectId={projectId} d={d} />
            <WatchToggle projectId={projectId} d={d} />
          </span>
        </span>
        {outcome?.message && (
          <span className={outcome.error ? s.rowError : s.rowNote} role="status">
            {outcome.message}
          </span>
        )}
      </td>
      <td className={s.actions}>
        <span className={s.rowActions}>
          {d.originKind && (
            <Button size="sm" icon="refresh" loading={outcome?.busy} aria-label={`Refresh ${d.name}`} onClick={onRefresh}>
              Refresh
            </Button>
          )}
          <Link className={buttonClass('secondary', 'sm', s.hoverAction)} to={`/visuals?project=${projectId}&datasetId=${d.id}`} title="Build a chart from this dataset">
            New visual
          </Link>
          <Link className={buttonClass('secondary', 'sm', s.hoverAction)} to={`/data/import?project=${projectId}&source=combine`} title="Combine this dataset with another">
            Combine
          </Link>
          <IconButton icon="trash" size="sm" label={`Move ${d.name} to the Trash`} onClick={onDelete} />
        </span>
      </td>
    </tr>
  );
}

export function DatasetList({ projectId }: { projectId: string }) {
  const q = useDatasets(projectId);
  const tags = useTags(projectId);
  const [tag, setTag] = useActiveTag();
  const remove = useDeleteDataset(projectId);
  const refresh = useRefresh(projectId);
  const [all, setAll] = useState(false);

  if (q.isPending) return <SkeletonRows rows={6} label="Loading datasets" />;
  if (q.isError) return <ErrorState heading={3} title="Datasets could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  if (q.data.length === 0) {
    return (
      <EmptyState
        icon="database"
        heading={3}
        title="No datasets yet"
        actions={
          <>
            <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
              Import file
            </Link>
            <Link className={buttonClass('ghost')} to={`/data/import?project=${projectId}&source=paste`}>
              Paste data
            </Link>
          </>
        }
      >
        Import a CSV, JSON or Excel file — or paste data straight in — to save a structured dataset in this project.
      </EmptyState>
    );
  }
  const tagged = (d: DatasetSummary) => tagsOf(tags.data, `dataset:${d.id}`);
  const present = [...new Set(q.data.flatMap((d) => tagged(d).map((t) => t.name)))];
  const shown = tag ? q.data.filter((d) => tagged(d).some((t) => t.name === tag)) : q.data;
  const refreshable = q.data.filter((d) => d.originKind);

  // Sequential, not all at once: one slow source must not stall the rest, and
  // one table in flight keeps the server's memory flat.
  const refreshAll = async () => {
    setAll(true);
    const results: boolean[] = [];
    for (const d of refreshable) results.push(await refresh.run(d.id));
    setAll(false);
    const failed = results.filter((ok) => !ok).length;
    toast(`Refreshed ${results.length - failed} of ${results.length}${failed ? ` · ${failed} failed` : ''}`, { kind: failed ? 'error' : 'success' });
  };

  return (
    <section className={s.section} aria-label="Datasets">
      <div className={s.listBar}>
        <TagFilterBar present={present} index={tags.data} active={tag} onPick={setTag} empty={shown.length === 0} />
        {refreshable.length > 0 && (
          <Button size="sm" icon="refresh" loading={all} className={s.barEnd} onClick={() => void refreshAll()}>
            Refresh all
          </Button>
        )}
      </div>
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className={s.num}>
                Rows
              </th>
              <th scope="col">Source</th>
              <th scope="col">Data as of</th>
              <th scope="col" className={s.actions}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <Row
                key={d.id}
                projectId={projectId}
                d={d}
                tags={tagged(d)}
                outcome={refresh.state[d.id]}
                onRefresh={() => void refresh.run(d.id)}
                onDelete={() => remove(d)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
