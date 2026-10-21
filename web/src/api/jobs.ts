// The Jobs popover's state: `jobs:list` once, then the server's pushes keep it
// live (`jobs:changed` = one pod's slice of this tab's or this user's jobs,
// `jobs:finished` = one completion, which becomes a toast — the browser's
// stand-in for the desktop's OS notification). After a dropped stream the list
// is re-read: pushes sent while it was down are gone.
//
// ANY POD: a job runs on the pod that took its RPC, and each pod pushes only its
// own jobs, so the list MERGES by job id (`mergeJobs`) instead of replacing —
// pod A's push must not erase pod B's jobs. `jobs:list` makes every other pod
// push its slice too (src/ipc/jobs.ts).

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '../ui/Toast';
import { rpc } from './client';
import { onReconnect, useServerEvent } from './events';

/** src/app/jobs.ts `Job`, as `jobs.publicJob` hands it to a tab. */
export interface Job {
  id: string;
  kind: string;
  label: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
  progress: number;
  note?: string;
  cancellable: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: { message?: string };
  error?: string;
  silent?: boolean;
}

export interface JobsSnapshot {
  active: Job[];
  recent: Job[];
}

const KEY = ['jobs:list'] as const;
const FINAL: ReadonlySet<Job['state']> = new Set(['done', 'error', 'cancelled', 'interrupted']);
/** The server keeps this many finished jobs (src/app/jobs.ts MAX_RECENT). */
const MAX_RECENT = 30;

function snap(v: unknown): JobsSnapshot {
  const o = v && typeof v === 'object' ? (v as Partial<JobsSnapshot>) : {};
  return { active: Array.isArray(o.active) ? o.active : [], recent: Array.isArray(o.recent) ? o.recent : [] };
}

/**
 * `next` (one pod's report) folded into the list so far, by job id. A finished
 * job is never revived by an older report that still had it running; running
 * jobs by start, finished ones newest first.
 */
export function mergeJobs(prev: JobsSnapshot | undefined, next: JobsSnapshot): JobsSnapshot {
  const byId = new Map<string, Job>();
  for (const j of [...(prev?.active ?? []), ...(prev?.recent ?? [])]) byId.set(j.id, j);
  for (const j of [...next.active, ...next.recent]) {
    const had = byId.get(j.id);
    if (had && FINAL.has(had.state) && !FINAL.has(j.state)) continue;
    byId.set(j.id, j);
  }
  const all = [...byId.values()];
  return {
    active: all.filter((j) => !FINAL.has(j.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    recent: all.filter((j) => FINAL.has(j.state)).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')).slice(0, MAX_RECENT),
  };
}

const listFn = (qc: ReturnType<typeof useQueryClient>) => async (): Promise<JobsSnapshot> =>
  mergeJobs(qc.getQueryData<JobsSnapshot>(KEY), snap(await rpc('jobs:list')));

/** The list, kept live from the stream. Mount once (the shell's Jobs button). */
export function useJobs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: listFn(qc) });
  useServerEvent('jobs:changed', (p) => qc.setQueryData<JobsSnapshot>(KEY, (prev) => mergeJobs(prev, snap(p))));
  useServerEvent('jobs:finished', (p) => {
    const j = p as Job;
    if (!j || typeof j !== 'object' || j.silent) return;
    if (j.state === 'done') toast(`${j.label} — done`, { kind: 'success' });
    else if (j.state === 'error') toast(`${j.label} — ${j.error || 'failed'}`, { kind: 'error' });
  });
  useEffect(() => onReconnect(() => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
  return q;
}

/** The same live list, read elsewhere (the shell's `useJobs` keeps it current; this registers no handlers of its own). */
export function useJobList() {
  const qc = useQueryClient();
  return useQuery({ queryKey: KEY, queryFn: listFn(qc) });
}

export function useCancelJob() {
  return useMutation({
    mutationFn: async (id: string) => rpc('jobs:cancel', { id }),
    onError: () => toast('Could not cancel that job.', { kind: 'error' }),
  });
}

export function useClearJobs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => rpc('jobs:clear'),
    // Every pod cleared them; a pod left with nothing finished pushes nothing, so drop them here, then re-read.
    onSuccess: () => {
      qc.setQueryData<JobsSnapshot>(KEY, (prev) => (prev ? { active: prev.active, recent: [] } : prev));
      return qc.invalidateQueries({ queryKey: KEY });
    },
    onError: () => toast('Could not clear finished jobs.', { kind: 'error' }),
  });
}
