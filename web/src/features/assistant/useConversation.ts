// The Assistant's conversation — one implementation for both its sizes: the
// dock beside the page (Dock.tsx) and the full-width page (AssistantPage.tsx).
// Which thread is open, the ask and its stream, the plan, import, rebuild and
// dashboard offers a reply leaves, the handed-over questions: all here, so the
// two sizes cannot drift. Their chrome is theirs; the body is Conversation.tsx.
//
// Answers are the app's facts narrated, streamed token by token to THIS tab
// over its event stream (`copilot:ask:chunk`, keyed by an askId so a stale ask
// can never paint into the current bubble). Every figure arrives from the
// server; nothing here computes one.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDatasets } from '../../api/datasets';
import { onServerEvent } from '../../api/events';
import { rpc } from '../../api/client';
import { useMe } from '../auth/api';
import { useCanEdit } from '../projects/api';
import { toast } from '../../ui/Toast';
import { ask, newThread, UNTITLED, useAiStatus, useHistory, useVerifiedChips, type ActivityStep, type SuggestedAction, type Turn } from './api';
import type { Learn } from './DidYouMean';
import { takePendingQuestion, takePendingSpec, useDockContext, useDockProject, usePendingQuestion, usePendingSpec, type DockContext, type HandedTo } from './dockState';
import type { PlanAction } from './PlanCard';
import { starterPrompts } from './prompts';
import type { ThreadAct } from './ThreadActions';
import type { Pending } from './Transcript';

/** A plan proposal on screen, for the project it was written from; `key` keeps a started one mounted across turns. */
export interface PlanSlot {
  key: string;
  projectId: string;
  action: PlanAction;
  threadId: string;
}

/** The thread to open first; `projectId: null` when the opener does not know its project (a URL). */
export interface OpenThread {
  projectId: string | null;
  id: string;
}

export type Conversation = ReturnType<typeof useConversation>;

