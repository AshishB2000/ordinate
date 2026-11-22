// Autopilot's calls (src/api/autopilot.ts; src/server/autopilot/). Org admins only. A reply holds chart and dataset names, dates and
// counts the server made; nothing here adds, averages or rounds a figure (a time in ms is only shown as seconds).

import { useMutation, useQuery, useQueryClient, skipToken } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { rpc } from '../../api/client';
import { useServerEvent } from '../../api/events';
import { toast } from '../../ui/Toast';

export interface Settings {
  projectId: string;
  enabled: boolean;
  windowDays: number;
  slowSeconds: number;
  trashUnused: boolean;
  repairRenames: boolean;
  runAs: string | null;
  pausedReason: 'lost_admin' | null;
}
export type RunState = 'running' | 'done' | 'paused' | 'failed';
export interface Run {
  id: string;
  projectId: string;
  week: string | null;
  manual: boolean;
  state: RunState;
  ranAs: string | null;
  windowDays: number;
  coveredFrom: string | null;
  counts: Record<string, number>;
  startedAt: string;
  finishedAt: string | null;
}
export interface OverviewProject { id: string; name: string; settings: Settings; latest: Run | null; firstCleanup: string | null }

export type ItemKind = 'trashed' | 'repaired' | 'broken' | 'slow';
export interface Gone { column: string; why: 'none' | 'again' | 'target_missing' | 'repair_off' | 'other_fields'; suggest?: string }
export interface Item {
  seq: number;
  kind: ItemKind;
  visualId: string;
  name: string;
  state: 'applied' | 'listed' | 'undone' | 'failed';
  detail: { days?: number; why?: string; fixes?: Array<{ from: string; to: string }>; gone?: Gone[]; avgMs?: number; maxMs?: number; computes?: number; datasetName?: string };
}

type Failed = { ok: false; error: string };
const KEY = ['autopilot:overview'];

export function useOverview() {
  const qc = useQueryClient();
  useServerEvent('autopilot:report', () => void qc.invalidateQueries({ queryKey: KEY }));
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const r = (await rpc('autopilot:overview')) as { ok: true; projects: OverviewProject[] } | Failed;
      if (!r.ok) throw new Error(r.error === 'needs_database' ? 'Autopilot needs the organization’s database (it keeps its settings and reports there).' : r.error);
      return r.projects;
    },
  });
}

export type Patch = { enabled?: boolean; windowDays?: number; slowSeconds?: number; trashUnused?: boolean; repairRenames?: boolean };

export function useSave(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Patch) => {
      const r = (await rpc('autopilot:save', { projectId, ...patch })) as { ok: true } | Failed;
      if (!r.ok) throw new Error(r.error === 'out_of_range' ? 'That value is outside its limits.' : 'Autopilot could not be saved.');
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: (e: Error) => toast(e.message, { kind: 'error' }),
  });
}

export function useRunNow(projectId: string, onRun: (runId: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = (await rpc('autopilot:runNow', { projectId })) as { ok: true; runId: string } | Failed;
      if (!r.ok) throw new Error(r.error === 'off' ? 'Switch Autopilot on first.' : r.error === 'busy' ? 'A run for this project is already going.' : 'The run did not finish.');
      return r.runId;
    },
    onSuccess: (runId) => {
      void qc.invalidateQueries({ queryKey: KEY });
      onRun(runId);
    },
    onError: (e: Error) => toast(e.message, { kind: 'error' }),
  });
}

export function useRuns(projectId: string | undefined) {
  return useQuery({
    queryKey: ['autopilot:runs', projectId],
    queryFn: projectId ? async () => ((await rpc('autopilot:runs', { projectId })) as { ok: true; runs: Run[] }).runs : skipToken,
  });
}

export function useRun(projectId: string | undefined, runId: string | undefined) {
  return useQuery({
    queryKey: ['autopilot:run', projectId, runId],
    retry: false,
    queryFn: projectId && runId ? async () => {
      const r = (await rpc('autopilot:run', { projectId, runId })) as { ok: true; run: Run; items: Item[] } | Failed;
      if (!r.ok) throw new Error('This report could not be found.');
      return r;
    } : skipToken,
  });
}

const WHY: Record<string, string> = { changed: 'The chart was changed since, so it was left as it is.', not_applied: 'That was already undone.', gone: 'The chart is gone.', failed: 'It could not be undone.' };

export function useUndo(projectId: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (seq?: number) => {
      const r = (await rpc('autopilot:undo', { projectId, runId, ...(seq !== undefined ? { seq } : {}) })) as { ok: true; undone?: number; refused?: number } | Failed;
      if (!r.ok) throw new Error(WHY[r.error] ?? 'It could not be undone.');
      return r;
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['autopilot:run', projectId, runId] });
      void qc.invalidateQueries({ queryKey: ['trash:list'] });
      void qc.invalidateQueries({ queryKey: ['visual:list'] });
      toast(r.undone !== undefined ? `Undid ${r.undone} repair${r.undone === 1 ? '' : 's'}${r.refused ? `; ${r.refused} left as they are because the chart changed` : ''}.` : 'Undone.', { kind: 'success' });
    },
    onError: (e: Error) => toast(e.message, { kind: 'error' }),
  });
}

/** The toast an open tab gets when a report is ready (ids, names and counts only). */
export function useAutopilotNotice(): void {
  const navigate = useNavigate();
  useServerEvent('autopilot:report', (p) => {
    const n = (p ?? {}) as { projectId?: unknown; runId?: unknown; state?: unknown; on?: unknown };
    if (typeof n.projectId !== 'string' || typeof n.runId !== 'string') return;
    const on = typeof n.on === 'string' && n.on ? n.on : 'a project';
    const go = () => void navigate(`/autopilot/${n.projectId as string}/${n.runId as string}`);
    toast(n.state === 'paused' ? `Autopilot paused in ${on}` : `Autopilot report for ${on} is ready`, { action: { label: 'Open', onClick: go } });
  });
}
