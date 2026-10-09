# Warehouses and live data

This page is for the team that connects Ordinate to a cloud warehouse. It covers what each warehouse
needs on its side (a read-only identity) and on yours (network egress). The plan behind it is
[docs/live-data/00-plan.md](../live-data/00-plan.md). It also covers the [refresh URL](#refresh-url)
that dbt or Airflow calls when new data has landed, the [schema sync](#schema-sync) a Live
dataset runs, and [fresh on ask](#fresh-on-ask) for the copies of operational databases. Sections
for cost limits and cache ages are added by the tasks that build them.

## Snowflake

Ordinate talks to Snowflake over its **SQL API** (HTTPS and JSON, no driver). A connection needs an
account identifier, a user, a warehouse, a role, and one of two credentials:

- **Key pair** (recommended): the user's RSA private key, PEM, PKCS#8, encrypted or not, plus its
  passphrase when encrypted. Ordinate signs a short-lived token (a `KEYPAIR_JWT`, valid at most one
  hour) with it for each connection; the private key itself is never sent anywhere.
- **Programmatic access token** (PAT): sent as the bearer token.

Ordinate does not offer password-only sign-in, which Snowflake is retiring. Both credentials are
stored in the encrypted secrets store (`ORDINATE_MASTER_KEY` and `DATABASE_URL`). The key goes in the
connection's `token` slot and its passphrase in `password`. Neither is ever sent to a browser: the
connection form shows "Key saved", and **Replace** takes a new key, tests it, and keeps it only if
the test passes.

### Read-only is your role's job

Snowflake's SQL API has no read-only session. **Ordinate never writes**, but the guard against a
write is the role the connection signs in with. **Test connection** warns when that role is
`ACCOUNTADMIN`, `SYSADMIN` or `SECURITYADMIN`. It does not see a custom role that has been granted
one of those, so keep the grants below as they are.

A read-only role, a warehouse for it, and a service user that can only sign in with a key pair:

```sql
USE ROLE SECURITYADMIN;

CREATE ROLE IF NOT EXISTS ORDINATE_READER COMMENT = 'Ordinate: read-only';

-- Run queries on one warehouse (a small, dedicated one keeps the bill readable).
GRANT USAGE ON WAREHOUSE ORDINATE_WH TO ROLE ORDINATE_READER;

-- Read one database: existing and future schemas, tables and views.
GRANT USAGE ON DATABASE SALES TO ROLE ORDINATE_READER;
GRANT USAGE ON ALL SCHEMAS IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT SELECT ON ALL TABLES IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT SELECT ON FUTURE TABLES IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT SELECT ON ALL VIEWS IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT SELECT ON FUTURE VIEWS IN DATABASE SALES TO ROLE ORDINATE_READER;

-- A service user: no password, key-pair sign-in only.
USE ROLE USERADMIN;
CREATE USER IF NOT EXISTS ORDINATE_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = ORDINATE_READER
  DEFAULT_WAREHOUSE = ORDINATE_WH;

USE ROLE SECURITYADMIN;
GRANT ROLE ORDINATE_READER TO USER ORDINATE_SVC;
```

Grant nothing else to `ORDINATE_READER`: no `OWNERSHIP`, no `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`, no
`CREATE` on a schema, and no other role.

### The key pair

Generate an encrypted key (you are asked for its passphrase) and its public half:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -v2 aes-256-cbc -inform PEM -out ordinate_svc.p8
openssl rsa -in ordinate_svc.p8 -pubout -out ordinate_svc.pub
```

Give Snowflake the public key: the body of `ordinate_svc.pub`, without its `-----BEGIN/END-----`
lines.

```sql
USE ROLE SECURITYADMIN;
ALTER USER ORDINATE_SVC SET RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…';
DESC USER ORDINATE_SVC;  -- RSA_PUBLIC_KEY_FP is the SHA256:… fingerprint Ordinate's token names
```

In Ordinate, paste the whole of `ordinate_svc.p8` (including its `-----BEGIN ENCRYPTED PRIVATE
KEY-----` line) into **Private key or access token**, and the passphrase into **Private key
passphrase**. To rotate: set `RSA_PUBLIC_KEY_2` to the new public key, **Replace** the key in
Ordinate, then unset the old one.

A PAT instead: `ALTER USER ORDINATE_SVC ADD PROGRAMMATIC ACCESS TOKEN ordinate ROLE_RESTRICTION =
'ORDINATE_READER';`, then choose **Programmatic access token** and paste the token. By default
Snowflake accepts a PAT only from a user under a network policy, so put your Ordinate egress
addresses in one.

### The account identifier and the network

The **Account** field takes your account identifier, `myorg-myaccount` or a locator such as
`xy12345.us-east-2.aws`. It does not take a URL. Ordinate builds the address itself,
`https://<account>.snowflakecomputing.com`, and refuses anything that is not an identifier (letters,
digits, `_` and `-`, at most four dot-separated parts). So a connection can only reach a subdomain of
`snowflakecomputing.com` (threat model R-L4).

Ordinate's pods need HTTPS egress (port 443) to `<account>.snowflakecomputing.com`. Every request
also goes through the server's SSRF guard: the name is resolved, refused if it resolves to an
internal address, and the socket is pinned to the address that was checked.

**PrivateLink.** Tick **Connect over PrivateLink** to use
`<account>.privatelink.snowflakecomputing.com`. That name resolves to your VPC endpoint, which is a
private address, so the SSRF guard refuses it until you allow the endpoint's subnet with
[`SSRF_ALLOW`](configuration.md), for example `SSRF_ALLOW=10.20.30.0/24`.

### What Ordinate sends

- One statement per request (`MULTI_STATEMENT_COUNT = 1`). A query typed in the workbench runs inside
  `select * from ( … ) limit N+1`, so the row limit holds whatever the query says.
- A statement timeout of 30 seconds for a connection's queries. When the timeout passes, or the person
  closes the tab, Ordinate cancels the statement, so no query is left running on the warehouse.
- `QUERY_TAG = 'ordinate:<org>'`, followed by `:live` or `:extract` when Ordinate knows what the query
  is for. To see what Ordinate ran and what it cost:

  ```sql
  SELECT start_time, query_tag, warehouse_name, total_elapsed_time, bytes_scanned
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
  WHERE query_tag LIKE 'ordinate:%'
  ORDER BY start_time DESC;
  ```

- `TIMEZONE = 'UTC'` and `WEEK_START = 1` (ISO weeks start on Monday). Timestamps arrive as UTC; a
  `TIMESTAMP_TZ` keeps its instant.
- Values in a live query are bind parameters, never text in the SQL.

To cap what the warehouse can spend, give Ordinate its own warehouse with a resource monitor (needs
`ACCOUNTADMIN`):

```sql
USE ROLE ACCOUNTADMIN;
CREATE RESOURCE MONITOR ordinate_monthly WITH CREDIT_QUOTA = 100
  TRIGGERS ON 90 PERCENT DO NOTIFY ON 100 PERCENT DO SUSPEND;
ALTER WAREHOUSE ORDINATE_WH SET RESOURCE_MONITOR = ordinate_monthly;
```

## BigQuery

Ordinate reads BigQuery over its REST API with a **service-account key**. It runs every query as that
service account, never as the person looking at the chart, so the account's roles decide what any
Ordinate user with access to the connection can read.

### The service account: two roles, nothing else

| Role | Where | Why |
|---|---|---|
| **BigQuery Data Viewer** (`roles/bigquery.dataViewer`) | On each dataset Ordinate should read, or on the project | Read tables and views, list datasets and tables |
| **BigQuery Job User** (`roles/bigquery.jobUser`) | On the billing project | Run query jobs there, and cancel its own |

Do **not** grant Data Editor, Data Owner, Admin or a basic role (Owner, Editor). With these two roles
the account cannot change any data, whatever SQL reaches BigQuery: that is the boundary Google
enforces.

```bash
PROJECT=my-project-123
SA=ordinate-reader@$PROJECT.iam.gserviceaccount.com

gcloud iam service-accounts create ordinate-reader --project=$PROJECT --display-name="Ordinate (read-only)"
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/bigquery.jobUser
gcloud iam service-accounts keys create ordinate-key.json --iam-account=$SA
```

Then grant Data Viewer on each dataset to read, in BigQuery:

```sql
GRANT `roles/bigquery.dataViewer` ON SCHEMA `my-project-123.analytics`
TO "serviceAccount:ordinate-reader@my-project-123.iam.gserviceaccount.com";
```

(or `--role=roles/bigquery.dataViewer` on the project to read every dataset in it). Paste the whole
`ordinate-key.json` into the connection form, then delete the file. Ordinate keeps it in the
encrypted secret store (`ORDINATE_MASTER_KEY`), never in `config.json`, never in a reply to a browser.

### The connection form

| Field | What it is |
|---|---|
| Billing project | Where queries run and are billed. Blank uses the key's own `project_id`. A project id (`my-project-123`), or a legacy domain-scoped one (`example.com:my-project`). |
| Service-account key (JSON) | The key file, pasted whole. |
| Default dataset | Optional. Unqualified table names in SQL resolve here (`dataset`, or `project.dataset`), and it is listed first in the schema tree. |
| Location | Optional. Where jobs run: `US`, `EU` or a region such as `europe-west2`. |
| Max bytes billed per query | Optional. A query that would bill more fails before it runs, at no charge. Never higher than the server's `LIVE_MAX_BYTES_BILLED`. |

Tables appear as `dataset.table`; in SQL, quote a path with backticks (`` `my-project.sales.orders` ``).
The tree lists up to 1,000 tables, the default dataset's first.

### Read-only, three ways

1. **IAM** — the two roles above. Google enforces this whatever else happens.
2. **Read-only scopes** — the access token Ordinate mints asks only for
   `https://www.googleapis.com/auth/bigquery.readonly` and
   `https://www.googleapis.com/auth/cloud-platform.read-only`. Whether Google refuses a write
   statement under these scopes has **not** been verified against a real account yet
   ([log](../live-data/log.md)); the real-account run below records the answer each night. If
   Google refuses the scopes themselves, every query fails with an error that says *insufficient
   authentication scopes*; Ordinate will not ask for broader access to work around it.
3. **A dry run first** — every statement the workbench, an import or a refresh sends is first
   dry-run (free), and refused unless BigQuery reports it is a `SELECT`. The dry run is of the exact
   text that then runs.

Cancelling a job is the one call no read-only scope covers, so Ordinate mints a second token with the
`bigquery` scope and uses it for `jobs.cancel` and nothing else.

### What a query can cost

- **Every query carries `maximumBytesBilled`**: the lowest of the connection's field, the server's
  `LIVE_MAX_BYTES_BILLED` (default 10 GiB, [configuration.md](configuration.md)) and any lower limit
  the caller sets. BigQuery fails a query over it *before it runs*, without charge. When the dry run
  already shows the query is over, Ordinate refuses it up front and says by how much.
- **The editor shows the price before you run**: "~1.2 GB" next to Run is the dry run's estimate of
  the bytes the statement would process. Run and Explain both bill a real query.
- **Every query is bounded in time and rows**: the job carries `jobTimeoutMs`, so BigQuery stops it
  even if Ordinate goes away; the user's SQL runs inside `select * from ( … ) limit N` with the
  statement on its own line; a closed tab or a timeout cancels the job.
- **Jobs are labelled** `ordinate=extract` (imports, refreshes, the workbench) or `ordinate=live`, so
  the bill can be read back per purpose. As an admin (BigQuery Resource Viewer), in the job's region:

```sql
SELECT DATE(creation_time) AS day,
       (SELECT value FROM UNNEST(labels) WHERE key = 'ordinate') AS purpose,
       COUNT(*) AS queries,
       SUM(total_bytes_billed) AS bytes_billed
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND EXISTS (SELECT 1 FROM UNNEST(labels) WHERE key = 'ordinate')
GROUP BY day, purpose
ORDER BY day;
```

### Network

Ordinate contacts exactly two hosts, over HTTPS (port 443): `bigquery.googleapis.com` and
`oauth2.googleapis.com`. Allow both in your egress rules. Every request goes through the server's
SSRF guard; the user never types a host. The key file's `token_uri` must be exactly
`https://oauth2.googleapis.com/token` — a key naming any other token endpoint is refused, because the
signed assertion would otherwise go wherever the file says.

### How values arrive

| BigQuery | In Ordinate |
|---|---|
| `INT64`, `NUMERIC`, `BIGNUMERIC`, `FLOAT64` | A number column — unless a value has more than 15 significant digits (an id), which a double cannot hold exactly; then the whole column is text and every digit is kept. |
| `DATE`, `DATETIME` | A date column, as sent. |
| `TIMESTAMP` | A date column in UTC ISO 8601, to the millisecond. |
| `BOOL`, `STRING`, `BYTES` (base64), `TIME`, `GEOGRAPHY` (WKT), `JSON` | Text. |
| `REPEATED` and `RECORD` / `STRUCT` | JSON text. |

### Incremental refresh

With incremental refresh on, Ordinate asks BigQuery only for rows at or past the cursor:
`` select * from `dataset.table` where `updated_at` >= '2024-05-01' ``. The bound is an untyped date
literal, which BigQuery reads as the column's own type (`DATE`, `DATETIME` or `TIMESTAMP`), so a
partitioned table scans only the partitions it needs. It is a day wider than needed on purpose; the
exact cut is made in Ordinate.

## Testing against a real account

The connectors' self-checks run against recorded replies. `scripts/test-warehouseLive.ts` runs the
same code against a **real** Snowflake account and a **real** Google Cloud project, through the
registry, over the network, with the SSRF guard on. For each warehouse it checks test connection,
the table list, a table's columns, a query cut at the row limit (and one exactly at it, not cut),
reading past the first result partition or page, how each type arrives (numbers, ids longer than 15
digits, dates and timestamps as UTC, JSON), bound values against hostile literals, and that a query
whose caller hangs up is cancelled *on the warehouse*, as the warehouse itself then reports. For
BigQuery it also checks the cost estimate and the dry-run gate, and records the read-only scope
answer (below). Throughout, it checks that no key, passphrase, token or signed assertion reaches a
result, an error or its output.

Then, for each warehouse, it runs the **live-parity matrix**: charts, KPI tiles and AI answers asked
of a Live dataset and of a copy of the same rows, which must agree figure for figure. The rows are
held in the query itself (literals cast to the warehouse's types), so nothing is written to the
account and the read-only role below is enough. The same matrix runs against PostgreSQL on every
pull request and against a ClickHouse container every night.

It runs only when a warehouse's variables are set. Without them it prints that it skipped and
passes, so `npm test` stays green. Setting only some of one warehouse's variables is a failure.
These are inputs to the test, **not server settings**: the server never reads them, so they are not
in [configuration.md](configuration.md).

| Variable | Required | What it is |
|---|---|---|
| `SNOWFLAKE_ACCOUNT` | yes | The account identifier, as in the connection form. |
| `SNOWFLAKE_USER` | yes | A user that signs in with the key below (`ORDINATE_SVC` above). |
| `SNOWFLAKE_PRIVATE_KEY` | this or the PAT | The PEM private key. A one-line value with `\n` escapes is accepted. |
| `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | for an encrypted key | Its passphrase. |
| `SNOWFLAKE_PAT` | this or the key | A programmatic access token, instead of the key. |
| `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_ROLE` | yes | As in the connection form. Use the read-only role above. |
| `SNOWFLAKE_DATABASE` | no | A database with **at least one table** the role can read. Without it, the account's first visible table is described, and the query-tag check is skipped. |
| `SNOWFLAKE_SCHEMA` | no | The schema whose table is described first. |
| `BIGQUERY_KEY_JSON` | yes | The service-account key file, whole. |
| `BIGQUERY_PROJECT` | no | The billing project. Defaults to the key's own. |
| `BIGQUERY_DATASET` | no | The default dataset, listed first. |
| `BIGQUERY_LOCATION` | no | Where jobs run, as in the connection form. |
| `BIGQUERY_SCRATCH_DATASET` | no | A dataset the test account may **write**, used only by the scope probe below. Leave it unset unless you want that probe; never grant write access to the account a real connection uses. |

Run it locally:

```bash
npm run build:ts
SNOWFLAKE_ACCOUNT=myorg-myaccount SNOWFLAKE_USER=ORDINATE_SVC SNOWFLAKE_WAREHOUSE=ORDINATE_WH \
SNOWFLAKE_ROLE=ORDINATE_READER SNOWFLAKE_DATABASE=SALES SNOWFLAKE_PRIVATE_KEY="$(cat ordinate_svc.p8)" \
SNOWFLAKE_PRIVATE_KEY_PASSPHRASE=… BIGQUERY_KEY_JSON="$(cat ordinate-key.json)" \
node scripts/test-warehouseLive.js
```

**Nightly.** `.github/workflows/warehouse-nightly.yml` runs it every night and on demand
(**Actions → Warehouse nightly → Run workflow**). It reads repository secrets with the same names;
add the ones you have, for example `gh secret set SNOWFLAKE_PRIVATE_KEY < ordinate_svc.p8` and
`gh secret set BIGQUERY_KEY_JSON < ordinate-key.json`. It is not a required check. The run's log
prints no credential and no account identifier, because the log of a public repository is public.

**What it costs.** Snowflake: about two minutes of the warehouse (most of it the cancel check,
which waits for Snowflake's own 45-second hand-off before cancelling), plus the parity matrix's
roughly 500 small statements, plus the warehouse's auto-suspend time. BigQuery: nothing billed in
the usual case. Every query it runs reads generated or literal rows rather than a table; the one
table it touches, the public `bigquery-public-data.samples.shakespeare`, is only described and
dry-run, and both are free.

**The read-only scope answer.** Each BigQuery run records, as `spike:` lines in the log and a table
in the run's summary: which scopes Google granted the query token (from Google's `tokeninfo`),
whether `jobs.query` accepts that token, and whether a **write** sent with it is refused by Google or
only by Ordinate's dry-run gate. The write it sends needs no IAM grant (a temporary table in a
script), so a refusal can only come from the token's scopes. With `BIGQUERY_SCRATCH_DATASET` set, it
also tries `CREATE TABLE … AS SELECT 1` there, and drops the table again if Google allowed it. Either
answer is safe, because the dry-run gate and the IAM roles hold regardless. The answer decides
whether the gate is the only read-only guarantee or defence in depth.

## Schema sync

A **Live** dataset keeps no rows, so Ordinate learns about its columns from the warehouse: when it is
created (or switched to Live), when someone with edit rights clicks **Sync schema**, and once a day.
A sync re-reads the columns from the catalog (or a one-row run of the defining query) and then sends
**one sampled statement** for the table, labelled `ordinate=live` like every live query:

- **Its size is the app's**: at most a million (row, column) cells — 10,000 rows, fewer for a table
  wider than 100 columns, never under 1,000 — read through the engine's own sample clause where it
  has one (Snowflake `SAMPLE (n ROWS)`, BigQuery `TABLESAMPLE SYSTEM` sized from the table's row
  count, Databricks `TABLESAMPLE (n ROWS)`, ClickHouse `SAMPLE` when the table has a sampling key),
  always under a `LIMIT`. Redshift has no sample clause: the `LIMIT` bounds it.
- **BigQuery prices it first** (a free dry run). Past `LIVE_MAX_BYTES_BILLED`, or the connection's
  lower "Max bytes billed per query", no sample is read; the columns still sync and the figures of the
  last sample are kept.
- **It counts like a live question**: the daily limit, the per-org concurrency cap and
  `LIVE_QUERY_TIMEOUT_MS` (cancelled in the warehouse) all apply. One sync per dataset runs at a
  time across pods; a daily sync that fails is retried after an hour.
- **At most one second try**, `LIMIT` only, when the warehouse refused the sample clause (a view,
  say) or a BigQuery block sample came back empty.

It stores, per column, how much of the sample is filled, roughly how many distinct values it holds
and — for a text column with few distinct values — up to 20 of the most frequent ones. Those values
fill the filter pickers and help the Assistant spell a filter right; a column marked personal or
financial never has its values shown to a model. A column that has gone from the warehouse leaves the
dataset, and any chart, KPI or answer that still uses it says "column missing" until it is changed or
the column comes back.

## Refresh URL

A refresh URL lets a pipeline tell Ordinate that new data has landed. A dbt run or an Airflow DAG
POSTs to it when it finishes, and Ordinate refreshes **one dataset** from its source. The URL can
do nothing else. On a **Live** dataset there is nothing to fetch, so the call resets the dataset's
cache instead, and the next chart or answer asks the warehouse again.

It works for any dataset that has a source to refresh from: a connection table or query, a web
address, SQL over other datasets, or a combined dataset. It does not work for pasted rows or a
screenshot. It needs the server's Postgres (`DATABASE_URL`).

### Making one

Open the dataset, then **⋯ → Refresh URL…**. The same panel opens from **Refresh URL** under the
dataset on its connection's details rail. Only editors of the project see the panel. Press **New
refresh URL**. The URL is shown **once**: Ordinate keeps only its SHA-256 and its first 13
characters (`ordh_…`), which name it in the list. Store it in your scheduler's secret store. The
list shows who made each URL, when, and when it was last called. **Revoke** stops it at once.

A call refreshes **as the person who made the URL**, with their role at the time of the call. If
they are disabled or lose write access to the project, the URL answers `403`. Make a new one as
someone who still has access.

### What a call gets back

`POST https://<your host>/api/hooks/refresh/<token>`. No body and no headers are needed. A body
(dbt Cloud and Airflow send JSON) is read up to 64 KiB and ignored. It names nothing: the token
alone decides the dataset.

| Status | Body | Meaning |
|---|---|---|
| `202` | `{"status":"queued"}` | A refresh was started. It runs in the background, and every open dashboard over the dataset redraws when it lands. |
| `202` | `{"status":"already_running"}` | A refresh of this dataset was already running, on this pod or another. Nothing new started. If it began before your load finished, call again once it has landed. |
| `202` | `{"status":"cache_reset"}` | A Live dataset: its cache was reset. Nothing is fetched. |
| `429` | `{"error":"too soon","retryAfter":N}` | This URL was called less than `REFRESH_HOOK_MIN_INTERVAL_SEC` (60 s by default) ago. `Retry-After` says how many seconds to wait. |
| `403` | `{"error":"forbidden"}` | The URL's creator can no longer refresh the dataset. |
| `404` | `{"error":"unknown refresh URL"}` | No such URL, or it was revoked. The two are the same answer on purpose. |
| `404` | `{"error":"dataset not found"}` | The dataset was deleted or is in the Trash. |

Every call that gets past the interval leaves an audit row, **Refresh URL called**, naming the URL's
creator, the URL's id and the dataset (Admin → Audit log). Unknown and revoked tokens leave none, so
the trail cannot be flooded with them. Scheduled refreshes are audited too, as **Scheduled
refresh**.

### curl

```bash
# --retry waits out a 429 (it honours Retry-After) and tries again.
curl -fsS --retry 3 -X POST "$ORDINATE_REFRESH_URL"
```

### dbt

dbt's `on-run-end` hooks run SQL **in the warehouse**. They cannot call a URL by themselves. So call
the URL from the step that runs dbt, after the models are built:

```bash
dbt build && curl -fsS --retry 3 -X POST "$ORDINATE_REFRESH_URL"
```

With **dbt Cloud**, use a webhook instead: Account settings → Webhooks → Create webhook, event
**Run completed**, endpoint = the refresh URL. Ordinate ignores the payload and dbt Cloud's
signature header.

### Airflow

Use the HTTP provider's `HttpOperator` (`SimpleHttpOperator` in older versions of the provider). Make
a connection `ordinate` whose host is your Ordinate URL, and a Variable `ordinate_refresh_token` that
holds the part of the URL after `/api/hooks/refresh/`. Airflow masks a Variable whose name contains
`token` in its task logs.

```python
from datetime import timedelta
from airflow.providers.http.operators.http import HttpOperator

refresh_orders = HttpOperator(
    task_id="refresh_orders",
    http_conn_id="ordinate",
    endpoint="api/hooks/refresh/{{ var.value.ordinate_refresh_token }}",
    method="POST",
    response_check=lambda r: r.status_code == 202,
    retries=3,
    retry_delay=timedelta(seconds=60),  # a 429 means: called less than a minute ago
)
load_orders >> refresh_orders
```

### Network and sign-in in front of Ordinate

The scheduler must reach Ordinate's ingress. The URL carries its own credential, so the server looks
up no session, cookie or proxy header for it. If an authenticating proxy sits in front of Ordinate
(`AUTH_MODE=header` behind oauth2-proxy, for example), let `POST /api/hooks/refresh/` through without
sign-in. With oauth2-proxy that is `--skip-auth-route="POST=^/api/hooks/refresh/"`. Ordinate still
checks the token on every call.

The token is in the URL path, so Ordinate masks that path in its own request log
(`/api/hooks/refresh/[redacted]`). Your ingress, proxy and scheduler logs may record full URLs. Keep
those logs as private as the token, or use a scheduler that masks it, like Airflow's Variable.

## Live on a PostgreSQL read replica

A PostgreSQL database stays a **copy** by default: an import, refreshed on a schedule (every 5 or
15 minutes with incremental refresh). It can also be **Live** — every chart and KPI tile asks the
database itself — but only on a connection that says it may be asked: tick **"This is a read replica
or a warehouse"** on the connection form, or later with the switch in the connection's details.
Until then the save bar offers "Copy the data" only, and the server refuses a Live dataset over
that connection (`connection:import`, `dataset:setMode`) and answers no Live question through it.

### Why it is opt-in

A Live question runs on **every view**, cached for the dataset's cache age (5 minutes by default, 0 =
every time). A dashboard of ten Live tiles opened by fifty people is up to ten queries every cache
age — aggregates that read the whole table unless a filter can use an index. On the primary database
of an application that load lands beside its transactions. On a replica or an analytics database it
lands where reporting belongs.

### When to use it

- You have a **streaming read replica** (a hot standby, or your provider's read replica endpoint:
  RDS/Aurora PostgreSQL, Cloud SQL, AlloyDB read pools, Neon read replicas, Supabase read replicas),
  or a PostgreSQL that exists for analytics. Point the connection's host at that endpoint.
- The figures must be fresher than a refresh schedule allows, and the tables answer an aggregate in
  well under `LIVE_QUERY_TIMEOUT_MS` (60 s by default).
- Otherwise keep the copy. A 5- or 15-minute incremental refresh reads only the new rows, once, for
  everyone.

Ordinate does not check the claim. `select pg_is_in_recovery();` is `true` on a streaming replica, if
you want to check it yourself; an analytics database that is itself a primary is also a fair "yes".

### What it costs the database

Per question that is not answered from the cache:

- **One connection**, opened and closed for that statement: `set default_transaction_read_only to on`,
  `set statement_timeout` (what is left of `LIVE_QUERY_TIMEOUT_MS`), `set timezone to 'UTC'`, the
  statement, close. Measured on a local PostgreSQL 16: 8–13 ms in all, the time-zone statement about
  0.1 ms of it; a remote replica adds its network round trips to each step.
- **One statement**: a `GROUP BY` over the table (or your saved query) with your filters bound as
  `$n` parameters. A text axis keeps its top 50 in the same statement.
- **At most `LIVE_MAX_CONCURRENT` at once** (4) per org in each pod, so at most pods × 4 connections
  from Ordinate's Live questions. Identical questions asked together share one statement.
- **Cancelled** when the last viewer waiting on it closes the tab (`pg_cancel_backend` from a second
  connection), and stopped by the server's `statement_timeout` in any case.

### A role for it

Connect as a role that can read the tables and nothing else, and cap its connections:

```sql
CREATE ROLE ordinate_live LOGIN PASSWORD '…' CONNECTION LIMIT 8;
GRANT CONNECT ON DATABASE app TO ordinate_live;
GRANT USAGE ON SCHEMA public TO ordinate_live;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ordinate_live;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ordinate_live;
ALTER ROLE ordinate_live SET default_transaction_read_only = on;
ALTER ROLE ordinate_live SET statement_timeout = '30s';
```

`CONNECTION LIMIT` is a hard cap the database enforces. The role's `statement_timeout` is a default:
Ordinate sets its own on every session (from `LIVE_QUERY_TIMEOUT_MS`), which takes precedence, so
lower that variable to tighten it; the role's value still bounds anyone else who signs in as the
role. On a hot standby, a long query can be cancelled by replay ("conflict with recovery"); Ordinate
then shows the last cached figure, labelled stale, or an error. `max_standby_streaming_delay` and
`hot_standby_feedback` trade that against replication lag — your call, not Ordinate's.

### Which PostgreSQL connectors

PostgreSQL, Google AlloyDB, Neon, Supabase and TimescaleDB: each runs PostgreSQL's own parser,
functions and casts, which the live compiler's SQL (the Redshift dialect: `$n` parameters, `~`,
`BTRIM`, `DATE_TRUNC`, `TO_CHAR`) is written in. Amazon Redshift is Live without the opt-in (a
warehouse). **CockroachDB, YugabyteDB, Materialize, QuestDB and RisingWave stay copies**: CockroachDB
reimplements PostgreSQL's SQL (its regular expressions are RE2, not PostgreSQL's), YugabyteDB runs a
fork of an older PostgreSQL query layer over distributed storage, and the other three speak the wire
protocol only. None of them has been run against the compiler.

