# Warehouses and live data

How Ordinate connects to a cloud warehouse, what it needs from you, and how the cost of each query
is bounded. The plan behind it is [`docs/live-data/00-plan.md`](../live-data/00-plan.md).

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