export function useConversation(where: HandedTo, first: OpenThread | null = null) {
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.user?.role === 'admin';
  const project = useDockProject(true);
  const pid = project.id;
  // A reply's offers to bring data in, rebuild, run a plan or draft a dashboard all write: an editor's.
  // Gated where they render, not in send(): a viewer still asks, and still reads the answer.
  const canEdit = useCanEdit(pid);
  // What `@` pinned, for the project it was pinned in; otherwise the context follows the screen.
  const [pin, setPin] = useState<{ projectId: string; context: DockContext } | null>(null);
  const onScreen = useDockContext(pid);
  const pinned = pin && pin.projectId === pid ? pin.context : null;
  const context = pinned ?? onScreen;
  const status = useAiStatus();
  // The open thread, for the project it was opened in: another project starts on its own most recent.
  const [open, setOpen] = useState<OpenThread>(() => first ?? { projectId: null, id: '' });
  const threadId = open.id && (open.projectId === null || open.projectId === pid) ? open.id : '';
  const setThreadId = useCallback((id: string) => setOpen({ projectId: pid, id }), [pid]);
  const history = useHistory(pid, threadId);
  const datasets = useDatasets(pid ?? undefined);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lastSteps, setLastSteps] = useState<{ turnId: string; steps: ActivityStep[] } | null>(null);
  const [hint, setHint] = useState('');
  const [plans, setPlans] = useState<PlanSlot[]>([]);
  const [getData, setGetData] = useState(false); // the last reply proposed bringing data in
  const [rebuildOffer, setRebuildOffer] = useState(false); // …or rebuilding a dashboard from another tool's screenshot
  // The last reply proposed a dashboard: drafted from what was asked, reviewed, and created only on the click.
  const [draft, setDraft] = useState<{ projectId: string; datasetId?: string; intent: string } | null>(null);
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [act, setAct] = useState<ThreadAct | null>(null); // a rename or delete being asked about
  const input = useRef<HTMLTextAreaElement>(null);
  /** The Assistant's frame: focus lands here when the composer is disabled. */
  const panel = useRef<HTMLElement>(null);
  /** What scrolls the turns. */
  const stage = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  // The thread the server resolved (the most recent one when none was asked for).
  const shownThread = history.data?.threadId ?? '';
  // Its stored name, once it has one: a first question's words, or what it was renamed to.
  const storedTitle = history.data?.title && history.data.title !== UNTITLED ? history.data.title : null;
  const turns: Turn[] = history.data?.turns ?? [];
  const ready = status.data?.ready === true;
  const enabled = status.data?.copilotEnabled !== false;
  const chips = useVerifiedChips(pid, context.kind === 'dataset' ? context.id : undefined);
  const usable = !!pid && enabled && !pending && (ready || chips.length > 0); // a verified question needs no model
  const focusComposer = useCallback(() => (input.current && !input.current.disabled ? input.current : panel.current)?.focus(), []);

  // Opening focuses the composer — or the frame, when the composer is disabled and refuses focus.
  useEffect(() => {
    focusComposer();
  }, [focusComposer]);

  // A rename, delete or draft dialog closing: what opened it (a menu item, a
  // History row, a question since sent) is gone, so focus would fall to <body>.
  // Back to the composer, a tick after the dialog lets go of it.
  const hadAct = useRef(false);
  const dialog = !!act || !!draft;
  useEffect(() => {
    if (dialog) {
      hadAct.current = true;
      return;
    }
    if (!hadAct.current) return;
    hadAct.current = false;
    const id = setTimeout(focusComposer, 0);
    return () => clearTimeout(id);
  }, [dialog, focusComposer]);

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

  // A question handed over (Home's ask bar, Explore, an alert): asked once the Assistant knows it can
  // (project, model, thread loaded), else left in the composer; focus moves in either way.
  const handed = usePendingQuestion(where);
  const decided = !!status.data && !project.loading && !(pid && history.isPending);
  const asker = useRef({ send, usable });
  asker.current = { send, usable }; // the current render's, read once per handed question
  useEffect(() => {
    if (!handed || !decided) return;
    const { question: q, about } = takePendingQuestion();
    // Pointed at one thing (a Home suggestion): pinned as `@` pins, if the Assistant is in its project.
    const on = about && pid && about.projectId === pid ? about.context : undefined;
    if (on && pid) setPin({ projectId: pid, context: on });
    const asking = asker.current.usable; // the composer turns disabled while it is asked, and a browser drops focus from it
    if (asking) void asker.current.send(q, on);
    else setText(q);
    (input.current && !input.current.disabled && !asking ? input.current : panel.current)?.focus();
  }, [handed, decided, pid]);

  // A verified answer handed over from Home's chips: run on the conversation shown, once the Assistant knows it.
  const handedSpec = usePendingSpec(where);
  const runner = useRef(followUp);
  runner.current = followUp;
  useEffect(() => {
    if (!handedSpec || !decided) return;
    const h = takePendingSpec();
    if (h && pid && enabled) void runner.current(h.spec, h.label);
  }, [handedSpec, decided, pid, enabled]);

  // Another project (the route named one, or the picker did): what the last turn left on
  // screen — a proposed plan, the Get-data links, an error — was about the project it was asked in.
  useEffect(() => {
    setPlans((ps) => ps.filter((p) => p.projectId === pid));
    setGetData(false);
    setRebuildOffer(false);
    setHint('');
    setLastSteps(null);
  }, [pid]);

  // …and once it can be asked (the model's status lands after the first paint), the composer, if focus waited on the frame.
  useEffect(() => {
    if (usable && document.activeElement === panel.current) input.current?.focus();
  }, [usable]);

  // Keep the newest turn in view, and there while an answer's card fills in under it (its chart and figures
  // land after the turn does) — unless the reader scrolled up meanwhile.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    let pinned = true;
    const onScroll = () => {
      pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    const grew = new ResizeObserver(() => {
      if (pinned) el.scrollTop = el.scrollHeight;
    });
    for (const child of el.children) grew.observe(child);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      grew.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, [turns.length, pending, plans.length, getData, rebuildOffer]);

  const setTurns = useCallback(
    (next: Turn[], tid: string | null) => {
      if (tid) setThreadId(tid);
      // The same conversation keeps the name the server gave for it (a rename outlives its next turn).
      qc.setQueryData(['copilot:history', pid, tid ?? threadId], { ok: true, turns: next, threadId: tid, title: tid && tid === shownThread ? storedTitle : null });
      void qc.invalidateQueries({ queryKey: ['copilot:threads', pid] }); // a new turn renames and reorders the list
    },
    [qc, pid, threadId, shownThread, storedTitle, setThreadId],
  );

  function switchThread(id: string): void {
    setThreadId(id);
    setLastSteps(null);
    setGetData(false);
    setRebuildOffer(false);
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

  /** `on`: what the answer is about, when the caller pinned it in this same turn (the state has not caught up). */
  async function send(question: string, on: DockContext = context): Promise<void> {
    const q = question.trim();
    if (!q || !pid || pending) return;
    const askId = crypto.randomUUID();
    setPending({ askId, question: q, text: '', steps: [] });
    setLastSteps(null);
    setHint('');
    setText('');
    setGetData(false);
    setRebuildOffer(false);
    setPlans((ps) => ps.filter((p) => p.key.startsWith('live:'))); // last turn's proposal is superseded
    let r: Awaited<ReturnType<typeof ask>>;
    try {
      r = await ask(pid, on, q, shownThread, askId);
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
        setPlans((ps) => [...ps, { key: askId, projectId: pid, action: { intent: action.intent, steps: action.steps ?? [], droppedSteps: action.droppedSteps }, threadId: r.threadId ?? '' }]);
      }
      setGetData(action?.kind === 'import');
      setRebuildOffer(action?.kind === 'rebuild');
      if (action?.kind === 'dashboard') {
        // ponytail: one turn's intent; fold a thread's earlier dashboard asks in if follow-ups should refine one plan.
        setDraft({ projectId: pid, ...(on.kind === 'dataset' && on.id ? { datasetId: on.id } : {}), intent: (action.intent || q).slice(0, 2000) });
      }
      return;
    }
    // Failure: the server left the thread unchanged; keep the typed text so nothing is lost.
    setText(q);
    if (r.notReady) {
      void qc.invalidateQueries({ queryKey: ['ai:status'] });
      setHint('Connect a model to ask anything else.');
    } else setHint(r.error || 'Could not answer that. Try again.');
  }

  async function followUp(spec: Record<string, unknown>, label: string, learn?: Learn): Promise<void> {
    if (!pid) return;
    const r = (await rpc('answer:rerun', { projectId: pid, ...(shownThread ? { threadId: shownThread } : {}), spec: spec as { datasetId: string }, label, ...(learn ? { learn } : {}) }).catch(() => null)) as
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
  const prompts = empty && usable && ready ? starterPrompts((datasets.data ?? []).map((d) => d.name), context.name, context.kind) : [];
  const placeholder = !pid
    ? 'Open a project to ask a question…'
    : !ready
      ? chips.length > 0 && enabled
        ? 'Ask a verified question, or connect a model to ask anything else.'
        : 'AI isn’t set up for your organization yet.'
      : !enabled
        ? 'The Assistant is off.'
        : pinned
          ? `Ask about ${pinned.name}…`
          : "Ask about what you're looking at, or type @ to pick…";

  return {
    pid,
    project,
    isAdmin,
    canEdit,
    status,
    ready,
    enabled,
    history,
    turns,
    shownThread,
    title,
    empty,
    pending,
    lastSteps,
    hint,
    plans,
    setPlans,
    getData,
    rebuildOffer,
    draft,
    setDraft,
    context,
    pinned,
    setPin,
    chips,
    prompts,
    placeholder,
    usable,
    text,
    setText,
    historyOpen,
    setHistoryOpen,
    act,
    setAct,
    input,
    panel,
    stage,
    send,
    followUp,
    startNew,
    switchThread,
    acted,
  };
}