### Unticking it

The switch refuses while Live datasets ask the connection, and says how many. Switch each one to
"Copy the data" on its dataset page first, then untick. Ordinate does not switch them for you: each
switch is a full import from the database you have just said is a primary, and it changes what every
dashboard over them shows (a live figure becomes a dated copy). A Live dataset that reappears over an
unticked connection (restored from the Trash, say) answers nothing until the box is ticked again.

### Differences from a copy to know about

- **Time zone.** A Live session runs in UTC, as a copy reads a `timestamptz` (an instant, written in
  UTC), so both put a timestamp on the same day whatever the database's `TimeZone`.
- **Collation.** Text comparisons in filters (`<`, `>`) and the order of tied labels follow the
  database's collation; a copy compares code points. A database created with a `C` (or `C.UTF-8`)
  collation agrees with the copy; `en_US` and friends can order differently.
- **Empty text.** An import turns an empty string into an empty cell, so a copy has one blank
  category. The database keeps `''` and `NULL` apart, so the live compiler folds `''` into `NULL` in a
  category or split key and Live shows the same one blank row (`scripts/test-liveReplica.ts`, and the
  real-engine parity matrix, `scripts/test-liveParityPostgres.ts`).

## Fresh on ask

A copy of an operational table — Postgres, MySQL, SQL Server and the other sources that stay copies
(plan D8) — is as old as its last refresh. A schedule refreshes it every N minutes whether anyone
looks or not. **Fresh on ask** refreshes it when someone does: a chart, a KPI tile, a statistics tile
or an AI answer that reads a copy older than the age you choose first pulls the rows added since the
last refresh, waits a moment for them, and answers with them.

