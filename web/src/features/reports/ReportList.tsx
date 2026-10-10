// The Reports tab (reportList.ts): a card per report — the cover drawn small at
// the report's own paper aspect, the format, pages, schedule and last run — with
// Generate now (the one thing a list can finish on its own) and Edit. New
// reports start from a dashboard; its sheets become the default pages.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { EmptyState, ErrorState } from '../../app/blocks';
import { ago } from '../../app/when';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Menu } from '../../ui/Menu';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useGallery } from '../analyses/api';
import { useCanEdit } from '../projects/api';
import { toastMovedToTrash } from '../projects/trashToast';
import { failure, useReports, type Report, type ReportSummary } from './api';
import { generateReport } from './export/generate';
import { useGenerateHooks } from './export/useGenerate';
import s from './Reports.module.css';

const CADENCE: Record<string, string> = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };

function aspect(r: ReportSummary): string {
  if (r.format === 'pptx') return s.thumbDeck;
  const land = r.paper.orientation === 'landscape';
  return r.paper.size === 'a4' ? (land ? s.thumbA4Land : s.thumbA4) : land ? s.thumbLetterLand : s.thumbLetter;
}

function NewReport({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const q = useGallery(projectId);
  const navigate = useNavigate();
  const [busy, setBusy] = useState('');
  const create = async (analysisId: string) => {
    setBusy(analysisId);
    try {
      const r = (await rpc('reports:create', { projectId, analysisId })) as { ok: boolean; report?: Report; error?: string };
      if (!r.ok || !r.report) throw new Error(failure(r, 'Could not create the report.'));
      void navigate(`/reports/${projectId}/${r.report.id}`);
    } catch (err) {
      toast(failure(err, 'Could not create the report.'), { kind: 'error' });
      setBusy('');
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New report"
      description="Pick the dashboard to print. Its sheets become the report’s pages — a cover, a summary, a page per sheet and one per big chart."
      footer={
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
      }
    >
      {q.isPending ? (
        <div className={s.pickList} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className={s.pickSkeleton} />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState compact heading={3} title="Dashboards could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState compact heading={3} icon="layout-dashboard" title="No dashboards yet" actions={<Link to={`/analyses?project=${projectId}`}>Create a dashboard</Link>}>
          A report prints a dashboard. Build one first.
        </EmptyState>
      ) : (
        <ul className={s.pickList} aria-label="Dashboards">
          {q.data.map((d) => (
            <li key={d.id}>
              <button type="button" className={s.pickRow} disabled={!!busy} onClick={() => void create(d.id)}>
                <Icon name="layout-dashboard" />
                <span className={s.pickName}>{d.name || 'Untitled dashboard'}</span>
                <span className={s.pickMeta}>{d.sheetCount === 1 ? '1 sheet' : `${d.sheetCount} sheets`}</span>
                {busy === d.id && <span className={s.pickMeta}>Creating…</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function ReportCard({ projectId, r, onGenerate, busy, canEdit }: { projectId: string; r: ReportSummary; onGenerate: () => void; busy: boolean; canEdit: boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const open = `/reports/${projectId}/${r.id}`;
  const refresh = () => void client.invalidateQueries({ queryKey: ['reports:list', projectId] });
  const duplicate = async () => {
    const res = (await rpc('reports:duplicate', { projectId, id: r.id }).catch((e: unknown) => e)) as { ok?: boolean; error?: string };
    if (!res || res.ok === false || res instanceof Error) toast(failure(res, 'Could not duplicate.'), { kind: 'error' });
    refresh();
  };
  const remove = async () => {
    const res = (await rpc('reports:delete', { projectId, id: r.id }).catch(() => null)) as { ok?: boolean } | null;
    toastMovedToTrash(client, { projectId, type: 'report', id: r.id, name: r.name }, res);
    refresh();
  };
  const cadence = r.schedule && CADENCE[r.schedule.cadence];
  return (
    <li className={s.card} data-report-id={r.id}>
      <Link to={open} className={s.cardLink} aria-label={`Edit ${r.name}`}>
        <span className={s.band}>
          <span className={`${s.thumb} ${aspect(r)}`} aria-hidden="true">
            <img className={s.thumbMark} src="/favicon.svg" alt="" />
            <span className={s.thumbTitle}>{r.cover.title || r.name}</span>
            <span className={s.thumbLines}>
              <span />
              <span />
              <span />
            </span>
          </span>
          <span className={s.badge}>{r.format.toUpperCase()}</span>
        </span>
      </Link>
      <div className={s.cardBody}>
        <h3 className={s.cardName}>{r.name}</h3>
        <p className={s.cardLine}>{r.pageCount === 1 ? '1 page' : `${r.pageCount} pages`}</p>
        <p className={s.cardLine}>{cadence ? `${cadence} at ${r.schedule?.at}` : 'No schedule'}</p>
        <p className={s.cardLine}>{r.lastRunAt ? `Last generated ${ago(r.lastRunAt)}` : 'Never generated'}</p>
      </div>
      <div className={s.cardActions}>
        <Button size="sm" variant="primary" icon="download" onClick={onGenerate} loading={busy}>
          Generate now
        </Button>
        {canEdit && (
          <Button size="sm" icon="pencil" onClick={() => void navigate(open)}>
            Edit
          </Button>
        )}
        <Menu
          label={`${r.name} options`}
          align="end"
          trigger={<IconButton icon="more-horizontal" label="Report options" size="sm" />}
          items={[
            { label: 'History', icon: 'history', onSelect: () => void navigate(`/versions/${projectId}/report/${r.id}`) },
            ...(canEdit
              ? [{ label: 'Duplicate', icon: 'copy' as const, onSelect: () => void duplicate() }, { kind: 'separator' as const }, { label: 'Delete', icon: 'trash' as const, danger: true, onSelect: () => void remove() }]
              : []),
          ]}
        />
      </div>
    </li>
  );
}

export function ReportList({ projectId }: { projectId: string }) {
  const q = useReports(projectId);
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState('');
  // Creating, editing, duplicating and deleting a report are an editor's; anyone may generate the file.
  const canEdit = useCanEdit(projectId);
  const { hooks, dialog } = useGenerateHooks();
  const generate = async (r: ReportSummary) => {
    setBusy(r.id);
    toast('Building the report…');
    const out = await generateReport(projectId, r.id, r, hooks, canEdit);
    setBusy('');
    if (out.ok) toast(`Downloaded ${out.filename}`, { kind: 'success' });
    else if (!out.cancelled) toast(out.error || 'Couldn’t build the report.', { kind: 'error' });
    void client.invalidateQueries({ queryKey: ['reports:list', projectId] });
  };

  let body;
  if (q.isPending) {
    body = (
      <ul className={s.grid} aria-busy="true" aria-label="Loading reports">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className={s.card} aria-hidden="true">
            <Skeleton className={s.skBand} />
            <Skeleton className={s.skLine} />
            <Skeleton className={s.skMeta} />
          </li>
        ))}
      </ul>
    );
  } else if (q.isError) {
    body = <ErrorState title="Reports could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  } else if (!q.data.length) {
    body = (
      <EmptyState
        icon="file-text"
        title="No reports yet"
        actions={
          canEdit && (
            <Button variant="primary" size="lg" icon="plus" onClick={() => setCreating(true)}>
              New report
            </Button>
          )
        }
      >
        A report turns a dashboard into a file you can send: a cover, a summary of what the figures say, a page per sheet and chart. Every number in it is
        one the app computed; the captions say what changed in words.{!canEdit && ' An editor of this project can create one. You have view-only access.'}
      </EmptyState>
    );
  } else {
    body = (
      <ul className={s.grid} aria-label="Reports">
        {q.data.map((r) => (
          <ReportCard key={r.id} projectId={projectId} r={r} busy={busy === r.id} canEdit={canEdit} onGenerate={() => void generate(r)} />
        ))}
      </ul>
    );
  }
  return (
    <div className={s.tab}>
      {!!q.data?.length && (
        <div className={s.bar}>
          <span className={s.count}>{q.data.length === 1 ? '1 report' : `${q.data.length} reports`}</span>
          {canEdit && (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New report
            </Button>
          )}
        </div>
      )}
      {body}
      {creating && <NewReport projectId={projectId} onClose={() => setCreating(false)} />}
      {dialog}
    </div>
  );
}
