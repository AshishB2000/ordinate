// The Datasets tab (dsList.ts): one row per saved dataset — name (with the
// red quality dot and its tags), rows, source, "Data as of" with the refresh
// schedule and the anomaly watch, and the row's actions. A failed refresh
// leaves the stored table as it was; its reason stays on the row. With shared
// folders (docs/team-folders) the folder rail sits beside it, and a row moves
// by Move to… or by dragging it onto the rail.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useDatasets, type AutoRefreshEvery, type DatasetSummary } from '../../api/datasets';
import { useCanEdit } from '../projects/api';
import { toastMovedToTrash } from '../projects/trashToast';
import { Button, buttonClass, IconButton } from '../../ui/Button';
import { ConfirmDelete } from '../../ui/ConfirmDelete';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useTags, useWrite } from './api';
import { freshness, fromControl, NOT_REFRESHABLE, rowsOf, SCHEDULES, sourceLabel } from './format';
import { BehindBadge, cadenceOptions } from './cadence';
import { TagChips, TagFilterBar, tagsOf, useActiveTag } from './tags';
import { FolderEmpty, FolderLayout, FolderTag, useFolderView, type FolderView } from '../folders/FolderView';
import { dragItem } from '../folders/FolderRail';
import s from './Data.module.css';

type Outcome = { busy?: boolean; message?: string; error?: boolean };
type RefreshReply = { ok: boolean; error?: string; warnings?: string[]; alreadyRunning?: boolean; live?: { epoch: number } };

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
 * A delete is a move to the Trash, taking the dataset's visuals with it. It
 * asks first; the toast still carries Undo (T2.2's trashToast, `trash:restore`).
 * Render `dialog` wherever `ask` is called.
 */
export function useDeleteDataset(projectId: string, then?: () => void) {
  const client = useQueryClient();
  const [doomed, setDoomed] = useState<DatasetSummary | null>(null);
  const del = useWrite('dataset:delete', ['dataset:list', 'catalog:list', 'relationship:list', 'trash:list'], { quiet: true });
  const run = (d: DatasetSummary) =>
    del.mutate(
      { projectId, id: d.id },
      {
        onSuccess: (r) => {
          toastMovedToTrash(client, { projectId, type: 'dataset', id: d.id, name: d.name }, r as { ok?: boolean; cascaded?: number });
          if ((r as { ok?: boolean }).ok) then?.();
        },
      },
    );
  const dialog = doomed && (
    <ConfirmDelete
      title={`Delete “${doomed.name}”?`}
      description="It moves to the Trash for 30 days, with every visual built on it. Restore it from there if you change your mind."
      onConfirm={() => {
        setDoomed(null);
        run(doomed);
      }}
      onClose={() => setDoomed(null)}
    />
  );
  return { ask: setDoomed, dialog };
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
    // A Live dataset fetches nothing: its refresh resets the cache (L2.6), and says so.
    const message = r.ok ? (r.live ? 'Cache reset. The next figure asks the warehouse.' : (r.warnings ?? []).join(' · ')) : r.error || 'Could not refresh this dataset.';
    setState((m) => ({ ...m, [id]: { message, error: !r.ok && !r.alreadyRunning } }));
    return r.ok || r.alreadyRunning === true;
  };
  return { state, run };
}

/** Import into the folder picked in the rail, when the caller adds to it. */
export const importHref = (projectId: string, folder: string | undefined, more = '') => `/data/import?project=${projectId}${more}${folder ? `&folder=${folder}` : ''}`;

