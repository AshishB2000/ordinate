// A dataset's refresh URLs (live data L0.5; src/server/hooks/rpc.ts). The list
// never carries a token: only create's reply does, once, and the panel drops
// it when it closes.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';

export interface RefreshHook {
  id: string;
  /** `ordh_` + 8 characters: names the URL, cannot be used. */
  prefix: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface HookList {
  /** False on a server without Postgres. */
  available: boolean;
  /** REFRESH_HOOK_MIN_INTERVAL_SEC. */
  minIntervalSec: number;
  hooks: RefreshHook[];
}

export type Created = { ok: true; hook: RefreshHook; token: string } | { ok: false; error: string };

const KEY = 'refreshHook:list';

export function useRefreshHooks(projectId: string, datasetId: string, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, projectId, datasetId],
    queryFn: async () => (await rpc(KEY, { projectId, datasetId })) as HookList,
    enabled,
    retry: (n, err) => (err as { status?: number }).status !== 403 && n < 2,
  });
}

export function useCreateHook(projectId: string, datasetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => (await rpc('refreshHook:create', { projectId, datasetId })) as Created,
    onSuccess: () => void client.invalidateQueries({ queryKey: [KEY, projectId, datasetId] }),
  });
}

export function useRevokeHook(projectId: string, datasetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await rpc('refreshHook:revoke', { projectId, id })) as { ok: boolean },
    onSuccess: () => void client.invalidateQueries({ queryKey: [KEY, projectId, datasetId] }),
  });
}

/** The URL a pipeline calls, on this server as the browser reaches it. */
export const hookUrl = (token: string): string => `${window.location.origin}/api/hooks/refresh/${token}`;

/** "once a minute", "once every 90 seconds" — the server's interval in words. */
export function intervalText(sec: number): string {
  if (sec === 60) return 'once a minute';
  if (sec % 60 === 0) return `once every ${sec / 60} minutes`;
  return sec === 1 ? 'once a second' : `once every ${sec} seconds`;
}

/** The three ways to call it. The URL is a secret: every snippet reads it from the pipeline's own secret store. */
export function snippets(datasetName: string) {
  const task = `refresh_${datasetName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'dataset'}`;
  return {
    curl: `# The URL is a secret: keep it in your scheduler's secret store.\n# --retry waits out a 429 (Retry-After) and tries again.\ncurl -fsS --retry 3 -X POST "$ORDINATE_REFRESH_URL"`,
    dbt: `# dbt Core: call it from the step that runs dbt, once the models are built.\ndbt build && curl -fsS --retry 3 -X POST "$ORDINATE_REFRESH_URL"\n\n# dbt Cloud: Account settings → Webhooks → Create webhook,\n# event "Run completed", endpoint = the refresh URL.`,
    airflow: `from datetime import timedelta
# Older versions of the HTTP provider call it SimpleHttpOperator
from airflow.providers.http.operators.http import HttpOperator

# Connection "ordinate": host = ${window.location.origin}
# Variable "ordinate_refresh_token": the part after /api/hooks/refresh/
${task} = HttpOperator(
    task_id="${task}",
    http_conn_id="ordinate",
    endpoint="api/hooks/refresh/{{ var.value.ordinate_refresh_token }}",
    method="POST",
    response_check=lambda r: r.status_code == 202,
    retries=3,
    retry_delay=timedelta(seconds=60),  # a 429 means: called less than a minute ago
)
load_tables >> ${task}`,
  };
}
