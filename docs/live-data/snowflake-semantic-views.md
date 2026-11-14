# Snowflake semantic views: what the adapter relies on

Semantic layer part 7, step c1 (`docs/semantic-layer/07-portability.md` D14–D17). This is the spike
the plan asks for before any adapter code: every Snowflake behaviour the adapter depends on, where
it was read, and the decision built on it.

**No real account was reachable when this was written (2026-11-05).** Every line below comes from
Snowflake's public documentation, read that day:

- `SEMANTIC_VIEW` construct: <https://docs.snowflake.com/en/sql-reference/constructs/semantic_view>
- Querying semantic views: <https://docs.snowflake.com/en/user-guide/views-semantic/querying>
- `DESCRIBE SEMANTIC VIEW`: <https://docs.snowflake.com/en/sql-reference/sql/desc-semantic-view>
- `SHOW SEMANTIC VIEWS`: <https://docs.snowflake.com/en/sql-reference/sql/show-semantic-views>

So each item is marked **documented** (the docs say it) or **inferred** (the docs imply it, or say
nothing), and every one is **unverified on an account**. The warehouse nightly
(`scripts/warehouseLiveSnowflakeSemantic.ts`) runs the whole parity matrix against a real semantic
view once the owner creates it (`scripts/fixtures/snowflake-semantic-view.sql`) and sets
`SNOWFLAKE_SEMANTIC_VIEW`. Until that run is green, treat this page as a plan, not as facts.

## The statement the adapter writes

One statement per question (`src/engine/live/semantic/snowflake.ts`), sent through the
connection's bound execution (`runBound`: `?` binds, the row cap, `QUERY_TAG`, the timeout and
cancel, the SSRF-pinned transport). The cap is the statement's own last line (`LIMIT n` up to the
cap, else the cap's), not the `select * from (…) limit n` wrapper a Live statement gets: Snowflake
keeps a subquery's ORDER BY only inside it, and a value list is read in the layer's order:

```sql
SELECT "d0" AS "region", CAST("m0" AS DOUBLE) AS "revenue"
FROM SEMANTIC_VIEW(
  "DB"."SALES"."ORDERS_SV"
  DIMENSIONS CASE WHEN CAST("region" AS VARCHAR) = '' THEN NULL ELSE CAST("region" AS VARCHAR) END AS "d0"
  METRICS "revenue" AS "m0"
  WHERE (coalesce(CAST("region" AS VARCHAR), '') <> CAST(? AS VARCHAR))
)
ORDER BY "m0" DESC NULLS LAST, "d0" ASC NULLS LAST
LIMIT 51
```

| What | Status | Source and decision |
|---|---|---|
| `FROM SEMANTIC_VIEW(<name> METRICS … DIMENSIONS … WHERE …)` | documented | The construct's syntax block. The adapter writes DIMENSIONS, then METRICS, then WHERE. |
| At least one of METRICS, DIMENSIONS, FACTS; never FACTS with METRICS | documented | A KPI is METRICS alone; a lookup is DIMENSIONS alone. FACTS are never used. |
| An alias after a dimension or metric (`AS alias`) | documented | Every member is aliased `"d<i>"` / `"m<j>"`, so the outer `SELECT` names each column itself and no output header is guessed. |
| Output headers are the members' unqualified names | documented | Not relied on: the aliases name the columns. |
| Scalar expressions in DIMENSIONS (`DATE_PART('year', orders.order_date) AS year`) | documented | A dimension is read exactly as the Live compiler reads a column (`compileFilter`: the `''` → NULL fold of a text key, a finite double, a DATE). |
| `DATE_TRUNC` in DIMENSIONS | inferred | Scalar expressions are documented; `DATE_TRUNC` is not named. **The grain rule:** every DATE or TIMESTAMP dimension is offered at every grain (`day` … `year`), truncated inside the clause, so the layer groups and computes each bucket. If the nightly shows it refused, the fallback is the plan's: each date dimension at its own grain only. |
| Week start | inferred | The connector sends `WEEK_START = 1` with every statement, as for Live SQL, so `DATE_TRUNC('WEEK', …)` is an ISO (Monday) week. |
| Qualifying a member by its logical table is optional | documented | "You can qualify the name of the metric (for example, `my_logical_table.my_metric`)"; a bare name that is ambiguous fails. The sync stores bare names, and `TABLE.NAME` only for a name two members share (`snowflakeSemantic.ts`), so a stored name is always unambiguous. |
| WHERE inside the clause: dimensions, facts, built-in functions; applied before metrics are computed | documented | Every filter, and the "Other" exclusion, goes INSIDE the clause, written by the Live compiler's own predicates (`compileFilter`) over the dimension: the same meaning, and the same Snowflake SQL, that Live datasets over tables already run nightly. |
| `?` binds inside the clause | **not documented** | **The bind strategy: inside.** Every value is a `?` bind (`CAST(? AS VARCHAR)`, as Live SQL). If Snowflake refuses binds there, the question fails with a typed error ("the warehouse failed") and nothing is shown: it never inlines a value. The plan's fallback (outer `WHERE` for grouped dimensions, the literal encoder or a refusal for the rest) is then the next change; no literal encoder is built until the nightly says it is needed. |
| `ORDER BY … LIMIT` outside the clause | documented | The examples order and limit after the closing parenthesis. `NULLS LAST` both ways, as the SQL path ranks. |
| A DIMENSIONS-only query lists values | inferred | The query "groups the results by the dimensions"; DIMENSIONS alone is allowed. **Lookups: yes** (`caps.lookups: true`): value pickers, the Assistant's spellings and the latest day an empty answer's note names are one dimension-only question each. |
| `TO_BINARY(…)` inside the clause | inferred | Built-in functions are allowed in WHERE, but no example shows it. **`caps.binaryCompare` stays `false`**: a viewer restricted by a row access rule is refused on every Snowflake semantic dataset, as on every layer (D17), until the nightly pins a byte-exact comparison inside the clause. |
| Private metrics cannot be queried | documented | `ACCESS_MODIFIER = PRIVATE` members are left out of the sync. |