function Row({ projectId, d, outcome, onRefresh, onDelete, tags, canEdit, view }: {
  projectId: string;
  view: FolderView;
  /** An editor's row: the schedule, Refresh, New visual, Combine and Trash. A viewer's row opens the dataset. */
  canEdit: boolean;
  d: DatasetSummary;
  outcome: Outcome | undefined;
  onRefresh: () => void;
  onDelete: () => void;
  tags: ReturnType<typeof tagsOf>;
}) {
  const navigate = useNavigate();
  const href = `/data/${projectId}/${d.id}`;
  const failedHint = d.lastRefreshStatus === 'error' ? d.lastRefreshError || 'The last refresh failed.' : undefined;
  const movable = view.canMove(d.id);
  const item = { kind: 'dataset' as const, id: d.id, name: d.name };
  return (
    <tr className={s.clickRow} onClick={(e) => !fromControl(e.target) && void navigate(href)} draggable={movable || undefined} onDragStart={movable ? (e) => dragItem(e, item) : undefined}>
      <td>
        <span className={s.nameCell}>
          <QualityDot n={d.qualityFailing} />
          <Link className={s.nameLink} to={href}>
            {d.name}
          </Link>
          <FolderTag view={view} id={d.id} />
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
          {canEdit && (
            <span className={s.freshTools}>
              <SchedulePicker projectId={projectId} d={d} />
              <WatchToggle projectId={projectId} d={d} />
            </span>
          )}
        </span>
        {outcome?.message && (
          <span className={outcome.error ? s.rowError : s.rowNote} role="status">
            {outcome.message}
          </span>
        )}
      </td>
      <td className={s.actions}>
        {canEdit && (
          <span className={s.rowActions}>
            {d.originKind && (
              <Button size="sm" icon="refresh" loading={outcome?.busy} aria-label={`Refresh ${d.name}`} onClick={onRefresh}>
                Refresh
              </Button>
            )}
            <Link className={buttonClass('secondary', 'sm', s.hoverAction)} to={`/visuals?project=${projectId}&datasetId=${d.id}`} title="Build a chart from this dataset">
              New visual
            </Link>
            {/* Joins need the rows here: a Live dataset is combined through a copy (L2.6). */}
            {d.mode !== 'live' && (
              <Link className={buttonClass('secondary', 'sm', s.hoverAction)} to={`/data/import?project=${projectId}&source=combine`} title="Combine this dataset with another">
                Combine
              </Link>
            )}
            {movable && <IconButton icon="folder" size="sm" label={`Move ${d.name} to another folder`} onClick={() => view.move([item])} />}
            <IconButton icon="trash" size="sm" label={`Move ${d.name} to the Trash`} onClick={onDelete} />
          </span>
        )}
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
  const canEdit = useCanEdit(projectId);
  const view = useFolderView(projectId, 'dataset');

  if (q.isPending) return <SkeletonRows rows={6} label="Loading datasets" />;
  if (q.isError) return <ErrorState heading={3} title="Datasets could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const ids = q.data.map((d) => d.id);
  if (q.data.length === 0 && !view.selected) {
    return (
      <FolderLayout view={view} ids={ids} allLabel="All datasets">
        <EmptyState
          icon="database"
          heading={3}
          title="No datasets yet"
          actions={
            canEdit && (
              <>
                <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
                  Import file
                </Link>
                <Link className={buttonClass('secondary')} to={`/connections/${projectId}`}>
                  <Icon name="plug" />
                  <span>Connect a database</span>
                </Link>
                <Link className={buttonClass('ghost')} to={`/data/import?project=${projectId}&source=paste`}>
                  Paste data
                </Link>
              </>
            )
          }
        >
          {canEdit
            ? 'Import a CSV, JSON or Excel file, paste data straight in, or connect a database, warehouse or app. Each saves a structured dataset in this project.'
            : 'An editor of this project can import a file, paste data in or connect a database. You have view-only access.'}
        </EmptyState>
      </FolderLayout>
    );
  }
  const tagged = (d: DatasetSummary) => tagsOf(tags.data, `dataset:${d.id}`);
  const present = [...new Set(q.data.flatMap((d) => tagged(d).map((t) => t.name)))];
  const inFolder = view.filter(q.data, (d) => d.id);
  const shown = tag ? inFolder.filter((d) => tagged(d).some((t) => t.name === tag)) : inFolder;
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

  if (view.selected && inFolder.length === 0) {
    return (
      <FolderLayout view={view} ids={ids} allLabel="All datasets">
        <FolderEmpty
          view={view}
          noun="dataset"
          actions={
            canEdit && (
              <Link className={buttonClass('primary')} to={importHref(projectId, view.landing)}>
                Import into this folder
              </Link>
            )
          }
        />
      </FolderLayout>
    );
  }

  return (
    <FolderLayout view={view} ids={ids} allLabel="All datasets">
      <section className={s.section} aria-label="Datasets">
        <div className={s.listBar}>
          <TagFilterBar present={present} index={tags.data} active={tag} onPick={setTag} empty={shown.length === 0} />
          {canEdit && refreshable.length > 0 && (
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
                  canEdit={canEdit}
                  view={view}
                  d={d}
                  tags={tagged(d)}
                  outcome={refresh.state[d.id]}
                  onRefresh={() => void refresh.run(d.id)}
                  onDelete={() => remove.ask(d)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {remove.dialog}
      </section>
    </FolderLayout>
  );
}
