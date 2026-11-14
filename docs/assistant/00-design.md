# Assistant: ask anything, keep what matters — design

Today the Assistant answers only from datasets, sees a few of them at a time, and cannot answer a
question its chart form can't express. This design makes it search the whole Data model, answer
straight from warehouse tables without making a dataset, write SQL when the form isn't enough, and
lets viewers read every number they are allowed to while asking an editor for anything that would
be kept. Access moves to teams: a project role, shared folders and the connection tables a team may
ask about.

The rule from `AGENTS.md` holds throughout: the AI picks *what* to compute (a chart form or one SQL
statement); an engine computes every figure; the AI's sentence carries no numbers.

Agreed on the flow page (Nov 2026). Related: [Explore](../explore/00-design.md),
[semantic layer, AI](../semantic-layer/03-ai.md), [source tables](../semantic-layer/02-source-tables.md),
[row access rules](../row-policy/00-design.md), [Live data](../live-data/00-plan.md).

## What you will see

- **An editor** asks "returns by reason last month". No dataset has returns, but
  `ANALYTICS.RETURNS` is on the project's Snowflake connection. The answer comes straight from that
  table, Live, with *Answered from ANALYTICS.RETURNS · warehouse table, not a dataset*. Nothing is
  created. **Add to dashboard** makes the dataset (Live) in the same click.
- **The same editor** asks "average days between a customer's orders". The chart form can't say
  that, so the answer is SQL the AI wrote (a CTE and `LAG()`), run through the Query tab's gate and
  marked **Not checked · SQL written by the AI** with **Show SQL ▾** and **Verify**. Once verified,
  the same question gets that SQL every time.
- **A question needs a link nobody defined** (sales has `country_id`, region lives in countries).
  Ordinate never guesses a join. It checks one and asks: *Link sales.country_id →
  countries.country_id? Names match · Types match · 98% of sampled values found · Unique in
  countries* — **Add link and answer** / **Cancel**.
- **A viewer** reads every number their teams may see: datasets in folders shared with their team,
  and connection tables ticked for it. Nothing else is searched, not even by name. Where the data
  isn't theirs: *This data isn't in Ordinate yet. [Ask an editor]*.
- **A viewer's Add to dashboard** becomes **Request a dashboard**: pick answers, a name, a note.
  Editors get *Priya asked for a dashboard: Returns Q4 (2 charts)*, review a draft that lists
  exactly what approving creates (the Live dataset, the link, the folder), and **Approve and
  publish**, **Edit** or **Decline with a note**. The viewer is told either way.
- **An admin** opens **Admin → Teams → Ops analysts** and gives the team a project role, shared
  folders (Can view / Can edit) and connection tables (tick a schema to include its new tables,
  untick one table, hide a column). Nothing is ticked by default.

## The flow

| Step | What happens | AI | Exists |
|---|---|---|---|
| 1 | You ask, from Home, the Assistant page or the side panel. An open topic scopes everything below. | — | yes |
| 2 | Same letters as a verified question (lowercase, no spaces or punctuation)? Show that chart. | — | yes |
| 3 | Search the Data model; follow links; add table facts. | — | new |
| 4 | One AI call returns a chart form, or SQL only when the form can't express it. | 1 (2 for SQL) | partly |
| 5 | Every dataset, column, metric and term named must be real, else "Did you mean …?". | — | yes |
| 6 | The engine computes: DuckDB on copies, compiled SQL in the warehouse for Live. | — | yes |
| 7 | Chart, table, Ordinate's caption and bullets; "Answered from ▾", "Also on ▸". | — | partly |
| 8 | Keep it: Save as visual, Verify, Add to dashboard, Alert me. Keeping a source-table answer makes its Live dataset. | — | partly |

### Step 3: what is searched

The question is searched as typed, no spell-correcting. Each item is ranked by meaning and by
words; the higher score wins. Without pgvector or a fingerprint model, everything falls back to
words (phase A works with words only). **Access is applied before ranking**, so hidden columns,
rows a person may not see, and tables their teams weren't given never reach the prompt.

