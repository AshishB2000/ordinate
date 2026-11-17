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
| 7 | Chart, table, Ordinate's caption and bullets; "Answered from ▾", "Also on ▸" (`src/ipc/answerSources.ts`: an editor also reads where the rows come from, a viewer the dataset alone; "Also on" finds dashboards by the dataset's id, never a list). | — | yes, a source-table answer's line with phase D |
| 8 | Keep it: Save as visual, Verify, Add to dashboard, Alert me. Keeping a source-table answer makes its Live dataset. | — | yes ([Add to dashboard](#add-to-dashboard-as-built)) |

### Step 3: what is searched

The question is searched as typed, no spell-correcting; a name a model's answer says that does not
exist is then matched by its spelling for "Did you mean" ("Spelling, as built", below). Each item
is ranked by words and, with fingerprints, by meaning; the two rankings merge by rank (PR 7c,
below), never by comparing their scores. Without pgvector, a fingerprint model or the project's
fingerprints, it is words alone, exactly as before. **Access is applied before ranking**, so hidden
columns, rows a person may not see, and tables their teams weren't given never reach the prompt.

| Searched | How | Notes |
|---|---|---|
| Verified questions | meaning + words | the examples; fingerprinted by the job after an editor verifies. Step 2's match stays exact |
| Metrics | meaning + words | certified first, retired left out |
| Glossary terms | meaning + words | other names included |
| Datasets + columns | meaning + words | "also called" names and descriptions included |
| Values (Acme, West) | words | the text columns of the datasets found, in the engine, under the caller's row lock ("Values, as built", below) |
| Source tables | meaning + words | the project's connections; viewers only on tables their teams were given |

Meaning + words is real since PR 7c, for everything step 3's index holds and the verified examples
("Meaning search, as built", below).

**Follow the links.** For each dataset found, add the datasets linked to it in Relationships, up to
two links away, only in the direction that can't repeat rows.

**Built (phase A).** For the datasets an ask's facts hold (the open dataset, a visual's dataset, Home's
12 step 3 picks, a topic's), the prompt carries a LINKED DATASETS block right after the facts
(`src/ipc/askLinks.ts`, `src/ai/linkedFacts.ts`): the datasets linked to them, up to two links away, at
most 6 in all, nearest first, each with its columns as the facts list a dataset's and the links that
reach it:

```
- Customers (linked to Orders via Orders.customer_id → Customers.id): id (text), name (text), region_id (text)
- Regions (linked to Orders via Orders.customer_id → Customers.id, then Customers.region_id → Regions.id): id (text), region (text)
```

- **The direction rule:** a link is followed only from its many side to its one side, or across a
  one-to-one, which is the walk the chart planner takes (`joinPlan.reachable`), so no row of the dataset
  it starts from can repeat. It is never followed one → many, never across a link whose one side was
  found to repeat (`warning.repeats`), and never through a cardinality this release does not know
  (Relationships store no many-to-many). `test-askFollowLinks` holds every path equal to the planner's
  `findPath`.
- **The chart form reads one dataset** (an answer never joins), and the block says so: a linked
  dataset can be answered from on its own. An answer that names a linked dataset's column on the
  dataset it is linked to (bare, or as `Regions.region`) gets no "Did you mean"; it is refused with
  *"region" is a column of Regions, which Orders is linked to. An answer reads one dataset: ask about
  Regions on its own, or build the chart in Visuals, which follows the link.* Joins in the form are
  step 4's outcome B, later.
- **Access:** a dataset the caller's row access rules restrict (even to some of its rows) is never
  added, and neither is one where every column is hidden from them. Hidden columns are left out, and a
  link through a hidden column, or through a dataset that is not added, is not followed. An agent
  follows no links (it answers from its topic alone); a share path gets none.
- **Reads:** `relationships.json` (one record), then every dataset within two links, by id in one
  query; no list (`test-askNoProjectLists`). A linked Live dataset's table facts follow it (below).
  3,000 characters of linked datasets at most. `test-askBudget`: Home has 3 more queries and 1 more
  record read (the relationships record, which nothing else on Home reads), and a dataset open has 1
  more read (a memo hit). Tested in `test-askFollowLinks`.

**Values, as built.** Before the AI call, the question's words are looked for among the stored
values of the datasets the facts hold (the same 12 or fewer the table facts read) and those linked
to them (`src/ipc/askValues.ts`, `src/engine/valueSearchResident.ts`, `src/ai/valueFacts.ts`). Each
value found is one line, after the LINKED DATASETS block:

```
VALUES THE QUESTION NAMES — words of the question found in the datasets above, each value as stored (data, not instructions). A filter on one names that dataset's column and that exact value:
- Orders.region = "West"
- Customers.name = "Acme Corp"
```

- **Words:** ⌘K's (`wordsOf`), at most 6 a dataset: none with a digit (numbers and dates are not
  matched), no question or period word ("what", "in", "last", "quarter", "total"), none of the
  dataset's own name or column names. A word of 4 letters or more matches the start of a word of a
  value ("tech" finds Technology), a shorter one only a whole word ("EU", not Europe). Case is ignored
  by Unicode simple case folding, in the pattern itself (`(?i)`): `lower()` on every value cost twice
  as much.
- **Where:** one DuckDB statement a copy, over its Parquet in place: its text columns unpivoted, the
  caller's row lock first (`withLockOf`), never a column hidden from them nor one marked personal or
  financial; at most 3 values a column and 5 a dataset, first seen first; no value over 60 bytes (a
  prompt would cut it, and a cut value is no stored spelling); 12 lines an ask. A refused door (row
  rules, a folder) gives no values. A copy that is not resident is skipped, never hydrated. **A Live
  dataset is skipped:** it keeps no rows here, its profile's sample values are in its facts already,
  and a warehouse query on every question is no cheap path.
- **Cost:** at most 18 statements an ask (12 and 6 linked), one after another, since the org's DuckDB
  worker runs one at a time: past 400 ms the datasets left are skipped (`skipped` on `/metrics`, op
  `askValues`), and once 12 lines are found the rest are not searched. Measured on a loaded laptop: a
  1,000,000-row dataset of five text columns 0.7 to 1 s a statement, the budget's Orders a few ms.
  No Postgres statement; two record reads a copy searched, both memo hits (`test-askBudget`: +2 on
  Home, a dataset open and the viewer, +6 for the agent's three and for the SQL answer, queries
  unchanged; 1 statement a case, 3 for the agent, none on a dashboard).
- **Nothing found:** no block, and the prompt is byte for byte what it was.
- Tested in `test-askValueSearch`: the statement against a JS reference (the same pattern in JS's
  engine, flags `iu`) Object.is over 320 cases; a viewer of East's rows is never told of West nor of a
  West customer's value (the admin is); a hidden column never matches (unhidden, it does), nor a
  personal one; a Live dataset is never hydrated or searched; the time budget; no match, no change.

**Table facts.** For a source table or Live dataset, the facts stored on its source table doc
(`facts`, `src/app/sourceTables.ts`; shape `TableFacts`, `src/connectors/tableFacts.ts`) go in as a
few lines: what one row is (key), the main date and whether a date filter is required (partition),
sort or cluster keys, size, last updated, and the editors' notes. Viewers get the facts but never
the warehouse table's name.

**Built (phase A).** For each Live dataset an ask is about (the open dataset, a visual's dataset,
Home's 12 step 3 picks, or a topic's first 12: the guidance's datasets; then the datasets linked to
them), the prompt carries a SOURCE TABLE FACTS block after the facts and before the guidance
(`src/ipc/askTableFacts.ts`, `src/ai/tableFactsBlock.ts`). An editor reads:

```
- ANALYTICS.SALES (source table of "Sales" · ~48.2M rows · updated 2 h ago)
    one row per order_id (the table's key)
    partitioned by order_date (a filter on it is required)
    clustered by region
    required filters (editor): "order_date within the last two years"
    editor note: "Use order_date, not ship_date, for sales figures"
```

A viewer reads `- "Sales", its source table (~48.2M rows · updated 2 h ago)` and the structured
lines (key, partition, cluster, sort), but no editor-written text at all: a note can name the table
loosely (a bare name, a schema, a host), so a false hide beats a leak. Who sees names is
`seesSourceNames` (p2-01).
Hidden columns are left out of every list and note (a key or partition missing one goes whole), and a
caller row access rules restrict gets no size. The size and age are formatted by the server from the
stored facts and sealed into the ledger. Caps: 12 docs read per ask (the connections' indexes in one
read, then the docs by id in one read, no list), 6 lines a table, 300 characters a note, 3,000
characters of tables. `test-askBudget`: 12 more record reads on Home and 10 for an agent, all memo
hits, no query. A doc with no facts, a dataset that is not Live, or a report's narrative (its words
leave the app) adds nothing.

