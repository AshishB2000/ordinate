// The Pipelines page's server calls (src/api/prepare.ts, the pipelines block),
// narrowed from src/app/pipelineView.ts (PipelineView), src/app/pipelineSummary.ts
// and src/ipc/pipelines.ts. On the server a file / URL source's id arrives
// masked (src/app/pipelineIds.ts) — it is opaque here, as every id is.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import type { AutoRefreshEvery } from '../../api/datasets';

export type NodeKind = 'source' | 'dataset' | 'quality' | 'alert' | 'report' | 'publish';
export type RunStatus = 'ok' | 'failed' | 'blocked' | 'paused';

export interface NodeRun {
  id: string;
  trigger: 'manual' | 'schedule';
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempts: number;
  rows?: number;
  rowsBefore?: number;
  /** rows − rowsBefore, by the server, where both exist. */
  rowsDelta?: number;
  warnings: string[];
  errors: string[];
  note?: string;
}

export interface PipelineNode {
  id: string;
  kind: NodeKind;
  stage: number;
  name: string;
  sub: string;
  ref?: { type: string; id: string };
  schedule: {
    text: string;
    edit: 'dataset' | 'report' | null;
    every?: string;
    cadence?: string;
    at?: string;
    hasFolder?: boolean;
    /** A dataset's incremental refresh is on: every 5 or 15 minutes is allowed. */
    incremental?: boolean;
    /** Its last scheduled refresh took longer than the interval (the server decides). */
    behind?: boolean;
  };
  lastRun: { at: string; status: string; durationMs?: number } | null;
  nextRunAt: string | null;
  paused: boolean;
  runs: NodeRun[];
}

export interface PipelineView {
  ok: true;
  stages: string[];
  nodes: PipelineNode[];
  edges: { from: string; to: string }[];
  schedule: { cron: string; tz: string; paused: boolean; text: string; nextRunAt: string | null } | null;
  policy: { retries: number; backoffMs: number };
  tz: string;
  live: Record<string, 'queued' | 'running'>;
  summary: { stages: number; scheduled: number; failed: number; lastActivityAt: string | null };
}
export type PipelineReply = PipelineView | { ok: false; error: string; cycle?: string[] };

export const pipelineKey = (projectId: string) => ['pipelines:get', projectId] as const;

export function usePipeline(projectId: string | undefined) {
  return useQuery({
    queryKey: ['pipelines:get', projectId],
    queryFn: projectId === undefined ? skipToken : async () => (await rpc('pipelines:get', { projectId })) as PipelineReply,
  });
}

type Ok = { ok: true } | { ok: false; error?: string };

export const cronPreview = async (cron: string, tz: string) =>
  (await rpc('pipelines:preview', { cron, tz })) as { ok: boolean; text: string; next: string[] };
export const setSchedule = async (projectId: string, patch: { cron?: string | null; tz?: string; paused?: boolean }) =>
  (await rpc('pipelines:setSchedule', { projectId, ...patch })) as Ok;
export const setPolicy = async (projectId: string, retries: number, backoffMs: number) =>
  (await rpc('pipelines:setPolicy', { projectId, policy: { retries, backoffMs } })) as Ok;
export const setPaused = async (projectId: string, nodeId: string, paused: boolean) =>
  (await rpc('pipelines:setPaused', { projectId, nodeId, paused })) as Ok;
export const setNodeSchedule = async (projectId: string, nodeId: string, patch: { every?: 'off' | AutoRefreshEvery; cadence?: 'off' | 'daily' | 'weekly' | 'monthly'; at?: string }) =>
  (await rpc('pipelines:setNodeSchedule', { projectId, nodeId, ...patch })) as Ok;

export type RunReply = { ok: true; done: number; failed: number; blocked: number } | { ok: false; error: string };
export const runPipeline = async (projectId: string, nodeId?: string) =>
  (await rpc('pipelines:run', nodeId ? { projectId, nodeId } : { projectId })) as RunReply;