| Searched | How | Notes |
|---|---|---|
| Verified questions | meaning + words | fingerprinted when an editor verifies |
| Metrics | meaning + words | certified first, retired left out |
| Glossary terms | meaning + words | other names included |
| Datasets + columns | meaning + words | "also called" names and descriptions included |
| Values (Acme, West) | words | text columns Ordinate already indexes |
| Source tables | meaning + words | the project's connections; viewers only on tables their teams were given |

**Follow the links.** For each dataset found, add the datasets linked to it in Relationships, up to
two links away, only in the direction that can't repeat rows.

**Table facts.** For a source table or Live dataset, the facts stored on its source table doc
(`facts`, `src/app/sourceTables.ts`; shape `TableFacts`, `src/connectors/tableFacts.ts`) go in as a
few lines: what one row is (key), the main date and whether a date filter is required (partition),
sort or cluster keys, size, last updated, and the editors' notes. None of this reaches the AI today.
Viewers get the facts but never the warehouse table's name. Today the facts are read only when an
editor clicks Read on a table (`sourceTable:read` → `src/connectors/tableFactsRun.ts`); phase A
also refreshes them on the connection's scheduled job, so they are current without a click.

```
- ANALYTICS.SALES (source table · ~48M rows · updated 2 h ago)
    one row = one order (key: order_id)
    partitioned by order_date (a date filter is required)
    editor note: "Use order_date, not ship_date, for sales figures"
```

### Step 4: outcomes

The prompt carries the question, the top verified questions, matching metrics and terms, the
columns of the 12 best datasets and those they link to, the table facts, the editors' instructions
and matching source tables. Rule in the prompt: *use a verified question only if it has the same
measure, grouping, filters and period.*

| | When | Result |
|---|---|---|
| A | Same as a verified question | that chart, re-run on today's data; *Matched Maria's verified question: "…"* and **Not what I asked** |
| B | A dataset has it | a new chart form using the org's metrics, terms and linked columns |
| C | Only a source table has it | answered Live from the table, no dataset (live-capable connections only, see below) |
| D | Nothing has it | editors: **Connect a source** / **Import a file**; viewers: *Ask an editor to add this data.* |
| E | Needs an undefined link | the checked-link card above; viewers: *These can't be combined yet. [Ask an editor]* |
| F | The form can't express it | a second AI call writes one SQL statement, Not checked |

## Two ways to answer

The AI uses the two tools a person already has, and picks the chart builder whenever it can.

