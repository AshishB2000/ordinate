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
| 2 | Same letters as a verified question (lowercase, no spaces or punctuation) on the open dataset, visual's dataset or topic (anywhere in the project from Home)? Show that chart, with **Not what I asked**, which gives the same words to the AI without that question or its answer. One indexed lookup (`verified_keys`, 0026): a miss reads no verified record. | — | yes |
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
- Every searched item gets a fingerprint in one small pgvector table (`assistant_search_vectors`, 0029), remade only when its text
  changes. Without pgvector or a configured fingerprint model, search is words only.
- The index is refreshed when an editor verifies a question; a metric, term or dataset description
  is edited; a dbt or Ossie import runs; the connection job pulls new table info.
- Verified questions are an index, `verified_keys` (0026): one row per wording, rewritten in the same
  transaction as the save. Step 2 is one lookup by key, and step 4's examples are ranked in Postgres, so
  only the few returned are read and checked for the person asking (whether each still runs, and
  what they may see). With 5,000 verified questions: 0.27 ms for a miss, 9.7 ms for the examples, where
  reading them all took about 650 ms each. The read-them-all path stays as the reference a
  differential test holds the index to (`test-verifiedIndex`), and answers without a database.

## Scale rules

Reviewed on 15 November 2026, after the verified match moved to an index (#499): the same mistake,
reading a whole list into the app and filtering it there, was in more places on the ask path. Test
projects have five datasets, so no test caught it.

### What one question read

Every store's list read its folder, then each record in its own transaction (begin, select,
commit), one after another, and nothing was kept for the length of a question, so one question
repeated the same lists. Local Postgres 17, where a round trip costs about 0.03 ms:

