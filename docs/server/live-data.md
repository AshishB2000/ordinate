# Warehouses and live data

This page is for the team that connects Ordinate to a cloud warehouse. It covers what each warehouse
needs on its side (a read-only identity) and on yours (network egress). The plan behind it is
[docs/live-data/00-plan.md](../live-data/00-plan.md). Sections for cost limits, cache ages
and the refresh URL are added by the tasks that build them.

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
   ([log](../live-data/log.md)). If Google refuses the scopes themselves, every query fails with an
   error that says *insufficient authentication scopes*; Ordinate will not ask for broader access to
   work around it.
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
Turning incremental refresh off turns fresh on ask off with it. (Incremental refresh is set on the
dataset record; the web app has no panel for it yet.) A Live dataset never has it: it is asked at the
warehouse every time.

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