| | Chart form (`AnswerSpec`) | SQL (the Query tab's gate) |
|---|---|---|
| A person today | picks dataset, columns, filters | types SQL |
| Good for | most questions, rank and YoY included | "bought in January but not February", "days between orders" |
| Ordinate checks | every field | that it is safe, not that it is right |
| Dashboard chart, alert | yes | not as a chart |

Only the form: complex questions get no answer. Only SQL: every answer is Not checked and none can
become a dashboard chart or an alert. So both, form first.

**The form gets a `calc` field.** `AnswerSpec` (`src/ai/answerSpec.ts`) has no window functions
today, but the engine already computes them (`TableCalcKind`, `src/analysis/tableCalc.ts`): running
total, % of total, difference, % difference, rank, percentile, moving average and sum, YoY, index.
Adding `calc` lets the form answer most "window function" questions without SQL.

**The SQL lane** reuses `compile()` in `src/engine/sqlDatasets.ts`: one read-only statement; CTEs,
`WITH RECURSIVE` and window functions allowed; `FROM` limited to datasets, CTEs and value
generators. It takes two AI calls: the first picks tables, Ordinate then sends the full details of
only those (every column and type, keys, sort and partition keys, size, links), the second writes
the SQL. The answer is marked Not checked until an editor verifies it.

Limits carried over from today: `sql:run` is classified `NET` in `scripts/rowPolicyReaders.ts`, so
a viewer under row rules is refused, and the gate refuses Live datasets (`requireExtract`). SQL on
Live datasets and source tables is phase F, after row rules, hidden columns and cost limits can be
applied in the warehouse.

## Asking needs no dataset; keeping makes one

A dataset is for what other people rely on: dashboards, alerts, verified answers. Asking in the
Assistant or Explore is for you, now.

| | Asking (Assistant, Explore) | Keeping (Save, Verify, Add to dashboard, Alert) |
|---|---|---|
| Dataset | none | made in the same click, Live |
| Source tables | editors, admins; viewers on tables their teams were given | editors, admins; a viewer sends a request |
| Datasets | everyone whose team can see its folder | editors, admins; a viewer sends a request |
| Limits | Live cost limits (`liveBudget.ts`) | plus row rules and hidden columns on the dataset |

**How.** A Live target is built in memory from the source table's facts and its connection, as
`src/engine/live/liveTarget.ts` builds one from a dataset record today, and runs through the same
compiler, budget and refusals. No record and no Parquet are written. `explore:*` contracts take a
`datasetId` today (`src/api/explore.ts`), so they gain a source-table target.

**Live-capable connections only:** Snowflake, BigQuery, Redshift, Databricks, ClickHouse, and
Postgres marked as a replica. On any other connection (a production database, a SaaS app) the data
must be copied first, so an editor sees *Copy returns into Ordinate?* and a viewer sees
*Ask an editor*.

**Live date filters on key columns.** The compiler wraps a date column in a cast before comparing
(`CAST(c AS DATE)` on Snowflake and Redshift, `SAFE_CAST` on BigQuery, `try_cast` on Databricks,
`toDate32` on ClickHouse; `dateOf` in `src/engine/live/compileFilter.ts`). On a `TIMESTAMP` sort or
partition key that may stop the warehouse skipping data. Planned: a plain half-open range on the
raw column when it is a sort or partition key, and a date filter always added where the table
requires one (*Last 12 months: this table needs a date range*). **Not measured yet**: measure
pruning first (bytes scanned before and after on one Snowflake and one BigQuery table), and keep the
Live/extract parity tests green.

## Access is given to teams

Ordinate signs in to a warehouse with one stored account per connection, so the warehouse can't
tell people apart; Ordinate decides. An admin gives a **team**, never one person, three things.

| Given | The team can |
|---|---|
| Project role | view, edit or admin, as today; a folder level never goes above it |
| Folder: Can view | open everything in it and see its numbers; ask the Assistant about its datasets |
| Folder: Can edit | also add, change and move items in it |
| A ticked table | ask the Assistant and Explore about it |

What exists: `project_grants` by user or team (`src/server/db/migrations/0006_authz.sql`), teams
and `team_members` (`0003_auth.sql`), IdP groups mapped to teams (`src/server/auth/idpGroups.ts`),
effective role = the highest of the user's and their teams' grants (`src/server/authz/index.ts`),
row rules and column access per user or team. Topics are not access control (D15,
`src/api/topics.ts`) and stay that way. Sharing a whole project with one person keeps working.

### Shared folders

```
Retail project
├── Everyone in the project/
├── Ops/              Ops analysts: Can view · Ops leads: Can edit
│   ├── orders              dataset
│   ├── Ops weekly          dashboard
│   └── Returns/            inherits Ops
└── Finance/          Finance: Can view
    └── Finance board       dashboard
```

The same shape as Metabase collections, Lightdash spaces, QuickSight shared folders, Looker folders
and Tableau projects. Share a folder with a team once and it gets everything in it, including what
is added later; a new hire just joins the team.

- Each dataset and dashboard sits in exactly one folder, so "why can I see this?" has one answer.
- Project admins create top-level folders; editors with Can edit put items in them.
- Subfolders inherit their parent's access.
- Everything already in a project starts in *Everyone in the project*, so nothing changes until
  someone moves it.
- A visual, metric or verified question follows its dataset; an alert follows its dashboard.
- A dashboard shows its numbers to anyone who can open it, even if its dataset is in another
  folder (row rules still apply); they just can't ask the Assistant about that dataset.
- Moving an item warns first: *Moving to Finance: Ops analysts will lose access.*
- Search and engine both check the folder, so what a team can't see is never searched or read.

### Connection tables

```
Admin → Teams → Ops analysts → Tables
▾ Snowflake (prod)
    ☑ ANALYTICS            whole schema, new tables included
    ▾ SALES
        ☑ ORDERS
        ☑ RETURNS
        ☑ CUSTOMERS        hide: email, phone
    ☐ HR
```

Kept apart from folders, as Metabase keeps data access apart from collections: tables are where
data comes from, folders hold what people made. Nothing is ticked by default. A table that needs
row rules (each manager sees only their region) becomes a dataset, where the rules live.

## Viewers request, editors approve

1. **Viewer: Request a dashboard.** Picks answers from the conversation, a name (new dashboard or
   an existing one) and a note.
2. **Ordinate builds the draft**, no AI: a draft dashboard only editors see (drafts exist,
   `src/api/analyses.ts`), holding those charts as they are and pointing at the source tables.
   Nothing else is created yet.
3. **Editors and admins are told**, in Ordinate and by email for those who turned it on, through
   the notification path mentions use (`src/api/notifications.ts`).
4. **Editor reviews**: the charts with today's numbers and exactly what approving creates (the Live
   dataset from `ANALYTICS.RETURNS`, the link, any chart written as SQL marked Not checked, the
   folder). **Approve and publish**, **Edit**, **Decline with a note**.
