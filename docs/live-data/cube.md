# Cube: what the connector and the encoder rely on

Semantic layer part 7, step e1 (`docs/semantic-layer/07-portability.md` D14–D18). This is the spike the plan asks for
before any connector code: every Cube behaviour Ordinate depends on, where it was read, and the decision built on it.

**No Cube deployment was reachable when this was written (2026-11-05), and none could be started on the build
machine.** Every line below comes from Cube's public documentation and its source, read that day:

- REST API: <https://docs.cube.dev/reference/core-data-apis/rest-api> and its reference page
  (`/reference/core-data-apis/rest-api/reference`)
- Query format: <https://docs.cube.dev/reference/core-data-apis/rest-api/query-format>
- JWT: <https://docs.cube.dev/embedding/authentication/jwt>
- Environment variables: <https://docs.cube.dev/reference/configuration/environment-variables>
- Measures: <https://docs.cube.dev/reference/data-modeling/measures>
- Source, `master` that day: `packages/cubejs-schema-compiler/src/adapter/BaseFilter.ts` (how each filter becomes SQL)
  and `src/compiler/CubeToMetaTransformer.ts` (what `/v1/meta` returns)

So each item is marked **documented**, **source** (read in Cube's code, not promised by its docs) or **inferred**, and
every one is **unverified on a deployment**. `scripts/fixtures/cube/` starts one (Postgres seeded with the live-parity
fixture, the pinned Cube image, the model `scripts/cubeFixture.ts` writes), and the warehouse nightly's `cube` job runs
the whole semantic parity matrix against it (`scripts/test-semanticCubeLive.ts`). Until that run is green, treat this
page as a plan, not as facts.

## The request Ordinate sends

One `POST <base>/v1/load` per question (`src/engine/live/semantic/cube.ts` writes the query, `src/connectors/cube.ts`
sends it through `httpShared.httpRequest`: the SSRF check and pin, the byte ceiling, the timeout, the abort):

```json
{ "query": {
  "measures": ["orders.revenue"],
  "dimensions": ["orders.region"],
  "filters": [{ "member": "orders.region", "operator": "notEquals", "values": ["North"] }],
  "order": [["orders.revenue", "desc"], ["orders.region", "asc"]],
  "limit": 51,
  "timezone": "UTC"
} }
```

```json
{ "query": { … }, "data": [{ "orders.region": "South", "orders.revenue": "4521.3" }, …],
  "annotation": { "measures": { "orders.revenue": { "type": "number" } }, "dimensions": { … }, "timeDimensions": { … } } }
```

| What | Status | Source and decision |
|---|---|---|
| Base path `/cubejs-api`, endpoints `/v1/meta`, `/v1/load` | documented | The connection's URL is the deployment's (`https://cube.example.com`) or its REST API URL (`…/cubejs-api/v1`, as Cube Cloud shows it). A bare origin gets `/cubejs-api/v1`; a path ending in `/v1` is kept; any other path (a custom `basePath`) gets `/v1`. |
| `POST /v1/load` with `{"query": …}` | documented | Always POST ("Use POST to fix problem with query length limits"), `Content-Type: application/json`. |
| Reply `data`: one object per row, keyed by member | documented | Read by key, never by position. A time dimension with a granularity is keyed `cube.dim.granularity` (inferred from the docs' examples). |
| Numbers come back as strings | inferred | The REST API passes the driver's values through; Postgres `numeric` and `bigint` are strings. A cell is turned into a number only where the reply's own `annotation` types its member `number` and the text is a finite number; everything else is left as Cube sent it. |
| Time values `YYYY-MM-DDTHH:mm:ss.SSS` | inferred | b1's reader accepts an ISO day or a midnight timestamp at the grain's first day; anything else is refused (`rowShape`), never relabelled. |
| `{"error":"Continue wait"}` with status 200 | documented | "Clients who received Continue wait should continuously retry the same query in a loop". **The poll rule:** the same POST again after 200 ms, until an answer, an error, `LIVE_QUERY_TIMEOUT_MS` or the caller's signal; the socket is destroyed on abort. Cube keeps a query nobody polls for a while, then marks it orphaned (documented): "at least we stop polling" (D18). One run is one counted question however many polls it takes. |
| Errors: 400 (query or database), 403 (no or invalid token), 500 | documented | The connector returns the status and Cube's `error` text, redacted (the stored secret and every token it signed); the executor logs it and the reply carries a catalog sentence only. |
| A redirect | — | Never followed (`httpRequest` follows none): a 3xx is an error. |
| `timezone` | documented | Always `"UTC"`, as Live SQL buckets dates in UTC. |

## Authentication

| What | Status | Decision |
|---|---|---|
| The token goes in the `Authorization` header as is | documented | `Authorization: <token>`, no `Bearer` (the core endpoints' examples). |
| A token is a JWT signed with `CUBEJS_API_SECRET` | documented | Two ways on the form, one secret field (`token`, `secret: true`, stored as `connection.token`): **API token** sends a token the deployment accepts as is; **API secret** signs a fresh token per request. |
| HS256 | inferred | The docs' examples sign with `jsonwebtoken`, whose default is HS256; `CUBEJS_JWT_ALGS` lists HS256 and RS256. `signJwtHs256` (`src/connectors/jwt.ts`, `node:crypto` HMAC, no dependency). |
| The payload must be an object; `exp` is good practice | documented | `{ "iat": now, "exp": now + 300 }`: a token lives five minutes, and every request (every poll) signs a new one. The security context is empty: Cube's own access rules see no Ordinate user. |
| A deployment with `CUBEJS_JWT_KEY` / a JWKS rejects secret-signed tokens | documented | Then **API token** is the way in. |

## Listing and describing (`GET /v1/meta`)

| What | Status | Decision |
|---|---|---|
| `cubes[]`: `name`, `type` (`cube` or `view`), `title`, `description`, `isVisible`, `public`, `measures`, `dimensions` | documented + source | Every cube and view is a model; `title` is its label. One not public, or not visible, is not listed. A name that is not a plain identifier is not listed. |
| Members are named `cube.member` | documented | A model's member is stored by its part after `cube.`; the encoder writes `<model>.<name>` back. A member that is not public or not visible is left out (the meta lists it with `isVisible: false`, source). |
| Dimension `type`: `string`, `number`, `time`, `boolean`, `geo` | documented | `string` → text, `number` → number, `time` → date at every grain below; `boolean` and `geo` are not read. |
| Measure `aggType` is the model's own type (`sum`, `count`, `countDistinct`, `avg`, `min`, `max`, `number`, …) | source | **Additive** only for `sum` and `count`, and never when `cumulative` (a rolling window). In a view, only when every dimension the view lists comes from the measure's own cube (each member's `aliasMember`, `cube.member`, in Cube's OpenAPI spec for `/v1/meta`): grouped by a joined cube's dimension (one-to-many), a row can count in two groups. Anything else, or anything unreadable, cannot be added up: a refused running total, never a wrong sum. |
| Granularities `day`, `week`, `month`, `quarter`, `year` on every time dimension | documented | All five are offered. |
| Week start | inferred | Cube truncates with the warehouse's week; on Postgres `date_trunc('week')` is the ISO (Monday) week, which is ours. On a warehouse whose week starts elsewhere, the bucket is not a Monday and b1's reader refuses the answer (`rowShape`): no week is relabelled. |

## Filters: every value is JSON, in `values`

Values are strings ("Values must be of type String", documented): a number goes as its JS text, a date as
`YYYY-MM-DD`. Member names come only from the dataset's declared dimensions and its synced metrics, each a plain
identifier; nothing a person typed is ever part of a member name.

What each operator means in SQL is from Cube's `BaseFilter` (source):

| Cube | SQL it writes |
|---|---|
| `equals [a]` / `equals [a, b]` | `x = a` / `x IN (a, b)` |
| `notEquals [a]` / `notEquals [a, b]` | `x <> a OR x IS NULL` / `x NOT IN (a, b) OR x IS NULL` |
| `set` / `notSet` | `x IS NOT NULL` / `x IS NULL` |
| `contains` | `x ILIKE '%a%'`: **case-insensitive** (documented) |
| `gt`, `gte`, `lt`, `lte` | `x > a` …, for **measures and `number` dimensions only** (documented) |
| `afterOrOnDate [d]`, `beforeDate [d]` | `x >= d 00:00:00.000`, `x < d 00:00:00.000` (the value through `formatFromDate`): the only date operators Ordinate sends, exact for a DATE and a TIMESTAMP alike |
| `inDateRange [a, b]` | `x >= a 00:00:00.000 AND x <= b 23:59:59.999`: not sent (its end misses the last sub-millisecond of a day) |
| `and`, `or` groups | documented |

Ordinate's filters mean what they mean on an extract (`compileFilter` is the reference: a NULL compares as `''`, a
date as its ISO day). **The encoding,** exact for every row, or refused `layerFilter` naming Cube:

| Ordinate | Text dimension | Number dimension | Date dimension |
|---|---|---|---|
| `= v` | `equals [v]`; `v` = `''`: `or [equals [''], notSet]` | `equals [v]`; not a finite number: nothing matches | `and [afterOrOnDate [v], beforeDate [v + 1 day]]` |
| `≠ v` | `notEquals [v]`; `v` = `''`: `and [notEquals [''], set]` | `and [notEquals [v], set]` | `or [beforeDate [v], afterOrOnDate [v + 1 day], notSet]` |
| `>`, `≥` | refused (no text order in Cube) | `gt`, `gte` | `afterOrOnDate [v + 1 day]`, `afterOrOnDate [v]` |
| `<`, `≤` | refused | `lt`, `lte` | `or [beforeDate [v], notSet]`, `or [beforeDate [v + 1 day], notSet]` |
| in list (a blank or a NULL in it matches both) | `equals [...]`, with `or […, notSet]` when a blank is in the list | `equals [...]` of its finite numbers | refused |
| not in list | `notEquals [...]`, with `and […, set]` when a blank is in the list | `notEquals [...]` | refused |
| contains | refused (Cube's is case-insensitive) | refused (as on any Live dataset) | refused |
| empty / not empty | refused: Cube cannot tell a whitespace-only cell from text (Ordinate's empty is null, `''` or whitespace); **except** a value list's own "not empty", which drops the blank values from the list here (exact: each row is one value; a full reply the drop left short is asked again whole) | `notSet` / `set` | `notSet` / `set` |
| a period (from, to) | — | — | `and [afterOrOnDate [from], beforeDate [to + 1 day]]` |
| "Other" (all but the kept categories) | the not-in form, wrapped in its own `and` | — | — |

A date value that is not an ISO day is refused. A number dimension's NaN or infinity compares as the warehouse
compares it (Ordinate reads it as no number): named here, not tested, since a model rarely holds one.

## Order, limits and blanks

| What | Status | Decision |
|---|---|---|
| `order` as an array of `[member, "asc" \| "desc"]` | documented | The plan's order, in priority. |
| No NULL placement in `order` | documented (none exists) | The warehouse decides (Postgres puts a NULL first on `desc`). Ordinate ranks a NULL last, so a question cut by its limit is checked: when an order column holds a NULL before a value, or its rows open with a NULL (all NULL, say), the cut may have kept the wrong rows, and the same question is asked again with the 50,000-row limit, ranked here. Exact either way. |
| Default limit 10,000; an explicit limit may not pass `CUBEJS_DB_QUERY_LIMIT` (50,000) | documented | **Always an explicit limit:** the plan's (51 for a text axis's ranks, a value list's, 1 for the latest day), else **50,000**; a reply that fills 50,000 is refused (`tooManyGroups`, as Live SQL refuses a reply past its cap). The plan's `LIVE_ROW_LIMIT + 1` (100,001) would exceed Cube's default maximum. |
| A query with dimensions and no measures lists their values | documented | **Lookups: yes** (`caps.lookups: true`): value pickers, the Assistant's spellings, the latest day for "last quarter". |
| `''` and NULL are two groups | inferred | Cube groups by the dimension's SQL. Ordinate keeps one blank group (an import stores `''` as null), and folding two of Cube's figures into one is arithmetic on the layer's figures. So **a reply with both a `''` and a NULL in one dimension is refused**, and a reply cut by its limit with either in a text dimension is asked again whole (the other may be past the cut); a model makes them one with `sql: NULLIF(col, '')` (the fixture model does). |
| A byte-exact comparison | — (none) | `equals` compares in the warehouse's collation: **`caps.binaryCompare: false`**, so a viewer restricted by a row access rule is refused on every Cube dataset (D17). |

## The image

`cubejs/cube:v1.8.13@sha256:5a728f42924051b9499016fb1ac9d1695ab544084d57221c0dd173e4c730730a` (the multi-arch manifest
list, read from Docker Hub on 2026-11-05; `v1.8.19`, the newest, was hours old). Pinned in
`scripts/fixtures/cube/compose.yml`.

## What only a real deployment can prove

1. The reply's shape: rows keyed `cube.member`, time values `…T00:00:00.000` keyed `cube.dim.granularity`, and an
   `annotation` that types each member.
2. That `{"error":"Continue wait"}` is answered by re-posting the same query (the nightly's model is small; a slow
   query is the owner's to try).
3. HS256 tokens signed with `CUBEJS_API_SECRET`, sent without `Bearer`, are accepted, and a five-minute `exp` is honoured.
4. Each operator's SQL as `BaseFilter` writes it (above), notably `notEquals … OR x IS NULL` and the start-of-day
   formatting of `afterOrOnDate` / `beforeDate`.
5. A dimension-only query answers distinct values; the limit 50,000 is accepted and 50,001 refused.
6. Week buckets start on Monday on Postgres.
7. `aggType` and `cumulative` in `/v1/meta` as the source reads them, and `isVisible: false` on a member that is not public.
