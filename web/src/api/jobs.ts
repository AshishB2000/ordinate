// The Jobs popover's state: `jobs:list` once, then the server's pushes keep it
// live (`jobs:changed` = this tab's whole list, `jobs:finished` = one
// completion, which becomes a toast — the browser's stand-in for the desktop's
// OS notification). After a dropped stream the list is re-read: pushes sent
// while it was down are gone.

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

function snap(v: unknown): JobsSnapshot {
  const o = v && typeof v === 'object' ? (v as Partial<JobsSnapshot>) : {};
  return { active: Array.isArray(o.active) ? o.active : [], recent: Array.isArray(o.recent) ? o.recent : [] };
}

/** The list, kept live from the stream. Mount once (the shell's Jobs button). */
export function useJobs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: async () => snap(await rpc('jobs:list')) });
  useServerEvent('jobs:changed', (p) => qc.setQueryData(KEY, snap(p)));
  useServerEvent('jobs:finished', (p) => {
    const j = p as Job;
    if (!j || typeof j !== 'object' || j.silent) return;
    if (j.state === 'done') toast(`${j.label} — done`, { kind: 'success' });
    else if (j.state === 'error') toast(`${j.label} — ${j.error || 'failed'}`, { kind: 'error' });
  });
  useEffect(() => onReconnect(() => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
  return q;
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
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: () => toast('Could not clear finished jobs.', { kind: 'error' }),
  });
}