### Turning it on

On the dataset's page, beside the refresh schedule (and in the connection workbench's list of
datasets): **Fresh on ask** · Off, 1 min, 5 min, 15 min or 1 h. Through the API it is
`dataset:update` with `freshOnAsk: { maxStalenessSec }` (60 – 86,400) or `null`.

It needs **incremental refresh** on the dataset — a cursor column, and the mark its first, full
refresh sets — because a pull on ask must be cheap for the source: only the rows past the cursor. A
dataset without incremental refresh shows the control disabled, saying so, and the server refuses it.
Turn incremental refresh on in the dataset's **Incremental refresh** panel, beside the schedule (and
in the workbench rail): a cursor column (a number or date that only grows), update by key or append,
and a lookback. It is offered only for sources Ordinate can ask for "rows past the cursor" in SQL —
Postgres, MySQL, SQL Server, Oracle, BigQuery, Snowflake and the other SQL families; an HTTP or SaaS
source would be read whole on every run ("filtered after fetch"), so the panel says so and refuses
it. Turning incremental refresh off turns fresh on ask off with it, and drops a 5- or 15-minute
schedule to hourly. A Live dataset never has it: it is asked at the warehouse every time.

### What an ask does

1. The copy is younger than the age: nothing happens. This costs one read of the dataset's record per
   dataset per request — a dashboard of 30 tiles over one dataset reads it once.
