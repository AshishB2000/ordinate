// The refresh URLs of a dataset, or of a connection — one URL for every
// dataset that came from it (live data L0.5; src/server/hooks/rpc.ts). The
// list never carries a token: only create's reply does, once, and the panel
// drops it when it closes.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';

/** What a URL refreshes: one dataset, or every dataset that came from one connection. */
export type HookTarget = { datasetId: string } | { connId: string };

export interface RefreshHook {
  id: string;
  /** `ordh_` + 8 characters: names the URL, cannot be used. */
  prefix: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** How the last call ended, `running` while it has not; null: no outcome recorded. */
  lastResult: 'running' | 'ok' | 'failed' | 'already_running' | null;
  lastFinishedAt: string | null;
  revokedAt: string | null;
}

const LAST_CALL = {
  running: { word: 'Refreshing', tone: 'accent' },
  ok: { word: 'Refreshed', tone: 'ok' },
  failed: { word: 'Refresh failed', tone: 'error' },
  already_running: { word: 'Joined a refresh', tone: 'warn' },
} as const;

/** How a URL's last call ended, as its row's badge says it — null when no outcome is known. */
export const lastCall = (h: RefreshHook) => (h.lastResult ? LAST_CALL[h.lastResult] : null);

export interface HookList {
  /** False on a server without Postgres. */
  available: boolean;
  /** REFRESH_HOOK_MIN_INTERVAL_SEC. */
  minIntervalSec: number;
  hooks: RefreshHook[];
}

export type Created = { ok: true; hook: RefreshHook; token: string } | { ok: false; error: string };

const KEY = 'refreshHook:list';

export function useRefreshHooks(projectId: string, target: HookTarget, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, projectId, target],
    queryFn: async () => (await rpc(KEY, { projectId, ...target })) as HookList,
    enabled,
    retry: (n, err) => (err as { status?: number }).status !== 403 && n < 2,
  });
}

export function useCreateHook(projectId: string, target: HookTarget) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => (await rpc('refreshHook:create', { projectId, ...target })) as Created,
    onSuccess: () => void client.invalidateQueries({ queryKey: [KEY, projectId, target] }),
  });
}

export function useRevokeHook(projectId: string, target: HookTarget) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await rpc('refreshHook:revoke', { projectId, id })) as { ok: boolean },
    onSuccess: () => void client.invalidateQueries({ queryKey: [KEY, projectId, target] }),
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
export function snippets(name: string) {
  const task = `refresh_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'dataset'}`;
  return {
    curl: `# The URL is a secret: keep it in your scheduler's secret store.
# --retry waits out a 429 (Retry-After) and tries again.
curl -fsS --retry 3 -X POST "$ORDINATE_REFRESH_URL"

# Optional: wait for the refresh, and fail this step if it failed.
# A GET of the same URL says how the last call ended.
while :; do
  s=$(curl -fsS --retry 3 "$ORDINATE_REFRESH_URL") || exit 1
  case "$s" in
    *'"running"'*) sleep 10 ;;
    *'"ok"'*) break ;;
    *) echo "$s" >&2; exit 1 ;;
  esac
done`,
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

# Optional: wait for the refresh, and fail the DAG if it failed.
# A GET of the same URL says how the last call ended.
from airflow.exceptions import AirflowFailException
from airflow.providers.http.sensors.http import HttpSensor

def landed(response):
    status = response.json()["status"]
    if status == "running":
        return False  # look again in poke_interval
    if status != "ok":
        raise AirflowFailException(f"Ordinate refresh: {status}")
    return True

${task}_landed = HttpSensor(
    task_id="${task}_landed",
    http_conn_id="ordinate",
    endpoint="api/hooks/refresh/{{ var.value.ordinate_refresh_token }}",
    response_check=landed,
    poke_interval=15,
    timeout=3600,
    mode="reschedule",
)
load_tables >> ${task} >> ${task}_landed`,
  };
}
