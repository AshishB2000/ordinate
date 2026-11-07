# dbt Semantic Layer (beta): what the connector and the encoder rely on

Semantic layer part 7, step d1 (`docs/semantic-layer/07-portability.md` D14–D18). The spike the plan asks for before any
connector code: every dbt behaviour Ordinate depends on, where it was read, and the decision built on it.

**There is no dbt Cloud account with the Semantic Layer (the owner's answer 3), so none of this has been checked
against one.** Every line comes from dbt's public documentation and dbt Labs' own Python client, read on 2026-11-05:

- GraphQL API: <https://docs.getdbt.com/docs/dbt-cloud-apis/sl-graphql> (the page says "Last updated on Aug 18, 2026")
- The Semantic Layer SDK for Python, `main` that day (dbt Labs' client of the same API):
  `dbtsl/api/graphql/protocol.py` (the documents it sends), `dbtsl/api/graphql/client/sync.py` (create, poll, pages),
  `dbtsl/api/graphql/client/base.py` (headers), `dbtsl/env.py` (the URL), `dbtsl/models/*.py` (the types)
- pandas `DataFrame.to_json(orient="table")` (the shape of `jsonResult`, which the API page says is made by pandas)

Each item is marked **documented** (on the API page), **SDK** (in dbt Labs' client, not on the page) or **inferred**, and
every one is **unverified on an account**. The reply fixtures in `scripts/fixtures/dbt-sl/` are built from those type
definitions and examples (the page publishes no example reply except a query id and an Arrow table), each file saying
so. The label says **beta** until the warehouse nightly's `dbt` job runs green against a real account
(`scripts/test-semanticDbtLive.ts`); until then, treat this page as a plan, not as facts.

## The endpoint and sign-in

| What | Status | Decision |
|---|---|---|
| `POST https://<host>/api/graphql`, GraphQL as a JSON body | documented | Plain JSON POSTs through `httpShared.httpRequest` (the SSRF check and pin on every request, the byte ceiling, the timeout, the abort): `{"query": <a fixed document>, "variables": {…}}`. **No GraphQL client.** Every document is a constant in `src/connectors/dbtWire.ts`; nothing a person or the layer wrote is ever part of one: names and values travel as variables. |
| Hosts: `semantic-layer.cloud.getdbt.com` (North America), `semantic-layer.emea.dbt.com` (EMEA), `semantic-layer.au.dbt.com` (APAC), multi-tenant | documented | The form's **Region** is a select of these three; `ConnectorDef.hosts` lists them, and the request door refuses any other host before a socket opens. |
| Single tenant `semantic-layer.<access URL>`, cell-based `<account prefix>.semantic-layer.<region>.dbt.com` | documented | **Not offered in the beta**: their host is per account, so it needs a typed host and a wildcard allowlist (`*.dbt.com`), the owner's call. |
| `Authorization: Bearer <token>`: a service token with the "Semantic Layer Only" and "Metadata Only" permissions, or a personal access token | documented | One secret field, `token` (`secret: true`, stored as `connection.token`, no new secret kind). The SDK writes `authorization: bearer …`; HTTP header names are case-insensitive, and Ordinate sends the page's spelling. |
| Every request names `environmentId: BigInt!` | documented | The form's **Environment ID**, digits only (at most 15, so it is a safe JSON number), sent as a number variable. |
| GraphQL errors come back as `{"errors": [{"message": …}]}` (often with status 200) | inferred (GraphQL convention; the SDK maps "User is not authorized") | Any `errors` entry, or a non-2xx status, is an error; dbt's words go to the server log only, redacted of the token (`safeError`), and the reply carries a catalog sentence. |

## What a dataset is: a saved query

`savedQueriesPaginated(environmentId, search, pageNum, pageSize)` lists saved queries (documented), so **a dataset is a
dbt saved query** (the plan's first choice; one semantic model's metrics is not built). Its metrics and its group-bys
are the dataset.

| What | Status | Decision |
|---|---|---|
| `savedQueriesPaginated { items { name label description queryParams { … } } pageNum totalPages }` | documented | Listing: every saved query whose name is an identifier the encoder can write (`^[a-z_][a-z0-9_]*$`), labelled by `label`, described by `description`. At most 20 pages of 100. |
| `savedQuery(environmentId, savedQueryName) { queryParams { metrics { name } groupBy { name grain datePart } where { whereSqlTemplate } } }` | documented | Describing reads it. A group-by with a `datePart` (day of week …) is not a date bucket and is left out. |
| A saved query's metrics and group-bys cannot be overridden when it is run by name (`createQuery(savedQuery: …)`) | documented | So Ordinate never runs it by name: each question is an ad-hoc `createQuery` over a subset of its metrics and group-bys. |
| Its own filter (`where { whereSqlTemplate }`) | documented | Part of what the saved query means. **The connector reads the saved query again at every question** (one metadata read inside the same counted question) and sends its filter **verbatim, as dbt wrote it**, beside Ordinate's own. In the same read it checks that every metric and group-by the question names is still the saved query's: a saved query changed in dbt refuses until the dataset is synced again, never asks outside it. |
| `dimensionsPaginated(environmentId, metrics) { items { name type queryableGranularities } }`; `Dimension.type` is `CATEGORICAL` or `TIME` | documented | Types each group-by by name: `CATEGORICAL` → **text**, `TIME` → **date** at the grains below. A group-by that is not a dimension of its metrics (an entity) is left out. **The API reports no SQL type for a categorical dimension**, so every one is text: a number or boolean dimension is text in Ordinate (its values compare as text; text order is refused, below). |
| Group-by names are the qualified names (`customer__customer_type`, `metric_time`) | documented (examples) | Stored as dbt names them; matched with `Dimension.name` (the SDK also has `qualifiedName`: to verify which one carries the entity path). |
| `metricsPaginated { items { name description type } }`; `MetricType` = `SIMPLE`, `RATIO`, `CUMULATIVE`, `DERIVED` (the SDK adds `CONVERSION`) | documented / SDK | Each of the saved query's metrics, with its description. |

## Can a metric be added up

| What | Status | Decision |
|---|---|---|
| The page's `MetricTypeParams` (dbt v1.12) has no aggregation; the page never mentions a measure | documented | — |
| `measures(environmentId, metrics) { name agg nonAdditiveDimension { name } }`, `AggregationType` = `SUM`, `MIN`, `MAX`, `COUNT_DISTINCT`, `SUM_BOOLEAN`, `AVERAGE`, `PERCENTILE`, `MEDIAN`, `COUNT` | SDK | **Additive** only for a `SIMPLE` metric whose one measure aggregates `SUM` or `COUNT` and has no `nonAdditiveDimension` (MetricFlow's `non_additive_dimension`, a semi-additive measure such as a balance), asked per simple metric. The SDK's `Measure` has no such field today, and an API that refuses it cannot say a measure is not a balance, so there **every metric reads as not additive** (fail safe: its running totals are refused until the API carries the field). `RATIO`, `DERIVED`, `CUMULATIVE`, `CONVERSION`, `COUNT_DISTINCT`, anything unknown, and any metric whose measures cannot be read (the query absent on a newer API, the field refused) are **not additive**: a refused running total, never a wrong sum. |

## Asking a question: create, then poll

```graphql
mutation($environmentId: BigInt!, $metrics: [MetricInput!], $groupBy: [GroupByInput!], $where: [WhereInput!], $orderBy: [OrderByInput!], $limit: Int) {
  createQuery(environmentId: $environmentId, metrics: $metrics, groupBy: $groupBy, where: $where, orderBy: $orderBy, limit: $limit) { queryId }
}
```

```graphql
query($environmentId: BigInt!, $queryId: String!, $pageNum: Int!) {
  query(environmentId: $environmentId, queryId: $queryId, pageNum: $pageNum) { status error totalPages jsonResult(encoded: false) }
}
```

| What | Status | Decision |
|---|---|---|
| `createQuery` returns `{ queryId }`; `query(…)` is polled until `status` is `SUCCESSFUL` or `FAILED` | documented | **The poll rule:** after 250 ms, then doubling to at most 2 s, until an answer, `FAILED`, `LIVE_QUERY_TIMEOUT_MS` or the caller's signal. Every other status (`PENDING`, `RUNNING`, `COMPILED`, `UNKNOWN`, SDK) keeps polling. One run is **one counted question** however many requests it takes (D18). |
| `FAILED` carries `error` | documented | An error, logged redacted. |
| `cancelQuery(environmentId, queryId) { queryId }` | SDK (not on the page) | On the caller's signal or the timeout, **polling stops at once** (D18's floor), and one best-effort `cancelQuery` is sent (5 s, its answer ignored). If the API has no such mutation, the query runs out on dbt's side; Ordinate has stopped asking either way. |
| Default output Arrow; `jsonResult(orient: PandasJsonOrient! = TABLE, encoded: Boolean! = true)`, "recommended for testing and validation"; `encoded: false` gives the raw JSON string | documented | **JSON, `encoded: false`** (pandas' table orient: `{"schema": {"fields": [...]}, "data": [{…}, …]}`). Arrow would need an Arrow reader, a dependency the owner has not taken. The page's performance warning is for large results; a chart's question is at most a few thousand rows. |
| 1024 rows per page by default; `totalPages`; `pageNum` | documented | Pages 2…`totalPages` are fetched in order (as the SDK does) until the row cap; past it the reply is `truncated` (the door's `tooManyGroups`). |
| Rows are keyed by column name: a metric by its name, a group-by by its name, a time group-by as `name__grain` | documented | Read by name, never by position; case-insensitively (a warehouse may upper-case unquoted names), and a reply where two columns differ only by case is refused. The pandas `index` column is ignored. |
| Time values (`2023-08-07T00:00:00.000`) | inferred (pandas' ISO format) | b1's reader accepts an ISO day or a midnight timestamp at the grain's first day; anything else is refused (`rowShape`), never relabelled. |
| Numbers | inferred | A metric cell is a number when it is a JSON number, or text that is a finite decimal (a warehouse decimal); a dimension cell is left as dbt sent it (`007` stays text). |

## Grouping, order and limits

| What | Status | Decision |
|---|---|---|
| `GroupByInput { name, grain: TimeGranularity }`, `TimeGranularity` = … `DAY`, `WEEK`, `MONTH`, `QUARTER`, `YEAR` | documented | A date dimension is grouped at `DAY`…`YEAR` when its `queryableGranularities` lists it. (The SDK sends `timeGranularity` as a string and calls the enum deprecated since custom granularities: to verify which one the API takes now.) |
| `orderBy: [{ metric: { name }, descending } \| { groupBy: { name, grain }, descending }]` | documented (examples; the signature line says `order`) / SDK (`orderBy`) | The plan's order, in priority. |
| No NULL placement in an order | documented (none exists) | The warehouse decides (Snowflake and Postgres put a NULL first on a descending order). Ordinate ranks a NULL last, so a reply cut by its limit is checked key by key (Cube's `cutIsExact`), and when a NULL came before a value or opened the rows, the same question is asked again without the plan's limit and ranked here. |
| `limit: Int` | documented | Always explicit: the plan's (51 for a text axis's ranks, 201 for a value list, 1 for the latest day), else the Live row cap + 1, so a reply past the cap is seen. |
| A query with group-bys and no metrics lists their values ("Categorical dimension only") | documented | **Lookups: yes** (`caps.lookups: true`): value pickers, the Assistant's spellings, the latest day for "last quarter". |
| `''` and NULL are two groups | inferred | A reply with both a `''` and a NULL in one dimension is refused, and a cut reply holding either is asked again whole (Ordinate keeps one blank group; joining dbt's two figures would be arithmetic on the layer's figures), as for Cube. |
| A byte-exact comparison | — (none) | The `where` compares in the warehouse's collation: **`caps.binaryCompare: false`**, so a viewer restricted by a row access rule is refused on every dbt dataset (D17). |

## Filters: template text, written only by a closed encoder

A filter is `where: [{ sql: "<template>" }]`, each entry AND-ed (documented). The template is Jinja over the
warehouse's SQL: `{{ Dimension('customer__customer_type') }} = 'new'`, `{{ TimeDimension('metric_time', 'month') }}`
(documented). **There is no bind parameter**, so a value is written into text. `src/engine/live/semantic/literals.ts`
is the only way one gets there, and it refuses whatever it cannot write exactly:

- **text:** 1–200 characters, each a letter, a mark, a digit, a space or one of `_ . , : ; / & ( ) # @ + % -`, quoted
  with `'`. Refused: `{`, `}` (Jinja), `\` (an escape in BigQuery and Databricks string literals), `'` itself
  (Databricks reads `'O''Brien'` as two literals run together, `OBrien`, and BigQuery as a syntax error), `"`, NUL, every control, format and line-break character, every quote look-alike (U+2018, U+2019, U+02BC,
  U+FF07), and anything longer. Nothing in the class starts a Jinja tag, closes the quote, or starts a comment.
- **dates:** an ISO day `YYYY-MM-DD` that is a real day, quoted.
- **numbers:** finite, written by `String(n)` only when it reads `^-?\d+(\.\d+)?$` (no exponent). **booleans:** `TRUE`,
  `FALSE`. A NULL only through `IS NULL` / `IS NOT NULL`.
- **names inside `Dimension('…')`:** only the dataset's synced dimensions, each matching
  `^[a-z_][a-z0-9_]*(__[a-z0-9_]+)*$`.

A refusal is `layerFilter` naming dbt and the field, never a dropped filter. Ordinate's filters mean what they mean on
an extract (`compileFilter` is the reference: a NULL compares as `''`, a date as its ISO day). A date dimension is
filtered at the day grain, `D` = `{{ TimeDimension('name', 'day') }}`, comparing with a quoted day (dbt's own example
compares a time dimension with a quoted date); a text one is `D` = `{{ Dimension('name') }}`. **The encoding:**

| Ordinate | Text dimension | Date dimension |
|---|---|---|
| `= v` | `D = 'v'`; `v` = `''`: `(D = '' OR D IS NULL)` | `D = 'v'` |
| `≠ v` | `(D <> 'v' OR D IS NULL)`; `v` = `''`: `D <> ''` | `(D <> 'v' OR D IS NULL)` |
| `>`, `≥` | refused: a categorical dimension's SQL type is unknown, so its order is | `D > 'v'`, `D >= 'v'` |
| `<`, `≤` | refused | `(D < 'v' OR D IS NULL)`, `(D <= 'v' OR D IS NULL)` (a NULL compares as `''`) |
| in list (a blank or a NULL in it matches both) | `D IN ('a', 'b')`; with a blank in it, `(D IN (…) OR D = '' OR D IS NULL)` | `D IN ('d1', 'd2')`; with a blank, `(D IN (…) OR D IS NULL)` |
| not in list | `(D NOT IN ('a', 'b') OR D IS NULL)`; with a blank in it, `(D NOT IN (…) AND D <> '')` | `(D NOT IN (…) OR D IS NULL)`; with a blank, `D NOT IN (…)` |
| contains `v` | `D LIKE '%v%'`, when `v` holds no `%` or `_` (no escape is needed then: escapes differ by warehouse); else refused | refused |
| empty / not empty | refused: Ordinate's empty is NULL, `''` or whitespace, and SQL's whitespace test differs by warehouse; **except** a value list's own "not empty", `D <> ''` at dbt with the whitespace-only values dropped here before the list is cut | `D IS NULL` / `D IS NOT NULL` |
| a period (from, to) | — | `(D >= 'from' AND D <= 'to')` |
| "Other" (all but the kept categories) | the not-in form | — |

A filter on a number dimension cannot occur (dbt types none) and is refused.

## Dialect

`environmentInfo { dialect }` names the warehouse (documented). The encoder needs none: every predicate above is SQL
that Snowflake, BigQuery, Databricks, Redshift, Postgres and Trino read alike, with no function call.

## What only a real account can prove

1. The hosts, `Authorization: Bearer`, and a service token with "Semantic Layer Only" + "Metadata Only" answering every
   document above; the environment id as a JSON number.
2. `savedQueriesPaginated`, `savedQuery`, `dimensionsPaginated` and `metricsPaginated` with the fields above, and
   whether `Dimension.name` carries the entity path.
3. `measures(environmentId, metrics) { name agg nonAdditiveDimension { name } }` on today's API (else every metric reads as not additive).
4. `createQuery` with `orderBy` (not `order`), `GroupByInput.grain` (not `timeGranularity`), and the poll's statuses.
5. `jsonResult(encoded: false)`: pandas' table orient, column names `metric`, `dimension`, `dimension__grain` (their case
   on Snowflake), ISO timestamps, numbers as JSON numbers, 1024-row pages.
6. The `where` templates: each predicate above rendered and run, a quoted ISO day against a time dimension, `LIKE`
   case-sensitive, a saved query's own `whereSqlTemplate` sent back verbatim beside Ordinate's.
7. `cancelQuery`.

The nightly's `dbt` job proves them all at once against a dbt project built from the live-parity fixture (its saved
query `ordinate_parity`, `docs/server/live-data.md`): the whole semantic parity matrix, the extract's figures
`Object.is` dbt's. The beta label comes off in the PR that first sees it pass (the owner's call).
