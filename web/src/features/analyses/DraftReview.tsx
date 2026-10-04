// The AI draft (legacy anDraft.ts): a REVIEWED plan that lands on a dashboard.
// The model proposes structure only; the server validates the envelope and
// computed every figure in the previews. What the app REFUSED is shown first
// and never collapsed. Nothing is created until "Create dashboard".

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { setDockOpen } from '../assistant/dockState';
import { failure, type BuildReply, type DraftReply, type PlanPreview, type PreviewVisual } from './api';
import { DrawnVisual, vizLabel } from './VisualTile';
import s from './Draft.module.css';

/** What the app refused — rendered wherever a plan is shown (anDraftAppendDropped). */
export function Dropped({ list }: { list: PlanPreview['dropped'] }) {
  if (!list || !list.length) return null;
  return (
    <section className={s.section} aria-label="Dropped">
      <h3 className={s.sectionH}>
        {list.length} {list.length === 1 ? 'thing was' : 'things were'} dropped
      </h3>
      <p className={s.note}>The app refused these because it could not verify them. They are listed so the draft is not flattered by hiding its own mistakes.</p>
      <ul className={s.dropped}>
        {list.map((d, i) => (
          <li key={i} className={s.drop}>
            <Badge tone="warn">{d.kind || 'dropped'}</Badge>
            {d.where && <span className={s.where}>{d.where}</span>}
            <span>{d.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One previewed visual: the app's figures, or the reason there are none (never a placeholder number). */
export function PreviewCard({ v, projectId }: { v: PreviewVisual; projectId: string }) {
  const name = v.name || v.title || 'Visual';
  const type = v.chartType || 'column';
  return (
    <div className={s.visual}>
      <div className={s.visualHead}>
        <span className={s.visualTitle}>{name}</span>
        <span className={s.type}>{vizLabel(type)}</span>
      </div>
      {v.data ? (
        <div className={s.viz}>
          <DrawnVisual type={type} data={v.data} label={name} projectId={projectId} />
        </div>
      ) : (
        <p className={s.why}>{v.note || 'The app could not compute this one yet.'}</p>
      )}
    </div>
  );
}

function Review({ draft, projectId }: { draft: PlanPreview; projectId: string }) {
  const calcs = draft.calculatedFields ?? [];
  return (
    <div className={s.body}>
      <div className={s.title}>{draft.name || 'Assistant dashboard'}</div>
      {draft.rationale && draft.rationale.trim() && (
        <div className={s.interp}>
          <span className={s.interpH}>Why the model proposed this · AI interpretation</span>
          <p>{draft.rationale}</p>
        </div>
      )}
      <Dropped list={draft.dropped} />
      {calcs.length > 0 && (
        <section className={s.section} aria-label="Calculated fields">
          <h3 className={s.sectionH}>Calculated fields it will add</h3>
          {calcs.map((c, i) => (
            <div key={i} className={s.calc}>
              <span className={s.calcName}>{c.name || c.column || 'field'}</span>
              <code className={s.formula}>{c.formula || c.expression}</code>
            </div>
          ))}
        </section>
      )}
      {draft.sheets.map((sheet, si) => {
        const visuals = sheet.visuals ?? [];
        const cards = sheet.cards ?? [];
        return (
          <section key={si} className={s.section} aria-label={sheet.name || `Sheet ${si + 1}`}>
            <h3 className={s.sectionH}>{sheet.name || `Sheet ${si + 1}`}</h3>
            {visuals.length === 0 && cards.length === 0 && <p className={s.note}>Nothing survived on this sheet.</p>}
            {visuals.length === 0 && cards.length > 0 && <p className={s.note}>{cards.length === 1 ? '1 card' : `${cards.length} cards`}</p>}
            <div className={s.visuals}>
              {visuals.map((v, i) => (
                <PreviewCard key={i} v={v} projectId={projectId} />
              ))}
            </div>
          </section>
        );
      })}
      <p className={s.foot}>Every figure here was computed by the app, not written by the model. You can edit everything after it is created.</p>
    </div>
  );
}

/** Build an approved draft through the same `analysis:buildPlan` an Assistant proposal uses; the user's name wins. */
export async function buildDraft(projectId: string, draft: PlanPreview, preferredName?: string): Promise<string | null> {
  const name = (preferredName || '').trim();
  try {
    let id: string | undefined;
    if (draft.plan) {
      const r = (await rpc('analysis:buildPlan', { projectId, plan: name ? { ...draft.plan, name } : draft.plan })) as BuildReply;
      if (!r.ok) throw new Error(r.error);
      id = r.analysis.id;
    } else {
      // The older reply: a sheet array, created as it stands.
      const r = (await rpc('analysis:create', { projectId, name: name || draft.name || 'Assistant dashboard', sheets: draft.sheets })) as { id?: string; ok?: boolean; error?: string };
      if (r.ok === false || !r.id) throw new Error(r.error || 'The dashboard was not created.');
      id = r.id;
    }
    return id;
  } catch (err) {
    toast(failure(err, 'Failed to build the dashboard.'), { kind: 'error' });
    return null;
  }
}

/**
 * Draft → review → build → open. With `draft` given (the wizard already asked)
 * it opens on the review; otherwise it asks the model first, with no intent —
 * the list header's one-shot draft.
 */
export function DraftFlow({ projectId, draft: given, preferredName, onClose }: { projectId: string; draft?: PlanPreview; preferredName?: string; onClose: () => void }) {
  const [reply, setReply] = useState<DraftReply | null>(given ?? null);
  const [failed, setFailed] = useState('');
  const [building, setBuilding] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();

  useEffect(() => {
    if (given) return;
    let live = true;
    rpc('analysis:draft', { projectId }).then(
      (r) => live && setReply(r as DraftReply),
      (err: unknown) => live && setFailed(failure(err, 'Could not draft a dashboard.')),
    );
    return () => {
      live = false;
    };
  }, [given, projectId]);

  const create = async () => {
    if (!reply || !reply.ok) return;
    setBuilding(true);
    const id = await buildDraft(projectId, reply, preferredName);
    setBuilding(false);
    void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });
    if (id) {
      onClose();
      void navigate(`/analyses/${projectId}/${id}`);
    }
  };

  let body;
  let ready = false;
  if (failed) body = <ErrorState compact heading={3} title="Could not draft a dashboard" message={failed} />;
  else if (!reply) body = <SkeletonRows rows={6} label="The Assistant is drafting a dashboard" />;
  else if (!reply.ok && reply.notReady) {
    body = (
      <EmptyState
        compact
        heading={3}
        icon="sparkles"
        title="Connect a model to draft"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              setDockOpen(true);
            }}
          >
            Open the Assistant
          </Button>
        }
      >
        Drafting needs a model. Everything else — blank sheets, layouts and templates — works without one.
      </EmptyState>
    );
  } else if (!reply.ok) body = <ErrorState compact heading={3} title="Could not draft a dashboard" message={reply.error || 'Try again.'} />;
  else {
    ready = true;
    body = <Review draft={reply} projectId={projectId} />;
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Assistant draft — review before creating"
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">{ready ? 'Discard' : 'Close'}</Button>
          </DialogClose>
          {ready && (
            <Button variant="primary" loading={building} onClick={() => void create()}>
              Create dashboard
            </Button>
          )}
        </>
      }
    >
      {body}
    </Dialog>
  );
}
