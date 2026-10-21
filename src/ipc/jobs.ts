import { ipcMain } from './bus';
import * as jobs from '../app/jobs';
import { onPodCommand, toOtherPods } from '../server/podCommands';
import { publish } from '../server/sse';

// Jobs IPC — the Jobs popover's list, Cancel and Clear. The queue itself is
// src/app/jobs.ts.

/**
 * The server's Jobs channels (src/server/app.ts). A tab sees, cancels and
 * clears only its own user's jobs — the queue is shared by every org on the
 * pod — each as `jobs.publicJob` (no server path). No Reveal: there is no file
 * manager to open; an export's file reaches a tab as a download (T0.4).
 *
 * ANY POD (docs/any-pod/00-design.md §3.6). A job runs on the pod that took the
 * RPC which submitted it, and a call may land elsewhere, so each channel also
 * tells the other pods over the bus (../server/podCommands.ts):
 *   jobs:list    this pod answers its own slice; every other pod holding jobs
 *                for the caller publishes theirs to the caller's tabs, and the
 *                popover merges them (web/src/api/jobs.ts);
 *   jobs:cancel  a job not here is cancelled by the pod that holds it — job ids
 *                are UUIDs, so exactly one does; its own `jobs:changed` confirms;
 *   jobs:clear   every pod drops the caller's finished jobs.
 */
export function registerServer(): void {
  const owner = (): string => jobs.requestOwner() ?? '\u0000'; // outside a request: matches no job
  ipcMain.handle('jobs:list', () => {
    const me = owner();
    if (me !== '\u0000') toOtherPods('jobs:list', { owner: me });
    return jobs.snapshotFor(me);
  });
  ipcMain.handle('jobs:cancel', (_e, { id }: { id: string }) => {
    const me = owner();
    if (jobs.get(id)) return { ok: jobs.get(id)?.owner === me && cancelFor(me, id) };
    return { ok: me !== '\u0000' && toOtherPods('jobs:cancel', { owner: me, id }) };
  });
  ipcMain.handle('jobs:clear', () => {
    const me = owner();
    jobs.clearRecent(me);
    if (me !== '\u0000') toOtherPods('jobs:clear', { owner: me });
    return { ok: true };
  });

  onPodCommand('jobs:cancel', (d) => {
    const { owner: who, id } = (d ?? {}) as { owner?: unknown; id?: unknown };
    if (ownerOf(who) && typeof id === 'string' && jobs.get(id)?.owner === who) cancelFor(who as string, id);
  });
  onPodCommand('jobs:clear', (d) => {
    const who = (d as { owner?: unknown } | null)?.owner;
    if (ownerOf(who)) jobs.clearRecent(who as string);
  });
  onPodCommand('jobs:list', (d) => {
    const who = (d as { owner?: unknown } | null)?.owner;
    const target = ownerOf(who);
    if (!target) return;
    const snap = jobs.snapshotFor(who as string);
    if (snap.active.length || snap.recent.length) publish(target, 'jobs:changed', snap);
  });
}

/**
 * Cancels `id` and tells its owner's tabs — now ("Cancelling…") and when it ends. A job's own pushes go
 * to the tab that submitted it, which may be gone (a reload makes a new tab id): the tab that pressed
 * Cancel must still see it land, on whichever pod its stream is.
 */
function cancelFor(who: string, id: string): boolean {
  if (!jobs.cancel(id)) return false;
  const target = ownerOf(who);
  if (!target) return true;
  publish(target, 'jobs:changed', jobs.snapshotFor(who));
  const off = jobs.onFinish((j) => {
    if (j.id !== id) return;
    off();
    publish(target, 'jobs:changed', jobs.snapshotFor(who));
  });
  if (!jobs.get(id) || ['done', 'error', 'cancelled', 'interrupted'].includes(jobs.get(id)!.state)) off(); // a queued job ends at once
  return true;
}

/** `org\nemail` as a push target (the owner's tabs), or null for anything else. */
function ownerOf(who: unknown): { org: string; user: string } | null {
  if (typeof who !== 'string') return null;
  const i = who.indexOf('\n');
  return i > 0 && i < who.length - 1 ? { org: who.slice(0, i), user: who.slice(i + 1) } : null;
}