| Read | Before | One query |
|---|---|---|
| All datasets (2,000) | 223 ms | 0.9 ms |
| All metrics (5,000) | 544 ms | 2.3 ms |
| All terms (2,000) | 214 ms | 0.8 ms |
| Verified match, no hit (5,000) | 658 ms | 0.27 ms (#499) |

Counted from the code, for 2,000 datasets, 5,000 metrics and 2,000 terms: about 45,000
single-record reads for one question from Home, and about 110,000 for an agent with a topic. The
worst places:

| Where | What it did | Fix |
|---|---|---|
| Hidden-column check on metrics | For a person with any hidden column, re-read every metric once per metric: about 50 million reads per call at 5,000 metrics, up to 3 calls a question | Once per request |
| Repeated lists | All datasets 4 times, all terms 4 times, a topic's members 4 times, the chart vocabulary up to 3 times, `catalog.json` parsed 50 to 60 times | Kept for the length of the question |
| Every list | One transaction per record | One query, paged at 100 records or 8 MiB |
| A dataset open | Every row loaded into the app to summarise its columns | `statsResident` and `qualityResident`, as the Data page |
| A dashboard open | Every metric in the project computed, Live ones against the warehouse's daily limit | Only the dashboard's own metrics |
| Checking verified questions | The whole project's vocabulary built to check at most 20 | Only what their charts name |
| Home | Every dataset, visual and dashboard name in the prompt; the 12 datasets with columns were the first 12 | Counts, and the 12 step 3 ranks highest |
| An agent's outside-the-topic check | Every dataset read, then every dataset compared with every metric and term | The step 3 index |

### The rules

- **No question lists the whole project.** Its facts come from step 3's index (its top results)
  and from what is open. A negative-control test proves an ask calls no whole-project list.
- **Step 3 is one Postgres index**, `assistant_search`, built as ⌘K's is (0022): rewritten in the
  same transaction as each save, a marker and a lazy rebuild, words split by the app, and the
  read-everything path kept as the reference a differential test holds it to.
- **Access is filtered inside the query.** Coarse grants (which teams may see a source table,
  whether a dataset is closed to viewers) are columns of the index and part of the `WHERE`. Only a
  person's own row and column checks run after ranking, on the few results.
- **Meaning and words merge by rank** (reciprocal rank fusion: 1/(60 + rank) in each list, summed),
  never by comparing their scores. Without fingerprints it is words alone.
- **Fingerprints are made by a job**, never inside a save: the save stores the text's hash, a job
  claims what needs one (`SKIP LOCKED`), each row records the model that made it, and a model
  change refingerprints in the background. Until then an item is found by its words.
- **Row values never go into Postgres.** "Acme" and "West" are matched in the engine, on the
  top-ranked datasets' text columns, under the person's row lock; on a Live dataset through the
  warehouse door or not at all.
- **A budget test** (`test-askBudget`) builds 2,000 datasets, 5,000 metrics, 2,000 terms and 5,000
  verified questions, counts the queries and record reads one question makes (from Home, on a
  dataset, on a dashboard, through an agent with a topic, and reopening a conversation), and
  fails above a ceiling. Each change lowers the ceilings it earns.
- `catalog.json` stays one record per project; a project whose catalog passes 4 MiB is logged
  once, and it is split per dataset only when a real project nears the 8 MiB cap.

### Step 3's index, as built (`0027_assistant_search`, PR 6a)

- **What it holds:** datasets (name; description from the catalog), their columns (name;
  display name, "also called" names and description from the catalog's column docs), metrics
  (name, description), glossary terms (name, other names, description) and documented source
  tables (`connections/<id>.tables.json`, editors only). Never a value: no example, value label,
  filter value or row. Verified questions keep their own index (0026).
- **Parts, not rows:** an item draws on up to two records, its own and `catalog.json`, so each
  record writes only its own part and a query sums the parts by item. `catalog.json` is split into
  groups (one per dataset, one for certified and retired) with a hash each: a save rewrites only
  the groups whose hash moved. At 10,000 column docs a column save costs 82 ms, 26 ms of it the
  describer on the event loop, instead of a 179 ms rebuild on the next question.
- **Words** are `answerSuggest.words`, less a short list of question words, with a light English
  plural fold (`src/ai/modelWords.ts`), the same on both sides. **Score:** 4 per asked word in a
  name, 2 in an other name, 1 in a description; then certified first, kind, newest, key. An
  integer the JS reference reproduces exactly (`test-assistantSearch`).
- **Access:** a viewer's query never matches a source table (`audience` in the `WHERE`). A column
  hidden from the caller, and a metric or term that reads one (`metricHidden`, `termHidden`, as the
  vocabulary leaves them out), are dropped after ranking, a page at a time. Retired items are left
  out. `countModel` counts datasets, metrics, terms and source tables the caller may see, never
  columns. For a caller with a hidden column those checks read every dataset and metric once a
  request (`hiddenAnywhere`, `metricsByName`): 1.6 s for a question whose results hold a metric, and
  1.2 s for the counts, at the size below. Since PR 6c both are index-backed (below).
- **Measured** (Postgres 17, 2,000 datasets × 20 columns, 5,000 metrics, 2,000 terms, 10,000
  column docs, 61,000 rows): first build 1.2 s, once; a question matching nothing 0.4 ms; one
  whose words match thousands of items ("sales by region") 22 ms, against 1,400 ms for reading
  every store. Until Postgres has statistics on a fresh build (autovacuum, about a minute), 17 to
  35 ms. The API is `searchModel` and `countModel` (`src/ipc/assistantSearch.ts`); PR 6b puts it
  on the ask path.

### On the ask path (PR 6b)

No ask calls a whole-project list any more (`test-askNoProjectLists` spies every store's list on
eight asks; with the index off, each one lists). What each reads:

- **Home:** counts (`countModel`; visuals and dashboards off ⌘K's index, one query), the 12
  datasets step 3 ranks highest for the question by their names or their columns' with the
  newest after them when fewer match, and the 8 best metrics and terms, by name and definition.
  The guidance gives the same 12 datasets' guides (`src/ipc/homeFacts.ts`, once per ask).
- **A topic:** only its own datasets, metrics and terms, by id in one query (`topics.membersOf`).
- **A dataset open:** its metrics and terms through the index's exact-lookup keys (0028: `d:` and
  the dataset's id), read by id.
- **A dashboard:** its own metrics, and at most 5 more that step 3 finds for the question on its
  other datasets (Q12), under the same saved filters.
- **An agent's outside-the-topic check:** step 3's search with the topic's datasets left out, each
  dataset scored by its own and its columns', metrics' and terms' matches; the first readable wins.
- **Checking the model's answer:** only the datasets, metrics and terms its spec names, found by
  their name as the validator compares it (0028 `keys`: trimmed and lowercased, and squashed,
  hashed; a match is a candidate, the validator's own rule decides) and read in one query. "Did
  you mean" a dataset offers among the 20 step 3 finds for the name said: one that shares no word
  with it (a one-letter typo of a one-word name) is no longer offered. `test-askIndex` holds a
  corpus of model answers Object.is-equal to the whole vocabulary, an admin and a restricted viewer.
- **Every ask:** its agent by its own record, a verified example's terms by id, and the metrics
  of a verified chart's metric's name through the index (no list of agents, terms or metrics).
- Without a database, or when an index query fails (logged once), each takes its reference path,
  the lists it read before.

`test-askBudget` at the scale above, queries and record reads (memo hits counted), before → after:
Home 345 / 7,134 → 89 / 154; a dataset open 345 / 7,121 → 88 / 123; an agent with a topic
339 / 7,113 → 75 / 136; a dashboard 354 / 7,112 → 112 / 183; the restricted viewer from Home
345 / 14,135 → 359 / 11,153 (PR 6c: → 114 / 7,299). Building one Home question's facts takes
20 ms (Q8).

### Answers keep the figures they had

An answer stored only its chart form, so it was computed again each time its conversation
opened: new rows changed an old answer under the words around it, "yesterday" moved to another
day, and a conversation with 15 charts ran 15 queries on every open, Live ones in the warehouse.
Now:

- **The turn stores a snapshot:** the card as the server computed it (bars or table, caption,
  bullets, filter labels, the resolved dates of a relative period) and its time. Reopening shows
  "As of Nov 1, 2:03 PM" with **Refresh**, and runs no query. Saved visuals and dashboards stay
  live. The AI's sentence still carries no figures.
- **Only while your access is unchanged:** each snapshot stores a fingerprint of the person's row
  lock on that dataset and their hidden columns. On open the server works it out again, reading
  no rows; if it differs, or the dataset is gone, the stored figures never reach the browser: the
  card is computed under today's access and says so. The channel is a reader in the row-policy
  safety net.
- **Refresh replaces the snapshot:** "As of Nov 15, 9:10 AM · first asked Nov 1".
- **A relative period shows its dates:** "Yesterday: Oct 31, 2026". A follow-up is a new answer,
  computed live.
- **An answer saved before this** gets its snapshot on its first open, labelled with that time,
  never backdated.
- **At most 64 KB a snapshot;** a bigger table answer is computed each time it opens, labelled "Updates on open" ("Live" is the word for a warehouse dataset).

### The changes, in order

| PR | What |
|---|---|
| 1 | The hidden-column metric check, once per request |
| 2 | Lists kept for the length of a question; the catalog size log; `test-askBudget` at the counts of the day |
| 2b | Answers keep their figures |
| 3 | One query per list in the record store, for every screen |
| 4 | An open dataset uses the DuckDB stats; a dashboard computes only its own metrics |
| 5 | Verified checks read only what they name; MCP's `answer_verified_question` uses the index |
| 6 | The `assistant_search` index, then a measurement of whether it should hold summaries too |
| 6c | A caller with a hidden column: its dataset and metric checks off the index |
| 7a | pgvector where Ordinate runs, optional everywhere (`0029_pgvector`): CI, the nightly, the release boot, Compose and the chart's kind run use `pgvector/pgvector:pg17-trixie`; the extension and `assistant_search_vectors` are made only where present; `src/server/vectorStore.ts` |
| 7b | The fingerprint model (Admin → AI, off by default) and `rankFusion.fuse`: done; 7c, the fingerprint job and the ask path, next |

**Measured after 6b:** building one Home question's facts takes 20 ms on the budget's project (2,000 datasets,
5,000 metrics, 2,000 terms), under the 50 ms line, so the index holds no summaries (6a's open question).

**What 7b still needs.** Its rules are above (a job makes fingerprints, each row records its model, meaning and words
merge by rank). pgvector (7a) and the fingerprint model (7b) are done; the job and the ask path (7c) are next:

- **pgvector (7a, done).** CI's check and web jobs, the e2e nightly, the release boot check, Compose and the chart's kind
  run use `pgvector/pgvector:pg17-trixie` (`postgres:17`, which is trixie, plus the extension). `0029_pgvector` creates
  the extension only where Postgres offers it and the role may, catching any error inside its DO block, and
  `assistant_search_vectors` (org, project, item, model, text hash, `vector(768)`, HNSW over cosine, forced RLS) only
  where it then exists. Every model's fingerprint is 768 numbers. An extension created later gets its table from the
  app through the same function, `ordinate_ensure_vector_store()`; `vectorStatus()` says which case a database is in
  (`no_database`, `no_extension`, `not_created`, `no_table`). `test-vectorStore` runs the 768-dimension round trip
  through the HNSW index, the later install, a role that may not create the extension, and, with
  `ORDINATE_EXPECT_PGVECTOR=1` as in CI, fails when pgvector is missing. A managed Postgres creates it by hand
  ([upgrade.md](../server/upgrade.md#pgvector-for-meaning-search-0029_pgvector)); without it, search stays on words.
- **The fingerprint model:** decided and built in 7b part 1 (see "Open questions"): picked in Admin → AI from the org's
  own OpenAI, Gemini or gateway key, off by default, with `src/ai/rankFusion.ts` for the merge.
- **Spelling mistakes** (also phase C): `pg_trgm` is available everywhere and would bring back the "Did you mean" that
  6b drops for a typo sharing no word with any name ("Ordrs"); its similarity is a float, so it needs a reference the
  differential can hold to.

**A caller with a hidden column (PR 6c).** No list of the project either (`test-askNoProjectLists`
adds a viewer that Orders' cost is hidden from: zero lists; with the index off, it lists):

- **`hiddenAnywhere`** reads only the datasets the index says may hide a column. Each dataset's
  base part carries `col:rules` (it holds column rules, sanitizing or not, or another dataset's
  id), `up:<id>` for each dataset it is built from (`parentsOfRecord`) and `col:known` (written by
  a release that writes these keys); no migration, they are 0028's `keys`, and
  ASSISTANT_SEARCH_VERSION 3 rebuilds every project once. One recursive query takes the ruled ones
  and those without `col:known` (an older pod's write), those built from a dataset the index does
  not hold (gone, in the Trash, unreadable, an id in another case), everything built from those at
  any depth, and any with a chain of more than the walk's 16 above it. That is a superset of the
  datasets whose hidden columns can be non-empty, and `hiddenColumnsFor` decides on each. A rule
  saved or removed rewrites the record's keys in the save's transaction, as every key.
- **`metricHidden`** finds a formula's metrics by the name keys of its stretches: every substring
  `mentionsHidden` could match (bounded by non-word characters, lowercased, trimmed; over 2,000 of
  them, every metric), the records read in one query and kept as `metricsByName` keeps them (the
  first of each lower-cased name in `listMetrics`' order). Lowercasing twice is lowercasing once
  over every code point, so a stretch's key is the name's.
- The counts' metric and term checks read a thousand records a query, and a ranked page's column
  checks its datasets' records in one.

`test-hiddenIndex` holds both Object.is-equal to the full walks (index off) for an admin, an
editor, two viewers the rules hide columns from, one in the team they show them to, and a fan-out:
over own rules, two levels of derivation, a union, a join, a chain of 18, a cycle, rules that do not
sanitize, the Trash, a rule added and removed, a deletion; and every metric of formula chains,
cycles, a chain past the depth, names differing in case, a name inside another, renamed and deleted
ones. NEGATIVE CONTROLS: a
dataset's `up:` key or its whole part out of the index, a metric's name key out: each fails.

**Left on the ask path for a caller with a hidden column:** the counts still check each metric and
term the caller can find (5,000 and 2,000 records, a thousand a query, at the budget's size). And
for anyone, a formula metric's figure (`factMetrics`' additivity, `resolveMetric`) still reads
every metric by name: `test-askNoProjectLists` keeps its formula on a dataset no case computes.

## Build order

| Phase | What | Needs |
|---|---|---|
| 0 | The Assistant page (#488); #492: one AI call per answer, "last quarter" from the calendar as dashboards do, every dashboard date preset; conversations in their own tables, all kept and paged (#493, #495, #498); agents (#496); the verified match inside what is open (#497) and by index (#499) | done |
| 0+ | [Scale rules](#scale-rules): no whole-project list on the ask path, and answers that keep their figures | the PR chain below |
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

- **Fingerprint model (phase C): answered (PR 7b).** The org's own OpenAI, Gemini or gateway key,
  picked in Admin → AI and off until an admin does: OpenAI `text-embedding-3-small` / `-large`,
  Gemini `gemini-embedding-001` / `gemini-embedding-2`, or a gateway's id; 768 numbers each,
  normalized by the server; Anthropic has none. A Test action checks one sample. Details, the cost
  note and the rank merge: `docs/ai-models/00-plan.md`, "Meaning search".
- **Date-filter pruning (phase A).** Unmeasured; see above. If the cast doesn't hurt pruning on a
  given warehouse, leave that dialect alone.
- **Folders and `/p/` links (phase E).** A published dashboard keeps working for its audience;
  whether moving its folder should warn about published links too.
