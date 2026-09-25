// First-run guidance — the Get-started checklist and the sample dashboard's
// coach marks. MAIN PROCESS ONLY.
//
// Started ONCE, by the sample seeder, so only a first launch ever sees it: an
// install that seeded before this existed has no `onboarding` block and gets
// neither the card nor the tour.
//
// THE TICKS COME FROM REAL RECORDS, not from button presses: "Import your data"
// is done when a dataset exists that is not the sample's, "Build a visual"
// when a visual exists that the seed did not make, "Create a dashboard" when
// a dashboard does, and "Set up the Assistant" when executionReady() says so.
// Each tick LATCHES into config the first time it is seen — deleting the one
// visual you made does not un-teach you how to make one — and once all four
// are latched nothing is scanned again.

import * as config from './config';
import * as execConfig from './execConfig';
import * as projects from './projects';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as analysis from '../analysis/analysis';

export type StepId = 'import' | 'visual' | 'dashboard' | 'assistant';
export const STEPS: StepId[] = ['import', 'visual', 'dashboard', 'assistant'];

export interface OnboardingState {
  startedAt: string;
  /** When each step was first seen done. */
  done: Partial<Record<StepId, string>>;
  /** The card is folded to the header's "2 of 4" pill. */
  collapsed: boolean;
  /** The card is gone for good. */
  dismissed: boolean;
  /** The sample dashboard's tour has been shown (once, ever). */
  coachSeen: boolean;
}

export interface OnboardingStatus {
  started: boolean;
  /** Show the card (or its pill): started, not dismissed, not finished. */
  show: boolean;
  collapsed: boolean;
  steps: Array<{ id: StepId; done: boolean }>;
  doneCount: number;
  total: number;
  /** Start the tour when the sample dashboard next opens. */
  coachPending: boolean;
  sample: { projectId: string; datasetId: string; analysisId: string } | null;
}

export function fresh(now = new Date()): OnboardingState {
  return { startedAt: now.toISOString(), done: {}, collapsed: false, dismissed: false, coachSeen: false };
}

/** Which of the three record steps the project tree already satisfies. */
async function scan(need: Set<StepId>): Promise<Set<StepId>> {
  const found = new Set<StepId>();
  const sample = config.get().sample;
  const seededVisuals = new Set(sample ? sample.visualIds : []);
  for (const p of await projects.listProjects()) {
    if (need.has('import') && !found.has('import')) {
      if ((await datasets.listDatasets(p.id)).some((d) => !sample || d.id !== sample.datasetId)) found.add('import');
    }
    if (need.has('visual') && !found.has('visual')) {
      if ((await visuals.listVisuals(p.id)).some((v) => !seededVisuals.has(v.id))) found.add('visual');
    }
    if (need.has('dashboard') && !found.has('dashboard')) {
      if ((await analysis.listAnalyses(p.id)).some((a) => !sample || a.id !== sample.analysisId)) found.add('dashboard');
    }
    if ([...need].every((s) => s === 'assistant' || found.has(s))) break;
  }
  return found;
}

export async function status(): Promise<OnboardingStatus> {
  const cfg = config.get();
  const state = cfg.onboarding;
  const sample = cfg.sample ? { projectId: cfg.sample.projectId, datasetId: cfg.sample.datasetId, analysisId: cfg.sample.analysisId } : null;
  if (!state) {
    return {
      started: false, show: false, collapsed: false, steps: STEPS.map((id) => ({ id, done: false })),
      doneCount: 0, total: STEPS.length, coachPending: false, sample,
    };
  }
  const done = { ...state.done };
  const now = new Date().toISOString();
  const need = new Set(STEPS.filter((s) => !done[s]));
  if (need.has('assistant') && execConfig.executionReady()) done.assistant = now;
  need.delete('assistant');
  if (need.size) for (const s of await scan(need)) done[s] = now;
  if (Object.keys(done).length !== Object.keys(state.done).length) config.save({ onboarding: { ...state, done } });
  const steps = STEPS.map((id) => ({ id, done: !!done[id] }));
  const doneCount = steps.filter((s) => s.done).length;
  return {
    started: true,
    show: !state.dismissed && doneCount < STEPS.length,
    collapsed: state.collapsed,
    steps, doneCount, total: STEPS.length,
    coachPending: !state.coachSeen,
    sample,
  };
}

/** The three things the renderer may change: fold, dismiss, tour seen. */
export function set(patch: { collapsed?: unknown; dismissed?: unknown; coachSeen?: unknown }): boolean {
  const state = config.get().onboarding;
  if (!state) return false;
  const next = { ...state };
  if (typeof patch.collapsed === 'boolean') next.collapsed = patch.collapsed;
  if (patch.dismissed === true) next.dismissed = true;
  if (patch.coachSeen === true) next.coachSeen = true;
  config.save({ onboarding: next });
  return true;
}
