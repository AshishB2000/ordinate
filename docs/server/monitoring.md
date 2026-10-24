# Monitoring

<sub>[← All operator docs](README.md)</sub>

Ordinate serves Prometheus metrics on `GET /metrics`, on its own port (`METRICS_PORT`, `9464` in the
chart and Compose) and never on the app port or behind the Ingress. Every figure is per pod; no
series carries an org label (tenant names stay out of your monitoring, and the label count stays
bounded).

## Scraping

- **Helm, without the Prometheus Operator:** the pods and the `<release>-ordinate-metrics` Service
  carry `prometheus.io/scrape` annotations (`metrics.annotations: true`).
- **Helm, with the Prometheus Operator:** set `metrics.serviceMonitor.enabled: true` (and
  `metrics.serviceMonitor.labels` to whatever your Prometheus selects ServiceMonitors by), then
  `metrics.prometheusRule.enabled: true` for the alerts below. Turn `metrics.annotations` off, or an
  annotation-based scrape config scrapes every pod twice.
- **Compose / ECS:** scrape `http://<host>:9464/metrics`.

## What saturates

| Series | Type | What it says |
|---|---|---|
| `ordinate_duckdb_queue_depth` | gauge | DuckDB calls handed to an org's worker that have not started yet, all orgs together. Each org has ONE DuckDB connection: its calls run one at a time. |
| `ordinate_duckdb_busy_workers` | gauge | Org DuckDB workers with a call waiting, running or leased to a compute thread. At most `DUCKDB_MAX_WORKERS`. |
| `ordinate_duckdb_wait_seconds` | histogram | From a DuckDB call being asked for to DuckDB starting it: the time spent behind other calls of the same org (and waiting for a new worker to start). One observation per call. |
| `ordinate_pg_pool_clients{state="total\|idle\|waiting"}` | gauge | The Postgres pool: connections open, idle, and queries waiting for one. At most `DATABASE_POOL_MAX` open. Absent without `DATABASE_URL`. |
| `ordinate_event_loop_delay_seconds{quantile="0.5\|0.9\|0.99\|1"}` | gauge | How late the event loop ran its timers over the last completed 30 s window (`1` is the max). One process serves every request: a blocked loop delays all of them. |
| `process_resident_memory_bytes` | gauge | The process's resident memory. DuckDB's own memory (80 % of the container limit by default) is part of it. |
| `nodejs_heap_used_bytes`, `nodejs_external_memory_bytes` | gauge | V8's heap in use, and memory outside it (Buffers). |
| `ordinate_sse_streams` | gauge | Open event streams: roughly the browser tabs connected to this pod. |
| `ordinate_live_queries_in_flight` | gauge | Live warehouse statements running from this pod (per org per pod at most `LIVE_MAX_CONCURRENT`). |
| `ordinate_draining` | gauge | `1` from SIGTERM until the pod exits ([shutdown](#shutdown)). |

And, unchanged: `ordinate_rpc_requests_total` / `_duration_seconds` (per RPC channel),
`ordinate_http_requests_total` / `_duration_seconds` (per route), `ordinate_jobs{state}`,
`ordinate_jobs_finished_total{kind,state}`, `ordinate_scheduled_job_runs_total`,
`ordinate_compute_pool_*` and `ordinate_resident_calls_total` (a `failed` outcome should stay 0).

## Alerts

`metrics.prometheusRule.enabled: true` installs these. Each one's `runbook_url` points here.

### DuckDB wait

`OrdinateDuckDBWaitHigh`: the p95 of `ordinate_duckdb_wait_seconds` is over 5 s for 10 minutes.
Queries queue behind each other inside one org's DuckDB worker.

1. Is it one org? `ordinate_duckdb_busy_workers` near `DUCKDB_MAX_WORKERS` means many orgs are
   active; a busy worker count of 1 with a deep `ordinate_duckdb_queue_depth` means one org.
2. Which channels are slow? `ordinate_rpc_request_duration_seconds` by channel.
3. Knobs: more cores per query (`DUCKDB_THREADS`), more workers (`DUCKDB_MAX_WORKERS`, with
   memory to match), or more replicas. A connection pool per org is the planned next step.

### Postgres pool waiting

`OrdinatePgPoolWaiting`: `ordinate_pg_pool_clients{state="waiting"}` above 0 for 5 minutes.
Requests wait for a database connection.

1. Is Postgres itself slow? Check its CPU and slow-query log first: a slow database holds
   connections longer.
2. Raise `DATABASE_POOL_MAX`, and keep Postgres `max_connections` ≥ pods × (`DATABASE_POOL_MAX` + 1
   for the event bus) + the migration Job + your own sessions ([sizing](sizing.md)).

### Event-loop delay

`OrdinateEventLoopLag`: the p99 event-loop delay is over 0.5 s for 5 minutes. Something blocks
the one thread every request shares.

1. Look for a channel whose latency jumped (`ordinate_rpc_request_duration_seconds`) and for
   CPU at the pod's limit.
2. Large in-memory work (an export of a very large project, a policy-masked export, a big
   synchronous parse) shows here. Give the pod more CPU, or spread users over more replicas.

### 5xx ratio

`Ordinate5xxRatio`: over 5 % of RPC and HTTP responses are 5xx for 10 minutes.

1. Read the pod logs at `error` level: every failed handler logs its channel (never its input).
2. A deploy's draining pods answer 503 for a few seconds by design; 10 minutes rules that out.
3. `ordinate_resident_calls_total{outcome="failed"}` above 0 points at the DuckDB fast path.

### Memory near the limit

`OrdinateMemoryNearLimit`: the container's working set is over 90 % of its memory limit for
5 minutes (needs cAdvisor and kube-state-metrics). The next spike is an OOM kill.

1. DuckDB takes 80 % of the limit by default (`DUCKDB_MEMORY_LIMIT`, split over
   `DUCKDB_MAX_WORKERS`): lower it to leave Node more room, or raise the limit.
2. `nodejs_heap_used_bytes` and `nodejs_external_memory_bytes` show Node's own share. Bundle
   imports, backups and restores hold at most one record (≤ 32 MiB) or one project's export in
   memory; a policy-masked export holds that dataset's rows.

### Container restarts

`OrdinateContainerRestarts`: the container restarted in the last 15 minutes.

1. `kubectl describe pod`: `OOMKilled` → see [memory](#memory-near-the-limit).
2. Otherwise the previous container's last lines: `kubectl logs --previous`. A fatal line at
   boot names the variable or the migration that stopped it.

## Shutdown

On SIGTERM (a rollout, a node drain, `docker compose stop`) the pod runs one sequence inside
`SHUTDOWN_GRACE_SECONDS` (20 s by default), and `ordinate_draining` reads `1` meanwhile:

1. `/readyz` answers 503 and new jobs are refused ("Ordinate is restarting. Try again in a minute.").
2. Running jobs get until half the budget, then are cancelled ("Ordinate restarted while this was
   running. Run it again."); the owner's open tab is told.
3. In-flight requests get until 70 % of the budget; any still running then is answered 503.
4. Every DuckDB query still running is interrupted, and every DuckDB worker is closed through its
   own queue — never torn down from outside, which aborts the process.
5. The pod exits 0.

If a DuckDB worker is still alive at 95 % of the budget, the pod logs `DuckDB workers still running
at the shutdown deadline` with the orgs, sets exit code 1 and keeps waiting for that worker: it
never exits around one. The orchestrator's kill after its grace period ends it. Keep
`SHUTDOWN_GRACE_SECONDS` below the grace: Kubernetes `terminationGracePeriodSeconds` minus the 5 s
`preStop` sleep (the chart refuses anything else), Compose `stop_grace_period` (30 s in
`deploy/docker-compose.yml`), ECS `stopTimeout` (30 s).