## Listing and describing

| What | Status | Decision |
|---|---|---|
| `SHOW SEMANTIC VIEWS [IN { ACCOUNT \| DATABASE }] [LIMIT n]` | documented | `SHOW SEMANTIC VIEWS IN DATABASE LIMIT 1000` when the connection names a database (the session's, sent as context: no name is interpolated), else `… IN ACCOUNT LIMIT 1000`. Columns read: `name`, `database_name`, `schema_name`, `comment`. A view whose name parts are not plain identifiers (`IDENT_RE`) is not listed: it could not be quoted safely. |
| `DESCRIBE SEMANTIC VIEW <name>` → `object_kind, object_name, parent_entity, property, property_value` | documented | One statement gives every dimension (`DATA_TYPE`) and metric (`EXPRESSION`, `ACCESS_MODIFIER`). Kinds read: `DIMENSION`, `METRIC`, `DERIVED_METRIC`; everything else is ignored. |
| Dimension types | documented (`DATA_TYPE`, e.g. `VARCHAR(25)`) | Through the Live column mapping (`liveColumnType('snowflake', …)`): text, number, date. A type it cannot map is left out and named by the sync, and so is a `TIMESTAMP_TZ`: its UTC day (a Live table's reading, `CONVERT_TIMEZONE('UTC', x)`) needs the warehouse type, which a semantic record does not keep, and `CAST(x AS DATE)` would bucket each value by its own offset. |
| Privileges | documented | Query: `SELECT` on the semantic view, and *not* `SELECT` on its tables. Describe and list: any privilege on the view, and one on its database and schema. A view the role cannot describe is a sentence in the app ("Snowflake didn't answer…"); Snowflake's own words go to the server log only. |
| Warehouse for SHOW / DESCRIBE | not documented | The connection always names a warehouse (a required field), so both run with it. |

## Can a metric be added up (D16)

Read from `DESCRIBE`'s `EXPRESSION` (documented, e.g. `AVG(orders.o_totalprice)`). Additive only
when the whole expression is one `SUM(…)` or `COUNT(…)`, not `COUNT(DISTINCT …)`, with no other
aggregate or operator outside it (`additiveExpression`). A derived metric is never additive, nor is
one declared `NON ADDITIVE BY (…)` (a semi-additive metric, a balance; documented in CREATE SEMANTIC
VIEW): DESCRIBE's property for the clause is not documented, so a metric with any property whose
name holds `ADDITIVE` (the organization usage view's column is `NON_ADDITIVE_DIMENSIONS`) is not.
Anything unreadable is `false`: the cost of being wrong is a refused running total, never a wrong
sum.

## What only a real account can prove

The nightly answers each of these, and fails if any is wrong:

1. `?` binds are accepted inside the clause's WHERE (every filter, and "Other").
2. `DATE_TRUNC` (and the `CASE` fold, the `CAST`s) are accepted in DIMENSIONS, and an alias is
   accepted on every member.
3. A DIMENSIONS-only query returns each distinct value once.
4. The figures equal an extract of the same rows: charts, "Other" as a second question, every
   grain, every filter operator, KPIs and answers (`Object.is`; float sums within the pinned 1e-13).
5. `SHOW SEMANTIC VIEWS` and `DESCRIBE SEMANTIC VIEW` return the columns above, and the expressions
   read as additive for `SUM`/`COUNT` and not for `AVG`/`MAX`.
6. The read-only role is enough: `SELECT` on the view, nothing on its table.
7. Whether `TO_BINARY(…) = TO_BINARY(?)` works inside the clause (not yet asked; lifting D17 for
   Snowflake waits for it).

The owner's task: run `scripts/fixtures/snowflake-semantic-view.sql` once in the nightly account,
grant the nightly role `SELECT` on the view, and add the repository secret
`SNOWFLAKE_SEMANTIC_VIEW` (`DATABASE.SCHEMA.ORDINATE_SEMANTIC_PARITY_SV`).
