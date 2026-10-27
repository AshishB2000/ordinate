// The AI draft (legacy anDraft.ts): a REVIEWED plan that lands on a dashboard.
// The model proposes structure only; the server validates the envelope and
// computed every figure in the previews. What the app REFUSED is shown first
// and never collapsed. Nothing is created until "Create dashboard".
//
// It ASKS FIRST. The brief — what kind, which look (DraftBrief.tsx) — then, if
// the model has questions about the request, those (DraftClarify.tsx), once;
// then the review.

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
import { failure, type Analysis, type BuildReply, type DraftAnswer, type DraftReply, type LookId, type PlanPreview, type PreviewVisual } from './api';
import { DEFAULT_BRIEF, DraftBrief, type Brief } from './DraftBrief';
import { DraftClarify } from './DraftClarify';
import { PlanSketch } from './PlanSketch';
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
        {v.chartType && <span className={s.type}>{vizLabel(v.chartType)}</span>}
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

/** The drafted plan as the app will build it. */
export function Review({ draft, projectId }: { draft: PlanPreview; projectId: string }) {
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
            <PlanSketch layout={sheet.layout} />
            {/* KPIs and notes are tiles too: a sheet the sketch draws is not an empty one. */}
            {visuals.length === 0 && cards.length === 0 && !sheet.layout?.length && <p className={s.note}>Nothing survived on this sheet.</p>}
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

/**
 * Build an approved draft through the same `analysis:buildPlan` an Assistant proposal uses; the user's name wins.
 * `look` is the brief's: a preset id the server applies, or none for the workspace's default.
 */
export async function buildDraft(projectId: string, draft: PlanPreview, preferredName?: string, look?: LookId | ''): Promise<string | null> {
  const name = (preferredName || '').trim();
  try {
    let id: string | undefined;
    if (draft.plan) {
      const r = (await rpc('analysis:buildPlan', { projectId, plan: name ? { ...draft.plan, name } : draft.plan, ...(look ? { style: look } : {}) })) as BuildReply;
      if (!r.ok) throw new Error(r.error);
      id = (r.analysis as Analysis | undefined)?.id; // a reply is data: guard the shape, not the type
      // Built, but the reply named no dashboard: say where to look rather than claim a failure (anBuildDraft).
      if (!id) {
        toast('The dashboard was built but not opened — find it in the list.');
        return null;
      }
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
 * Brief → (questions) → review → build → open. Every draft ask goes through
 * here: the list header's one-shot draft (no intent), the Assistant's proposal
 * (`intent`, and the dataset on screen), and the wizard — which shows the brief
 * in its own step and hands it over as `brief`, so this skips that screen.
 *
 * The draft is asked with `clarify`, so the model may answer with questions
 * instead of a plan. The answers go back with the same ask — `[]` for "Skip" —
 * and a call that carries answers is never answered with questions (the server
 * holds that; a reply that breaks it is shown as an error, not as a second round).
 */
export function DraftFlow({
  projectId,
  datasetId,
  intent,
  preferredName,
  brief: given,
  onClose,
}: {
  projectId: string;
  datasetId?: string;
  intent?: string;
  preferredName?: string;
  brief?: Brief;
  onClose: () => void;
}) {
  const [brief, setBrief] = useState<Brief>(given ?? DEFAULT_BRIEF);
  const [briefed, setBriefed] = useState(!!given);
  /** What the user answered — `[]` once they skipped; undefined until either. */
  const [answers, setAnswers] = useState<DraftAnswer[]>();
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [reply, setReply] = useState<DraftReply | null>(null);
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [building, setBuilding] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();

  const kind = brief.kind;
  useEffect(() => {
    if (!briefed) return;
    let live = true;
    rpc('analysis:draft', { projectId, ...(datasetId ? { datasetId } : {}), ...(intent ? { intent } : {}), kind, clarify: true, ...(answers ? { answers } : {}) }).then(
      (r) => live && setReply(r as DraftReply),
      (err: unknown) => live && setFailed(failure(err, 'Could not draft a dashboard.')),
    );
    return () => {
      live = false;
    };
  }, [briefed, projectId, datasetId, intent, kind, answers, attempt]);
  // Ask again after a failure, exactly as that ask was made.
  const retry = () => {
    setFailed('');
    setReply(null);
    setAttempt((n) => n + 1);
  };
  const answer = (list: DraftAnswer[]) => {
    setReply(null);
    setAnswers(list);
  };

  const create = async () => {
    if (!reply || !reply.ok || 'questions' in reply) return;
    setBuilding(true);
    const id = await buildDraft(projectId, reply, preferredName, brief.look);
    setBuilding(false);
    void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });
    if (id) {
      onClose();
      void navigate(`/analyses/${projectId}/${id}`);
    }
  };

  const refused = (message: string) => <ErrorState compact heading={3} title="Could not draft a dashboard" message={message} onRetry={retry} />;
  let title = 'Assistant draft — review before creating';
  let description: string | undefined;
  let body;
  let close = 'Close';
  let actions;
  if (!briefed) {
    title = 'Draft a dashboard';
    description = 'Two choices first. The Assistant then drafts it, and you review everything before it is created.';
    body = <DraftBrief value={brief} onChange={setBrief} />;
    close = 'Cancel';
    actions = (
      <Button variant="primary" icon="sparkles" onClick={() => setBriefed(true)}>
        Draft dashboard
      </Button>
    );
  } else if (failed) body = refused(failed);
  else if (!reply) {
    // The first call may come back as questions, so it is not yet "drafting".
    const doing = answers ? 'The Assistant is drafting your dashboard' : 'The Assistant is planning your dashboard';
    description = `${doing}. This can take a moment.`;
    body = <SkeletonRows rows={6} label={doing} />;
  } else if (!reply.ok && reply.notReady) {
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
  } else if (!reply.ok) body = refused(reply.error || 'Try again.');
  else if ('questions' in reply) {
    const questions = reply.questions;
    // Questions are asked once. After the answers — or with none to show — a reply of them is a failed draft.
    if (answers || !Array.isArray(questions) || !questions.length) body = refused('The Assistant asked again instead of drafting. Try again.');
    else {
      title = 'A few questions first';
      description = 'The Assistant asks once, then drafts. You review everything before it is created.';
      body = <DraftClarify questions={questions} picked={picked} onPick={(i, option) => setPicked((p) => ({ ...p, [i]: option }))} />;
      const chosen = questions.flatMap((q, i) => (picked[i] ? [{ ask: q.ask, answer: picked[i] }] : []));
      actions = (
        <>
          <Button onClick={() => answer([])}>Skip — just build it</Button>
          <Button variant="primary" disabled={!chosen.length} onClick={() => answer(chosen)}>
            Continue
          </Button>
        </>
      );
    }
  } else {
    body = <Review draft={reply} projectId={projectId} />;
    close = 'Discard';
    actions = (
      <Button variant="primary" loading={building} autoFocus onClick={() => void create()}>
        Create dashboard
      </Button>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={title}
      description={description}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">{close}</Button>
          </DialogClose>
          {actions}
        </>
      }
    >
      {body}
    </Dialog>
  );
}
