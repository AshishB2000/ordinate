// The reader's state of an open dashboard (legacy dashSelection.ts,
// snapshotAsOf.ts, fxUi.ts, dashShare.ts Present, commentPanel.ts) — none of
// it saved, none of it undoable, the same standing as a control's selection:
//
//   selection   sheet-wide filter steps the reader arrived with (a navigate
//               action's carry) or clicked into (a map mark); every tile reads them
//   tileSteps   per-tile narrowing from a `filter_target` action
//   crumb       where a navigate action came FROM, for "From …" ← Back
//   asOf        the sheet read as of a snapshot time (KPI deltas then go: a past
//               figure against today's periods means nothing)
//   currency    the dashboard's own currency (fx settings), money shows in it
//   presenting  Present mode
//   comments    the comment panel's target, or null
//
// A navigation to ANOTHER dashboard is a route change (the editor remounts), so
// the carry and the crumb ride sessionStorage for exactly one open.

import { useCallback, useMemo, useState } from 'react';
import type { Step } from '../analyses/api';
import { useFx, type TargetKind } from './api';
import { linkedThread } from './CommentsPanel';

const NAV_KEY = 'ordinate.dashNav';

export interface Crumb {
  fromId: string;
  fromName: string;
  fromSheet?: string;
}
export type CommentTarget = { kind: TargetKind; id: string; point?: { label: string; series?: string } } | 'all' | null;

export interface Viewer {
  selection: Step[];
  toggleSelection(step: Step): void;
  removeSelection(step: Step): void;
  /** A same-dashboard navigation's carry: merged in, a step already on stays once. */
  addSelection(steps: Step[]): void;
  clearSelection(): void;
  tileSteps(cardId: string): Step[];
  narrowed: ReadonlyMap<string, Step[]>;
  narrow(tiles: string[], steps: Step[]): void;
  unnarrow(tiles: string[]): void;
  crumb: Crumb | null;
  asOf: string | null;
  setAsOf(v: string | null): void;
  currency: string | undefined;
  presenting: boolean;
  setPresenting(on: boolean): void;
  comments: CommentTarget;
  openComments(t: CommentTarget): void;
}

/** One step's identity — two clicks on the same mark are the same step (dashSelKey). */
export const stepKey = (s: Step): string => JSON.stringify([s.column, s.op, s.value ?? null, s.values ?? null, s.period ?? null]);

interface Pending {
  to: string;
  carry: Step[];
  crumb: Crumb | null;
  sheet?: string;
}

/** Leave for another dashboard carrying `carry`; the next open of `to` takes it. */
export function stashNavigation(p: Pending): void {
  try {
    sessionStorage.setItem(NAV_KEY, JSON.stringify(p));
  } catch {
    // private mode: the target opens without the carry
  }
}

function takeNavigation(analysisId: string): Pending | null {
  try {
    const raw = sessionStorage.getItem(NAV_KEY);
    sessionStorage.removeItem(NAV_KEY);
    const p = raw ? (JSON.parse(raw) as Pending) : null;
    return p && p.to === analysisId ? p : null;
  } catch {
    return null;
  }
}

export function useViewer(projectId: string, analysisId: string): Viewer & { arrivedSheet?: string } {
  const [arrived] = useState(() => takeNavigation(analysisId));
  const [selection, setSelection] = useState<Step[]>(() => arrived?.carry ?? []);
  const [narrowed, setNarrowed] = useState<ReadonlyMap<string, Step[]>>(() => new Map());
  const [asOf, setAsOf] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  // `?comment=<kind>:<id>` (Home's "Recent comments"): the thread opens on arrival.
  const [comments, openComments] = useState<CommentTarget>(() => {
    const l = linkedThread();
    return !l ? null : l.kind === 'analysis' ? 'all' : l;
  });
  const fx = useFx(projectId);
  const currency = fx.data?.settings.dashboards[analysisId] || undefined;

  const toggleSelection = useCallback((step: Step) => {
    setSelection((sel) => {
      const k = stepKey(step);
      if (sel.some((x) => stepKey(x) === k)) return sel.filter((x) => stepKey(x) !== k);
      // A click on a column already selected by `=` replaces that pick (dashSelToggle).
      return [...sel.filter((x) => !(x.column === step.column && x.op === '=' && step.op === '=')), step];
    });
  }, []);
  const narrow = useCallback((tiles: string[], steps: Step[]) => {
    setNarrowed((m) => {
      const k = JSON.stringify(steps.map(stepKey));
      const on = tiles.length > 0 && tiles.every((t) => JSON.stringify((m.get(t) ?? []).map(stepKey)) === k);
      const next = new Map(m);
      for (const t of tiles) {
        if (on || !steps.length) next.delete(t);
        else next.set(t, steps.slice());
      }
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      selection,
      toggleSelection,
      removeSelection: (step: Step) => setSelection((sel) => sel.filter((x) => stepKey(x) !== stepKey(step))),
      clearSelection: () => {
        setSelection([]);
        setNarrowed(new Map());
      },
      addSelection: (steps: Step[]) =>
        setSelection((sel) => {
          const keys = new Set(steps.map(stepKey));
          return [...sel.filter((x) => !keys.has(stepKey(x))), ...steps];
        }),
      tileSteps: (cardId: string) => narrowed.get(cardId) ?? [],
      narrowed,
      narrow,
      unnarrow: (tiles: string[]) =>
        setNarrowed((m) => {
          const next = new Map(m);
          for (const t of tiles) next.delete(t);
          return next;
        }),
      crumb: arrived?.crumb ?? null,
      arrivedSheet: arrived?.sheet,
      asOf,
      setAsOf,
      currency,
      presenting,
      setPresenting,
      comments,
      openComments,
    }),
    [selection, toggleSelection, narrowed, narrow, arrived, asOf, currency, presenting, comments],
  );
}
