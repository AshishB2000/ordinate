# Configuration reference

Every environment variable the Ordinate server reads. The server reads its configuration once at
startup and validates it there (`src/server/env.ts`). A bad value stops the process with one line
that names the variable, for example `ordinate: AUTH_MODE must be one of password|oidc|header|dev, got "sso"`.
It does not crash later. The Helm chart's migration Job reads the same environment, so a typo stops
`helm upgrade` before any pod rolls.

Columns:

- **Default** is the code's default. The image (`deploy/Dockerfile`) sets five of them itself:
  `ORDINATE_ENV=prod`, `PORT=8080`, `DATA_DIR=/data`,
  `DUCKDB_EXTENSION_DIR=/opt/ordinate/duckdb-extensions` and `NODE_ENV=production`.
- **Required when** gives the condition under which startup refuses to go on without the variable.
- **Secret** set to *yes* means the value goes in a Secret: a Kubernetes Secret (the chart's
  `existingSecret`, which the chart refuses to take in `config`), an ECS `secrets` entry, or the
  Compose `.env`. Never put a secret in values, a task definition's `environment` block, or a log.

`scripts/test-serverDocs.ts` (part of `npm test`) fails when a variable the code reads is missing
from these tables, or when a table names one that no code reads.

## Process and listeners

| Variable | Purpose | Default | Required when | Secret |
|---|---|---|---|---|
| `ORDINATE_ENV` | `dev` or `prod`. `prod` refuses `AUTH_MODE=dev`, requires `DATA_DIR`, uses `__Host-` Secure cookies, accepts only `https://` OIDC URLs, and listens on `0.0.0.0` (dev listens on `127.0.0.1` only). | `dev` (the image sets `prod`) | always `prod` in a deployment | no |
| `PORT` | The app port: the web app, `/api/*`, `/healthz`, `/readyz`. `0` lets the OS pick one. | `8080` | — | no |
| `METRICS_PORT` | Port for `GET /metrics` (Prometheus text format) on its own listener, so the ingress that routes `PORT` can never expose it. It must differ from `PORT`. | unset: no metrics listener (the chart and Compose set `9464`) | — | no |
| `LOG_LEVEL` | pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs are JSON on stdout. | `info` | — | no |

## Storage

| Variable | Purpose | Default | Required when | Secret |
|---|---|---|---|---|
| `DATA_DIR` | Absolute directory for per-org temp files, uploads in flight and the local cache of S3 tables. Without S3 the Parquet tables live here too, and so do the records when there is no `DATABASE_URL`. | `./data` (the image sets `/data`) | `ORDINATE_ENV=prod`, unless `STORAGE_URL=file://…` names the directory | no |
| `STORAGE_URL` | Where Parquet tables live. Unset or `file:///abs/dir` (the same directory as `DATA_DIR`) keeps them on disk. `s3://bucket/optional/prefix` stores them as immutable, versioned objects read through DuckDB `httpfs`. | unset: on `DATA_DIR` | more than one replica without a ReadWriteMany volume (operational, not checked) | no |
| `S3_REGION` | Region of the bucket. Read only when `STORAGE_URL` is `s3://`. | `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1` | — | no |
| `AWS_REGION` | Fallback for `S3_REGION`. EKS (IRSA) and ECS usually inject it. | unset | — | no |
| `AWS_DEFAULT_REGION` | Second fallback for `S3_REGION`. | unset | — | no |
| `S3_ENDPOINT` | `http(s)://host[:port]` of an S3-compatible store (MinIO, Ceph, R2). When it is set, requests use path-style URLs; `http://` turns TLS off. | unset: AWS S3 | — | no |
| `STORAGE_CACHE_MB` | Per-pod LRU cache of S3 Parquet on `DATA_DIR`. `0` turns it off. Keep the volume larger than this value. | `2048` | — | no |
| `STORAGE_GC_GRACE_MINUTES` | A table version that no record names is deleted from the bucket this long after it was first seen unreferenced. The `storage:gc` job runs every 15 min per org. | `60` | — | no |
| `DUCKDB_EXTENSION_DIR` | Absolute directory holding DuckDB's `httpfs` and `aws` extensions. The server only LOADs them and never downloads at run time. Read only when `STORAGE_URL` is `s3://`. | DuckDB's default (the image sets `/opt/ordinate/duckdb-extensions`, baked at build) | — | no |

## Metadata database and secrets

