// The Jobs popover's state: `jobs:list` once, then the server's pushes keep it
// live (`jobs:changed` = one pod's slice of this tab's or this user's jobs,
// `jobs:finished` = one completion, which becomes a toast — the browser's
// stand-in for the desktop's OS notification). After a dropped stream the list
// is re-read: pushes sent while it was down are gone.
//
// ANY POD: a job runs on the pod that took its RPC, and each pod pushes only its
// own jobs, tagged with its pod id. The list keeps ONE SLICE PER POD: a push
// replaces its pod's slice (pod A's push never erases pod B's jobs), and a
// `jobs:list` reply starts over — every other pod re-pushes its slice
// (src/ipc/jobs.ts), so a job no pod reports any more (a restart) is gone.

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

/** One slice per pod: what that pod last reported of this user's jobs. */
export type JobSlices = Record<string, JobsSnapshot>;
const podOf = (v: unknown): string => (v && typeof v === 'object' && typeof (v as { pod?: unknown }).pod === 'string' ? (v as { pod: string }).pod : '');

/** Every pod's slice as one list: running jobs by start, finished ones newest first. */
export function mergeSlices(slices: JobSlices | undefined): JobsSnapshot {
  const byId = new Map<string, Job>();
  for (const s of Object.values(slices ?? {})) for (const j of [...s.active, ...s.recent]) byId.set(j.id, j);
  const all = [...byId.values()];
  return {
    active: all.filter((j) => !FINAL.has(j.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    recent: all.filter((j) => FINAL.has(j.state)).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')).slice(0, MAX_RECENT),
  };
}

/**
 * A `jobs:list` reply STARTS the list over (the other pods re-push their slices: src/ipc/jobs.ts),
 * so a job no pod reports any more — its pod restarted — is gone. A finished job the reply still
 * has running (the reply raced its last push) stays finished.
 */
function fromReply(prev: JobSlices | undefined, reply: unknown): JobSlices {
  const finished = new Map(mergeSlices(prev).recent.map((j) => [j.id, j]));
  const s = snap(reply);
  const active = s.active.filter((j) => !finished.has(j.id));
  const recent = [...s.recent, ...s.active.filter((j) => finished.has(j.id)).map((j) => finished.get(j.id) as Job)];
  return { [podOf(reply)]: { active, recent } };
}

const listFn = (qc: ReturnType<typeof useQueryClient>) => async (): Promise<JobSlices> =>
  fromReply(qc.getQueryData<JobSlices>(KEY), await rpc('jobs:list'));

/** The list, kept live from the stream. Mount once (the shell's Jobs button). */
export function useJobs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: listFn(qc), select: mergeSlices });
  // A push REPLACES its own pod's slice; the other pods' stay.
  useServerEvent('jobs:changed', (p) => qc.setQueryData<JobSlices>(KEY, (prev) => ({ ...(prev ?? {}), [podOf(p)]: snap(p) })));
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
  return useQuery({ queryKey: KEY, queryFn: listFn(qc), select: mergeSlices });
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
      qc.setQueryData<JobSlices>(KEY, (prev) => (prev ? Object.fromEntries(Object.entries(prev).map(([pod, s]) => [pod, { active: s.active, recent: [] }])) : prev));
      return qc.invalidateQueries({ queryKey: KEY });
    },
    onError: () => toast('Could not clear finished jobs.', { kind: 'error' }),
  });
}
