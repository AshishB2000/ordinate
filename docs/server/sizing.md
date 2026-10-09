# Sizing

Every figure on this page is either **measured**, in which case it names the task in
`docs/phase-7-web/log.md` that measured it and the conditions, or **an estimate**, labelled as such.
The measurements come from developer machines, often under heavy load from parallel work. Read them
as ratios and orders of magnitude, not as guarantees for your hardware.

## Fixed limits

| Limit | Value | Where |
|---|---|---|
| Rows per dataset | 1,000,000 | `CLAUDE.md`, enforced on import |
| Upload size | `MAX_UPLOAD_MB`, 200 MB by default | [configuration.md](configuration.md#limits-and-egress) |
| One RPC | `RPC_TIMEOUT_SECONDS` (60 s); one DuckDB query, `DUCKDB_QUERY_TIMEOUT_SECONDS` (60 s) | same |
| Postgres connections per pod | 10 (fixed pool, `src/server/db/pool.ts`) | size `max_connections` ≥ 10 × pods + the migration Job + your sessions. A running dataset refresh holds one of the ten for its length — the lock that keeps two pods from refreshing one dataset at once — at most 3 per pod (the job limit) |
| Compute threads per pod | 3 (`src/engine/computePool.ts`) | each borrows its org's DuckDB worker |
| Regex threads per pod | 4, 2 s deadline per call (T6.4) | user regexes run off the request thread |

## The image

| | linux/amd64 | linux/arm64 |
|---|---|---|
| Uncompressed (`docker image inspect … .Size`, T7.3) | 583 MB | 589 MB |
| Compressed, what a node pulls (T7.3) | 136 MB | 133 MB |

Both stay under the 600 MB cap that CI and the release workflow enforce. The arm64 image is built
natively; amd64 was booted under emulation on arm64 and passed the full UI flow in S3 mode (T7.3).

## How memory is divided

Each org gets one DuckDB worker per pod, and `DUCKDB_MEMORY_LIMIT` caps each worker. By default the
cap is **80% of the container's memory limit ÷ `DUCKDB_MAX_WORKERS` (8)**. The cap limits what a
worker may use, not what it reserves; DuckDB spills to `DATA_DIR` beyond it.

**A deployment has one org** (`ORDINATE_ORG`), so it runs at most two workers: the org's, and a
tiny one `/readyz` starts before any request has. With the default divisor of 8, the org's worker
is capped at 10% of the pod's limit, about 205 MiB under the chart's default 2 GiB limit.

*Estimate, derived from the code and not load-tested:* for a single-org deployment, set
`DUCKDB_MAX_WORKERS=2`. The org's worker can then use up to 40% of the limit, while Node itself,
the S3 cache index, uploads in flight and the compute threads keep the rest. Alternatively, set
`DUCKDB_MEMORY_LIMIT` directly.

`DUCKDB_THREADS` defaults to `os.availableParallelism()`. Inside a container with a CPU limit, Node
24 derives that from the limit. Measured with `docker run --cpus` (Node v24.21.0, T7.3):

| `--cpus` | threads |
|---|---|
| 2 | 2 |
| 1.5 | 1 |
| 0.5 | 1 |
| no limit | every core of the node (10 here) |

On Kubernetes, set a CPU **limit**, or set `DUCKDB_THREADS` explicitly.

## Measured throughput

**Load test** (T4.3, `npm run loadtest`): 20 simulated users × 5 iterations against one 1M-row
dataset, over real HTTP, on one server process. 600 requests, 0 failed. Event-loop delay p99 was
**22.6 ms** at machine load 20.

| Operation | One user alone, p50 | 20 users at once, p50 / p95 |
|---|---|---|
| Data page (100 rows of 1M) | 34 ms | 324 / 673 ms |
| Sorted page | — | 589 / 869 ms |
| Chart (aggregate) | 33–43 ms | ~650–690 / ~835 ms |
| Column stats | 53 ms | 925 / 976 ms |

All requests of one org go through that org's one DuckDB connection, one at a time. That is why 20
concurrent users on one dataset see roughly 10–20× the single-user latency, even though the event
loop stays free. More pods spread the load, because each pod has its own worker.

**S3 vs disk** (T5.2, MinIO on loopback, 1M rows, 8.5 MiB table, median ms):

| | disk | S3 via httpfs | S3, pod cache hit |
|---|---|---|---|
| Page | 37.4 | 41.9 | 35.4 |
| Chart | 33.7 | 37.0 | 31.1 |
| First page, cold | 98 | 95 | 93 |

Under heavy machine load, a cold httpfs read took 4.6 s against 0.8 s from the cache. Keep
`STORAGE_CACHE_MB` above your hot tables.

**Storage footprint.** 500k rows ≈ 0.3 MB of Parquet for a narrow table (`CLAUDE.md`). The 1M-row
test table above is 8.5 MiB. Every table write is a new version. Superseded versions are deleted
`STORAGE_GC_GRACE_MINUTES` after nothing names them, so the bucket holds roughly current data plus
an hour of churn. Bucket versioning, if you turn it on, keeps more.

**Other figures:**

- A 150 MB upload added 18–78 MB of RSS over a ~140 MB idle process (T0.4).
- 1,000 idle event streams cost ~40 KB of RSS each (T0.5).
- A boot migrates in 163 ms on a fresh database and 34–63 ms when the schema is current (T7.2).
- On Compose, `/readyz` answers about 1 s after the container starts (T7.3).
- `helm install --wait` with two pods took 10–12 s on kind (T7.2, T7.3).

## Starting points (estimates)

None of these profiles was load-tested as a whole. Start here, then watch `/metrics`: RPC latency per
channel, compute-pool queue depth, and `residentTrace` `failed` counts. Also watch the pods'
memory.

| Team | Pods | Per pod (request → limit) | DuckDB settings | Postgres |
|---|---|---|---|---|
| Trial, ≤ 10 people | 1 (Compose or 1 replica) | 1 → 2 CPU, 1 → 2 GiB | `DUCKDB_MAX_WORKERS=2` | the Compose container, or the smallest managed instance |
| Team, ≤ 50 people | 2 | 1 → 2 CPU, 2 → 4 GiB | `DUCKDB_MAX_WORKERS=2`, `DUCKDB_THREADS=2` | 2 vCPU, `max_connections` ≥ 50 |
| Department, ≤ 200 people | 3–6 (HPA on CPU) | 2 → 4 CPU, 4 → 8 GiB | `DUCKDB_MAX_WORKERS=2`, `DUCKDB_THREADS=4` | 2–4 vCPU, `max_connections` ≥ 100 |

Two pods are the minimum for a rollout or a node drain without downtime: the PDB keeps one. More
than one pod needs sticky sessions at the load balancer ([eks.md](eks.md#5-values)) and S3 or a
ReadWriteMany volume for the tables.
