// The AI dock — dock.ts, dockHero.ts and dockResize.ts, ported: a docked,
// toggleable panel on the right that follows the user across the app. Its
// context is what is on screen (dockState.ts); its answers are the app's facts
// narrated, streamed token by token to THIS tab over its event stream
// (`copilot:ask:chunk`, keyed by an askId so a stale ask can never paint into
// the current bubble). Every figure arrives from the server; nothing here
// computes one.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useDatasets } from '../../api/datasets';
import { onServerEvent } from '../../api/events';
import { rpc } from '../../api/client';
import { useMe } from '../auth/api';
import { buttonClass, IconButton } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { Splitter, useStoredSize } from '../../ui/Splitter';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { ask, mineModel, newThread, UNTITLED, useAiStatus, useHistory, type ActivityStep, type SuggestedAction, type Turn } from './api';
import { AiNotReady } from './AiNotReady';
import { Composer } from './Composer';
import { DockMenu, modelLabel, ThreadMenu, TOGGLE_ID } from './DockParts';
import { History } from './History';
import { pickDockProject, setDockOpen, takePendingQuestion, useDockContext, useDockProject, usePendingQuestion, type DockContext } from './dockState';
import { PlanCard, type PlanAction } from './PlanCard';
import { starterPrompts } from './prompts';
import { ThreadActionDialog, type ThreadAct } from './ThreadActions';
import { Transcript, type Pending } from './Transcript';
import s from './Dock.module.css';

const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 340;

/** A plan proposal on screen; `key` keeps a started one mounted across turns. */
interface PlanSlot {
  key: string;
  action: PlanAction;
  threadId: string;
}

