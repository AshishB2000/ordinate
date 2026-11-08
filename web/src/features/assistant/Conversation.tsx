// The conversation's body, drawn at either of the Assistant's two sizes: the
// stage of turns, the offers a reply leaves (bring data in, rebuild, a plan),
// the verified answers, the starter suggestions and the composer. The state is
// useConversation's; the chrome around it (the dock's header, the page's header
// and conversations column) is Dock.tsx's and AssistantPage.tsx's.
//
// `dock`: 340px beside the page, the composer under the turns.
// `page`: full width. Before the first question the conversation stands in
// the middle of the stage (a greeting, a big composer, the chips); after it,
// the turns read down a centred column with the composer at its foot, and the
// answer cards spread out (AnswerCard.module.css, at their own width).

import { lazy, Suspense, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { buttonClass } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { mineModel } from './api';
import { AiNotReady } from './AiNotReady';
import { Composer } from './Composer';
import { modelLabel } from './DockParts';
import { pickDockProject } from './dockState';
import { PlanCard } from './PlanCard';
import { ThreadActionDialog } from './ThreadActions';
import { Transcript } from './Transcript';
import type { Conversation } from './useConversation';
import { VerifiedChips } from './VerifiedChips';
import s from './Dock.module.css';
import w from './Wide.module.css';

// The draft review draws charts: loaded when a reply first proposes a dashboard, not with the Assistant.
const DraftFlow = lazy(() => import('../analyses/DraftReview').then((m) => ({ default: m.DraftFlow })));

export type Layout = 'dock' | 'page';

/** Why the Assistant cannot answer here, if it cannot. */
function Notice({ c }: { c: Conversation }) {
  const { status } = c;
  if (!c.project.loading && !c.pid) return <div className={s.hint}>Open a project to ask a question.</div>;
  if (status.isError) return <ErrorState compact heading={3} title="The Assistant could not load" message="Check your connection and try again." onRetry={() => void status.refetch()} />;
  if (!status.data) return null;
  if (!c.ready) {
    return (
      <div className={s.hint} data-testid="dock-setup">
        <AiNotReady status={status.data} />
      </div>
    );
  }
  if (!c.enabled) {
    return (
      <div className={s.hint}>
        {`The Assistant is off. ${c.isAdmin ? 'Turn it back on from the ⋯ menu above.' : 'An org admin can turn it back on.'} Everything else in Ordinate works exactly as it does now.`}
      </div>
    );
  }
  return null;
}

/** The turns, and what the last reply offers to do next. */
function Turns({ c }: { c: Conversation }) {
  const qc = useQueryClient();
  const { pid, canEdit, pending } = c;
  if (!pid) return null;
  return (
    <>
      <Transcript turns={c.turns} pending={pending} lastSteps={c.lastSteps} projectId={pid} threadId={c.shownThread} onFollowUp={c.followUp} />
      {canEdit && c.getData && !pending && (
        <div className={s.getData} data-testid="dock-get-data">
          <Link className={buttonClass('primary', 'sm')} to={`/data/import?project=${pid}`}>Import a file</Link>
          <Link className={buttonClass('secondary', 'sm')} to={`/data/import?project=${pid}&source=paste`}>Paste data</Link>
          <Link className={buttonClass('secondary', 'sm')} to={`/connections/${pid}`}>Connect a source</Link>
        </div>
      )}
      {canEdit && c.rebuildOffer && !pending && (
        <div className={s.getData} data-testid="dock-rebuild">
          <Link className={buttonClass('primary', 'sm')} to={`/analyses/${pid}/rebuild${c.context.kind === 'dataset' && c.context.id ? `?dataset=${c.context.id}` : ''}`}>
            Rebuild from a screenshot
          </Link>
        </div>
      )}
      {/* Only in the project it was proposed for: an answer landing after the route moved on is not this project's to run. */}
      {canEdit &&
        c.plans
          .filter((p) => p.projectId === pid)
          .map((p) => (
            <PlanCard
              key={p.key}
              projectId={p.projectId}
              threadId={p.threadId}
              action={p.action}
              onDone={() => c.setPlans((ps) => ps.filter((x) => x.key !== p.key))}
              onLogged={() => void qc.invalidateQueries({ queryKey: ['copilot:history', p.projectId] })}
            />
          ))}
    </>
  );
}

/** The starter questions: a pick fills the composer, it never sends. */
function Suggestions({ c, className, pill }: { c: Conversation; className: string; pill: string }) {
  if (c.prompts.length === 0) return null;
  return (
    <div className={className}>
      {c.prompts.map((p) => (
        <button
          key={p}
          type="button"
          className={pill}
          title={p}
          onClick={() => {
            c.setText(p);
            c.input.current?.focus();
          }}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function ConversationComposer({ c, layout, className }: { c: Conversation; layout: Layout; className?: string }) {
  const pid = c.pid;
  // The page is the whole project's, so "what you're looking at" means nothing there.
  const placeholder = layout === 'page' && pid && c.ready && c.enabled && !c.pinned ? (c.empty ? 'Ask about your data, or say what to build…' : 'Ask a follow-up, or say what to build…') : c.placeholder;
  return (
    <Composer
      layout={layout}
      className={className}
      inputRef={c.input}
      projectId={pid}
      status={c.status.data}
      context={c.context}
      pinned={c.pinned !== null}
      onPin={(p) => c.setPin(p && pid ? { projectId: pid, context: p } : null)}
      text={c.text}
      onText={c.setText}
      onSend={() => void c.send(c.text)}
      usable={c.usable}
      placeholder={placeholder}
      projectPick={
        !c.project.fromRoute && c.project.projects.length > 1 ? (
          <Select
            size="sm"
            aria-label="Project"
            value={pid}
            onValueChange={(v) => {
              pickDockProject(v);
              c.switchThread('');
            }}
            options={c.project.projects.map((p) => ({ value: p.id, label: p.name }))}
          />
        ) : undefined
      }
    />
  );
}

/** The body at one size. `intro`: the page's greeting over its first question. */
export function ConversationBody({ c, layout, intro }: { c: Conversation; layout: Layout; intro?: ReactNode }) {
  const loading = !!c.pid && c.history.isPending;
  const failed = c.history.isError && <ErrorState compact heading={3} title="The conversation could not load" message={c.history.error.message} onRetry={() => void c.history.refetch()} />;
  const hint = c.hint && (
    <div className={s.hint} role="alert">
      {c.hint}
    </div>
  );
  const verified = c.empty && c.enabled && !!c.pid;

  if (layout === 'dock') {
    const mine = mineModel(c.status.data);
    return (
      <>
        <div className={s.stage} ref={c.stage} data-testid="dock-messages">
          <Notice c={c} />
          {hint}
          {loading && <SkeletonRows rows={3} label="Loading the conversation" />}
          {failed}
          {c.empty && c.ready && c.enabled && mine && c.status.data && !loading && (
            <div className={`${s.powered} ${s.stageTop}`}>{`Powered by ${modelLabel({ ...mine, isDefault: false }, c.status.data.models)}`}</div>
          )}
          <Turns c={c} />
        </div>
        {verified && <VerifiedChips chips={c.chips} onPick={(v) => void c.followUp(v.spec, v.question)} />}
        <Suggestions c={c} className={s.suggests} pill={s.suggest} />
        <ConversationComposer c={c} layout="dock" />
      </>
    );
  }

  // Before the first question the conversation stands in the middle of the stage: the greeting over the
  // composer, the chips under it. One tree either way, so the composer (its text, its focus) stays put.
  const start = c.empty && !loading && !c.history.isError;
  return (
    <div className={start ? `${s.lattice} ${w.stage} ${w.start}` : `${s.lattice} ${w.stage}`}>
      <div className={w.scroll} ref={c.stage} data-testid="dock-messages">
        <div className={`${w.column} ${s.wide}`}>
          {start && intro}
          {loading && <SkeletonRows rows={4} label="Loading the conversation" />}
          {failed}
          <Turns c={c} />
        </div>
      </div>
      {/* Why it cannot answer sits on the composer, where it is read, however long the conversation above. */}
      <div className={w.foot}>
        <Notice c={c} />
        {hint}
        <ConversationComposer c={c} layout="page" className={start ? w.heroComposer : undefined} />
        {start && verified && <VerifiedChips className={w.verified} chips={c.chips} onPick={(v) => void c.followUp(v.spec, v.question)} />}
        {start && <Suggestions c={c} className={w.suggests} pill={w.suggest} />}
      </div>
    </div>
  );
}

/** The dialogs a conversation opens: a dashboard draft's review, a rename or delete. */
export function ConversationDialogs({ c }: { c: Conversation }) {
  return (
    <>
      {c.canEdit && c.draft && (
        <Suspense fallback={null}>
          <DraftFlow projectId={c.draft.projectId} datasetId={c.draft.datasetId} intent={c.draft.intent} onClose={() => c.setDraft(null)} />
        </Suspense>
      )}
      {c.pid && c.act && <ThreadActionDialog key={`${c.act.kind}:${c.act.thread.id}`} projectId={c.pid} act={c.act} onClose={() => c.setAct(null)} onDone={c.acted} />}
    </>
  );
}