| Variable | Purpose | Default | Required when | Secret |
|---|---|---|---|---|
| `DATABASE_URL` | Postgres URL (`postgres://` or `postgresql://`) for users, passwords, sessions, roles, records, jobs, audit and secrets. Without it only `AUTH_MODE=dev` starts (Ordinate's automated tests). TLS options go in the query string, see [TLS to Postgres](#tls-to-postgres). The value never appears in an error or a log. | unset: no Postgres, records stay as JSON under `DATA_DIR` | `AUTH_MODE` is `password` (the default), `oidc` or `header`, or `STORAGE_URL` is `s3://` | yes |
| `ORDINATE_MASTER_KEY` | 32 random bytes, written as base64 (44 chars) or hex (64 chars), made with `openssl rand -base64 32`. It wraps each org's data key, and those keys encrypt every stored connection password and AI provider key (AES-256-GCM). Without it, saving such a secret is refused. Losing it loses those secrets. | unset: no secrets store | `ORDINATE_ENV=prod` and `DATABASE_URL` is set | yes |
| `ORDINATE_MASTER_KEY_OLD` | Rotation only: the current key, read by `node src/server/secrets/rotate.js` (`npm run secrets:rotate`). The server never reads it. | unset | running the rotation command | yes |
| `ORDINATE_MASTER_KEY_NEW` | Rotation only: the replacement key, read by the same command. | unset | running the rotation command | yes |

## Sign-in

| Variable | Purpose | Default | Required when | Secret |
|---|---|---|---|---|
| `AUTH_MODE` | `password`: Ordinate's own email + password accounts, for trying Ordinate out. At the first start the server logs a one-time setup code that creates the first admin; the server warns at every start that this mode is not for real use. `oidc`: Ordinate signs people in with your IdP. `header`: it trusts `X-Forwarded-Email` from a proxy in `TRUSTED_PROXY_CIDRS` (oauth2-proxy). `dev`: every request is an admin, with no Postgres; only when set explicitly, for Ordinate's automated tests, and refused when `ORDINATE_ENV=prod`. See [sso.md](sso.md). | `password` | always `oidc` or `header` in a real deployment | no |
| `ORDINATE_ORG` | The org every sign-in joins (one org per deployment). Lower-case letters, digits and `-`, up to 63 characters. | `default` | — | no |
| `ORDINATE_ADMIN_EMAIL` | Made (or kept) org admin at every sign-in. Under SSO this is the first admin and the way back in; every other new user joins as a viewer. Under `password` the setup code makes the first admin, and this address, if it has an account, is made admin again when it signs in. | unset | — (under SSO, without it nobody can grant roles) | no |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated email domains that may sign in, for example `example.com,example.org`. | unset: any domain the IdP or proxy lets through | — | no |
| `SESSION_IDLE_MINUTES` | A session with no request for this long is signed out. | `480` (8 h) | — | no |
| `SESSION_ABSOLUTE_HOURS` | A session ends this long after sign-in, however active. | `168` (7 days) | — | no |
| `OIDC_ISSUER` | The IdP's issuer URL, exactly as the `issuer` field of its discovery document. Ordinate fetches `<issuer>/.well-known/openid-configuration` at the first sign-in and retries if that fails. Must be `https://` in prod. | unset | `AUTH_MODE=oidc` | no |
| `OIDC_CLIENT_ID` | The client (application) ID registered at the IdP. | unset | `AUTH_MODE=oidc` | no |
| `OIDC_CLIENT_SECRET` | That client's secret. Sent to the token endpoint as `client_secret_post`. | unset | `AUTH_MODE=oidc` | yes |
| `OIDC_REDIRECT_URL` | This server's callback, `https://<your host>/api/auth/callback`, registered at the IdP character for character. Must be `https://` in prod. | unset | `AUTH_MODE=oidc` | no |
| `TRUSTED_PROXY_CIDRS` | Comma-separated IPv4/IPv6 CIDRs of the proxies directly in front of the pod. In every mode, their `X-Forwarded-For` names the client for rate limits. In `header` mode they are also the only peers whose `X-Forwarded-Email` is believed. The check uses the TCP peer address, never a header. Keep it as narrow as the proxy. | unset | `AUTH_MODE=header` | no |

## Limits and egress

| Variable | Purpose | Default | Required when | Secret |
|---|---|---|---|---|
| `MAX_UPLOAD_MB` | Largest file `POST /api/files` accepts, in MB. Uploads stream to disk and are cut at the cap without buffering. | `200` | — | no |
| `MAX_RPC_BODY_KB` | Cap on every JSON request body, in KB. Larger bodies get 413. | `1024` | — | no |
| `RPC_TIMEOUT_SECONDS` | A call running longer gets 504, and its DuckDB queries are interrupted. | `60` | — | no |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | Sign-in starts plus IdP callbacks, per client IP. Calls of [refresh URLs](live-data.md#refresh-url) get a bucket of their own of the same size. | `60` | — | no |
| `RATE_LIMIT_RPC_PER_MINUTE` | RPC and `/api/mcp` calls per signed-in user, across all their tabs and tokens. | `1200` | — | no |
| `RATE_LIMIT_RPC_IP_PER_MINUTE` | RPC and `/api/mcp` calls per client IP. | `3000` | — | no |
| `SSRF_ALLOW` | Comma-separated CIDRs that connectors, URL sources and AI gateways may reach even though they are private, loopback or link-local. Everything else in those ranges, including cloud metadata, is refused before a socket opens. List your internal database subnets here. `0.0.0.0/0` turns the guard off. | unset: no private range allowed | a connector reads a database inside your VPC | no |

## Warehouses and live data

Bounds on what a connection may cost in the warehouse it reads. See [live-data.md](live-data.md).

| Variable | Purpose | Default | Required when | Secret |
|---|---|---|---|---|
| `LIVE_MAX_BYTES_BILLED` | The most a single BigQuery query may bill, in bytes. Every query a BigQuery connection runs carries BigQuery's `maximumBytesBilled` = the lower of this and the connection's own "Max bytes billed per query", so a query over it fails before it runs, at no charge. A whole number of bytes, no unit. | `10737418240` (10 GiB) | — | no |
| `LIVE_QUERY_TIMEOUT_MS` | How long one warehouse statement of a Live dataset may run, in milliseconds (100 – 3600000). Past it the statement is cancelled in the warehouse, and the figure is the last cached answer, labelled stale, or an error. A viewer who closes the tab cancels it too. | `60000` | — | no |
| `LIVE_MAX_CONCURRENT` | Live warehouse statements in flight at once, per org, in each pod (1 – 1000). More wait their turn; one that is cancelled while waiting never reaches the warehouse. N pods allow N × this. | `4` | — | no |
| `LIVE_DAILY_QUERY_LIMIT` | Warehouse statements Live datasets may send per org per UTC day (0 – 1000000000; `0` = no limit). Counted in Postgres across every pod, so N pods share one limit; without `DATABASE_URL` each pod counts its own. Past it, a figure is the last cached answer, labelled stale, or a refusal saying so, until 00:00 UTC; the org's admins get one notice the first time. Admin → Live usage shows the count per day and connection. | `10000` | — | no |
| `LIVE_MIN_CACHE_AGE_PUBLIC_SEC` | The least age, in seconds, a Live figure has on a published `/p/` page, whatever the dataset's own cache age (0 – 2592000; `0` = no floor), so a public link cannot be used to run up the warehouse bill. Signed-in requests keep the dataset's own age. | `60` | — | no |
| `REFRESH_HOOK_MIN_INTERVAL_SEC` | The least gap, in seconds, between two calls of one [refresh URL](live-data.md#refresh-url). A call inside it gets `429` with `Retry-After` and starts nothing. Kept in Postgres, so it holds across every pod. Each refresh URL has its own clock; per client IP, refresh URL calls also share a bucket the size of `RATE_LIMIT_LOGIN_PER_MINUTE`. | `60` | — | no |
| `FRESH_ON_ASK_WAIT_MS` | How long a chart, KPI or answer on a stale copy with "Fresh on ask" waits for its incremental pull, in milliseconds. Landed in time: the answer has the new rows. Not yet: the answer comes from the copy marked "refreshing…", and open dashboards redraw when the rows land. `0` never waits. At most `30000`; keep it well under `RPC_TIMEOUT_SECONDS`. See [live-data.md](live-data.md#fresh-on-ask). | `5000` | — | no |

## DuckDB

Each org gets its own DuckDB worker, locked to that org's directory and S3 prefix before it answers.

| Variable | Purpose | Default | Required when | Secret |
|---|---|---|---|---|
| `DUCKDB_MAX_WORKERS` | Org workers alive at once in one pod. Past this, the least recently used idle worker is closed. | `8` | — | no |
| `DUCKDB_MEMORY_LIMIT` | DuckDB `memory_limit` per worker, for example `512MiB` or `2GB`. | 80% of the container's memory limit (the machine's memory if there is none) ÷ `DUCKDB_MAX_WORKERS`, at least `64MiB` | — | no |
| `DUCKDB_THREADS` | DuckDB `threads` per worker. | `os.availableParallelism()`: the container's CPU limit rounded down, minimum 1 (measured: `--cpus=2` gives 2, `1.5` gives 1, `0.5` gives 1), or every node core when there is no limit | no CPU limit is set (operational) | no |
| `DUCKDB_QUERY_TIMEOUT_SECONDS` | A single query running longer is interrupted. | `60` | — | no |
| `DUCKDB_IDLE_SECONDS` | A worker unused this long is closed and its memory returned. | `300` | — | no |

## Development and tests only

Do not set these in a deployment. They are listed because server code reads them.

| Variable | Purpose | Default | Required when | Secret |
|---|---|---|---|---|
| `ORDINATE_COMPUTE_INLINE` | `1` runs compute-pool work on the main thread. Self-checks use it. On a server it stalls every request while a query runs. | unset | never | no |
| `ORDINATE_DUCKDB_PIPELINE` | `1` lets an unforced prepare pipeline run on DuckDB. Since T4.2 no shipped code path calls it unforced, so it has no effect on the server. | unset | never | no |
| `ORDINATE_TODAY` | Pins "today" (`YYYY-MM-DD`) for relative-date filters. Smoke tests use it. | unset: the server's local date | never | no |
| `ORDINATE_SAAS_FIXTURE_BASE` | Points SaaS connectors at a loopback fixture server (`http://127.0.0.1:<port>` only) for tests. | unset | never | no |
| `ORDINATE_TEST_LIVE_FAKE` | `1` registers the test harness's fake warehouse (DuckDB, `scripts/liveFakeConnector.ts`) so the e2e can drive a Live dataset. Never offered in the connection picker. Refused with `ORDINATE_ENV=prod`, and the image does not contain it. | unset | never | no |

## Read by libraries, not by Ordinate

These never appear in Ordinate's code. They are listed here, outside the tables, because they decide
how the pod authenticates to S3 and trusts Postgres.

- **AWS credential chain.** Both DuckDB's S3 secret (`PROVIDER credential_chain`, in every org
  worker) and the server's few direct S3 calls (`src/engine/s3.ts`) resolve credentials through
  DuckDB's `aws` extension, which follows the AWS SDK's default chain. That chain covers environment keys `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, shared config (`AWS_PROFILE`), web identity
  (`AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`, which EKS IRSA injects), the ECS task role
  (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, which ECS injects), and the instance profile. Use static
  keys only for an S3-compatible store with no pod identity (MinIO), and put them in the Secret.
  IRSA and the ECS task role were not tested against real AWS for this release. MinIO with static
  keys was (T5.2, T7.1, T7.3).
- **`NODE_EXTRA_CA_CERTS`**: a PEM bundle Node adds to its trusted roots. You need it for
  `sslmode=verify-full` to a Postgres whose certificate comes from a private CA, such as Amazon RDS.
- `NODE_ENV`: the image sets `production`. Ordinate's code never reads it.

## TLS to Postgres

`DATABASE_URL` takes the `pg` driver's query-string options (`pg-connection-string` 2.14 in this
release):

| `sslmode=` | What happens |
|---|---|
| unset or `disable` | Plaintext. Use it only on a network you trust end to end, such as Compose's private network. |
| `verify-full` (also `require`, `prefer` and `verify-ca`, which this driver treats as `verify-full` and warns about) | TLS, with the server certificate checked against Node's trusted roots. A public CA works as is. A private CA (Amazon RDS, Azure, Cloud SQL server certs) needs `NODE_EXTRA_CA_CERTS`, or `sslrootcert=/path/ca.pem` in the URL, pointing at a file inside the container. |
| `no-verify` | TLS without checking the certificate. Traffic is encrypted, but a host that can intercept it inside your network can impersonate the database. |

The chart and the image mount no CA file today. To verify a private CA, build a derived image, as
described in [eks.md](eks.md#rds), or accept `sslmode=no-verify` as a deliberate choice.