/** The open panel — its own lazy chunk (DockParts.tsx `Dock` mounts it), so the shell carries only the toggle. */
export default function DockPanel() {
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.user?.role === 'admin';
  const project = useDockProject(true);
  const pid = project.id;
  // What `@` pinned, for the project it was pinned in; otherwise the context follows the screen.
  const [pin, setPin] = useState<{ projectId: string; context: DockContext } | null>(null);
  const onScreen = useDockContext(pid);
  const pinned = pin && pin.projectId === pid ? pin.context : null;
  const context = pinned ?? onScreen;
  const status = useAiStatus();
  const [threadId, setThreadId] = useState('');
  const history = useHistory(pid, threadId);
  const datasets = useDatasets(pid ?? undefined);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lastSteps, setLastSteps] = useState<{ turnId: string; steps: ActivityStep[] } | null>(null);
  const [hint, setHint] = useState('');
  const [plans, setPlans] = useState<PlanSlot[]>([]);
  const [getData, setGetData] = useState(false); // the last reply proposed bringing data in
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [act, setAct] = useState<ThreadAct | null>(null); // a rename or delete being asked about
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const [width, setWidth, commitWidth] = useStoredSize('ordinate.dockWidth', DEFAULT_WIDTH, MIN_WIDTH, Math.max(window.innerWidth * 0.4, MIN_WIDTH));

  // The thread the server resolved (the most recent one when none was asked for).
  const shownThread = history.data?.threadId ?? '';
  // Its stored name, once it has one: a first question's words, or what it was renamed to.
  const storedTitle = history.data?.title && history.data.title !== UNTITLED ? history.data.title : null;
  const turns: Turn[] = history.data?.turns ?? [];
  const ready = status.data?.ready === true;
  const enabled = status.data?.copilotEnabled !== false;
  const usable = !!pid && ready && enabled && !pending;

  // Opening focuses the composer — or the panel, when the composer is disabled and refuses focus.
  useEffect(() => {
    (input.current && !input.current.disabled ? input.current : panel.current)?.focus();
  }, []);

  // A rename or delete dialog closing: what opened it (a menu item, a History row)
  // is gone, so focus would fall to <body>. Back to the composer, a tick after
  // the dialog lets go of it.
  const hadAct = useRef(false);
  useEffect(() => {
    if (act) {
      hadAct.current = true;
      return;
    }
    if (!hadAct.current) return;
    hadAct.current = false;
    const id = setTimeout(() => (input.current && !input.current.disabled ? input.current : panel.current)?.focus(), 0);
    return () => clearTimeout(id);
  }, [act]);

  // Esc closes and hands focus back to the toggle — unless something above (a menu, a select) took it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setDockOpen(false);
      document.getElementById(TOGGLE_ID)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The asking tab's stream: tokens into the pending bubble, the app's steps under it.
  useEffect(() => {
    const offChunk = onServerEvent('copilot:ask:chunk', (p) => {
      const d = p as { askId?: string; delta?: string };
      setPending((cur) => (cur && d.askId === cur.askId ? { ...cur, text: cur.text + String(d.delta ?? '') } : cur));
    });
    const offStep = onServerEvent('copilot:ask:activity', (p) => {
      const d = p as { askId?: string; step?: ActivityStep };
      if (!d.step || typeof d.step.label !== 'string') return;
      const step = d.step;
      setPending((cur) => (cur && d.askId === cur.askId ? { ...cur, steps: [...cur.steps, step] } : cur));
    });
    const offKey = onServerEvent('key:changed', () => void qc.invalidateQueries({ queryKey: ['ai:status'] }));
    return () => {
      offChunk();
      offStep();
      offKey();
    };
  }, [qc]);

  // A question handed over from Home's ask bar: asked once the dock knows it can
  // (project, model, thread loaded), else left in the composer; focus moves in either way.
  const handed = usePendingQuestion();
  const decided = !!status.data && !project.loading && !(pid && history.isPending);
  const asker = useRef({ send, usable });
  asker.current = { send, usable }; // the current render's, read once per handed question
  useEffect(() => {
    if (!handed || !decided) return;
    const q = takePendingQuestion();
    if (asker.current.usable) void asker.current.send(q);
    else setText(q);
    (input.current && !input.current.disabled ? input.current : panel.current)?.focus();
  }, [handed, decided]);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = stage.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, pending, plans.length, getData]);

  const setTurns = useCallback(
    (next: Turn[], tid: string | null) => {
      if (tid) setThreadId(tid);
      // The same conversation keeps the name the server gave for it (a rename outlives its next turn).
      qc.setQueryData(['copilot:history', pid, tid ?? threadId], { ok: true, turns: next, threadId: tid, title: tid && tid === shownThread ? storedTitle : null });
      void qc.invalidateQueries({ queryKey: ['copilot:threads', pid] }); // a new turn renames and reorders the list
    },
    [qc, pid, threadId, shownThread, storedTitle],
  );

  function switchThread(id: string): void {
    setThreadId(id);
    setLastSteps(null);
    setGetData(false);
    setPlans((ps) => ps.filter((p) => p.key.startsWith('live:')));
  }

  async function startNew(): Promise<void> {
    if (!pid) return;
    // Already on a blank conversation: a second one would only be an empty row in History.
    if (shownThread && turns.length === 0) {
      input.current?.focus();
      return;
    }
    const id = await newThread(pid).catch(() => '');
    switchThread(id);
    setTurns([], id || null);
  }

  async function send(question: string): Promise<void> {
    const q = question.trim();
    if (!q || !pid || pending) return;
    const askId = crypto.randomUUID();
    setPending({ askId, question: q, text: '', steps: [] });
    setLastSteps(null);
    setHint('');
    setText('');
    setGetData(false);
    setPlans((ps) => ps.filter((p) => p.key.startsWith('live:'))); // last turn's proposal is superseded
    let r: Awaited<ReturnType<typeof ask>>;
    try {
      r = await ask(pid, context, q, shownThread, askId);
    } catch {
      r = { ok: false, error: 'Something went wrong. Try again.' };
    }
    const steps = pendingRef.current?.askId === askId ? pendingRef.current.steps : [];
    setPending(null);
    if (r.ok) {
      setTurns(r.turns, r.threadId);
      const answered = r.turns.findLast((t) => t.role === 'assistant');
      setLastSteps(steps.length && answered ? { turnId: answered.id, steps } : null);
      const action: SuggestedAction | undefined = r.suggestedAction;
      if (action && action.kind === 'plan' && Array.isArray(action.steps)) {
        setPlans((ps) => [...ps, { key: askId, action: { intent: action.intent, steps: action.steps ?? [], droppedSteps: action.droppedSteps }, threadId: r.threadId ?? '' }]);
      }
      setGetData(action?.kind === 'import');
      return;
    }
    // Failure: the server left the thread unchanged; keep the typed text so nothing is lost.
    setText(q);
    if (r.notReady) void qc.invalidateQueries({ queryKey: ['ai:status'] });
    else setHint(r.error || 'Could not answer that. Try again.');
  }

  async function followUp(spec: Record<string, unknown>, label: string): Promise<void> {
    if (!pid) return;
    const r = (await rpc('answer:rerun', { projectId: pid, ...(shownThread ? { threadId: shownThread } : {}), spec: spec as { datasetId: string }, label }).catch(() => null)) as
      | { ok: true; turns: Turn[]; threadId: string | null }
      | { ok: false; reason?: string }
      | null;
    if (r && r.ok) setTurns(r.turns, r.threadId);
    else toast((r && !r.ok && r.reason) || 'Could not run that follow-up.', { kind: 'error' });
  }

  const firstUser = turns.find((t) => t.role === 'user')?.text.trim() ?? '';
  const title = storedTitle ?? (firstUser ? (firstUser.length > 40 ? `${firstUser.slice(0, 40)}…` : firstUser) : 'New conversation');

  /** A conversation was renamed or deleted: the lists are stale, and a deleted one on screen gives way to the most recent. */
  function acted(done: ThreadAct): void {
    if (done.kind === 'delete' && done.thread.id === shownThread) switchThread('');
    void qc.invalidateQueries({ queryKey: ['copilot:threads', pid] });
    void qc.invalidateQueries({ queryKey: ['copilot:history', pid] });
  }
  const empty = turns.length === 0 && !pending;
  const prompts = empty && usable ? starterPrompts((datasets.data ?? []).map((d) => d.name), context.name) : [];
  const placeholder = !pid
    ? 'Open a project to ask a question…'
    : !ready
      ? 'AI isn’t set up for your organization yet.'
      : !enabled
        ? 'The Assistant is off.'
        : pinned
          ? `Ask about ${pinned.name}…`
          : "Ask about what you're looking at, or type @ to pick…";

  const notice = (() => {
    if (!project.loading && !pid) return <div className={s.hint}>Open a project to ask a question.</div>;
    if (status.isError) return <ErrorState compact heading={3} title="The Assistant could not load" message="Check your connection and try again." onRetry={() => void status.refetch()} />;
    if (!status.data) return null;
    if (!ready) {
      return (
        <div className={s.hint} data-testid="dock-setup">
          <AiNotReady status={status.data} />
        </div>
      );
    }
    if (!enabled) {
      return (
        <div className={s.hint}>
          {`The Assistant is off. ${isAdmin ? 'Turn it back on from the ⋯ menu above.' : 'An org admin can turn it back on.'} Everything else in Ordinate works exactly as it does now.`}
        </div>
      );
    }
    return null;
  })();

  const mine = mineModel(status.data);
  return (
    <>
      <div className={s.scrim} onClick={() => setDockOpen(false)} aria-hidden="true" />
      <aside id="dock-panel" ref={panel} className={s.panel} style={{ width }} tabIndex={-1} aria-label="Assistant">
        {/* Double-click the line: back to the width the dock ships with. */}
        <div
          className={s.handle}
          onDoubleClick={() => {
            setWidth(DEFAULT_WIDTH);
            commitWidth(DEFAULT_WIDTH);
          }}
        >
          <Splitter pane="after" label="Resize the Assistant panel" size={width} min={MIN_WIDTH} max={Math.max(window.innerWidth * 0.4, MIN_WIDTH)} onSizeChange={setWidth} onCommit={commitWidth} />
        </div>
        <div className={s.head}>
          <ThreadMenu projectId={pid} threadId={shownThread} title={title} onOpen={switchThread} onAll={() => setHistoryOpen(true)} />
          <div className={s.headActions}>
            <IconButton icon="plus" size="sm" label="New conversation" disabled={!pid || !!pending} onClick={() => void startNew()} />
            <History projectId={pid} threadId={shownThread} open={historyOpen} onOpenChange={setHistoryOpen} onOpen={switchThread} onAct={setAct} />
            <DockMenu status={status.data} isAdmin={isAdmin} turns={turns} thread={shownThread && !pending ? { id: shownThread, title } : null} onAct={setAct} />
            <IconButton icon="x" size="sm" label="Close the Assistant" onClick={() => setDockOpen(false)} />
          </div>
        </div>
        <div className={s.stage} ref={stage} data-testid="dock-messages">
          {notice}
          {hint && <div className={s.hint} role="alert">{hint}</div>}
          {pid && history.isPending && <SkeletonRows rows={3} label="Loading the conversation" />}
          {history.isError && <ErrorState compact heading={3} title="The conversation could not load" message={history.error.message} onRetry={() => void history.refetch()} />}
          {empty && ready && enabled && mine && status.data && !history.isPending && (
            <div className={`${s.powered} ${s.stageTop}`}>{`Powered by ${modelLabel({ ...mine, isDefault: false }, status.data.models)}`}</div>
          )}
          {pid && <Transcript turns={turns} pending={pending} lastSteps={lastSteps} projectId={pid} onFollowUp={followUp} />}
          {pid && getData && !pending && (
            <div className={s.getData} data-testid="dock-get-data">
              <Link className={buttonClass('primary', 'sm')} to={`/data/import?project=${pid}`}>Import a file</Link>
              <Link className={buttonClass('secondary', 'sm')} to={`/data/import?project=${pid}&source=paste`}>Paste data</Link>
              <Link className={buttonClass('secondary', 'sm')} to={`/connections/${pid}`}>Connect a source</Link>
            </div>
          )}
          {pid &&
            plans.map((p) => (
              <PlanCard
                key={p.key}
                projectId={pid}
                threadId={p.threadId}
                action={p.action}
                onDone={() => setPlans((ps) => ps.filter((x) => x.key !== p.key))}
                onLogged={() => void qc.invalidateQueries({ queryKey: ['copilot:history', pid] })}
              />
            ))}
        </div>
        {prompts.length > 0 && (
          <div className={s.suggests}>
            {prompts.map((p) => (
              <button
                key={p}
                type="button"
                className={s.suggest}
                title={p}
                onClick={() => {
                  setText(p);
                  input.current?.focus();
                }}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <Composer
          inputRef={input}
          projectId={pid}
          status={status.data}
          context={context}
          pinned={pinned !== null}
          onPin={(c) => setPin(c && pid ? { projectId: pid, context: c } : null)}
          text={text}
          onText={setText}
          onSend={() => void send(text)}
          usable={usable}
          placeholder={placeholder}
          projectPick={
            !project.fromRoute && project.projects.length > 1 ? (
              <Select size="sm" aria-label="Project" value={pid} onValueChange={(v) => { pickDockProject(v); switchThread(''); }} options={project.projects.map((p) => ({ value: p.id, label: p.name }))} />
            ) : undefined
          }
        />
      </aside>
      {pid && act && <ThreadActionDialog key={`${act.kind}:${act.thread.id}`} projectId={pid} act={act} onClose={() => setAct(null)} onDone={acted} />}
    </>
  );
}
