// The reader's state of an open dashboard (legacy dashSelection.ts,
// snapshotAsOf.ts, fxUi.ts, dashShare.ts Present, commentPanel.ts) — none of
// it saved, none of it undoable, the same standing as a control's selection:
//
//   selection   sheet-wide filter steps the reader arrived with (a navigate
//               action's carry) or clicked into (a map mark); every tile reads them
//   tileSteps   per-tile narrowing from a `filter_target` action
//   clicks      click-to-filter: the marks the reader clicked, each attributed to
//               its card (filters.ts toggleClickFilter) — every OTHER card reads them
//   crumb      where a navigate action came FROM, for "From …" ← Back
//   asOf        the sheet read as of a snapshot time (KPI deltas then go: a past
//               figure against today's periods means nothing)
//   currency    the dashboard's own currency (fx settings), money shows in it
//   compare     the whole sheet against another period: every KPI shows its change
//               and every bar chart its figure then beside its figure now — the
//               server moves the date range in scope, exactly as a KPI card's own
//               Compare does
//   presenting  Present mode
//   comments    the comment panel's target, or null
//
// A navigation to ANOTHER dashboard is a route change (the editor remounts), so
// the carry and the crumb ride sessionStorage for exactly one open.

import { useCallback, useMemo, useState } from 'react';
import type { Step } from '../analyses/api';
import { toggleClickFilter, type ClickFilter, type ClickMark } from '../analyses/editor/filters';
import { useFx, type TargetKind } from './api';
import { linkedThread } from './CommentsPanel';

const NAV_KEY = 'ordinate.dashNav';

export interface Crumb {
  fromId: string;
  fromName: string;
  fromSheet?: string;
}
export type CommentTarget = { kind: TargetKind; id: string; point?: { label: string; series?: string } } | 'all' | null;

/** A comparison period, as a KPI card's `compare` is (dateIntel.sanitizeCompare). A custom one needs both dates. */
export type Compare = { mode: 'previous_period' | 'previous_year' | 'custom'; from?: string; to?: string };

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
  /** Click-to-filter (never saved): one entry per (card, column). */
  clicks: readonly ClickFilter[];
  /** A click on a mark of card `origin`; `additive` is ⌘/Ctrl held. */
  clickMark(origin: string, mark: ClickMark, additive: boolean): void;
  /** One chip's ×; no argument clears every click-filter (Esc, "Clear"). */
  clearClicks(one?: ClickFilter): void;
  crumb: Crumb | null;
  asOf: string | null;
  setAsOf(v: string | null): void;
  currency: string | undefined;
  /** The sheet's Compare, or null: off. Wins over a KPI card's own while it is on. */
  compare: Compare | null;
  setCompare(c: Compare | null): void;
  presenting: boolean;
  setPresenting(on: boolean): void;
  comments: CommentTarget;
  openComments(t: CommentTarget): void;
  /** A saved view applied (views/viewState.ts): its selection, narrowing and As of replace the reader's; click-filters go. */
  restore(selection: Step[], narrowed: ReadonlyMap<string, Step[]>, asOf: string | null): void;
}

/** What the dashboard opens on before the reader does anything: a saved view's part of the viewer state. */
export interface Opening {
  selection: Step[];
  narrowed: ReadonlyMap<string, Step[]>;
  asOf: string | null;
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

/** `steps` after `base`, a step already on staying once (addSelection's merge). */
const merged = (base: Step[], steps: Step[]): Step[] => {
  const keys = new Set(steps.map(stepKey));
  return [...base.filter((x) => !keys.has(stepKey(x))), ...steps];
};

export function useViewer(projectId: string, analysisId: string, opening?: Opening | null): Viewer & { arrivedSheet?: string } {
  const [arrived] = useState(() => takeNavigation(analysisId));
  // The opening view's selection first, then a navigation's carry.
  const [selection, setSelection] = useState<Step[]>(() => merged(opening?.selection ?? [], arrived?.carry ?? []));
  const [narrowed, setNarrowed] = useState<ReadonlyMap<string, Step[]>>(() => opening?.narrowed ?? new Map());
  const [clicks, setClicks] = useState<readonly ClickFilter[]>([]);
  const clickMark = useCallback((origin: string, mark: ClickMark, additive: boolean) => setClicks((c) => toggleClickFilter(c, origin, mark, additive)), []);
  const clearClicks = useCallback((one?: ClickFilter) => setClicks((c) => (one ? c.filter((x) => !(x.origin === one.origin && x.column === one.column)) : c.length ? [] : c)), []);
  const [asOf, setAsOf] = useState<string | null>(() => opening?.asOf ?? null);
  const restore = useCallback((sel: Step[], tiles: ReadonlyMap<string, Step[]>, at: string | null) => {
    setSelection(sel);
    setNarrowed(tiles);
    setAsOf(at);
    setClicks([]);
  }, []);
  const [compare, setCompare] = useState<Compare | null>(null);
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
      addSelection: (steps: Step[]) => setSelection((sel) => merged(sel, steps)),
      tileSteps: (cardId: string) => narrowed.get(cardId) ?? [],
      narrowed,
      narrow,
      unnarrow: (tiles: string[]) =>
        setNarrowed((m) => {
          const next = new Map(m);
          for (const t of tiles) next.delete(t);
          return next;
        }),
      clicks,
      clickMark,
      clearClicks,
      crumb: arrived?.crumb ?? null,
      arrivedSheet: arrived?.sheet,
      asOf,
      setAsOf,
      currency,
      compare,
      setCompare,
      presenting,
      setPresenting,
      comments,
      openComments,
      restore,
    }),
    [selection, toggleSelection, narrowed, narrow, clicks, clickMark, clearClicks, arrived, asOf, currency, compare, presenting, comments, restore],
  );
}