5. **Viewer gets it**: *Your dashboard Returns Q4 is ready*, with the link, or the editor's note.

## Who sees what

| Role | Source tables | Row rules | Can verify |
|---|---|---|---|
| Viewer | only tables their teams were given; others not even by name; requests dashboards | apply | no |
| Editor | searched and answered from directly; a dataset only when kept | see every row | yes |
| Project admin | same as editor | see every row | yes |
| Org admin | same as editor, in every project | see every row | yes |

AI agents over MCP and API tokens act as their person and get that person's role.

## Behind the scenes

- Everything stays in Postgres. No separate vector database.
- Every searched item gets a fingerprint in one small pgvector table, remade only when its text
  changes. Without pgvector or a configured fingerprint model, search is words only.
- The index is refreshed when an editor verifies a question; a metric, term or dataset description
  is edited; a dbt or Ossie import runs; the connection job pulls new table info.
- Verified questions load in one query, not one per question.

## Build order

| Phase | What | Needs |
|---|---|---|
| 0 | The Assistant page (merged, #488) and `fix/assistant-answers` (#492): one AI call per answer, "last quarter" from the calendar as dashboards do, every dashboard date preset | Merge #492 |
| A | Word search over the whole Data model; follow links; table facts in the prompt; `calc` in the chart form; Live date filters on sort and partition keys (measured first); Home sees metrics and terms; one-query loading | nothing new |
| B | SQL for questions the form can't express, on copied datasets: second AI call, Not checked, editor verifies | the Query tab's gate |
| C | Meaning search (fingerprints), spelling mistakes, the "Matched Maria's…" line | pgvector and a fingerprint model; otherwise stays on A |
| D | Editors answer straight from source tables with no dataset (Assistant and Explore); keeping makes the dataset; approve a missing link | nothing new |
| E | Shared folders shared with teams; connection tables per team; dashboard requests | every list, search and reader checks the item's folder, with a safety-net test like row rules have |
| F | SQL on Live datasets and source tables | row rules, hidden columns and cost limits applied in the warehouse |
| G | Ask-an-editor notifications, "Answered from ▾", "Also on", Alert me | nothing new |

Each phase gets its own design note before code where it adds a channel or a reader: new `read`
contracts are classified in `scripts/rowPolicyReaders.ts`, a new row-reading channel joins
`scripts/test-liveSafetyNet.ts`, and every guard ships a negative control.

## Test questions

Every phase is checked against one fixed list: typos ("revnue by regon"), "sales" meaning revenue,
"last quarter" vs "last year", a viewer vs an editor on the same question, a question only a
source table can answer, a question needing an undefined link, and a question only SQL can answer.

## Open questions

- **Fingerprint model (phase C).** Which model makes the fingerprints, and where it runs. It must be
  the org's configured AI provider or something the operator installs: no surprise network calls,
  nothing installed at run time.
- **Date-filter pruning (phase A).** Unmeasured; see above. If the cast doesn't hurt pruning on a
  given warehouse, leave that dialect alone.
- **Folders and `/p/` links (phase E).** A published dashboard keeps working for its audience;
  whether moving its folder should warn about published links too.
