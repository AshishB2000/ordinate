// A story's undo / redo — the dashboards' own pure stack (dashHistory.ts
// dashHistNew / Push / Undo / Redo): snapshots with a label, keystrokes within
// COALESCE_MS merged into one step, a cap on depth. Pure; the page owns one.

export const COALESCE_MS = 1200;
const MAX = 100;

export interface Entry<T> {
  label: string;
  snap: T;
  at: number;
}
export interface History<T> {
  past: Entry<T>[];
  present: Entry<T>;
  future: Entry<T>[];
}

export function historyNew<T>(snap: T): History<T> {
  return { past: [], present: { label: '', snap, at: 0 }, future: [] };
}

/** Record a change. With `coalesce`, a change of the same label right after the last one replaces it. */
export function historyPush<T>(h: History<T>, label: string, snap: T, at: number, coalesce = false): History<T> {
  if (coalesce && h.past.length && h.present.label === label && at - h.present.at < COALESCE_MS) {
    return { past: h.past, present: { label, snap, at }, future: [] };
  }
  return { past: [...h.past, h.present].slice(-MAX), present: { label, snap, at }, future: [] };
}

/** Step back; the label of the change undone, or null when there is none. */
export function historyUndo<T>(h: History<T>): { h: History<T>; label: string } | null {
  const prev = h.past[h.past.length - 1];
  if (!prev) return null;
  return { h: { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] }, label: h.present.label };
}

export function historyRedo<T>(h: History<T>): { h: History<T>; label: string } | null {
  const next = h.future[0];
  if (!next) return null;
  return { h: { past: [...h.past, h.present], present: next, future: h.future.slice(1) }, label: next.label };
}

export const undoLabel = <T,>(h: History<T>): string => (h.past.length ? h.present.label : '');
export const redoLabel = <T,>(h: History<T>): string => (h.future[0] ? h.future[0].label : '');