2. Older: one **incremental** refresh starts — the same run a schedule makes, through the same job
   queue, with the cursor pushed to the source where its SQL allows. Every tile of that dataset on the
   page waits for the same run.
3. It lands within `FRESH_ON_ASK_WAIT_MS` (5 s by default): the answer includes the new rows.
4. It does not: the answer comes from the copy, captioned "As of 1:00 AM · refreshing…", and every open
   tab of a reader redraws when the rows land (the same push a ↻ sends). A person who closes the tab
   stops waiting; the refresh carries on for everyone else.

After it lands, everything that follows a refresh runs: alerts, quality checks, a republish, and the
SQL datasets built on it.

### Never a full refresh

Fresh on ask only ever pulls new rows. When the next refresh of the dataset must be a full one — its
first run, every 7th run, "Full refresh now", a cursor or key column that is gone, or columns that
changed at the source — an ask does not start it: the dataset shows **Waits for a full refresh**, and
answers come from the copy until a scheduled refresh or **Refresh now** has run it.

### What it costs the source

- **At most one pull per dataset per window** — the age you chose — however many people ask, on
  however many pods. The pull's start is stamped on the dataset record, and the stamp is claimed under
  a short Postgres advisory lock, so exactly one pod starts a window's pull; a refresh already running
  anywhere (a ↻, the schedule, another pod's pull) is waited for, never doubled. A source that fails is
  tried again only when the next window opens.
- Each pull is one bounded query: `select * from <table> where <cursor> >= <mark − lookback>`.
- Anyone who may read the dashboard can cause a pull by opening it — that is the feature. It runs as
  the connection's identity, like every refresh, and the person who set fresh on ask chose the window.
- Without `DATABASE_URL` there is one process, and the same rules hold inside it.

### Choosing an age

The age is both the freshness promise and the rate limit. 1 minute suits a small, indexed table
people watch during the day; 15 minutes to 1 hour suits a large one, or a source that should not be
read often. If every view should be current, a 5-minute incremental schedule (L0.3) keeps the copy
fresh without anyone waiting; fresh on ask then rarely has anything to pull.

A dashboard viewed **as of** a past time never pulls. Publishing reads like any other ask (a stale
copy is pulled first); the published page is then a snapshot and asks nothing.
