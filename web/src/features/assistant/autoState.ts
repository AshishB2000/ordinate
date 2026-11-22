// Auto (docs/agent-router): which conversations with no turns yet are asked with the router instead of a picked agent. A
// conversation is Auto when it was made that way (a new conversation, Home's ask bar, the picker's "Auto"); picking an agent
// makes the next one an ordinary one. Kept in memory for the tab, like the dock's other hand-overs (./dockState): a blank
// conversation reopened in a new tab is not Auto, and the person just picks.

import { useSyncExternalStore } from 'react';

/** The picker's value for Auto. */
export const AUTO = 'auto';

const marked = new Set<string>();
let version = 0;
const subs = new Set<() => void>();
const emit = (): void => {
  version += 1;
  subs.forEach((f) => f());
};

export function markAuto(threadId: string): void {
  if (threadId && !marked.has(threadId)) {
    marked.add(threadId);
    if (marked.size > 200) marked.delete(marked.values().next().value as string); // a tab never needs more than the newest few
    emit();
  }
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

/** Is this conversation an Auto one, now (no re-render: for a handler)? */
export const isMarked = (threadId: string): boolean => marked.has(threadId);

/** Is this blank conversation an Auto one? Re-renders when that changes. */
export function useIsAuto(threadId: string): boolean {
  useSyncExternalStore(subscribe, () => version);
  return marked.has(threadId);
}
