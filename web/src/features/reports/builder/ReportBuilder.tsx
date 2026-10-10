// /reports/:projectId/:reportId — the report builder (reportBuilder.ts): the
// page list, the live preview at true page size, the settings. The preview is
// ONE page — the server resolves it under the dashboard's saved scope with the
// unsaved settings over it (`report:preview`), the browser draws its charts in
// the print theme — so what is on screen is what the file will say. Generate
// saves first, then builds the whole file (export/generate.ts).

import { useEffect, useMemo, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { ErrorState, PageSkeleton } from '../../../app/blocks';
import { Badge } from '../../../ui/Badge';
import { Button, buttonClass } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { Dialog } from '../../../ui/Dialog';
import { Textarea } from '../../../ui/Field';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { useCanEdit } from '../../projects/api';
import { useAdoptProject } from '../../projects/current';
import { failure, useOpenReport, type OpenReport, type PagesReply, type Report } from '../api';
import { materialize } from '../export/materialize';
import { generateReport } from '../export/generate';
import { useGenerateHooks } from '../export/useGenerate';
import { addPage, draftOf, withCaption, withSettings } from './model';
import { PageList } from './PageList';
import { PreviewSheet } from './PreviewSheet';
import { SettingsPane } from './SettingsPane';
import s from './Builder.module.css';

const FORMAT_WORD = { pdf: 'PDF', pptx: 'PowerPoint', docx: 'Word' } as const;

/** A value that settles `ms` after it stops changing — keeps typing off the preview path. */
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Builder({ projectId, opened }: { projectId: string; opened: OpenReport }) {
  const client = useQueryClient();
  const [report, setReport] = useState<Report>(opened.report);
  const [selected, setSelected] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'' | 'save' | 'generate'>('');
  const [appCaption, setAppCaption] = useState('');
  const { hooks, dialog } = useGenerateHooks();
  // A viewer may look and generate the file as saved; Save is an editor's.
  const canEdit = useCanEdit(projectId);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  const edit = (next: Report, sel = selected) => {
    setReport(next);
    setSelected(Math.max(0, Math.min(sel, next.pages.length - 1)));
    setDirty(true);
  };
  const page = report.pages[selected];
  const settled = useSettled(report, 450);
  const settledDraft = useMemo(() => draftOf(settled), [settled]);
  const preview = useQuery({
    queryKey: ['report:preview', projectId, report.id, selected, settledDraft],
    queryFn: async () => {
      const r = (await rpc('report:preview', { projectId, id: report.id, draft: settledDraft, page: selected })) as PagesReply & { date?: string };
      if (!r.ok) throw new Error(r.error);
      const raw = r.pages[0] ?? null;
      const ready = raw ? (await materialize([raw], settled, projectId))[0] : null;
      return { raw, ready, date: r.date || '' };
    },
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
  // The app's own sentence is only visible when the page has no override — keep the last one seen.
  const raw = preview.data?.raw;
  useEffect(() => {
    if (raw && page && !page.caption) setAppCaption(raw.caption || '');
  }, [raw, page]);

  const save = async (): Promise<boolean> => {
    setBusy('save');
    try {
      const r = (await rpc('reports:update', { projectId, id: report.id, patch: draftOf(report) })) as { ok: boolean; report?: Report; error?: string };
      if (!r.ok || !r.report) {
        toast(failure(r, 'Could not save.'), { kind: 'error' });
        return false;
      }
      // Take the server's sanitized copy back, so the two never drift.
      setReport(r.report);
      setDirty(false);
      void client.invalidateQueries({ queryKey: ['reports:list', projectId] });
      return true;
    } catch (err) {
      toast(failure(err, 'Could not save.'), { kind: 'error' });
      return false;
    } finally {
      setBusy('');
    }
  };
  const generate = async () => {
    if (dirty && canEdit && !(await save())) return;
    setBusy('generate');
    toast('Building the report…');
    const out = await generateReport(projectId, report.id, report, hooks, canEdit);
    setBusy('');
    if (out.ok) {
      toast(`Downloaded ${out.filename}`, { kind: 'success' });
      void client.invalidateQueries({ queryKey: ['reports:list', projectId] });
    } else if (!out.cancelled) toast(out.error || 'Couldn’t build the report.', { kind: 'error' });
  };

  const captionable = page && page.kind !== 'notes' && raw && (raw.kind === 'tile' || raw.kind === 'sheet' || raw.kind === 'summary');
  return (
    <div className={s.builder}>
      <header className={s.head}>
        <Link className={buttonClass('ghost', 'sm')} to={`/reports?project=${projectId}`}>
          <Icon name="arrow-left" />
          <span>Reports</span>
        </Link>
        <div className={s.ident}>
          <h1 className={s.name}>{report.name}</h1>
          <span className={s.of}>{opened.dashboard ? `From “${opened.dashboard.name}”` : report.scorecardId ? 'From a scorecard' : 'Its dashboard was deleted'}</span>
        </div>
        {dirty && <Badge tone="warn">Unsaved</Badge>}
        <div className={s.headActions}>
          <Link className={s.link} to={`/versions/${projectId}/report/${report.id}`}>
            History
          </Link>
          {canEdit && (
            <Button onClick={() => void save().then((ok) => ok && toast('Report saved', { kind: 'success' }))} loading={busy === 'save'} disabled={!dirty || !!busy}>
              Save
            </Button>
          )}
          <Button variant="primary" icon="download" onClick={() => void generate()} loading={busy === 'generate'} disabled={!!busy}>
            Generate {FORMAT_WORD[report.format]}
          </Button>
        </div>
      </header>
      {opened.missing && !report.scorecardId && (
        <p className={s.banner} role="status">
          The dashboard this report prints has been deleted. Its pages are kept; only Notes pages still have something to print.
        </p>
      )}
      <div className={s.panes}>
        <PageList
          pages={report.pages}
          selected={selected}
          sheets={opened.sheets}
          onSelect={setSelected}
          onChange={(pages, sel) => edit({ ...report, pages }, sel ?? selected)}
          onAdd={(kind, cardId) => edit({ ...report, pages: addPage(report.pages, kind, cardId) }, report.pages.length)}
        />
        <section className={s.center} aria-label="Preview">
          {preview.isError ? (
            <ErrorState title="This page could not be resolved" message={preview.error.message} onRetry={() => void preview.refetch()} />
          ) : preview.isPending ? (
            <div className={s.stage} aria-busy="true">
              <Skeleton className={s.sheetSkeleton} />
            </div>
          ) : (
            <div className={preview.isFetching ? `${s.previewWrap} ${s.refreshing}` : s.previewWrap} aria-busy={preview.isFetching}>
              <PreviewSheet page={preview.data.ready} setup={report} date={preview.data.date} />
            </div>
          )}
          {page?.kind === 'notes' && (
            <div className={s.editRow}>
              <Textarea
                label="Notes"
                value={page.notes || ''}
                rows={4}
                maxLength={20_000}
                onChange={(e) => edit({ ...report, pages: report.pages.map((p, i) => (i === selected ? { ...p, notes: e.target.value } : p)) })}
              />
            </div>
          )}
          {captionable && (
            <div className={s.editRow}>
              <Textarea
                label="Caption"
                hint={page.caption ? 'Your words replace the app’s sentence.' : 'The app’s sentence follows the data; type to replace it.'}
                value={page.caption || appCaption}
                rows={2}
                maxLength={400}
                onChange={(e) => edit({ ...report, pages: report.pages.map((p, i) => (i === selected ? withCaption(p, e.target.value, appCaption) : p)) })}
              />
              {page.caption && (
                <Button size="sm" variant="ghost" icon="rotate-ccw" onClick={() => edit({ ...report, pages: report.pages.map((p, i) => (i === selected ? withCaption(p, '', appCaption) : p)) })}>
                  Reset to the app’s caption
                </Button>
              )}
            </div>
          )}
        </section>
        <SettingsPane report={report} views={opened.views} onChange={(patch) => edit(withSettings(report, patch))} />
      </div>
      {dialog}
      <Dialog
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => !o && blocker.reset?.()}
        size="sm"
        title="Discard unsaved changes?"
        description="This report has changes that are not saved."
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              Discard
            </Button>
          </>
        }
      />
    </div>
  );
}

export default function ReportBuilderPage() {
  const { projectId = '', reportId = '' } = useParams();
  useAdoptProject(projectId);
  const q = useOpenReport(projectId, reportId);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError || !q.data.ok) {
    return (
      <div className={s.builder}>
        <ErrorState title="That report could not be opened" message={q.isError ? q.error.message : q.data.ok ? '' : q.data.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  return <Builder key={reportId} projectId={projectId} opened={q.data} />;
}
