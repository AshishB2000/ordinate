// The Trash (legacy trashPage.ts): every delete in a project is a MOVE here
// (src/app/trash.ts); a record waits 30 days — the server's tick purges it
// after that — and Restore puts it back exactly where it was. Delete
// permanently and Empty trash are the project admin's; Restore needs editor.
// "Days left" is the server's figure.

import { useState } from 'react';
import { Page } from '../../app/blocks';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { PageSkeleton, SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { fmtWhen, plural, useCan, useChange, useTrash, type RecordType, type Restored, type TrashItem } from './api';
import { restoredLine } from './trashToast';
import { useCurrentProject } from './current';
import s from './Trash.module.css';

const TYPE: Record<RecordType, { word: string; icon: IconName }> = {
  dataset: { word: 'Dataset', icon: 'database' },
  visual: { word: 'Visual', icon: 'chart-bar' },
  dashboard: { word: 'Dashboard', icon: 'layout-dashboard' },
  metric: { word: 'Metric', icon: 'gauge' },
  report: { word: 'Report', icon: 'file-text' },
  alert: { word: 'Alert', icon: 'bell' },
};

type Ask = { kind: 'purge'; item: TrashItem } | { kind: 'empty' } | null;

export default function TrashPage() {
  const cur = useCurrentProject();
  if (cur.status === 'pending') return <PageSkeleton />;
  if (cur.status === 'error') {
    return (
      <Page title="Trash">
        <ErrorState title="Projects could not be loaded" message={cur.error?.message ?? ''} onRetry={cur.refetch} />
      </Page>
    );
  }
  if (!cur.projectId) {
    return (
      <Page title="Trash">
        <EmptyState icon="folder" title="No project open">
          The Trash belongs to a project. Pick or create one from the project switcher at the top left.
        </EmptyState>
      </Page>
    );
  }
  return <Trash projectId={cur.projectId} projectName={cur.project?.name ?? ''} />;
}

function Trash({ projectId, projectName }: { projectId: string; projectName: string }) {
  const trash = useTrash(projectId);
  const can = useCan(projectId);
  const [ask, setAsk] = useState<Ask>(null);
  const refresh = ['trash:list', 'projects:overview', 'dataset:list'];
  const restore = useChange<'trash:restore', { ok: boolean; error?: string; restored: Restored[] }>('trash:restore', refresh, (r) =>
    r.ok ? toast(restoredLine(r.restored), { kind: 'success' }) : toast(r.error ?? 'Could not restore that.', { kind: 'error' }),
  );
  const purge = useChange<'trash:purge', { ok: boolean }>('trash:purge', refresh, (r, input) => {
    setAsk(null);
    if (r.ok) toast(`Deleted “${trash.data?.find((i) => i.id === input.id)?.name ?? 'it'}” for good.`);
  });
  const empty = useChange<'trash:empty', { ok: boolean; removed: number }>('trash:empty', refresh, () => {
    setAsk(null);
    toast('Trash emptied.');
  });
  const items = trash.data ?? [];

  let body;
  if (trash.isPending) body = <SkeletonTable cols={5} rows={4} label="Loading the Trash" />;
  else if (trash.isError) {
    body = <ErrorState heading={3} title="The Trash could not be loaded" message={trash.error.message} onRetry={() => void trash.refetch()} />;
  } else if (items.length === 0) {
    body = (
      <EmptyState heading={3} icon="trash" title="Trash is empty">
        Anything you delete — a dataset, a visual, a dashboard, a metric, a report or an alert — waits here for 30 days, and can be put back
        exactly where it was.
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className={s.typeCol}>
                Type
              </th>
              <th scope="col">Deleted</th>
              <th scope="col">Kept for</th>
              <th scope="col" className={s.actions}>
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const tv = TYPE[it.type] ?? { word: 'Record', icon: 'file-text' as const };
              const parent = it.deletedWith ? items.find((x) => x.id === it.deletedWith) : undefined;
              return (
                <tr key={`${it.type}:${it.id}`}>
                  <td>
                    <span className={s.nameCell}>
                      <span className={s.tile} data-type={it.type} aria-hidden="true">
                        <Icon name={tv.icon} />
                      </span>
                      <span className={s.nameText}>
                        <span className={s.name}>{it.name || 'Untitled'}</span>
                        {it.deletedWith && <span className={s.sub}>{parent ? `Deleted with “${parent.name}”` : 'Deleted with its dataset'}</span>}
                      </span>
                    </span>
                  </td>
                  <td className={`${s.meta} ${s.typeCol}`}>{tv.word}</td>
                  <td className={s.meta}>{fmtWhen(it.deletedAt)}</td>
                  <td>
                    <span className={`${s.left} ${it.daysLeft <= 3 ? s.soon : ''}`}>
                      {it.daysLeft === 0 ? 'Removed today' : `${plural(it.daysLeft, 'day')} left`}
                    </span>
                  </td>
                  <td className={s.actions}>
                    {can('editor') && (
                      <Button
                        size="sm"
                        icon="rotate-ccw"
                        aria-label={`Restore ${it.name}`}
                        loading={restore.isPending && restore.variables?.id === it.id}
                        onClick={() => restore.mutate({ projectId, type: it.type, id: it.id })}
                      >
                        Restore
                      </Button>
                    )}
                    {can('admin') && (
                      <Button size="sm" variant="ghost" className={s.purge} aria-label={`Delete ${it.name} permanently`} onClick={() => setAsk({ kind: 'purge', item: it })}>
                        Delete permanently
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <Page title="Trash" sub="Deleted items stay here for 30 days, then they are removed for good. Restore puts one back exactly where it was.">
      <div className={s.bar}>
        <span className={s.project}>
          <Icon name="folder" size={16} />
          {projectName}
          {items.length > 0 && <span className={s.count}>{plural(items.length, 'item')}</span>}
        </span>
        {can('admin') && (
          <Button icon="trash" className={s.emptyBtn} disabled={items.length === 0} onClick={() => setAsk({ kind: 'empty' })}>
            Empty trash
          </Button>
        )}
      </div>
      {body}
      {ask?.kind === 'purge' && (
        <Dialog
          open
          size="sm"
          onOpenChange={(o) => !o && setAsk(null)}
          title={`Delete “${ask.item.name}” permanently?`}
          description={`This ${(TYPE[ask.item.type]?.word ?? 'record').toLowerCase()} and its version history are removed for good. This cannot be undone.`}
          footer={
            <>
              <DialogClose asChild>
                <Button>Keep it</Button>
              </DialogClose>
              <Button variant="danger" loading={purge.isPending} onClick={() => purge.mutate({ projectId, type: ask.item.type, id: ask.item.id })}>
                Delete permanently
              </Button>
            </>
          }
        />
      )}
      {ask?.kind === 'empty' && (
        <Dialog
          open
          size="sm"
          onOpenChange={(o) => !o && setAsk(null)}
          title="Empty the Trash?"
          description={`${plural(items.length, 'item')} ${items.length === 1 ? 'is' : 'are'} removed for good, with ${items.length === 1 ? 'its' : 'their'} version history. This cannot be undone.`}
          footer={
            <>
              <DialogClose asChild>
                <Button>Keep them</Button>
              </DialogClose>
              <Button variant="danger" loading={empty.isPending} onClick={() => empty.mutate({ projectId })}>
                Empty trash
              </Button>
            </>
          }
        />
      )}
    </Page>
  );
}