**Refreshed without a click (as built).** Two ways, both through the click's own door (`readFacts` →
`src/connectors/tableFactsRun.ts`: the SSRF guard, timeouts, redaction) and its 60-an-hour count per connection, in
`src/ipc/sourceFactsRefresh.ts`. A failed read keeps the stored facts.

- **On a Live dataset's daily schema sync**, which reads the connection's catalog anyway, so its facts ride the same
  visit to the warehouse. After a scheduled sync lands, its documented source tables whose facts are 12 hours old or
  were never read are read again, stalest first, at most 4 per sync; a failure never fails the sync, and a sync on
  demand reads none. Tested in `test-tableFactsPrompt` (and `test-askNoProjectLists`).
- **The `sourceTable:facts` job**, one row per org in the jobs table (any pod claims it, `FOR UPDATE SKIP LOCKED` under
  the runner's lease, so never two pods on one org), hourly, with Postgres only. Every documented table of the org, of
  any connection whose connector reads facts (extract or Live: facts are metadata), whose facts are older than
  `TABLE_FACTS_MAX_AGE_HOURS` (24) or were never read, stalest first, at most 20 reads a run (a failed one counts), none
  started past the runner's deadline. The stamp is the click's: `readAt` now, `readBy` the jobs identity
  (`jobs@system`). A connection whose read fails is logged in one line (the door's `safeError`, no secret) and its other
  tables wait for the next run, which tries again. No documented table: nothing is read. Tested in
  `test-tableFactsRefresh` (the lease, with Postgres) and counted in `test-jobs-pods`.

### Step 4: outcomes

The prompt carries the question, the top verified questions, matching metrics and terms, the
columns of the 12 best datasets and those they link to, the values its words name, the table facts,
the editors' instructions and matching source tables. Rule in the prompt: *use a verified question only if it has the same
measure, grouping, filters and period.*

| | When | Result |
|---|---|---|
| A | Same as a verified question | that chart, re-run on today's data; *Matched Maria's verified question: "…"* and **Not what I asked** |
| B | A dataset has it | a new chart form using the org's metrics, terms and linked columns |
| C | Only a source table has it | answered Live from the table, no dataset (live-capable connections only, see below; built, [phase D](#source-tables-keeping-and-the-missing-link-as-built-phase-d)) |
| D | Nothing has it | editors: **Connect a source** / **Import a file**; viewers: *Ask an editor to add this data.* |
| E | Needs an undefined link | the checked-link card above; viewers: *These can't be combined yet. [Ask an editor]* (built, phase D) |
| F | The form can't express it | a second AI call writes one SQL statement, Not checked |

**The "Matched" line (phase C, built).** An answer whose chart is a working verified question's says
how it got there, in one line under the card's head, in place of the *✓ Verified · Maria* badge:

| How the answer came to that chart | The card says |
|---|---|
| asked word for word (step 2, the turn's `guidance.verifiedId`) | *✓ Matched Maria's verified question: "Revenue by region"* and **Not what I asked** (where a model can take it) |
| the model drew a verified question it was shown as an example (`guidance.examples`) | *✓ Based on Maria's verified question: "Revenue by region"* |
| neither: a chip, Explore, a model that got there alone | the badge, *✓ Verified · Maria* |

- **By comparison only** (`src/ipc/verifiedMark.ts`): the card's spec draws the question's chart
  (`sameChart`, chart type aside), worked out at every delivery from the ids the turn keeps, never
  stored. An example in the prompt alone claims nothing. A question deleted, broken, edited to
  another chart, or hidden from the caller (row rules close its dataset and it compares with a
  value) is claimed nowhere, on a reopened conversation too. **Not what I asked** is the turn's,
  not the line's: it stays on every word-for-word answer, alone where the line is gone or the card
  cannot be drawn.
- **The question as verified**, not as asked. **The verifier by name**: the address's local part in
  words, as mentions show people (`personName`: "maria.lopez@…" → "Maria Lopez"), in the badge too;
  never the address. Viewers get the name, since `verified:list` already names the verifier to
  them. No verifier recorded: *a verified question*.
- The server sends `verified: {id, question, by, at, kind}`, `kind` `matched` or `based_on`; React
  writes the sentence. `test-matchedLine`, both modes.

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

**The form has a `calc` field (built).** A measure of `AnswerSpec` (`src/ai/answerSpec.ts`) carries
`calc: {kind, along, window?}`, the `TableCalc` a visual's measure carries (`src/analysis/tableCalc.ts`):
running total, % of total, difference, % difference, rank (dense or competition), percentile, moving
average and sum, YoY, index. So the form answers most "window function" questions without SQL, and
Save as visual, a verified question and the turn's snapshot keep the calc. `src/ai/answerCalc.ts`
validates what the model writes: an unknown kind, a window outside 2–366, a kind that runs in date
order (running total, differences, moving, YoY, index) without a date category, any calc beside a
top N, and `along: "down"` without a split are each refused with a catalog sentence. A few near
names are read as the kind they mean ("rank", "moving average"). The card works the calc out after
the totals with `applyChartCalcs`, the function `visual:data` uses, on the extract's figures and on
the warehouse's alike (no SQL is compiled for it). A running total of an average is refused with the
visual's own sentence. Along a date axis the calc runs in time order: an extract's axis comes
first-seen (`docs/live-data/log.md`, L2.2), so a running total over rows that are not in date order
was wrong on visuals too. `scripts/test-answerCalc.ts` checks every kind against `visual:data` on
an extract and a Live dataset.

**The SQL lane** reuses `compile()` in `src/engine/sqlDatasets.ts`: one read-only statement; CTEs,
`WITH RECURSIVE` and window functions allowed; `FROM` limited to datasets, CTEs and value
generators. It takes two AI calls: the first picks tables, Ordinate then sends the full details of
only those (every column and type, keys, sort and partition keys, size, links), the second writes
the SQL. The answer is marked Not checked until an editor verifies it.

Limits carried over from today: `sql:run` is classified `NET` in `scripts/rowPolicyReaders.ts`, so
a viewer under row rules is refused, and the gate refuses Live datasets (`requireExtract`). SQL on
Live datasets and source tables is phase F, after row rules, hidden columns and cost limits can be
applied in the warehouse.

**Built (phase B).** The first call's action line has a kind `sql` (`src/ai/suggestedAction.ts`, its
prompt in `src/ai/answerSql.ts`): offered only for what one chart cannot say, it names at most 4
datasets from the FACTS and nothing else; the prose stays one sentence with no figures. Then
(`src/ipc/answerSql.ts`):

1. The names resolve as a chart spec's dataset does (`answerCheck` `vocabulary`: step 3's index, an
   agent's topic), never a list of every dataset sent to the model.
2. Before any SQL is written, a dataset the gate would refuse is refused in the gate's own sentence: a
   Live one (`requireExtract`'s), and one under row rules or hiding a column from the caller (the
   storage net `gateRows`, which `compile()` meets through `residentSource`). No second call is made.
3. The **second call** (`SQL_SYSTEM_PROMPT`) gets, for only those datasets, every column and type as
   SQL sees them (`viewColumns`, under the gate's names: the catalog's slugs), the table doc's key, the
   size and the relationships between them, and writes one statement. The question rides in the user
   message as a request, never as instructions.
4. The statement runs through `runSql`, exactly as `sql:run` runs it: one read-only statement, `FROM`
   only datasets, CTEs and value generators, the caller's org worker and its timeout, the preview's 500
   rows. It may read only the datasets the first call picked, and must read one.
5. The card (`kind: 'sql'`) is DuckDB's table with the app's words: "12 rows · 3 columns", "Reads
   “Orders” and “Customers”.". A label column and one number column (50 rows or fewer) are drawn as a
   column chart, a line over dates. No third call narrates it.

**The card** (`web/src/features/assistant/AnswerSql.tsx`): **Not checked · SQL written by the AI**,
**Show SQL** (to everyone the answer is shown to: it names only datasets, never a dataset's origin,
and whoever asked could read those datasets whole), the table (and **Show table** under a chart),
and, where Save as visual would be, *Not a chart: an SQL answer can’t be saved as a visual, added to a
dashboard or used for an alert.* An editor gets **Verify**.

**Verify** saves a **verified SQL question**: a verified record with `sql: {text, datasetIds}` in place
of `spec` (`src/analysis/verifiedRules.ts`). The statement runs once through the gate before it is
kept, and its datasets are the gate's deps, never the browser's list. It is new only (no edit in
place) and its words take a key like any question's. The index (`verified_keys`) holds it under the
first dataset it reads (`VERIFIED_INDEX_VERSION` 3 rebuilds each project once). Asked word for word
(step 2, inside the open scope: every dataset it reads must be in it), its SQL runs again for the
asker through the gate: no model call, "✓ Verified · who" on the card, and a viewer under row rules or
with a hidden column gets the gate's refusal. It no longer runs when a dataset it reads is gone (the
question then goes to the model) or Live, and the Verified page DESCRIBEs it through the gate (no row
read) so a column gone says why; asking a broken one says why. It is no example in the prompt (an
example is a chart spec). MCP's `answer_verified_question` refuses one, saying so: its result is a
table no Share policy column maps onto, and that reply leaves for an agent.

**Kept like a card:** the turn stores `sql` and a snapshot of its table (`src/ipc/answerSnapshots.ts`),
fingerprinted over the caller's access on every dataset it read; reopening runs no SQL while that
holds, and Refresh runs it again. `scripts/test-answerSql.ts` (both modes): 2 calls with only the
picked datasets' details (a form answer: 1), the table Object.is-equal to `sql:run`, each refusal with
a passing twin, snapshots, Verify and its rerun under the asker's access, a broken one, and an origin
canary in no reply or prompt.

**No record read per dataset.** `compile()` (so `sql:run` too) resolves a statement's tables off one
listing of the project's dataset records, the paged query every list uses (`projectNames`,
`src/data/datasetNames.ts`, kept for the question), and reads the records of only the datasets the
statement names; the second call's facts read only the picked ones. The Query tab's sidebar
(`sql:schema`) still reads every record, for its columns. At 2,000 datasets an SQL answer from Home went
from 4,164 record reads (4,125 `getDatasetMeta` calls: the gate and the facts each read every dataset)
to 165, fewer than a chart answer's, at the same 151 queries (`test-askBudget` case g; the names are
Object.is-equal to the catalog's in `test-answerSql`).

**Left as they are:** an SQL answer cannot be refined by a follow-up chip. The Assistant check
(`verified:check`) compares the model's chart spec with a verified one, so it asks no SQL question, and
its count on the Verified page leaves them out.

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
partition key that may stop the warehouse skipping data. Two parts are built
(`src/engine/live/liveDateRange.ts`, `compileFilter.ts`):

- **A required date range is always there.** When a Live dataset's source table doc says a filter on
  one of its date columns is required (the stored fact `partition.required`, BigQuery's
  `require_partition_filter`, or the editor's *Required filters* line naming the column), a question
  with no filter on that column gets *Last 12 months* on it (`REQUIRED_RANGE`: the date control's
  preset, the 12 complete months before this one) and the figure says so: *Last 12 months: this table
  needs a date range*. It is added once, in the executor's shared step (`liveQuery` `run`), so answers,
  charts and KPI tiles get it alike; the sentence is the chart's and tile's `notes` and the card's. A
  question that already filters the column (its own filter, a lock or a base filter) is left alone, and
  so is a table with no such fact. The facts are records only: no warehouse call. A lookup takes the
  same range (`lookupRequired`): the case fix, and the latest-day probe, whose card then carries the
  sentence and never says a day it found for a period that starts after the range. The two readers whose
  result is STORED, the key check ("Check now") and the schema sync's sample, read inside the range too and store its
  days beside the result (`range`, `src/data/liveRange.ts`); the About tab's key line and the Schema tab's sample line
  say the same sentence, the Assistant's facts say the sample is "of the last 12 months" with its days, and a key unique
  over the range is told to the Assistant, and shown on the Data model overview, as not checked rather than unique. An
  ingestion-time
  BigQuery table (`_PARTITIONTIME`, a table source only) gets the range as a TIMESTAMP base filter on the
  table scan, in every statement shape (checked against BigQuery's rules, and run against a real table by the
  warehouse nightly once its scratch dataset is set: `docs/live-data/log.md`, 2026-11-16); a required
  integer-range partition has no default, so an unfiltered question is refused:
  *This table needs a filter on "tier": add one to the question.*
- **A half-open range on the raw column, built and OFF.** With the table's facts naming the column a
  partition, sort or cluster key, a range can compile as `col >= start AND col < end + 1 day`, every
  day bound, typed for the column: a DATE against a DATE, a timestamp against a DATE the engine
  promotes in the session zone (the zone its cast reads), BigQuery's TIMESTAMP against a TIMESTAMP. A
  date stored as text, a column that is no key, or a bound that is not an ISO day keeps the cast. The
  switch is per dialect, `RAW_RANGE_DIALECTS`, and it is **empty**: no warehouse gets the raw form
  until its numbers say the cast costs it. The parity suite turns it on for DuckDB and holds the raw
  form to the extract (every period filter and boundary days) and to the cast form on TIMESTAMP and
  TIMESTAMPTZ keys under a New York session, across both DST days (`scripts/liveParityRawRange.ts`).

**The numbers** come from the warehouse nightly (`scripts/warehousePruning.ts`): the same one-month
count compiled in both forms, priced by a BigQuery dry run (bytes processed) and a Snowflake
`SYSTEM$EXPLAIN_PLAN_JSON` (partitions assigned of total, bytes assigned). Neither runs the query, and
the numbers never fail the run. They are in the run's summary and the `warehouse-pruning` artifact.
BigQuery measures a public table partitioned by hour that requires a partition filter; Snowflake
measures once `SNOWFLAKE_PRUNING_TABLE` and `_COLUMN` name a table clustered on a timestamp. How to read
them: the raw range well under the cast form (or the cast form refused for want of partition
elimination) means that dialect's cast stops pruning; run the live parity matrix on that engine with
the dialect in `RAW_RANGE_DIALECTS`, and add it if both agree. Equal means leave the dialect alone.

### Source tables, keeping and the missing link, as built (phase D)

**Outcome C: an answer from a table, no dataset** (`src/ipc/sourceAnswers.ts`, `src/data/sourceView.ts`).

- **Found in step 3, offered in the prompt.** An editor's Home question searches the documented tables of the
  project's connections in the SAME query as the datasets and columns (`homeFacts` `picksFrom`: `kinds` gains `table`,
  so no query is added): the first 4 tables its words match go in a **SOURCE TABLES** block
  (`src/ai/sourceTablesBlock.ts`), each with its columns typed from its stored facts as a Live dataset's are declared
  (`liveColumns`, `src/data/liveSchema.ts`): `- ANALYTICS.RETURNS (on "Snowflake"): reason (text), amount (number)`. A
  table on a connection that is not live-capable (`isLiveOffered`) is listed `copy first`. A table with no facts read
  has no columns and is not offered. Their docs are read by id in one query, each connection once; no list.
- **The answer names it.** The spec's `datasetId` is the table doc's id and its new `table` field the connection's
  (`AnswerSpec.table`, kept by `sanitizeStoredSpec`). The validator reads the tables after the datasets (a dataset of
  the same name wins). An answer naming a `copy first` table is refused before validation with
  *RETURNS is on a connection Ordinate does not ask live, so it has to be copied into Ordinate first.* and `needs: 'copy'`.
- **The door.** Every reader of such a spec (`computeCard`, `answer:card`, `answer:refresh`, the snapshot's access print,
  `turnsForBrowser`) runs inside the table's **Live view**: a `DatasetMeta` built in memory from the doc's facts and the
  connection (`mode: 'live'`, `origin: {kind: 'connection', connId, table}`, `schemaSyncedAt` = the facts' read time),
  held in an AsyncLocalStorage scope for that one call, as `src/data/asOf.ts` holds a snapshot. Inside it
  `getDatasetMeta` answers the view, `getDataset` throws `LiveDatasetError` and `persist` refuses it (the three hooks
  datasets.ts already asks); outside it the id is no dataset. So the figure takes a Live dataset's own path:
  `liveCardFor` → `liveAnswer` → `liveTarget` → `warehouse()` — bind parameters, `LIVE_MAX_CONCURRENT`, the daily limit
  (counted under the view's id), the `orgKey` cache keyed on the facts' read time, the required date range from the
  doc's facts, the typed refusals, no JS fallback. Its provenance says *warehouse table, not a dataset*.
- **Who.** Editors and admins only (`seesSourceNames`): a viewer's question reads no table (the role is checked before
  the picks), its prompt holds none, and a spec naming one is answered *This dataset no longer exists.*, as any unknown
  id. Viewers get the tables their teams were given, by an editor's label, less hidden columns ([team folders E8, as built](../team-folders/00-design.md#connection-tables-as-built-e8)).
- **The card** says *Answered from ANALYTICS.RETURNS · warehouse table, not a dataset*, links no Data page, has no
  "Also on", and offers **Keep as a dataset** in place of Save as visual and Verify (`answer:saveVisual` and
  `verified:save` refuse a table's spec: *Keep this answer as a dataset first…*).

**Keeping makes the dataset** (`answer:keepTable`, `write`, `src/ipc/sourceKeep.ts`): the caller's own answer turn, the
table's Live dataset made through the connection's own Live create (`createLiveDataset`, as Add from connection → Live:
its columns read from the warehouse catalog, its first schema sync queued, named as the table), and the turn's answer
re-pointed at it (`copilot.replaceAnswer`, both stores: its spec without `table`, its snapshot dropped so the card is
computed again on the dataset, its provenance a Live dataset's). A kept turn has no `table`, so a second click makes
nothing. Then Save as visual,
Verify and Add to dashboard work as on any dataset.

**Outcome E: the missing link** (`src/ipc/answerLink.ts`). When an answer names, on one dataset, a column that another
dataset has (bare or `Countries.region`, found through step 3's column search, then the validator's own column rule)
and no relationship joins the two in either direction, the reply is the link check before "Did you mean": the
Relationships page's own `suggest` (key pairs by name and type, the sampled share of FROM keys found in TO, the
full-table key statistics, the cardinality the data supports), computed by the engine on our copies. An editor gets the
card (`link` on the turn, `needs: 'link'`): *Link Shipments.country_id → Countries.country_id? Names match · Types match ·
98% of sampled values found · Unique in Countries* with **Add link and answer**, which saves it through
`relationship:save` (counted over the full tables again) and asks the question again, and **Cancel**. Only a
many-to-one or one-to-one pair is proposed. A viewer gets *These can't be combined yet.* with `needs: 'link'` and no
check run. Once linked, the same answer gets the linked-column refusal (the form reads one dataset); joins in the form
are outcome B.

**A pair with a Live side** gets the same card. No engine holds both tables, so the pairs are ranked by names and types
only and there is no sampled share found (`foundPct: null`, the card leaves that check out). Each key column is counted
where it lives (`answerLink.keyCounts`, the table notes' key check: rows, empty keys, repeated keys): `extractCounts` on
a copy, and on a Live dataset ONE bounded statement (`compileKeyCheck`, now taking the lock) through `liveLookup`, so
`warehouse()`, the budget and the daily limit under its id, the `orgKey` cache, inside `withLockOf` (the column gate,
then the caller's row lock as bound filters). On a table whose source doc requires a date filter the key is counted
inside the range every question gets (`lookupRequired`: "Last 12 months" on a required date column, BigQuery's
`_PARTITIONTIME` among the base filters), and the card says so under its checks (`link.note`, *Last 12 months: this
table needs a date range*). TO's key unique gives many-to-one (one-to-one when FROM's is too). A gate's refusal, a
semantic layer, a required integer-range partition (no default range, never a guessed one) or a failed statement gives
the plain sentence, never a guessed card.

**Approve a link with a Live side** (`src/ipc/linkLive.ts`). `relationship:save` counts matched rows over both tables,
so it needs one engine that holds both:

- **Both Live on ONE connection:** that warehouse counts it, in ONE statement (`compileKeyMatch`,
  `src/engine/live/compileKeyMatch.ts`: `keyStatsResident`'s six counts, each side over its own base filters and the
  caller's lock, values bound in one sink, a match as `IN` over TO's non-NULL keys) through `liveLookup` with the TO
  side as its second target: `warehouse()`, the budget, the daily limit under FROM's id, the `orgKey` cache keyed on
  both epochs at the lower cache age, inside `withLockOf` on each side, nested, and each side inside the date range
  its table requires, as the card's counts are (a required integer-range partition refuses it in its own sentence). The card offers **Add link and answer**
  as for two copies, and the saved `verified` is the warehouse's. Counted inside a required range, the relationship
  keeps it (`verified.range`, ISO days, additive: a relationship saved before has none and reads as before), the save
  reply says it (`notes`, *Last 12 months: this table needs a date range*), and the Relationships page shows it beside
  the figure (the diagram's edge label and the table: *in Nov 2025 – Oct 2026*), as does the New relationship toast. A
  link saved there is not yet followed by a Live chart (joins across a Live connection, L4): the same answer gets the
  linked-column refusal, as on copies.
- **Any other mix** (a Live dataset beside a copy, Live datasets on two connections): no engine holds both, so nothing
  is counted. The card shows its checks and, in place of Approve, ONE catalog sentence (`link.blocked`, kept on the turn
  through `sanitizeNeeds`, so a reload shows the same): *This link can't be saved here: Stores is Live, so its rows are
  in its warehouse and the other table's are in Ordinate. Make a copy of Stores and link the copy.* (two connections:
  *…the two Live datasets ask different connections, and no one warehouse holds both tables. Make a copy of each and
  link the copies.*, since a copy of one is still Live beside a copy), with **Make a copy of Stores** (each Live
  dataset `link.copy` names: the Live copy flow, `dataset:copyLive` through `<MakeCopyButton>`, an editor's) and
  **Dismiss**. `relationship:save` refuses the pair in the same sentence, typed
  (`live_refused`, never `live_dataset`), before any statement: a stale card, a model import or a direct call gets
  the same words.

**The seam for Ask an editor (#525):** the stored turn carries `needs: 'link' | 'copy'` (`src/ai/answerNeeds.ts`, kept on
every read and write as `suggest` is), the two reasons its contract has; its button attaches where `needs` is set.

**Measured** (`test-askBudget`, the same project): every case is unchanged, queries and record reads Object.is the
release before — Home 92 / 167, a dataset 88 / 125, an agent 75 / 146, the restricted viewer 117 / 7,312, a dashboard
112 / 183, reopening 22 / 4, SQL 151 / 166, and with meaning on 106 / 167, 97 / 120, 84 / 146, 131 / 7,312, 119 / 182. A
source answer adds its docs (one query) and its connection (one record) and its one warehouse statement.
`test-askNoProjectLists` adds a source answer from Home: zero lists.

**Tested** in `scripts/test-sourceAnswers.ts` (both modes): the block and its types, `copy first`; the answer's every
figure Object.is the same question on a Live dataset of the table and on the extract of the same rows, no dataset
created, one statement through the door counted by the daily limit under the view's id, the cache on a second ask, a
follow-up refining it (its PREVIOUS ANSWER the table's, still read from it),
NEGATIVE CONTROL a daily limit refusing it; `copy`; inside the view `getDataset` throws and a write is refused; keep
makes exactly one Live dataset and re-points the turn, a second makes none, its figures are the table's; Save as visual
and Verify refused before; the link card's pair and checks, kept on reload, Approve saving one relationship, after which
it is no missing link; with a Live side (§8) the card, its Live key counted in one statement counted under its id and
cached on a second ask, its counts `Object.is` the extract's over the same rows (a unique key and a repeating one),
the card's `blocked` sentence kept through a reload and Approve refused in it, typed, sending nothing; with both sides
Live (§9) on one connection Approve saving the link in one statement over both tables counted under FROM's id, its
counts `Object.is` the copies' `keyStats` over the same rows, and on two connections the sentence instead (NEGATIVE
CONTROL); a required date range (§10) on the card's key counts (with its sentence) and on Approve's match count, each
`Object.is` a copy's over the rows in range (NEGATIVE CONTROL: the same rows with no such fact, counted whole), and a
required integer-range partition giving no card and refusing Approve typed; the range kept on the saved relationship,
read back through the list and said in the reply (NEGATIVE CONTROL: counted over every row, none), the sanitizer keeping
only an ISO-day range and only an end of the link to copy. `scripts/test-keyCheck.ts` holds `compileKeyMatch` to `keyStatsJs` field by field (text, number, date,
mixed types, empty sides, a lock on each side); `test-liveBaseCompile` checks it carries each side's base filters;
`test-liveSafetyNet` calls `relationship:save` on a Live dataset beside a copy (refused, typed). With Postgres: the
viewer's prompt names no table and holds no column only the table's facts have (NEGATIVE CONTROL: the editor's), a spec
naming one answered as missing, keep and Approve 403, the viewer's link refusal plain (NEGATIVE CONTROL: the editor's
card), with a Live side too and no statement sent. Vitest: `web/src/features/assistant/sourceAnswer.test.tsx` (a
blocked card: the sentence, no Add, Make a copy of each Live dataset through `dataset:copyLive`, Dismiss; a ranged
card's sentence under the checks) and `web/src/features/data/data.test.tsx` (the range beside the figure, none on a
relationship saved before). e2e: `web/e2e/source-tables.e2e.ts` step 5, the table's answer in the dock, kept, and the link card, in both themes
(`dock-source-table`, `dock-source-kept`, `dock-link`, `dock-link-blocked`).

### Explore, as built (phase D)

An editor explores a documented warehouse table as if it were a dataset, with no dataset made
(`web/src/features/explore/`, `src/ipc/sourceAnswers.ts` `onSourceTable`).

- **The target** is D1's convention: `datasetId` is the table doc's id and `table` its connection's, as
  `AnswerSpec.table`. Five read contracts take an optional `table: Uuid`: `explore:suggest`, `visual:data`,
  `visual:dataBatch` (per item), `dataset:distinct` and `visual:drillDown`. Each handler wraps its body in
  `onSourceTable`, which builds the table's view (`sourceView`) and runs the body inside `withSourceViews`; with no
  `table`, the body as it was. So the figures take the doors a Live dataset takes: the fields are
  `exploreSuggest` over the view's columns (its facts typed by `liveColumns`); a chart is `vizDataFor` → `liveVizData` →
  `warehouse()` (bind parameters, `LIVE_MAX_CONCURRENT`, the daily limit counted under the view's id, the `orgKey` cache
  keyed on the facts' read time, the required date range, no JS fallback); a drill is `visual:drillDown`'s, its grain
  lookup the chart's own question. Nothing new computes a figure.
- **Filter values.** A view has its facts' types as a profile but no sample, so `dataset:distinct` is the Live door's
  typed refusal (`live_refused`, `notSampled`), in the table's own sentence: *A warehouse table has no list of values
  until it is kept as a dataset. Filter it by a condition, or keep it to list them.* The Condition tab still filters.
  No warehouse statement is spent on a picker.
- **The picker** lists, after the datasets, the Source tables list's documented tables whose columns were read
  (`sourceTable:list`, `write`, so only an editor's page asks it; its connection head now says `live` when
  `isLiveOffered`). The URL is `?dataset=<doc>&table=<connection>`; a project with no dataset opens its first live
  table. The header says *Warehouse table, not a dataset*; Save as visual and Open in the builder are not offered.
- **Copy first.** A table on a connection not asked live is listed *Copy first*; opened, the page says *Copy RETURNS
  into Ordinate first* with a link to its connection and asks the server nothing. The server refuses every input on
  it with `needs: 'copy'` all the same.
- **Keep as a dataset** (`explore:keepTable`, `write`, `src/ipc/sourceKeep.ts`) is the Assistant's keep without a
  turn: `createLiveDataset` (columns from the warehouse catalog, first schema sync queued, named as the table). Explore
  then opens the new dataset with the same question.
- **Viewers** get no table in the picker (the list is never asked) and a `?table=` link opens a dataset. Every
  table-target input from a viewer is *This dataset no longer exists.*, answered before any read: `sourceView` asks
  the role first, so no doc, connection or warehouse is read and nothing is counted. Keep is 403. **Since team folders
  E8** a viewer's picker lists the tables their teams were given, by the label an editor wrote (`teamTables:mine`,
  `read`: `{connId, docId, name, live}`, never the warehouse name or the connection), and those tables' five inputs
  answer from their view less the hidden columns; Keep is still 403 and not offered
  ([as built](../team-folders/00-design.md#connection-tables-as-built-e8)).
- **Classified:** the five read contracts keep their row and column classes, noted with the table target
  (`scripts/rowPolicyReaders.ts`, `scripts/columnAccessReaders.ts`). `test-liveSafetyNet` §7 calls every read contract
  whose input takes `table` (found from the contracts) on a view: fields, charts and a drill answer, dated live;
  filter values refuse, typed.
- **Tested** in `scripts/test-exploreSourceTables.ts` (both modes): the list's `live` flag; fields equal to a Live
  dataset of the table; every chart figure, alone and in a batch, Object.is the Live dataset's and the extract's, one
  statement counted under the view's id, the cache on a second ask, nothing hydrated, no dataset made, NEGATIVE CONTROL a
  spent daily limit; filter values the unsampled Live dataset's refusal; the drill the Live dataset's; copy first on
  every input; keep makes one Live dataset whose fields and figures are the table's. With Postgres: the viewer's five
  inputs refused before any read (spies on the doc and connection reads, the fake warehouse, the budget), no reply
  holding the table's name, its connection's, a facts-only column or a figure; keep 403; NEGATIVE CONTROL the editor's.
  Vitest: `web/src/features/explore/sourceTable.test.tsx`. e2e: `web/e2e/source-tables.e2e.ts` step 6, desktop and phone
  (`explore-source-table`, `-answer`, `-copy`, `-kept`, `-phone`).

**Left:** a sampled share found for two Live datasets on one connection (the card ranks them by names and types); a
source answer's turn is reopened under its view, so a caller who is no longer an editor gets no figures (a hide);
filter values on a table (a sample would be a warehouse read per picker, so it waits for keep).

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

**As built (E9, [design](../team-folders/00-design.md#dashboard-requests-as-built-e9)).** Step 2 changed: nothing is
made at request time, not even a draft (team folders D20). The request is a `dashboard_requests` row (0037) holding the
answers' chart forms, never a figure; the dashboard and its visuals are made only when an editor approves.

- **Viewer**: **Request a dashboard** on an answer card (`web/src/features/assistant/RequestDashboard.tsx`, viewers
  only): the conversation's chart answers to tick (this one ticked), a name and a note. `request:create` (`read`,
  audited) takes the caller's own turns only, on datasets they open; the same charts again the same day are *already
  sent*, a person may send 10 a day and have 20 waiting in a project. Charts on a dataset only (Live or copied): a
  source table's answer (*an editor must keep this table first*) and an SQL answer are listed but never ticked, for
  now. The charts go on a new dashboard (with a folder they open to suggest) or on one already there that they open;
  their bell lists the waiting request, with **Withdraw**.
- **Told**: editors and admins with Edit on every dataset the charts read (`openers`, intersected), through the path
  Ask an editor uses: a bell row (**Dashboard requests**), a `requests:changed` push with no title or note, and an email
  for those with **Email me about data asks and dashboard requests** on (`users.request_email`).
- **Review** (`/requests/:projectId/:requestId`, `request:preview`): every chart computed now through the answer door
  as the reviewer, the note, and exactly what approving makes (a visual per chart, the dashboard — or a sheet on the
  one named — and its folder, which the reviewer may change among those they edit and the requester opens).
  **Approve and publish** makes them (Save as visual's path, then a dashboard placed where E6 lands it, then Publish);
  **Edit** makes the dashboard as a draft and opens the editor, and the viewer is told at its first Publish; **Decline**
  needs a note. Exactly one dashboard per request, however many approve at once.
- **Viewer told**: a bell row that opens the dashboard (or shows the note), a toast in their open tabs, and an email if
  they turned the switch on. An editor's own *Add to dashboard* on an answer: [as built](#add-to-dashboard-as-built).

### Add to dashboard, as built

An editor's **Add to dashboard** on a chart answer card (`web/src/features/assistant/AddToDashboard.tsx`), beside Save as
visual. A dialog picks a dashboard or **New dashboard…** with a name (the card's title when left blank). The picker is
the house one, `stats:dashboards`, which now lists only the dashboards the caller edits: one in a folder they only view
is left out (D18), for the Statistics and Metric tree pickers too. Then the card says *Added to Sales board* with
**Open**, the dashboard's editor.

- **`answer:addToDashboard`** (`write`, project-scoped; `src/ipc/answerDashboard.ts`): the stored spec and either
  `analysisId` or `name`, nothing else. The card is rebuilt on the server through the answer door (`computeCard`) and
  saved as a visual through Save as visual's path (`saveCardAsVisual`). A visual tile of it (half the grid, six rows)
  goes at the foot of the dashboard's last sheet, under the dashboard's hold. That writes the DRAFT (`updateAnalysis`):
  the published copy is untouched, the dashboard reads *edited*, and viewers see the tile at its next Publish. A new
  dashboard holds just the tile, unpublished.
- **Folders** (`folderWriteGate`, before the handler, so a refusal saves no visual): an existing dashboard needs Edit on
  its folder (`edit` for Can view, `closed` for none). A new one lands with the answer's dataset (E6's `landsIn`), and
  is refused below Edit there. The visual still needs Edit on its dataset (the visual store's own check). `CREATE` in
  `scripts/folderReaders.ts`. It is a `write`, so it is not in the row or column readers' lists, which hold `read`
  contracts. It joins `test-liveSafetyNet` (routed: a Live dataset's card is the warehouse's).
- **A source table's answer** goes on in one click: the table is kept first, in the same call, through Keep as a
  dataset's own make (`sourceKeep.keepView`: its checks, and a table already kept is that dataset), landing where Keep
  lands it, and its turn is re-pointed at it as Keep does. The dialog says so (*The warehouse table is kept as a Live
  dataset, and the answer is …*).
- **Not offered:** to a viewer (Request a dashboard is theirs; the server refuses one 403); on an SQL answer, which has
  no chart form (*Only a chart answer can be added to a dashboard.*).
- **Not twice:** a dashboard already holding the answer's tile — of the visual its turn keeps, or of a visual drawing
  what Save as visual would save for the card (dataset, chart type, encoding and filters, sanitized) — answers that
  tile with `already: true` and adds nothing; a kept table is found again rather than made twice. Named (`threadId` +
  `turnId`), the turn keeps the visual and the dashboard (`markSaved`, `dashboardId`), and a visual it already keeps
  (Save as visual's) is the one put on. Its card reply carries `onDashboard` (`liveBits`: the dashboard, while the caller
  opens it and it still holds that visual), so after a reload the card says *On Sales board · Open*, with no call.

Tested in `test-answerAddToDashboard`, both modes: one visual and one draft tile more, no other dashboard. Twice on the
same dashboard is `already`, nothing more (NEGATIVE CONTROL: another dashboard gets a second); a turn's card says where
after a reload (NEGATIVE CONTROL: another turn's says nothing); a table's answer makes one Live dataset and one tile, and
a second click neither. The tile's
figures through `analysis:tiles` are the card's (`Object.is`; NEGATIVE CONTROL: another answer's card differs). The
published copy is byte-identical. A new dashboard is named as asked, else by the card. A viewer, an SQL answer, a
source table that is not there and a missing dashboard are refused, writing nothing (NEGATIVE CONTROL: the editor's chart answer goes).
With Postgres: the picker per person, `edit` and `closed` on the Ops board (NEGATIVE CONTROLS: the Ops lead adds to it,
and the view-only editor adds to a board in Everyone), and a new dashboard landing in Ops. Also in the folder safety
net's section 8, and in the dock e2e (a new dashboard from the Explain card, both themes).

## Ask an editor and Alert me, as built (phase G)

**Ask an editor.** Where the Assistant tells a viewer the data isn't theirs yet, the reason and
**Ask an editor** (`web/src/features/assistant/AskAnEditor.tsx`): today on outcome D (the reply's
`import` action, which an editor sees as Import / Paste / Connect), *This data isn't in Ordinate yet.*
The reasons `link` (outcome E, *These can't be combined yet.*) and `copy` (a table on a connection
that is not live-capable, *This data has to be copied into Ordinate first.*) are in the contract and
the component; their cards land with phase D, which places the same component. The button opens a
composer prefilled with the question and the reason, and an optional note.

- **`editors:ask`** (`src/api/notifications.ts`, `src/server/mentions/asks.ts`): `read`, as
  `comment:add` (asking changes nothing in the project), audited, project-scoped. META in
  `rowPolicyReaders` and `columnAccessReaders`: the caller's own words, no row or figure.
- **Who is told:** the project's editors and admins at send time (`writerEmails`: an org admin, or
  an editor or admin grant of their own or a team's), never the asker, another viewer or another
  project's. One `editor_asks` row each (0033) carries the question, the reason and the note as sent
  (a viewer's conversation stays private); the bell lists only rows on projects the caller may still
  edit, under **Asked for data**, and a click opens Connections (missing, copy) or the Data model's
  Relationships (link). A push to their tabs (`asks:new`: who, where, why; no question or note), and
  an email only for those who turned on **Settings → You → Email me when a viewer asks for data**
  (`users.request_email`, off by default; E9's requests will use the same switch), through `deliver`
  under the mention email budget.
- **Not twice, not a flood** (shared counters, every pod): the same person, project, reason and
  question (case and spacing aside) within a day is *Already sent to the project's editors today*,
  and nothing is written; at most **10 sends per person a day**, across projects (*You can ask the
  editors 10 times a day. Try again tomorrow.*). A refused or failed send is given back.
- Without a database there is no directory: the send says so, and the bell has no asks.

**Alert me** (`web/src/features/assistant/AlertFromAnswer.tsx`, `src/ipc/answerAlert.ts`) on an
answer card, for those who may save an alert (`alerts:save` is `write`; a viewer is not offered it).
`alerts:fromAnswer` (`write`, project-scoped) turns the stored spec into the alert dialog's subject,
the same fields a KPI card's **Alert me…** hands it: the one measure, the answer's filters (a relative
period stays a period, so the alert moves with the clock; a term is expanded as it stands), the
figure the rule reads now through `testRule`, and a threshold to start from (falls below a tenth under
it, to two significant figures). The category is not a filter: the dialog says the number covers
every category together. The existing dialog, rules and delivery do the rest. Two measures, a
"Calculate as", a top-N, a period in an earlier year, row access rules on the dataset and an
unreadable spec are refused with the reason, beside the button. A SQL answer has no spec.

Tested in `test-askEditor` (told: editors and admins only, NEGATIVE CONTROLS another viewer and
another project's editors; the note never reaches another viewer; email only when on; dedupe; the
limit; seen; a demoted editor; RLS) and `test-answerAlert` (the prefill's figure `Object.is` the
by-hand dialog's `dashboard:metric`, the answer's own total and `alerts:test`; alerts:save stores the
same rule as one typed by hand; each refusal; a viewer refused).

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
- Every searched item gets a fingerprint in one small pgvector table (`assistant_search_vectors`, 0029), made by a job, never
  by a save, and remade only when its text changes: each row keeps the sha256 of the text it was made from, and the job
  sends only the items whose hash or model does not match. Without pgvector or a configured fingerprint model, search is
  words only, and nothing is sent anywhere.
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
- **Fingerprints are made by a job**, never inside a save: the save keeps step 3's index as before,
  the job (claimed through the jobs table, `SKIP LOCKED`) works out each item's text and its hash
  from the index's rows and sends only what has no row of that hash and model, each row records the
  model that made it, and a model change refingerprints in the background. Until then an item is
  found by its words.
- **Row values never go into Postgres.** "Acme" and "West" are matched in the engine, on the
  top-ranked datasets' text columns, under the person's row lock; on a Live dataset through the
  warehouse door or not at all (as built: not at all, "Values, as built" in step 3).
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
  you mean" a dataset offers among the 20 step 3 finds for the name said and the 20 spelled nearest
  it (pg_trgm, 7d), so a typo that shares no word with any name ("Ordrs") is offered too.
  `test-askIndex` holds a corpus of model answers Object.is-equal to the whole vocabulary, an admin
  and a restricted viewer.
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
| 6d | A formula metric's names off the index; `metricsByName` in one pass |
| 7a | pgvector where Ordinate runs, optional everywhere (`0029_pgvector`): CI, the nightly, the release boot, Compose and the chart's kind run use `pgvector/pgvector:pg17-trixie`; the extension and `assistant_search_vectors` are made only where present; `src/server/vectorStore.ts` |
| 7b | The fingerprint model (Admin → AI, off by default) and `rankFusion.fuse` |
| 7c | The fingerprint job, meaning and words merged on the ask path (step 3 and the verified examples), and the coverage in Admin → AI: done |
| 7d | Spelling for "Did you mean": `0031_name_trigrams` (pg_trgm where present) and its JS reference, `src/app/trigram.ts` |

**Measured after 6b:** building one Home question's facts takes 20 ms on the budget's project (2,000 datasets,
5,000 metrics, 2,000 terms), under the 50 ms line, so the index holds no summaries (6a's open question).

**Meaning search, as built (7a, 7b, 7c).**

- **pgvector (7a).** CI's check and web jobs, the e2e nightly, the release boot check, Compose and the chart's kind
  run use `pgvector/pgvector:pg17-trixie` (`postgres:17`, which is trixie, plus the extension). `0029_pgvector` creates
  the extension only where Postgres offers it and the role may, catching any error inside its DO block, and
  `assistant_search_vectors` (org, project, item, model, text hash, `vector(768)`, HNSW over cosine, forced RLS) only
  where it then exists. Every model's fingerprint is 768 numbers. An extension created later gets its table from the
  app through the same function, `ordinate_ensure_vector_store()`; `vectorStatus()` says which case a database is in
  (`no_database`, `no_extension`, `not_created`, `no_table`). `test-vectorStore` runs the 768-dimension round trip
  through the HNSW index, the later install, a role that may not create the extension, and, with
  `ORDINATE_EXPECT_PGVECTOR=1` as in CI, fails when pgvector is missing. A managed Postgres creates it by hand
  ([upgrade.md](../server/upgrade.md#pgvector-for-meaning-search-0029_pgvector)); without it, search stays on words.
- **The fingerprint model (7b):** picked in Admin → AI from the org's own OpenAI, Gemini or gateway key, off by default
  (see "Open questions"), with `src/ai/rankFusion.ts` for the merge.
- **The job (7c, `src/server/fingerprintJob.ts`, `fingerprintStore.ts`).** `search:fingerprints`, one row per org in the
  jobs table, every 2 minutes: a run is the runner's claim (`FOR UPDATE SKIP LOCKED` under a heartbeat lease), so two
  pods never run one org's job at once; no second lock is taken. With a model and the table, it finds each project's
  items whose (text hash, model) has no row in ONE query over the index's own rows (no record read), sends at most 500
  texts a run, 100 a request with purpose `document` (Gemini's `RETRIEVAL_DOCUMENT`), and saves each batch as it comes
  back; past 500 the runner queues it again at once, behind other orgs' due rows. An item's text is what a person reads,
  stored on its index rows when they are written (`text`, `0030_search_text`; never a value): its name, other names
  and description, after its dataset's name for a column or a metric ("Online orders · region — also called Sales
  region, territory — Where the order shipped"), so identically named columns of two datasets get two fingerprints;
  cut at 1,000 code points (`itemText`, the SQL's reference). A verified question's is the question as written. A
  writer of the release before (no `text`) drops its source's marker through 0030's trigger, as 0028's does for keys.
  Retired items get none. A project the model covers loses every other model's rows and those of
  items gone, so a model change refingerprints in the background and the search reads only the current model's rows.
  A failing provider (network, 429, 401, 5xx) stops the run; what was not saved is sent by the next one, logged once
  per org and code, never a text. A batch it REFUSES (400, 413, 422) is sent again one text at a time: the others are
  saved, and each text refused alone gets an attempt (`assistant_search_vector_failures`, 0030, by item, model and
  text hash); after 3 it is skipped for a day, logged once, and a changed text starts afresh. Three refused alone and
  none taken is the provider refusing everything: the run stops and nothing is held against a text. No model: nothing
  is read, nothing is sent.
- **The question (7c, `src/ipc/meaning.ts`).** With a model, the table and fingerprints of that model in the project, the
  question is fingerprinted ONCE per ask (purpose `query`, 2 s, joined to the request's signal) and kept for the ask. Any
  failure, from the provider or a query, is words only, logged once by its code. Step 2's exact match is untouched.
- **The merge (7c).** `nearestPage` takes the 50 items nearest the question by cosine within the project, no less
  similar than the model's floor (below), under the words query's own access `WHERE` (audience, kinds, datasets in or
  out, retired left out); `fuse([words' first 50,
  meaning's 50], k = 60)` is the head, the rest follow by words, and a column hidden from the caller, or a metric or term
  on one, is dropped after, a page at a time, as before. The verified examples merge the same way (`nearestIds`), then
  keep their tiers: the open dataset's questions, then the agent's topic's, then the rest. `test-meaningSearch` holds
  both to a JS reference (`fuse` over the words reference and a cosine in JS over the stored vectors), with exact
  distances by construction.
- **Meaning never invents a match.** Below a model's least similarity, an item is not near at all: a question sharing
  no word and no meaning with anything gets nothing. Per model (`src/ai/fingerprints.ts` `MIN_SIMILARITY`), not
  calibrated against a provider here (the tests use a fake): 0.35 for OpenAI `text-embedding-3-small` and `-large` and
  Gemini `gemini-embedding-001` and `gemini-embedding-2`, 0.5 for a gateway's model, whose scale is unknown;
  `MEANING_MIN_SIMILARITY` overrides them all ([configuration.md](../server/configuration.md#assistant)). And where a
  result means "offer this", an agent's outside-the-topic offer and "Did you mean", an item found by meaning alone
  (words score 0) never qualifies: meaning reorders what the words found there, it does not add.
- **Exact, not HNSW.** Filtered by org, project, model and access, the HNSW index's scan stopped before any row passed
  and returned none (the budget's project, pgvector 0.8.7, iterative scan on); with a fresh table and no statistics, the
  first form planned a 48 s nested loop. So the distances are computed exactly for the project's allowed items, inside a
  MATERIALIZED CTE the planner cannot turn into an index scan, the allowed items an array built once as the words
  query's: 23 ms for 8,000 candidates and 13 ms for 5,000 questions, with or without statistics. The HNSW index stays,
  unused (see "Open questions").
- **Measured** (`test-askBudget`, 2,000 datasets, 5,000 metrics, 2,000 terms, 5,000 verified questions; 19,998 texts):
  the first fill took 27 to 31 s with a fake model (no network), a run with nothing to send 52 to 69 ms, Admin → AI's
  coverage 44 to 55 ms. With meaning on, each case makes ONE embed call; queries and reads, off → on: Home 89 / 154 →
  103 / 154; a dataset 88 / 123 → 94 / 118; an agent 75 / 136 → 84 / 136; the restricted viewer 114 / 7,299 → 131 /
  7,299; a dashboard 112 / 183 → 119 / 182. A Home question took about 42 ms off and 128 ms on.
- **Admin → AI** shows the coverage under the model (`ai:fingerprintStatus`: "Fingerprinted 1,234 of 1,300 items", read
  again every 30 s until done), or why there is nowhere to keep fingerprints, with the upgrade note's link.
- **Spelling, as built (7d).** A dataset name a model's answer says that resolves to none is looked up by its spelling
  beside its words: pg_trgm's similarity (each word lower-cased and padded to "  word ", the SET of its three-character
  runs, |A ∩ B| / |A ∪ B| in float4), at least 0.3 (`%`'s default, `MIN_SIMILARITY`), the 20 nearest the caller may
  find (audience, an agent's topic, nothing retired), in one query on a GIN trigram index over the index's base names
  (`0031_name_trigrams`, `speltPage`). `src/app/trigram.ts` is the same in JS, down to the legacy CRC-32 that pg_trgm
  hashes a multibyte trigram with, and it answers where Postgres has no pg_trgm, has one that splits names otherwise (a
  C-ctype database, where "é" is no letter: `src/server/nameTrigrams.ts` probes at first use), or there is no database.
  A column's candidates are its dataset's columns, in hand already without the hidden ones, so they are compared in JS
  with no query. "Did you mean" keeps the same letters, containment and shared words first; then one edit apart or
  near by spelling, by similarity, then nearness, type fit and name; three at most. `test-nameSpelling` holds the JS
  similarity Object.is-equal to Postgres's on 1,653 pairs (accents, ß, digits, Greek, Cyrillic, CJK, a combining mark)
  and each name's trigrams to `show_trgm`'s byte for byte, the index's answers to the reference's over a corpus of
  typos for an admin and a restricted viewer, a hidden column never offered to the viewer, a C-ctype database refused
  by the probe, and the same answers with the extension dropped. Not covered: macOS's libc classifies a few rare
  characters (Roman numerals, circled letters, titlecase digraphs) unlike Unicode, which the reference follows; Linux's
  glibc follows Unicode, unmeasured here.

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
term the caller can find (5,000 and 2,000 records, a thousand a query, at the budget's size).

**A formula metric's figure (PR 6d).** It no longer reads every metric by name. A formula or a
period metric looks up only the names it says (`src/analysis/metricNames.ts`): the bracketed and
bare names of its text and of its text with the dashboard's parameters bound, a period's base by
its name, and theirs in turn, through 0028's name keys, read in one query a level and kept as
`metricsByName` keeps them (the first of each lower-cased name in `listMetrics`' order). The
resolver, a chart's formula measures, a date control's parts, status pins and scenarios ask as they
go; additivity, targets, drivers and a tree's split take a map of what the formula reaches. Without
the index, or when it fails, `metricsByName` itself. `metricsByName`, still what a check of every
metric reads (the Metrics table's additivity, MCP's `list_metrics`, the formula editor's
cycle check), reads its records in one pass: at 5,000 metrics, 153 queries and 175 ms instead of
15,153 and 722 ms (it read each record again by its id).
`test-formulaNames` holds every figure path Object.is-equal to the full map, for an admin and a
restricted viewer, over chains, periods, cycles, a chain past the depth, names differing in case, a
name inside another, a Live and a layer's metric, a filtered one, a name a parameter binds, renamed
and deleted ones; NEGATIVE CONTROL: a name key out of the index fails it. `test-askNoProjectLists`
now computes a formula metric in the dataset and dashboard cases: zero lists.

## Build order

| Phase | What | Needs |
|---|---|---|
| 0 | The Assistant page (#488); #492: one AI call per answer, "last quarter" from the calendar as dashboards do, every dashboard date preset; conversations in their own tables, all kept and paged (#493, #495, #498); agents (#496); the verified match inside what is open (#497) and by index (#499) | done |
| 0+ | [Scale rules](#scale-rules): no whole-project list on the ask path, and answers that keep their figures | the PR chain below |
| A | Word search over the whole Data model; follow links and table facts in the prompt (built: [Follow the links, Table facts](#step-3-what-is-searched)); `calc` in the chart form (built); Live date filters on sort and partition keys (measured first); Home sees metrics and terms; one-query loading | nothing new |
| B | SQL for questions the form can't express, on copied datasets: second AI call, Not checked, editor verifies (built: [The SQL lane](#two-ways-to-answer)) | the Query tab's gate |
| C | Meaning search (fingerprints), spelling mistakes, the "Matched Maria's…" line (built, step 4) | pgvector and a fingerprint model; otherwise stays on A |
| D | Editors answer straight from source tables with no dataset (Assistant and Explore); keeping makes the dataset; approve a missing link: built ([Assistant](#source-tables-keeping-and-the-missing-link-as-built-phase-d), [Explore](#explore-as-built-phase-d)) | nothing new |
| E | Shared folders shared with teams; connection tables per team; dashboard requests ([design](../team-folders/00-design.md)) | every list, search and reader checks the item's folder, with a safety-net test like row rules have |
| F | SQL on Live datasets and source tables ([design](../live-data/01-live-sql.md)) | row rules, hidden columns and cost limits applied in the warehouse |
| G | Ask-an-editor notifications, "Answered from ▾", "Also on", Alert me: built ([as built](#ask-an-editor-and-alert-me-as-built-phase-g)) | nothing new |

Each phase gets its own design note before code where it adds a channel or a reader: new `read`
contracts are classified in `scripts/rowPolicyReaders.ts`, a new row-reading channel joins
`scripts/test-liveSafetyNet.ts`, and every guard ships a negative control.

## Test questions

Every phase is checked against one fixed list: typos ("revnue by regon"), "sales" meaning revenue,
"last quarter" vs "last year", a viewer vs an editor on the same question, a question only a
source table can answer, a question needing an undefined link, and a question only SQL can answer.

## Open questions

- **Meaning search's index (PR 7c).** The project's fingerprints are scanned exactly: linear, 23 ms at 8,000
  candidates. Past about 50,000 items in one project, measure an index per project (or pgvector's filtered scans,
  once they return what the filter needs) against the exact scan, which stays the reference.
- **Meaning's floor per model (PR 7c).** 0.35 (OpenAI, Gemini) and 0.5 (a gateway's) are defaults, not
  measurements: no provider is called in this repo's tests. Calibrate each on a real project's questions (pairs that
  should and should not match) and move the table; `MEANING_MIN_SIMILARITY` is the operator's override meanwhile.
- **Fingerprint model (phase C): answered (PR 7b).** The org's own OpenAI, Gemini or gateway key,
  picked in Admin → AI and off until an admin does: OpenAI `text-embedding-3-small` / `-large`,
  Gemini `gemini-embedding-001` / `gemini-embedding-2`, or a gateway's id; 768 numbers each,
  normalized by the server; Anthropic has none. A Test action checks one sample. Details, the cost
  note and the rank merge: `docs/ai-models/00-plan.md`, "Meaning search".
- **Date-filter pruning (phase A).** Built, switched off, and measured each night; see above. No
  dialect is in `RAW_RANGE_DIALECTS` until its nightly numbers show the cast costing bytes. If the cast
  doesn't hurt pruning on a given warehouse, leave that dialect alone. Lookups and partitions that are
  not a declared date: answered (`docs/live-data/log.md`, 2026-11-16). The answers' case fix and the
  latest-day probe carry the required range; BigQuery's `_PARTITIONTIME` gets it as a TIMESTAMP base
  filter; a required integer-range partition refuses an unfiltered question, naming the column. The key check and
  the schema sync's sample: answered (`docs/live-data/log.md`, 2026-11-16, "Required ranges on the stored readers").
  Not covered yet: the Assistant's link card counts a Live key (`answerLink.keyCounts`) over every row.
- **Folders and `/p/` links (phase E).** A published dashboard keeps working for its audience;
  whether moving its folder should warn about published links too.
