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
which waits for Snowflake's own 45-second hand-off before cancelling), plus the warehouse's
auto-suspend time. BigQuery: nothing billed in the usual case. Every query it runs reads generated
rows rather than a table; the one table it touches, the public `bigquery-public-data.samples.shakespeare`,
is only described and dry-run, and both are free.

**The read-only scope answer.** Each BigQuery run records, as `spike:` lines in the log and a table
in the run's summary: which scopes Google granted the query token (from Google's `tokeninfo`),
whether `jobs.query` accepts that token, and whether a **write** sent with it is refused by Google or
only by Ordinate's dry-run gate. The write it sends needs no IAM grant (a temporary table in a
script), so a refusal can only come from the token's scopes. With `BIGQUERY_SCRATCH_DATASET` set, it
also tries `CREATE TABLE … AS SELECT 1` there, and drops the table again if Google allowed it. Either
answer is safe, because the dry-run gate and the IAM roles hold regardless. The answer decides
whether the gate is the only read-only guarantee or defence in depth.

