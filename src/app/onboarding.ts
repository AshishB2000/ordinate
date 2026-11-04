// First-run guidance: the Get-started tour and the sample dashboard's coach
// marks. MAIN PROCESS ONLY.
//
// Started ONCE for the org, with its first project: the sample seeder, or
// `projects:create` for an org that starts with its own (startOnce). An install
// that had projects before this existed (or one that hid or finished the old
// org-wide checklist) has no `onboarding` block and gets neither the card nor
// the coach marks.
//
// THE TOUR IS EACH PERSON'S. A stop ticks when that person opens its page
// (the browser reports the visit, from the card or the sidebar) or, for the
// Assistant, sends it a question. Ticks, fold and hide live under
// `by[email]`, so one member's tour never moves another's. The Assistant stop
// exists only while AI is set up. Once every stop a person was shown is ticked
// their card is gone for good: setting AI up later does not bring it back.

import * as config from './config';
import * as execConfig from './execConfig';

export type StepId = 'assistant' | 'explore' | 'dashboards' | 'reports' | 'data';
/** The tour's order when the project has data (the browser moves Data first when it has none). */
export const STEPS: StepId[] = ['assistant', 'explore', 'dashboards', 'reports', 'data'];

export interface TourState {
  /** When each stop was first visited. */
  seen: Partial<Record<StepId, string>>;
  /** The card is folded to the header's "2 of 5" pill. */
  collapsed: boolean;
  /** Hidden by the person, or finished: gone for good. */
  dismissed: boolean;
}

export interface OnboardingState {
  startedAt: string;
  /** The sample dashboard's coach marks have been shown (once, for the org). */
  coachSeen: boolean;
  /** Each person's tour, by sign-in email. */
  by: Record<string, TourState>;
}

export interface OnboardingStatus {
  started: boolean;
  /** Show the card (or its pill): started, not hidden, not finished. */
  show: boolean;
  collapsed: boolean;
  steps: Array<{ id: StepId; done: boolean }>;
  doneCount: number;
  total: number;
  /** Start the coach marks when the sample dashboard next opens. */
  coachPending: boolean;
  sample: { projectId: string; datasetId: string; analysisId: string } | null;
}

export function fresh(now = new Date()): OnboardingState {
  return { startedAt: now.toISOString(), coachSeen: false, by: {} };
}

/** Starts the tour for an org that has none; a started, hidden or finished one is left alone. */
export function startOnce(): void {
  if (!config.get().onboarding) config.save({ onboarding: fresh() });
}

const blank = (): TourState => ({ seen: {}, collapsed: false, dismissed: false });

function put(state: OnboardingState, user: string, mine: TourState): void {
  config.save({ onboarding: { ...state, by: { ...state.by, [user]: mine } } });
}

export async function status(user: string): Promise<OnboardingStatus> {
  const cfg = config.get();
  const state = cfg.onboarding;
  const sample = cfg.sample ? { projectId: cfg.sample.projectId, datasetId: cfg.sample.datasetId, analysisId: cfg.sample.analysisId } : null;
  if (!state) {
    return {
      started: false, show: false, collapsed: false, steps: STEPS.map((id) => ({ id, done: false })),
      doneCount: 0, total: STEPS.length, coachPending: false, sample,
    };
  }
  const ids = (await execConfig.executionReady()) ? STEPS : STEPS.filter((s) => s !== 'assistant');
  const mine = state.by[user] ?? blank();
  const steps = ids.map((id) => ({ id, done: !!mine.seen[id] }));
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === ids.length && !mine.dismissed) put(state, user, { ...mine, dismissed: true });
  return {
    started: true,
    show: !mine.dismissed && doneCount < ids.length,
    collapsed: mine.collapsed,
    steps, doneCount, total: ids.length,
    coachPending: !state.coachSeen,
    sample,
  };
}

/** `user` opened a stop's page (or asked the Assistant). Latches; a second visit writes nothing. */
export function visit(user: string, step: StepId): boolean {
  const state = config.get().onboarding;
  if (!state || !STEPS.includes(step)) return false;
  const mine = state.by[user] ?? blank();
  if (mine.seen[step]) return true;
  put(state, user, { ...mine, seen: { ...mine.seen, [step]: new Date().toISOString() } });
  return true;
}

/** What the browser may change: the person's own fold and hide, and the org's coach marks seen. */
export function set(user: string, patch: { collapsed?: unknown; dismissed?: unknown; coachSeen?: unknown }): boolean {
  const state = config.get().onboarding;
  if (!state) return false;
  const mine = { ...(state.by[user] ?? blank()) };
  if (typeof patch.collapsed === 'boolean') mine.collapsed = patch.collapsed;
  if (patch.dismissed === true) mine.dismissed = true;
  config.save({ onboarding: { ...state, coachSeen: state.coachSeen || patch.coachSeen === true, by: { ...state.by, [user]: mine } } });
  return true;
}
