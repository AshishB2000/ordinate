# Row-level security, phase 1 — design

A dataset can carry **row access rules**: a column and, for each user or team, the values of that
column they may see. A project **viewer** then sees only their rows — on every dashboard tile, KPI,
chart, Explore question, data grid and filter list — while editors and admins see everything. Every
other way of reading rows refuses that viewer, typed, with a sentence; every way of sending figures
to other people (published links, embeds, subscriptions, alerts) is off for that dataset until
per-recipient sending exists (phase 2).

Operator page: [`docs/server/row-level-security.md`](../server/row-level-security.md). Plan:
item 5 of the five-item round (branch `feat/row-policy`). Threat model: §4.12 and R19.

## What you will see

- **Dataset page → Row access** (a new tab after Snapshots, on extract and Live datasets alike;
  **project admins only** — editors and viewers do not see it).
  - Empty: "No row access rules. Everyone with access to this project sees every row." and
    **Add rules**.
  - Rules: a **column** picker (the dataset's text columns), then one row per rule — a **member**
    (a user or a team of the org, from the project's share targets), the **values** they may see
    (a searchable picker over the column's values, plus typed values for rows that do not exist
    yet), and a remove button. **Save** and **Remove all rules** (with a confirm).
  - A plain summary beside it: *Editors and admins see every row. Viewers see only the rows their
    rules give them; a viewer with no rule sees none.* and *While rules are on, published links,
    embeds, subscriptions and alerts that read this dataset are off.*
  - Warnings when the rules cannot hold: the column is gone or is no longer text ("Viewers see no
    rows until you pick another column"), or the prepare steps store a value computed across rows
    (a running total, rank, segment, LOD field) — "Viewers are refused: those values were computed
    over every row" — or a step that writes the column changed since the rules were saved ("Save the rules
    again to re-open the dataset to viewers"). Below: *Datasets built from this one are closed to
    viewers until they have rules of their own*, and their names.
  - Without Postgres there is no user directory: the tab says row access needs `DATABASE_URL`.
- **A viewer in team East**, on a dashboard over that dataset, sees East's figures in every chart and
  KPI, East's rows in the grid and behind a chart mark, and only East's values in every filter list
  — the same in **Explore** (item 2). The dataset page and Explore's field list carry a quiet chip,
  *Rows limited to your access*.
- **What that viewer is refused**, each with the server's sentence in the designed refusal state
  (never a retry, never an empty chart): SQL, statistics, drivers, segments, scenarios, insights,
  quality results, snapshots diffs, Prepare previews, the column statistics, AI suggestions and
  Assistant answers over that dataset, as-of reads, questions that reach a related dataset, and
  exports. On a dashboard a refused tile says why and the rest of the sheet draws.
- **An editor publishing that dashboard** gets "This reads a dataset with row access rules.
  Published links, embeds, subscriptions and alerts show the same figures to everyone, so they're
  off for it." — in the Publish dialog before anything is built, and the same from the
  subscription dialog, the alert dialog and an embed. A page published **before** the rules were
  set stops being served.

## The model, plainly

| Who | Sees |
|---|---|
| Org admin, project admin, project editor | Every row. They can edit Prepare steps and the rules themselves, so restricting them would protect nothing. |
| Project viewer (directly or through a team) | Only rows whose policy column holds one of their values — the union over every rule naming them or a team they are in. No matching rule: no rows (refused, typed). |
| Anyone a figure is **sent** to (published link, embed, subscription, alert) | Nothing from a policy dataset in phase 1: those paths compute once and fan out, so they refuse. |

A dataset without rules behaves exactly as today. Rules restrict **rows and the values in them**,
not the dataset's existence, its column names, its total row count or anything a person typed
(see *Ceilings*).

## Decisions

The plan's decisions are fixed; the rows marked *(here)* are calls this design makes where the plan
left room.

| # | Decision | Why |
|---|---|---|
| D1 | **Build on `embedLock.ts`.** `lockStep`, `storesCrossRow` and `makeLock` move to `src/data/rowLock.ts` (no import of the chart door); `embedLock.ts` re-exports them. A viewer's lock is `makeLock({ [policy.column]: values })` — the same `Lock`, the same steps (`=`/`in`, `context: true`, placed first), the same `covers()`. The "reads another dataset" half of `visualAllowed` moves beside them and decides a chart for a restricted viewer as it decides an embed tile. The embed path gets the tightened `storesCrossRow` too (D16): its own CHANGELOG line and explicit new cases in `test-embedLock`. | One mechanism, one differential suite guarding both. |
| D2 | **The policy lives on the dataset record**, `rowPolicy = { column, rules: [{ userId \| teamId, values }], stepsHash }`, sanitized in `src/data/rowPolicy.ts`. It is **never** part of the in-memory `Dataset` or `DatasetMeta` (refutation N3): it is read raw from the record where needed (`rowAccess.ts`, the admin channels), so no reply that spreads a record can carry it. No migration (like `Dataset.live`). | `datasets.ts` is 792 lines: three lines change (two gate calls, one import). |
| D2b | **A stored policy never fails open, and no data write can drop it** (refutation B1). The record write inside `persistNow` becomes a locked read-merge-write in `datasetRecord.ts` (`writeRecordKeepingPolicy`): under `recordFs.locked` it re-reads the STORED record and copies its `rowPolicy` onto what is written, never from memory — so a policy set while a long fold runs survives the fold's write, and a narrowed policy is never widened back. A `rowPolicy` key that does not sanitize becomes a CLOSED policy (no column: every restricted reader refused), never "no policy". A test walks every writer of a dataset record and proves the policy survives each. | A refresh, a step edit or a mode switch that silently dropped or reverted the rules would widen without anyone noticing. |
| D3 | **Only a project admin sets it**, through `dataset:setRowPolicy` (`access: 'admin'`, project-scoped, audited by the route), a metadata-only write through `datasetRecord.serialized` (no `updatedAt` bump); the server stamps `stepsHash` (D18). The tab reads it through `dataset:rowPolicy` (also `admin`): the rules say who sees what, which is not a viewer's business. | Narrowest channel. The answer caches do not need invalidating (D12). |
| D4 | **Restricted = effective project role viewer.** Org admins and project editors/admins are never restricted: editors cannot edit the rules, but they can rewrite Prepare (and so the policy column) and they read every row through it anyway, so restricting them would protect nothing. A caller with no grant at all (the `/p/` and embed pseudo-identities) counts as restricted with no entitlement — fail closed. The project role reuses `authz`'s own `grantRank`; a Postgres error THROWS (deny), never falls back to the org role (refutation S5). | The plan's model, stated accurately. |
| D5 | **`entitlement(policy, userId, teamIds)` is pure** and returns `'all'` (no policy), the union of matching rules' values, or `'none'`. | One place to test exhaustively. |
| D6 | **Fail closed before any query**, in this order, each a typed refusal (409 `row_policy`): an **as-of** read; the dataset is **derived** from a policy dataset and has no rules of its own (D14); the policy column **missing** (also a Live column the warehouse dropped), **not text**, or a Live dialect with no binary comparison; a pipeline that **stores a cross-row value** (`storesCrossRow`, an allow-list over steps AND origin — D16), **references a dashboard parameter**, or whose **policy-column writers changed** since the rules were saved (D18); entitlement **`none`** or a **blank** value list; a question that reaches a **related** dataset. Never an empty `in`, never a skipped filter: the two widening traps (`transforms.ts:357` unknown column, `:389` empty `in`, and their twins `residentFilter.ts:62/89`, `liveSpec.ts:231/262`) are never reached with the lock. | Each of these would draw the unscoped figure or a cross-row total. |
| D7 | **The lock is prepended at the doors** — `vizDataFor`, `computeCardMetric`, `computeCard` — after input sanitization, BEFORE the Live split and the answer-cache key, computed **per dataset inside the door**. The wrappers live in their own module, `src/ipc/rowDoors.ts`; `visuals.ts` and `dashboards.ts` only rename their body (refutation N4). The prepend is idempotent: the lock is prepended unless `filters` already STARTS WITH exactly `lock.steps` (deep-equal) — never skipped just because a scope is open (S4). A restricted caller's filter list is reduced to `filter` steps. Plus the locked readers: `pageFor` (dataset:page, visual:rows, rowsDownload), `distinctFor` (its own file: dataset:distinct, metric series, scorecard breakdowns, alert periods), `dataset:profile`. | Every tile, KPI, `visual:preview`/`data`, MCP `aggregate`, and item 2's Explore pass through these three functions. |
| D8 | **A storage net behind the doors** — the Live D6 pattern. `datasets.getDataset` and `datasets.residentSource` call `gateRows(projectId, id)` first (before the as-of hooks and the publish read memo): a restricted caller on a policy (or policy-derived) dataset is refused unless the current async scope is a **lock scope** for exactly that dataset, opened by the door that prepended its lock. The scope is the innermost door's one dataset — a door for E nested inside a door for D cannot read D unlocked. | A reader the inventory missed then REFUSES (a bug report), instead of leaking (a breach). 31 of the readers below are covered by this net alone. |
| D9 | **Every other row reader refuses a restricted caller, typed.** The ones that never touch `getDataset`/`residentSource` — stored artifacts, caches, the value index, values carried on the record — get an explicit check or redaction (the EXPLICIT, SKIP and REDACT rows of the inventory), and so do the channels that return step BODIES (`prepare:get`, refutation S2). | Those are exactly the paths a storage net cannot see. |
| D10 | **Fan-out refuses for everyone** in phase 1: publish (`/p/`), signed embeds, subscriptions (every channel — item 4's email included, inside its shared `deliver()`), alerts. Mechanism: a **fan-out scope** around each build — per RULE for alerts (refutation N1) — in which doors and the net refuse ANY policy or policy-derived dataset and record every dataset id they touch, plus ONE exported function, `assertFanOutAllowed(projectId, datasetIds)`, at each send point. A published site records the dataset ids its build read; `/p/` stops serving a site once one of them is policy-closed (own rules or derived), and a site published before this change (no recorded ids) is not served while its project has any policy-closed dataset, until it is re-published (N5). A cached embed page re-checks its recorded ids on every hit. | They compute once, as the publisher or the system, and reach people whose entitlement differs. A snapshot built before the rules must not outlive them. |
| D11 | **Exports refuse a restricted caller** (`dashboard:exportHtml`, `story:export`, `report:build`, `report:preview`) through an **export scope**; editors export as today. `visual:rowsDownload` is a locked reader, not an export. | Their builders mix door figures with whole-dataset parts (control values, Summary card, stats tiles); refusing is the honest phase-1 answer. |
| D12 | **Caches key on the lock**: it is part of `filters`, which `queryCache.cacheKey` stringifies with sorted keys under the org id (arrays keep order, so `[lock, …f]` never collides with `f`); the Live executor's key carries the IR, which carries it. A restricted caller never reaches the `insights` cache (keyed by dataset alone) for a policy dataset. No cache needs invalidating when rules change: a changed entitlement is a different key. | "A restricted viewer never reads an unrestricted cached answer, and vice versa." |
| D13 | **Live**: the lock compiles to bound parameters like every value, and compares **binary** per dialect (refutation S3): DuckDB `encode(x)` (a VARCHAR→BLOB cast would parse `\x41` escapes), BigQuery `CAST(x AS BYTES)`, Databricks `CAST(x AS BINARY)`, Snowflake `TO_BINARY(x, 'UTF-8')`, the Postgres/Redshift dialect `md5(x)` (byte-based in both; Postgres has no `COLLATE()` function and Redshift no `COLLATE "C"`), ClickHouse plain `=`/`IN` (String compares bytes). Every dialect must declare its form (`binary` is required by the `Dialect` interface, so a new dialect without one fails `tsc`); `test-rowPolicyLive` pins the exact clause per dialect, and `test-liveParityPostgres` runs the `md5` form on a real Postgres column with a case-insensitive collation. The two Live lookups that run without the question's filters — the latest date that anchors a relative period, and the stored spelling of a typed value (`liveCaseFix`) — compile with the lock as their WHERE. The stored profile sample (`live.profile`) is never shown to a restricted caller. | Parity with the extract path (JS string equality), on warehouses whose default collation may be case-insensitive. |
| D14 | **Derived datasets fail closed** (refutation B2; the earlier "trusted to editors" is withdrawn). The effective policy of a dataset is its own if it has one; otherwise, if its transitive upstream (origin parents — combined, composed, sql, notebook deps — and Prepare `union`/`lookup_join` references, `MAX_DEPTH` 16, a visited set, memoised per request) contains a policy dataset, it is **closed** to restricted callers and inside every fan-out scope (reason `derived`). One small exported closure helper, `upstreamIds` in `src/data/upstream.ts`, built on `originParents` + `stepRefIds` (the primitives `stepRefs.buildsOn` walks); item 4's `deliver()` will share it at integration. A copy of a policy dataset (`dataset:copyLive`, any extract copy) carries the same `rowPolicy`. The Row access tab lists the datasets built from this one. | A SQL dataset over a policy dataset must not be the way around it. |
| D15 | **One refusal code**, `row_policy` (HTTP 409 from the route, or `{ok:false, code:'row_policy', reason, error}` inside a reply, per item in a batch), a machine `reason`, and a fixed catalog sentence per reason (`t()`; the reply never names another team or value). The route maps `RowPolicyError` like `LiveDatasetError` and tags caught refusals like `tagLiveRefusals`. A catch that turns an error into `[]`/`null` rethrows `RowPolicyError`. | The Live safety net's shape, which the web already renders. |
| D16 | **The policy column must be declared `text`**; values match cells **exactly** (case and spaces), blank values are dropped, and a null or blank cell is in no one's rows. `storesCrossRow` becomes an **allow-list** over the steps AND the origin (refutation B3): row-local steps pass; `window`, `group_aggregate` and `pivot` pass only when partitioned/grouped by every locked column; `dedupe_key` only when its key includes every locked column; `segment`, `text_terms`, `lookup_join`, LOD fields and any step type added later store a cross-row value; so does an origin of kind `sql`, `notebook`, `composed` or `combined` (conservative on purpose: such a dataset with its own rules is refused to restricted viewers in phase 1 — a ceiling). | No number/date coercion edge cases in three engines; a new step type fails closed. Tightens embeds the same way (D1). |
| D17 | No SQL migration, no new dependency, no env var. | Plan. |
| D18 | **The policy column's writers are pinned** (refutation S1). When an admin saves the rules, the server stores `stepsHash` — a hash of the prepare steps that can WRITE the policy column (a calculated or conditional column, `replace_values`, `fill_empty`, `trim` naming it or all text columns, a mask, `parse_date`, `split_column`, `rename_column` onto or off it, `drop_column`, `unpivot`, `union`, and any step type not known to leave it alone). If the current pipeline's hash differs, `rowLockFor` refuses (`pipeline`) until an admin saves the rules again; the Row access tab says so. | An editor's step that rewrites the column (`East` → everyone's value) would otherwise widen silently. |

## How it is enforced

```
request ──► route: contract, authorize (rank seeds the caller memo) ──► handler
                                                                          │
   ┌──────────────────────────── figure doors ────────────────────────────┤
   │ vizDataFor / computeCardMetric / computeCard / pageFor / distinct / profile
   │   rowLockFor(projectId, datasetId)  → null (unrestricted, no policy)
   │                                      → Lock  (prepend; open lock scope for this dataset)
   │                                      → throw RowPolicyError(reason)   ← D6 checks
   │   cache key (lock in filters) → Live split → engines …                     │
   └──────────────────────────────────────────────────────────────────────────┘
   anything else ──► getDataset / residentSource ──► gateRows: restricted + policy + not in
                                                     this dataset's lock scope → RowPolicyError
   stored artifacts / caches / index / record values ──► explicit check or redaction (D9)
   publish · embed · subscription · alert ──► fan-out scope + assertFanOutAllowed (D10)
```

### Who is asking (`src/server/authz/caller.ts`, new)

`callerOn(projectId)` → `{ restricted: false }` or `{ restricted: true, userId, teamIds }`:

- desktop / self-check mode (`ctx()` is the desktop admin): never restricted;
- `ctx().user.role === 'admin'` (org admin, the jobs' system identity): never restricted, no query;
- otherwise the project rank from `authz`'s own `grantRank` (exported, not restated; the route and
  the MCP route seed it from the rank `authorize` just computed, so an editor's request costs no
  extra query). Rank ≥ editor: not restricted. Viewer or no grant: restricted, and ONE more query by
  org + email reads `users.id` and every `team_members.team_id`. No Postgres: rank 0 → restricted,
  no entitlement. A Postgres error THROWS — the request is denied, never answered on the org role.
- Memoised per request in a `WeakMap` keyed by the request context object, so it dies with the
  request (a job submitted by the request keeps the submitter's answer, as it keeps their context).
  The RPC route and the MCP route seed it with the rank `authorize` already computed. Team or role
  changes apply from the next request.

`ctx()` carries only the org role today, which is why the effective project role has to be resolved
here (the MCP route never goes through the RPC handlers either: its tools call the doors directly,
`src/automation/handlers.ts`, `creators.ts` — so the enforcement lives in the doors and the storage
net, never in a handler or the route).

### The doors (D7)

`src/data/rowAccess.ts` (new) exports `rowLockFor`, `withRowLock`, `gateRows`, `assertReadable`,
`fanOutScope`, `exportScope`, `assertFanOutAllowed`, `RowPolicyError`, `isRowPolicyError`.

- **`vizDataFor`** (`src/ipc/visuals.ts:437`): the exported function becomes a thin wrapper; the
  body moves to an inner function unchanged. For a restricted caller on a policy dataset the wrapper
  runs the D6 checks plus `visualAllowed` (metric measures and labels from a related dataset are
  refused) and a foreign-column check (a column the dataset lacks that resolves through a
  relationship → `related`; one that resolves nowhere is skipped as today — skipping a non-lock
  filter can only widen within the lock), forces `opts.sample = false` (the sampled preview samples
  the whole table and returns its row count, `vizSampleData.ts:45`), refuses `encoding.drivers`
  (the drivers tile anchors "latest" on the whole period column, `alertStore.recentPeriods`), and
  runs the body with `[...lock.steps, ...onlyFilterSteps(filters)]` inside `withRowLock(datasetId)`.
  The prepend is idempotent (S4): a re-entry for the same dataset (metric measures, facet panels)
  whose `filters` already START WITH exactly `lock.steps` is not prepended again; anything else is. Item 1's `figures` block is computed inside the wrapped body,
  after the extract/Live split, so it is computed from the locked rows with no extra code.
- **`computeCardMetric`** (`src/ipc/dashboards.ts:147`): the same wrapper (D6 checks, related
  columns, filter steps only, the lock first, the scope). Formula metrics resolve each operand
  through this door per dataset (`metrics.ts:175-197`), so each operand gets its own lock.
- **`computeCard`** (`src/ipc/answers.ts:137`): extract — right after `getDataset` (`:144`) the table
  is folded through `lock.steps` before anything else reads it, so `heldValues`, `matchValues`,
  `canonicaliseTextFilters`, `specFilterSteps` (the relative-period anchor and its `in` list),
  `nearestValueFixes` (the "Did you mean" options) and `splitCandidates` see entitled rows only.
  Live — the lock joins the spec's filters as an `in` answer filter, and the two lookups take it
  (D13).
- **`pageFor`** (`src/ipc/datasets.ts:198`): `req.filters = [...lock.steps, ...req.filters]` inside a
  lock scope; both `readPage` and `pageRowsJs` honour `filters`. A `rowFilter` (quality failing rows)
  under a lock refuses (its predicate is computed over the whole table and a referenced dataset).
- **The locked distinct reader**: `DistinctRequest` gains `filters` — `filterPredicates` in the
  resident query, the fold in its JS reference (`datasetPage.ts`, +4 lines; a split would have had to
  share the module's ordinal-fallback state) — and one helper in its own file, `distinctFor(projectId,
  datasetId, column, req)` (`src/ipc/distinctFor.ts`), applies the caller's lock: `dataset:distinct`,
  `metrics.distinctValues` (`metrics.ts:283`) and `scorecards.topDimension` (`scorecards.ts:339`).
  `alertStore.distinctValues` is not a viewer's (alerts run in a fan-out scope): the net covers it. On the policy column it
  returns the entitled values that exist; on any other text column, the values that exist under the
  lock — what `lockedOptions` gives an embed's filter bar.
- **`dataset:profile`** (`src/ipc/datasetViews.ts:98`): under a lock `figuresFor` skips the resident
  summaries (they take no filters) and folds the locked rows; the distribution goes through
  `vizDataFor`; `meta.rowCount` is replaced by the locked count.

### The storage net (D8)

`gateRows(projectId, id)` is the first line of `datasets.getDataset` (`datasets.ts:484`) and
`datasets.residentSource` (`:472`) — above the as-of hooks (`asOf.datasetHook`/`residentHook`, which
would otherwise serve snapshot rows first) and above `recordFs.memoRead` (a publish build's memo
would otherwise serve a hydrated table without asking). For an unrestricted caller it costs the
memoised role check; for a restricted one it reads the CURRENT record's policy (raw, via
`datasetRecord` — never through the as-of hooks, which swap in a snapshot's metadata) once per
request. Both storage doors are gated, so a reader whose `residentSource(…).catch(() => null)` falls
back to `getDataset` (`scorecards.ts:343`, `drivers.ts:204`, `qualityRun.ts:65`, …) still refuses.
Inside a fan-out scope the gate reads the policy of every dataset it is asked for, whoever the
caller is (once per dataset per build, memoised in the scope), and records the id.

Other direct table reads are covered where they are: `dataSearchRun.ts:99` builds `tablePath()`
itself (SKIP for a restricted caller), `snapshots:diff` opens snapshot files by path (EXPLICIT),
`incrementalRefresh.ts:156` is a writer (editors), and `liveRecord.ts:88-90` only deletes files.

### Fan-out and export scopes (D10, D11)

`fanOutScope(fn)` runs a build so that every door, the net and every explicit reader refuse ANY
policy dataset (for every caller, admin and system included) and record each dataset id they touch;
when the build ends, a recorded refusal fails the whole operation even if a tile-level catch
swallowed the throw — nothing is published, posted or served. Wrapped: `publishHosted` (publish,
re-publish after refresh — `hosted.ts:136`, `:248`), `planPublish` (`publish:plan`), the embed build
(`embedPage.ts:53`), `buildMessage` (subscriptions and `subscription:preview`, `run.ts:97`), alert
evaluation and `alerts:test` (`alertStore.ts:422`, `:486`). `assertFanOutAllowed(projectId, ids)` is
called at the send points: every post goes through `deliver(channel, source)` (`deliver.ts`
`refuseFanOut`, over the datasets `figureDatasets` reads from the source); a subscription run first asks
`dashboardSendRefusal` of the dashboard's DEFINITION in `runSubscription`, so a refused run computes no
figure and is recorded as `skipped` / `row_policy` (docs/notifications D5); `publishHosted` refuses
before the manifest switch, the embed route before it serves. `alerts:save` and `subscription:save` refuse up front
(the save runs the same check as the dialog's preview), so the author sees why when they save.

`exportScope(fn)` refuses a policy dataset to a RESTRICTED caller only; editors export as today.

### Pushes

`alerts:fired` (`schedules.ts:81`, `alerts.ts:43`) goes to every project reader, viewers included
(`readerEmails`). With alerts refused on policy datasets no new alert event concerns one, but quality
runs push through the same channel: an event whose dataset has a policy is pushed with its ids and
time only — no value, previous, delta, message or diagnosis — and the inbox re-reads `alerts:list`,
which redacts for a restricted caller. The same rule applies to the 5-minute `event_payloads` copy
(it is the push body). `hub:dataset-refreshed` carries row COUNTS only (a ceiling).

## The entitlement and the lock checks

```ts
type RowPolicy = { column: string; rules: Array<{ userId: string; values: string[] } | { teamId: string; values: string[] }> };
entitlement(policy: RowPolicy | null, userId: string | null, teamIds: readonly string[]): 'all' | string[] | 'none'
```

- No policy → `'all'`. A rule matches when its `userId` equals the caller's or its `teamId` is one of
  theirs; the result is the de-duplicated union of matching values, in rule order. No match, or a
  union that is empty after sanitizing → `'none'`.
- Sanitizer: column 1–256 chars; ≤ 500 rules; each rule exactly one of `userId`/`teamId` (UUID);
  values: strings, 1–1,000 chars, no `[[…]]` parameter reference (makeLock refuses one), blank
  strings dropped, ≤ 1,000 per rule. On SET a violation is a 400/typed refusal naming the field; on
  LOAD it yields a CLOSED policy (D2b).
- `rowLockFor(projectId, datasetId)`, for a restricted caller (or inside a fan-out scope), in order:
  fan-out scope → `fanout` (for a policy or policy-derived dataset); export scope → `export`; as-of →
  `asOf`; no own policy but a policy dataset upstream → `derived`; no policy → `null`; column
  missing / not text / dropped by the warehouse → `column`; `storesCrossRow(steps, [column])` or a
  step referencing a parameter → `pipeline`; entitlement `none` → `none`; else
  `makeLock({ [column]: values })`.

## Refusals

| `reason` | When | Sentence (catalog, `src/data/rowAccessMessages.ts`) |
|---|---|---|
| `none` | no rule names the viewer or their teams, or every value is blank | You don't have access to any rows of this dataset. A project admin can give you access. |
| `column` | the policy column is missing, not text, or gone from the warehouse | This dataset's row access rules name a column it no longer has, so it is closed to you until a project admin fixes them. |
| `derived` | the dataset has no rules but is built from one that has (D14) | This dataset is built from a dataset with row access rules, so it's closed to you until a project admin gives it rules of its own. |
| `pipeline` | prepare steps or the origin store a cross-row value, read a dashboard parameter, or a step writing the policy column changed since the rules were saved | This dataset stores values computed across all of its rows, so it can't be limited to the rows you can see. |
| `reader` | a non-door reader (the storage net, an explicit check) | This reads the whole dataset, and your access covers only some of its rows, so it's off for you. |
| `related` | a column or label reached through a relationship | This question reaches a related dataset, and row access rules don't extend across relationships yet. |
| `asOf` | an as-of read | Looking at past data is off for datasets with row access rules. |
| `fanout` | publish, embed, subscription, alert | This reads a dataset with row access rules. Published links, embeds, subscriptions and alerts show the same figures to everyone, so they're off for it. |
| `export` | an export by a restricted caller | Exports are off for datasets with row access rules while your access covers only some of its rows. |

The web recognises `row_policy` in the same helper that recognises Live refusals
(`web/src/features/live/refusal.ts`, generalised to `refusalOf` with `liveRefusalOf` kept as its
alias) and draws it in the same refusal state — without Live's "Make a copy".

## Cache keying (D12)

| Cache | Key | Verdict |
|---|---|---|
| Answer cache, `vizDataFor` (`visuals.ts:458`) and `computeCardMetric` (`dashboards.ts:168`) | `org · op · dataset · updatedAt · pipelineHash · stableStringify({…, filters, …})` (`queryCache.ts:112`) | Safe: the lock is prepended before the key is built, as plain JSON. A viewer, an editor and another team's viewer get three different keys; an editor who types the same filter gets the viewer's answer, which is the same rows. |
| Live executor (`liveQuery.ts:139`) and its flights | `orgKey(live · project · dataset · epoch · schemaSyncedAt · {ir, source, dialect})` | Safe: the IR carries the lock. The stale fallback uses the same key. |
| Live latest-date and case-fix lookups (`liveQuery.ts:162`, `:341`) | the lookup SQL + params | Safe once they compile with the lock (D13). |
| `insights` (`insights.ts:70`) | `org · dataset · updatedAt · pipelineHash · ambient` — no filter, no user | Never reached by a restricted caller on a policy dataset (refused before the lookup); fan-out builds refuse before it too. |
| `paramReplay` memo (`paramReplay.ts:33`) | org + dataset + `[updatedAt, params]` — whole replayed table | Only reached inside a door, whose filters (lock first) apply after it; and D6 refuses parameterized pipelines under a lock. |
| fx `rateCache` (`fxQuery.ts:108`) | org + rates dataset version | The rates dataset is checked with `assertReadable` when a conversion needs it (a rates table with rules is refused to a restricted caller). |
| `recordFs.memoRead` (`datasets.ts:489`) | one publish / embed build | The gate sits above it. |
| Embed page cache (`embedPage.ts:40`) | org · site · publishedAt · dashboard · claims · theme · hide | Each entry keeps the dataset ids its build read; a hit re-checks them (D10). |
| Value index `<id>.search.json` (`dataSearchResident.ts`) | Parquet path + stamp | Never read for a restricted caller on a policy dataset (SKIP). |
| `parquetCache` (S3 disk tier) | immutable object version | A storage tier: its readers go through `tablePath`, whose callers are gated or skipped. |

**Pre-existing finding (F21).** `stableStringify` (`queryCache.ts:89`) turns a `Map` into `{}`, and
`ParamValues` is a `Map` (`params.ts:59`): every parameter set of a parameterized pipeline shares
one answer-cache key, so a dashboard can be served another parameter value's figure until the
dataset changes. Unrelated to the lock (plain JSON), but in the same key: fixed in its own commit
(entries serialised in key order) with a test, and logged as F21 together with the second one —
`dataSearchRun.ts:97` turns a failed share-policy lookup into "no withheld columns" and searches
sensitive columns (fail open); it now refuses the search.

## The inventory

Every channel a viewer can call is a `read` contract: **182** of the 371 contracts (`write` and
`admin` channels need an editor or an admin, who are never restricted). Every one is listed here
exactly once; `scripts/test-rowPolicySafetyNet.ts` holds the same table as code and fails when a
`read` contract is missing from it.

| Treatment | Count | Meaning |
|---|---|---|
| DOOR | 14 | Figures through `vizDataFor` / `computeCardMetric` / `computeCard`: locked. |
| DOOR+ | 5 | Door figures, plus a part that goes through the locked distinct reader or is redacted. |
| LOCKED | 5 | Row and value readers locked directly (`pageFor`, distinct, profile). |
| NET | 31 | Reads rows outside a door through `getDataset`/`residentSource`: refused by the storage net. |
| EXPLICIT | 11 | Reads a stored artifact, a cache or the value index: refused by an explicit check. |
| SKIP | 1 | A search across datasets: policy datasets are skipped for a restricted caller. |
| REDACT | 6 | Metadata replies that carry row values: the values are stripped for a restricted caller. |
| FANOUT | 3 | Builds what is sent to others: refused for everyone. |
| EXPORT | 4 | Builds a file: refused for a restricted caller. |
| META | 102 | Names, definitions, counts, ids, the caller's own records: not a row reader (reason given). |

Handler paths are under `src/`.

| Channel | Handler | What it reads, and how it is covered |
|---|---|---|
| **DOOR** | | |
| `visual:data` | `ipc/visuals.ts:636` | `vizData` → `vizDataFor` (every sub-path: Live, pivot, cohort/funnel, LOD, facets, maps, joins, fx, param replay, JS); overlays re-ask the door; overlay metrics → `computeCardMetric` on their own dataset |
| `visual:dataBatch` | `ipc/visuals.ts:640` | ≤ 50 `vizData` items, each through `vizDataFor` |
| `visual:preview` | `ipc/vizSample.ts:26` | `vizDataFor(…, {sample:true})`; under a lock the sample is off (`sampledVizData` samples the whole table and returns its row count) |
| `visual:thumbs` | `ipc/visualsServer.ts:53` | `handlers.get('visual:data')` per stored visual (skips the route, keeps the request context) → `vizDataFor` |
| `dashboard:metric` | `ipc/dashboards.ts:256` | `computeCardMetric` with sanitized, param-bound filters |
| `metric:preview` | `ipc/metrics.ts:534` | `previewDefinition` → `resolveDefinition` → `computeCardMetric` per dataset |
| `metric:values` | `ipc/analysesServer.ts:179` | `metric:value` → `resolveMetric` → `computeCardMetric` |
| `metric:check` | `ipc/metricCheck.ts:91` | `checkMetric` → `previewDefinition` → `computeCardMetric` (formula operands may name related columns → `related` refusal) |
| `answer:card` | `ipc/answers.ts:396` | `computeCard`: under a lock the hydrated rows are folded through the lock FIRST, so `heldValues`, `matchValues`, `nearestValueFixes`, `specFilterSteps` and `splitCandidates` see only entitled rows |
| `answer:explain` | `ipc/answers.ts:413` | `computeCard` on a stored visual or a client tile; the narration it stores is of the locked card |
| `answer:rerun` | `ipc/answers.ts:450` | `computeCard(…, loose)`; fuzzy matching runs over the locked rows only |
| `story:figures` | `ipc/reportsServer.ts:228` | `visual:data` / `metric:value` handlers → `vizDataFor` / `computeCardMetric` |
| `versions:figures` | `ipc/versionDiff.ts:323` | `cardFigure` → `resolveMetric` / `computeCardMetric` with each version's stored filters, on current data |
| `analysis:tiles` | `ipc/analysesServer.ts:86` | batch via `handlers.get`: visual / metric / compare items through the doors; `stats:tile`, `metricTree:compute` and `scenario:card` items reach rows outside a door → refused per item by the storage net, typed |
| **DOOR+** | | |
| `scorecard:compute` | `ipc/scorecards.ts:453` | figures `resolveMetric` → door; the anchor date via `vizDataFor`; `row.alert.message` (stored alert sentence, scorecards.ts:222) is dropped for a policy dataset (REDACT) |
| `scorecard:detail` | `ipc/scorecards.ts:461` | series via the doors; `topDimension` (scorecards.ts:339) and the breakdown's `distinctValues` (metrics.ts:283) read distinct values → the locked distinct reader |
| `metric:table` | `ipc/analysesServer.ts:157` | values via `metric:value` (door); sparkline periods via `resolveMetricSeries` → `distinctValues` (metrics.ts:283) → the locked distinct reader |
| `metricTree:compute` | `ipc/metricTree.ts:404` | nodes via `compareMetric` (door), splits via `vizDataFor`; period anchor and sparklines via `resolveMetricSeries` → the locked distinct reader |
| `home:overview` | `ipc/recent.ts:69` | sparks via `vizDataFor`; `insights.standsOut` walk SKIPS policy datasets for a restricted caller (as it skips Live), before the insights cache |
| **LOCKED** | | |
| `dataset:page` | `ipc/datasets.ts:435` | `pageFor` (datasets.ts:198): `residentSource` + `readPage` / `getDataset` + `pageRowsJs`; the lock is prepended to `req.filters` INSIDE `pageFor`, which both paths honour |
| `dataset:distinct` | `ipc/datasets.ts:457` | the locked distinct reader (resident query with the lock's WHERE, or the JS fold over the locked rows); the Live branch answers from the stored profile sample → refused for a restricted caller |
| `dataset:profile` | `ipc/datasetViews.ts:98` | `figuresFor` takes its JS path over the locked fold (the resident summaries take no filters); the distribution via `vizDataFor`; `rowCount` is the locked count; Live profile branch → refused |
| `visual:rows` | `ipc/visuals.ts:655` | `drillFilters` → `pageFor` (lock inside `pageFor`) |
| `visual:rowsDownload` | `ipc/visualsServer.ts:69` | `drillFilters` → `pageFor` per chunk → CSV (lock inside `pageFor`) |
| **NET** | | |
| `dataset:stats` | `ipc/datasets.ts:394` | `residentStats` (`residentSource`) / `getDataset`: whole-table min/max/mostCommon |
| `dataset:suggestCalcField` | `ipc/datasets.ts:725` | `promptSummary`: resident stats + 5 sample rows to a model |
| `dataset:suggestSteps` | `ipc/datasets.ts:705` | same `promptSummary` |
| `dataset:composePreview` | `ipc/datasetCompose.ts:341` | `resolveRef` → `getDataset` of the base and every join |
| `geo:spatialPreview` | `ipc/geoAnalysis.ts:88` | `inputAt` → `getDataset` (pre-pipeline source) + `loadStepRefs` |
| `input:load` | `ipc/input.ts:35` | `loadInputTable` → `getDataset` (source + refused-cell overlay) |
| `prepare:similarValues` | `ipc/preparePower.ts:144` | `inputAt` → `getDataset` (source): distinct values + counts |
| `prepare:stepPreview` | `ipc/preparePower.ts:137` | `inputAt` → `getDataset` (source); `parse_date` samples; count oracle |
| `quality:preview` | `ipc/quality.ts:81` | `evaluateRules` → `residentSource` / `getDataset` (self + referenced): failing count for a caller's rule |
| `relationship:suggest` | `ipc/relationships.ts:268` | `residentSource` / `getDataset` of both datasets: match rates |
| `sql:run` | `ipc/sqlQuery.ts:62` | `compile` → `residentSource` per dataset the statement names (sqlDatasets.ts:263) — one choke point for run, explain, MCP `query_sql`, SQL datasets and notebooks |
| `sql:explain` | `ipc/sqlQuery.ts:65` | same `compile` (DESCRIBE only, but it resolves every named dataset) |
| `text:preview` | `ipc/text.ts:234` | `stepInput` → `getDataset` (source): 12 output rows |
| `text:profile` | `ipc/text.ts:227` | `residentSource` + `textSampleResident` / `getDataset`: terms from cells |
| `template:list` | `ipc/templates.ts:43` | `loadPlanContext` → `residentSource` (whole-table stats) |
| `template:plan` | `ipc/templates.ts:94` | `loadPlanContext` → `residentSource` |
| `rebuild:match` | `ipc/rebuild.ts:139` | `loadPlanContext` → `residentSource` (whole-table stats), then doors |
| `analysis:draft` | `ipc/analyses.ts:140` | `loadPlanContext` (`residentSource`, stats + geo sample → a model); `withInsightCharts` → insights (explicit refusal) |
| `analysis:previewPlan` | `ipc/analyses.ts:160` | calculated fields → `residentSource` + `sampleRowsResident(src, 8)` (planPreview.ts:151); visuals via `vizDataFor` |
| `story:draft` | `ipc/stories.ts:98` | `draftAnalysisPlan` → `loadPlanContext` (`residentSource`) |
| `drivers:explain` | `ipc/drivers.ts:537` | `driversFor` → `residentSource` / `getDataset` (drivers.ts:206/216); `recentPeriods` whole column |
| `drivers:explainAlert` | `ipc/drivers.ts:548` | stored rule → `runDrivers` (same reads) |
| `drivers:explainPoint` | `ipc/driversPoint.ts:89` | `vizDataFor` then `runDrivers` (same reads) |
| `scenario:compare` | `ipc/scenarios.ts:75` | `loadInputs` → `paramTable` / `scenarioInputsResident` / `getDataset` (scenarioResolve.ts:162-175) |
| `scenario:compute` | `ipc/scenarios.ts:63` | same, with viewer-supplied driver filters |
| `segments:features` | `ipc/segments.ts:85` | `residentSource` / `getDataset`: whole-table summaries |
| `segments:fit` | `ipc/segments.ts:112` | `residentSource` / `getDataset`: per-row projections |
| `segments:rfm` | `ipc/segments.ts:153` | `residentSource` / `getDataset` |
| `stats:pair` | `ipc/stats.ts:258` | `compute` → `residentSource` / `getDataset`: ≤ 2,000 raw (x,y) pairs |
| `stats:run` | `ipc/stats.ts:245` | `compute` → `residentSource` / `getDataset`: levels, min/max, histograms |
| `visual:suggest` | `ipc/visuals.ts:700` | `residentSource` + whole-table summaries → a model |
| **EXPLICIT** | | |
| `insights:list` | `ipc/insights.ts:190` | `insightsForDataset` → the `insights` cache (insights.ts:70, key has no filter and no user) → scan; refused at the top of `insightsForDataset`, BEFORE the cache; the project walk skips policy datasets |
| `captureDataset:get` | `ipc/captureDataset.ts:113` | stored capture thread: the full extracted table, chart data, headline (captureUpload.ts:106) |
| `captureDataset:image` | `ipc/captureDataset.ts:122` | the stored screenshot of the table |
| `snapshots:diff` | `ipc/snapshots.ts:154` | snapshot Parquet by path (`snap.parquetPath`, snapshots.ts:46/51), never `residentSource` |
| `quality:failingRows` | `ipc/quality.ts:91` | `failingRowFilter` computes its row filter over the whole table and a referenced dataset (qualityRun.ts:273) → refused, not locked |
| `formula:check` | `ipc/formula.ts:191` | 8 sample rows via `pageFor` + `lodPreview` (whole-table LOD values): an authoring check — refused whole, typed |
| `summary:compute` | `ipc/summary.ts:255` | insights cache, stored quality results and alert events, `driversFor`: refused when any dataset it reads has a policy (the embed lock refuses the Summary card the same way); an alert event found through the request's `analysisId` names a dataset no tile was gated on, so it is skipped when that dataset is closed to the caller (NV-17) |
| `summary:rewrite` | `ipc/summary.ts:275` | same facts, then a model |
| `copilot:ask` | `ipc/copilot.ts:459` | `buildFacts`: a dataset or capture context over a policy dataset refuses (whole-dataset summaries, sample rows, insights, a Live sample); visual, analysis and scorecard contexts are door figures (locked); stats, drivers and scenario contexts refuse through the net; the plain-ask inventory drops a policy dataset's Live sample notes; the ledger carries only facts that were allowed |
| `versions:get` | `ipc/versions.ts:66` | stored version file: an input table's version carries the full table (inputTable/store.ts:102) → refused for `type:'dataset'` on a policy dataset |
| `prepare:get` | `ipc/preparePower.ts:135` | returns the step BODIES (a filter or replace step can name other teams' values) and per-step counts → refused for a restricted caller on a policy or policy-derived dataset (refutation S2) |
| **SKIP** | | |
| `dataSearch:query` | `ipc/dataSearch.ts:20` | `runSearch`: `tablePath` + the stored `<id>.search.json` value index (dataSearchRun.ts:99-101) — policy datasets are skipped for a restricted caller; the withheld-columns catch fails closed |
| **REDACT** | | |
| `alerts:list` | `ipc/alerts.ts:116` | stored `alerts.json`: events' value/previous/delta/message/diagnosis and rules' lastValue/history/firedPeriod → stripped for a policy dataset (ids, rule name and time stay) |
| `quality:list` | `ipc/quality.ts:39` | record `quality.latest.results[].sample` (up to 5 whole failing rows) and counts, and each rule's `args` (an allowed set, a whole-table min/max: values) → results stripped and every rule's `args` emptied for a policy dataset (NV-21) |
| `incremental:get` | `ipc/incremental.ts:15` | record `incremental.highWater` and `log[].highWater` (a row value) → stripped |
| `dataset:liveSchema` | `ipc/liveProfile.ts:236` | record `live.profile` sample values and counts → stripped (column names and types stay) |
| `captureDataset:list` | `ipc/captureDataset.ts:106` | stored `thumb` (an image of the table) → stripped for a capture linked to a policy dataset |
| `format:colors:get` | `ipc/format.ts:59` | project colour map: every category value an editor's chart dealt (colorMap.ts:35) → empty for a restricted caller in a project with any policy dataset |
| **FANOUT** | | |
| `publish:plan` | `ipc/publishServer.ts:66` | `planPublish` → `buildDashboard(defaultOnly)` + control `distinct()`: inside the fan-out scope → refused for EVERYONE when it reaches a policy dataset (the Publish dialog says why) |
| `subscription:preview` | `server/subscriptions/rpc.ts:135` | `buildMessage` → `resolveFigures` → doors: inside the fan-out scope → refused for everyone (the subscription dialog says why) |
| `alerts:test` | `ipc/alerts.ts:165` | `testRule` → `computeCardMetric`, `recentPeriods`, `anomaliesFor`: an alert on a policy dataset is refused for everyone in phase 1 |
| **EXPORT** | | |
| `dashboard:exportHtml` | `ipc/publishServer.ts:118` | `dashboardPageHtml` → `buildDashboard` (control `distinct()`, Summary card, stats tiles): inside the export scope → refused for a restricted caller |
| `story:export` | `ipc/reportsServer.ts:245` | `storyReportPages` → doors + `privacy:summary`: export scope |
| `report:build` | `ipc/reportsServer.ts:219` | `buildReportPages`: doors + summary / narrative (model) / discussion pages: export scope |
| `report:preview` | `ipc/reportsServer.ts:218` | same builder, with a client draft that can switch pages on: export scope |
| **META** | | |
| `ai:setMine` | `ipc/aiModels.ts:48` | the caller's own model pick |
| `ai:status` | `ipc/aiModels.ts:42` | approved models, has-key flags |
| `analysis:gallery` | `ipc/analysesServer.ts:54` | dashboard records (authored definitions, saved views); a preview visual's custom order and series colours dropped for a restricted caller (`rowDoors.visualForCaller`, round 2 #12) |
| `analysis:open` | `ipc/analysesServer.ts:75` | dashboard + visual records (authored); each visual through `visualForCaller` (#12) |
| `asset:read` | `ipc/analysesServer.ts:152` | an uploaded image |
| `boundary:get` | `ipc/projectBoundaries.ts:25` | uploaded reference GeoJSON |
| `boundary:list` | `ipc/projectBoundaries.ts:24` | boundary names and feature counts |
| `branding:logo` | `ipc/prefs.ts:49` | the org logo |
| `calendar:today` | `ipc/periods.ts:133` | the clock and the workspace calendar |
| `captureDataset:status` | `ipc/captureDataset.ts:105` | AI readiness |
| `catalog:columns` | `ipc/catalog.ts:29` | authored column notes (an `example` an editor typed is authored text — ceiling) |
| `catalog:get` | `ipc/catalog.ts:15` | authored catalog doc |
| `catalog:list` | `ipc/catalog.ts:58` | names, tags, `rowCount` (whole-table count — ceiling) |
| `catalog:tags` | `ipc/catalog.ts:55` | tags |
| `channel:list` | `server/subscriptions/rpc.ts:96` | channel names and kinds |
| `comment:add` | `ipc/comments.ts:93` | authored comments; a `target.point` label is what the commenter clicked (ceiling) |
| `comment:delete` | `ipc/comments.ts:103` | as comment:add |
| `comment:deleteReply` | `ipc/comments.ts:105` | as comment:add |
| `comment:edit` | `ipc/comments.ts:97` | as comment:add |
| `comment:list` | `ipc/comments.ts:92` | as comment:add |
| `comment:reopen` | `ipc/comments.ts:101` | as comment:add |
| `comment:reply` | `ipc/comments.ts:95` | as comment:add |
| `comment:resolve` | `ipc/comments.ts:99` | as comment:add |
| `connections:list` | `ipc/connections.ts:251` | connection metadata, secretSet flags; `lastError` (a refresh failure's text, which can quote a value — N2) → withheld from a restricted caller on a connection that feeds a dataset closed to them (NV-22) |
| `connectors:catalog` | `ipc/connections.ts:238` | static form shapes |
| `connectors:logos` | `ipc/connections.ts:471` | static glyphs |
| `copilot:deleteThread` | `ipc/copilot.ts:434` | own thread |
| `copilot:history` | `ipc/copilot.ts:382` | the caller's OWN stored turns, written under the access they had then (ceiling) |
| `copilot:newThread` | `ipc/copilot.ts:413` | own thread |
| `copilot:renameThread` | `ipc/copilot.ts:426` | own thread |
| `copilot:threads` | `ipc/copilot.ts:402` | own thread titles |
| `dashboard:asOfStamps` | `ipc/dashboardsServer.ts:19` | snapshot times and names |
| `dataset:columns` | `ipc/datasets.ts:371` | header: names, types, `rowCount` (ceiling); gains `scoped: true` for a restricted caller on a policy dataset |
| `dataset:list` | `ipc/datasets.ts:352` | summaries: `rowCount`, `qualityFailing` count (ceiling); gains `scoped`; a restricted row drops `lastRefreshError` and `autoRefresh.lastAnomalyKeys` (N2, #16) |
| `dataset:source` | `ipc/datasetViews.ts:88` | `{kind, label, refreshable}` |
| `embed:columns` | `ipc/embed.ts:52` | lockable column names and types, no values |
| `embed:status` | `ipc/embed.ts:47` | settings flags |
| `events:list` | `ipc/events.ts:58` | authored event annotations |
| `formula:functions` | `ipc/formula.ts:202` | static docs |
| `fx:get` | `ipc/fx.ts:30` | currency settings |
| `geo:boundarySources` | `ipc/geoAnalysis.ts:79` | boundary names |
| `geo:resolvePlace` | `ipc/geoAnalysis.ts:72` | bundled places table |
| `input:lookups` | `ipc/input.ts:53` | dataset and column names |
| `jobs:cancel` | `ipc/jobs.ts:16` | the caller's own jobs |
| `jobs:clear` | `ipc/jobs.ts:19` | the caller's own jobs |
| `jobs:list` | `ipc/jobs.ts:15` | the caller's own jobs (notes are counts) |
| `key:status` | `ipc/providersServer.ts:53` | has-key flags |
| `lineage:get` | `ipc/lineage.ts:85` | record graph |
| `metric:get` | `ipc/metrics.ts:465` | metric definition (authored) |
| `metric:list` | `ipc/metrics.ts:445` | metric definitions |
| `metricTree:suggest` | `ipc/metricTree.ts:416` | column names; its distinct-count read is `residentSource(…).catch(() => null)` → the net's refusal falls back to "every text column" (no value leaves) |
| `onboarding:status` | `ipc/onboarding.ts:8` | step booleans |
| `period:picker` | `ipc/visualsServer.ts:89` | calendar presets |
| `pipelines:get` | `ipc/pipelines.ts:44` | pipeline graph, `rowCount` (ceiling); runs' `errors`/`warnings`/`note` blanked on a restricted caller's dataset and quality nodes (#14) |
| `pipelines:preview` | `ipc/pipelines.ts:91` | cron times |
| `plan:check` | `ipc/plan.ts:89` | plan step checks over metadata |
| `prefs:get` | `ipc/prefs.ts:23` | formats, branding |
| `privacy:overview` | `ipc/privacy.ts:20` | sensitivity levels and column names |
| `privacy:review` | `ipc/privacy.ts:44` | same, one dataset |
| `privacy:summary` | `ipc/privacy.ts:68` | sensitive column names |
| `project:access` | `server/authz/share.ts:76` | grantees |
| `projects:list` | `ipc/projects.ts:37` | project records, never the colour map or dismissed insight ids (#11; the web reads `format:colors:get`) |
| `projects:open` | `ipc/projects.ts:91` | project record, as `projects:list` (#11) |
| `projects:overview` | `ipc/projects.ts:105` | record counts |
| `projects:roles` | `server/authz/share.ts:57` | the caller's roles |
| `publish:sites` | `ipc/publishServer.ts:77` | site manifests (the /p/ pages themselves: serve-time check, §Fan-out) |
| `publish:targets` | `ipc/publishServer.ts:50` | dashboard/story/scorecard names |
| `rebuild:read` | `ipc/rebuild.ts:117` | the caller's own upload, read by a model for layout |
| `recent:list` | `ipc/recent.ts:21` | record summaries (`rowCount` — ceiling) |
| `relationship:list` | `ipc/relationships.ts:251` | authored model + stored `verified` match counts (ceiling) |
| `relationship:related` | `ipc/relationships.ts:276` | column groups |
| `reports:get` | `ipc/reports.ts:39` | report definition |
| `reports:list` | `ipc/reports.ts:36` | report definitions |
| `reports:open` | `ipc/reportsServer.ts:198` | names and ids |
| `scenario:get` | `ipc/scenarios.ts:44` | scenario definition |
| `scenario:list` | `ipc/scenarios.ts:43` | scenario list |
| `scenario:metrics` | `ipc/scenarios.ts:109` | metric list |
| `scenario:targets` | `ipc/scenarios.ts:116` | metric records, formula compile |
| `scorecard:get` | `ipc/scorecards.ts:438` | scorecard definition |
| `scorecard:list` | `ipc/scorecards.ts:437` | scorecard list |
| `search:query` | `ipc/search.ts:169` | record names, `rowCount` (ceiling) |
| `snapshots:list` | `ipc/snapshots.ts:120` | stamps, row counts (ceiling) |
| `snapshots:stamps` | `ipc/snapshots.ts:177` | snapshot times |
| `sql:datasetQuery` | `ipc/sqlQuery.ts:52` | the SQL dataset's authored statement |
| `sql:schema` | `ipc/sqlQuery.ts:54` | names, columns, `rowCount` (ceiling) |
| `starred:get` | `ipc/recent.ts:29` | the caller's pins |
| `starred:set` | `ipc/recent.ts:32` | the caller's pins |
| `stats:dashboards` | `ipc/stats.ts:283` | dashboard names |
| `story:get` | `ipc/stories.ts:74` | authored blocks |
| `story:list` | `ipc/stories.ts:72` | story names |
| `subscription:get` | `server/subscriptions/rpc.ts:125` | definition, last outcome sentence |
| `subscription:history` | `server/subscriptions/rpc.ts:130` | run outcomes (no figures stored) |
| `subscription:list` | `server/subscriptions/rpc.ts:116` | definitions |
| `themes:list` | `ipc/themes.ts:13` | themes |
| `tokens:create` | `server/auth/tokens.ts:84` | the caller's own token |
| `tokens:list` | `server/auth/tokens.ts:75` | own tokens |
| `tokens:revoke` | `server/auth/tokens.ts:99` | own token |
| `trash:list` | `ipc/trash.ts:17` | trashed record names |
| `versions:diff` | `ipc/versionDiff.ts:322` | structural sentences; `type: 'dataset'` gated like `versions:get` (#13), and so `versions:figures` |
| `versions:list` | `ipc/versions.ts:63` | version metas |
| `visual:get` | `ipc/visuals.ts:552` | visual definition (authored), through `visualForCaller` (#12); `versions:get` of a visual too |
| `visual:list` | `ipc/visuals.ts:550` | visual names |

### MCP tools (`POST /api/mcp`, as the token's user)

Read-only tools pass `authorize` with `read` (`serverMcp.ts:76`), so a viewer may call them; they
call modules directly, never the RPC handlers — which is why nothing here is enforced in a handler.

| Tool | Handler | Covered by |
|---|---|---|
| `aggregate` | `automation/creators.ts:93` → `vizDataFor` | DOOR |
| `metric_value` | `automation/handlers.ts:198` → `resolveMetric` → `computeCardMetric` | DOOR |
| `query_sql` | `handlers.ts:161` → `runSql` → `compile` → `residentSource` | NET |
| `insights` | `handlers.ts:209` → `insightsForDataset` | EXPLICIT (before the cache) |
| `list_projects`, `list_datasets`, `describe_dataset`, `list_metrics`, `list_dashboards` | `handlers.ts:53/66/89/187/223` | META (`rowCount` is a ceiling; `describe_dataset` drops profile, quality and incremental values) |
| `create_visual`, `create_dashboard` and the other write tools | `creators.ts`, `handlers.ts` | need `write`: never a restricted caller |

### Background jobs (they run as the system identity, an org admin: unrestricted)

| Job | Where | Output, and how phase 1 treats it |
|---|---|---|
| Alert evaluation (tick, after a refresh, pipelines, MCP) | `alertStore.ts:422` via `schedules.ts:109`, `ipc/alerts.ts:65`, `pipelineRunner.ts:101` | Inside a fan-out scope: a rule on a policy dataset is not evaluated; it carries a typed pause reason ("Off: Orders has row access rules"). Stored events from before the rules are redacted on read (`alerts:list`, scorecards, Summary). |
| Quality checks | `qualityRun.ts:135` | Writes `quality.latest.results[].sample` (whole failing rows) to the record — storage, not a reply; `quality:list` redacts it, the Summary refuses, the push is stripped. |
| Live schema sync | `schemaSyncJob.ts`, `schemaSync.ts:292` | Writes `live.profile` sample values to the record; every reader of it refuses or redacts for a restricted caller. |
| Value index | `dataSearchResident.ts:146` (`scheduleIndex`) | Writes `<id>.search.json`; `dataSearch:query` skips policy datasets for a restricted caller. |
| Re-publish after refresh | `hosted.ts:266` → `publishHosted` | Fan-out scope: refused; the old snapshot is no longer served either (D10). |
| Subscriptions | `subscriptions/job.ts:32` → `run.ts:120` (as the owner) | Fan-out scope + `assertFanOutAllowed`: the run fails `row_policy`, nothing posts, the owner sees why. |
| Dependents re-materialised | `datasetDependents.ts:41` | A derived dataset holds a copy of the rows; it is closed to restricted callers and to fan-out until it has rules of its own (D14) (D14, a ceiling). |
| Scheduled refresh, fresh-on-ask pull, refresh URL, trash purge, `storage:gc` | `refreshJob.ts`, `freshOnAsk.ts:163`, `hooks/act.ts:56` | Writers, not readers. |

### Pushes to browsers

| Push | Where | Carries | Phase 1 |
|---|---|---|---|
| `alerts:fired` | `schedules.ts:81`, `ipc/alerts.ts:43` | value, previous, delta, message, diagnosis (category labels) | For a policy dataset: ids and time only. |
| `hub:dataset-refreshed` | `refreshEvents.ts:43` | row counts | Ceiling (counts). |
| `copilot:ask:chunk` / `:activity` | `ipc/copilot.ts:484` | narration of the facts | Only facts that were allowed (`copilot:ask` is EXPLICIT). |
| `jobs:*` | `server/sse.ts:259` | the submitting tab's own job | The job ran as that caller, under the same checks. |
| `comments:changed`, `subscriptions:*`, `pipelines:changed`, `key:changed`, `live:daily-limit` | — | ids and states | Not values. |

### Stored artifacts and caches that bypass `getDataset`/`residentSource`

These are why D9 exists; each has its row above. The `insights` cache (`insights.ts:70`); the value
index (`dataSearchRun.ts:99-101`, `tablePath` + `readIndex`); snapshot files (`snapshots.ts:46/51`);
`quality.latest.results[].sample` (`qualityRules.ts:48,104`); `live.profile` values
(`liveProfile.ts:112/137/177`); `incremental.highWater`; an input table's version (the whole table,
`inputTable/store.ts:102`); capture threads (`captureUpload.ts:106`); the project colour map
(`colorMap.ts:35`); stored alert events (`alertStore.ts:81`); published pages
(`hosted.ts:150`); the embed page cache (`embedPage.ts:40`); the `paramReplay` memo and the fx rate
cache (inside the doors only).

### Reachable by no viewer today (kept on the list so a future contract is caught)

`filterParse`'s per-dashboard value catalog (`ipc/filterParse.ts:31`, no contract, not registered);
notebook cells (`analysis/notebook/run.ts`, run only by a dataset refresh — a notebook dataset is
derived, D14); `alerts:evaluate` and `alerts:explain` (handlers without contracts). The suite's
coverage check fails the day any of these gains a `read` contract. A dataset version stores
`{id, steps}` and, for an input table, its table (`versionRecordOf`) — never the rules.

## UI

- **Row access tab** (`web/src/features/data/RowAccessTab.tsx` + CSS module), added to
  `DatasetPage.tsx`'s tab list and to the Live tab set, rendered only when `projects:roles` says
  `admin` (hidden — never disabled — otherwise; seeded from nothing until roles arrive). Reads
  `dataset:rowPolicy`, the share targets (`project:shareTargets`) for the member picker, the
  dataset's text columns from the header it already has, values from `dataset:distinct` (the admin
  is unrestricted). Designed states in both themes: loading skeleton, empty, rules, saving, a
  server refusal (the sentence), column-gone and cross-row warnings, no-Postgres.
- **The chip and the off states**: `dataset:list` and `dataset:columns` rows gain `scoped: true` for
  a restricted caller on a policy dataset (computed per caller on the server; nothing else about the
  rules is sent). The dataset page header and Explore's field list show *Rows limited to your
  access*; the Quality, Insights and Snapshots tabs show the designed off state with the server's
  sentence (the `offFeatures.ts` pattern Live uses) instead of asking and failing.
- **Refusals** everywhere else render through the existing refusal state (`refusalOf`), per tile on a
  dashboard.
- **Publish, subscription and alert dialogs** show the `fanout` sentence from their existing
  preview/plan call.

## Tests

House style: differential with `Object.is`, every guard with a negative control, `finish()`.

1. **`scripts/test-rowPolicy.ts`** (pure, no DB): the sanitizer (shapes, caps, parameter references,
   blank values; a corrupt stored policy becomes a CLOSED policy — control: a valid one does not);
   `entitlement` (user, team, union, order, `none`, blank, `all`); the `storesCrossRow` allow-list for
   EVERY step type in `transforms.ts`'s `STEP_TYPES` (a test fails when a new type is added and not
   classified — control: an invented type is cross-row); `lockStep` shapes.
2. **`scripts/test-rowPolicySafetyNet.ts`** (needs `DATABASE_URL`; skips green without it, like
   `test-embed-db`), over the real RPC route as real users: an org with an admin, an editor, viewer
   **East** (through team East), viewer **West** (a user rule), viewer **Nobody** (no rule); dataset
   *Orders* (region, sales, day, customer — West-only customers are canaries like
   `W_CANARY_7f19`; a policy value `WEST_POLICY_CANARY` exists only in the West rule) and a
   **physical subset** *OrdersEast* (only East's rows, same columns and steps).
   - **Coverage**: every `read` contract in `src/api` is in the suite's table with its treatment; an
     unlisted one fails the suite. NEGATIVE CONTROL: a contract planted into `contracts` is reported.
   - **Doors are locked, differentially**: for each door case — bar, pivot, cohort, event funnel,
     LOD with a context filter, small multiples, top-N with Other, point map, KPI sum/count/avg, a
     formula metric over two datasets, metric:values, analysis:tiles, visual:thumbs, story:figures,
     versions:figures, scorecard figures, answer card (with a misspelled value, a relative period and
     a value that is not there), MCP `aggregate`/`metric_value` — East's reply on *Orders* is
     `Object.is`-equal, number by number and label by label, to the editor's reply on *OrdersEast*.
     NEGATIVE CONTROL: the editor's reply on *Orders* differs from *OrdersEast* (the data can show a
     leak), and Nobody is refused `none`.
   - **Locked readers**: dataset:page, dataset:distinct (policy column and another column, with a
     search), dataset:profile, visual:rows, visual:rowsDownload — equal to *OrdersEast*'s.
   - **Every other reader refuses, typed**: 409 `row_policy` or `{ok:false, code:'row_policy'}` with
     the catalog sentence, per item in a batch. NEGATIVE CONTROL: the editor gets 200 with data from
     each.
   - **Nothing leaks, anywhere**: every reply East receives in this suite — all 182 channels, the
     pushes it subscribes to, the MCP replies — is grepped for the West canaries and for
     `WEST_POLICY_CANARY`. NEGATIVE CONTROL: the editor's replies to the same reader channels contain
     the canaries (they are reachable).
   - **A planted unrouted reader makes the suite fail**: a contract + handler registered by the suite
     that reads the Parquet by `tablePath` (bypassing the net) is run through the same loop, and the
     loop reports exactly it as a leak; a planted reader that calls `getDataset` is refused by the
     net, typed (the net works for code it was never told about).
   - **Fail closed**: the policy column renamed by a step, dropped, retyped to number; a window step
     added; a parameterized step; an as-of read; a related column — each refuses with its reason
     (controls: the same without the rule or as the editor answers).
   - **Caches**: viewer East, then the editor, then viewer West, then East again on the same spec:
     four correct answers, no cross-serving. NEGATIVE CONTROL: `cacheKey` with and without the lock
     differs; with the lock dropped the second viewer WOULD get the first's answer.
   - **Fan-out, for everyone**: as the admin — publish:plan, publish:run, an embed, subscription
     preview / save / send (and `deliver()` once item 4 is in), alerts:test / save / evaluation —
     refuse; a site published before the rules is no longer served; a legacy site (no recorded ids)
     is not served while the project has a policy; an embed cached before the rules is refused on
     its next hit; an `alerts:fired` push for a policy dataset carries no value. NEGATIVE CONTROL:
     the same on a dataset without rules publishes, sends and posts.
   - **Live**: a fake-warehouse Live dataset with the same policy — East's figures are
     `Object.is`-equal to the extract *OrdersEast*'s (parity), including a cell `east` that a
     case-insensitive comparison would admit; the compiled statements carry every lock value as a
     bound parameter and none in the SQL text; the latest-date and case-fix lookups carry the lock;
     the profile sample is refused / redacted. `scripts/test-rowPolicyLive.ts` (pure) pins the binary
     form compiled for each of the six dialects.
   - **The policy survives every writer** (D2b) — including the race: `dataset:setRowPolicy` lands
     while a slow `updateDatasetData` fold runs, and the fold's write keeps the new policy (and a
     NARROWED policy is not widened back). `dataset:setRowPolicy` / `dataset:rowPolicy` answer the
     admin and 403 the editor and the viewer.
   - **Derived datasets are closed** (D14): a SQL dataset over *Orders*, a composed one, one with a
     `union` of *Orders*, two hops down — each refuses East (`derived`) and refuses every fan-out;
     a copy of *Orders* carries its rules. NEGATIVE CONTROL: the same derivation over a dataset
     without rules answers.
   - **Writers pinned** (D18): an editor's `replace_values` on the policy column after the rules were
     saved refuses East (`pipeline`) until the admin saves again; a step that does not write the
     column (a filter on `sales`) does not.
3. **`test-embedLock.ts`** stays green with explicit new cases for the tightened allow-list (a
   `lookup_join` step, a SQL origin, a `dedupe_key` without the locked column now refuse an embed
   tile; partitioned/grouped by the locked column still draws).
4. **`test-liveSafetyNet.ts`**, `test-liveParity`, `test-liveRoute` stay green (the gate is a no-op
   for their admin identity).
5. **Vitest**: the Row access tab shows for an admin and not for an editor or a viewer (control); its
   states; `refusalOf` recognises `row_policy` and draws no "Make a copy".
6. **`web/e2e/row-access.e2e.ts`**: an admin sets a policy on the sample's region column; a viewer
   in team East sees only East on a dashboard, in Explore and in a filter's options; publishing that
   dashboard shows the refusal; screenshots `row-access-tab`, `row-access-viewer`,
   `row-access-publish`, light and dark.

## Steps

1. **Design** (this document + the operator page). A separate agent tries to refute it; what
   survives is folded in before any code.
2. **F21**: `stableStringify` keeps a `Map`'s entries; the withheld-columns catch fails closed. Tests.
3. **Moves, no behaviour change**: `lockStep`/`storesCrossRow`/`makeLock` → `src/data/rowLock.ts`
   (embedLock re-exports); the distinct readers take a `filters` list. `test-embedLock`,
   `test-datasetPage` green before and after.
4. **The policy**: `src/data/rowPolicy.ts` (sanitizer, `entitlement`, the writer-steps hash),
   `src/data/upstream.ts` (the closure), the `storesCrossRow` allow-list over steps and origin,
   `writeRecordKeepingPolicy` in `datasetRecord.ts` (B1), the three `datasets.ts` lines,
   `test-rowPolicy`, the writer-survival and race tests.
5. **Who is asking**: `src/server/authz/caller.ts`, the route and MCP seeding.
6. **`src/data/rowAccess.ts`**: `RowPolicyError`, the reasons and `src/data/rowAccessMessages.ts`
   (added to `MAIN_FILES`; `i18n-extract`), `rowLockFor`, the scopes, `gateRows`, `assertReadable`,
   `assertFanOutAllowed`; the route's 409 and reply tagging.
7. **The doors** (`src/ipc/rowDoors.ts`): `vizDataFor`, `computeCardMetric`, `computeCard` (+ the
   Live lookups and the binary comparison per dialect), `pageFor`, `distinctFor` (+ its four
   callers), `dataset:profile`; the `scoped` flag.
8. **Explicit readers**: insights, captures, snapshots diff, quality failing rows, formula check,
   Summary, copilot, versions:get; SKIP and REDACT rows; `assertReadable` on the fx rates dataset; the
   rethrow in every swallowing catch the safety net finds.
9. **Fan-out and exports**: the scopes around publish / re-publish / plan / embed / subscriptions /
   alerts / exports; recorded dataset ids on sites and embed cache entries; the `/p/` serve check;
   `assertFanOutAllowed` at today's send points; the save-time refusals; the `alerts:fired` strip.
10. **`dataset:setRowPolicy` and `dataset:rowPolicy`**: contracts in a new `src/api/rowPolicy.ts`
    (appended to `src/api/index.ts`), handlers in `src/ipc/rowPolicy.ts`.
11. **`scripts/test-rowPolicySafetyNet.ts`**, in full.
12. **Web**: the Row access tab, the chip and off states, `refusalOf`; Vitest.
13. **e2e** `row-access.e2e.ts` + screenshots, looked at in both themes.
14. **Docs**: threat model §4.12 + R19, `docs/README.md` row, `docs/server/README.md` link,
    CHANGELOG, F21 in `docs/first-run-pass/findings.md`.
15. **Integration, after the orchestrator merges items 1, 2 and 4 into this branch** (this item
    merges last):
    - *Item 1 (`figures`)*: confirm `chartShapes` runs inside the wrapped `vizDataFor` body (after
      the extract/Live split, so after the lock); add Pareto, waterfall and 100%-stacked cases to the
      safety net's door differential (`figures` `Object.is`-equal to *OrdersEast*'s). Publish is
      refused for policy datasets, so the sanitizers need nothing.
    - *Item 2 (Explore)*: confirm Explore's figures come from `visual:preview` → `vizDataFor`; put
      `explore:suggest` in the suite's table — it must ANSWER a restricted viewer with encodings
      only and must not read rows (spy on `getDataset`/`residentSource`; if its ranking reads row
      statistics, it ranks from declared types for a restricted caller, as it does for Live); the
      e2e's Explore step and the chip.
    - *Item 4 (`deliver`)*: move `assertFanOutAllowed` into `deliver(channel, model)` over
      `model.datasetIds` (one line), drop the interim call in `run.ts`/`alertPosts.ts`; add the email
      channel to the fan-out cases (a subscription and an alert on a policy dataset send no email).
    - Re-run every gate on the merged tree.

## As built (Phase B)

- **Suites**: `scripts/test-rowPolicy.ts` (pure), `scripts/test-rowPolicyLive.ts` (pure, compiled SQL per
  dialect), `scripts/test-rowPolicySafetyNet.ts` and `scripts/test-rowPolicyFanOut.ts` (DB, over the real
  route; shared world in `scripts/rowPolicyHarness.ts`, the inventory as code in
  `scripts/rowPolicyReaders.ts`), `web/src/features/data/rowAccess.test.tsx`, `web/e2e/row-access.e2e.ts`.
- **Found while building, fixed**: `pageRowsJs` dropped the filters when a request had no page
  window, so a grid request without one counted the whole table (a count leak under a lock);
  `alertStore`'s period and anomaly catches, and the scorecard's figure catch, swallowed a refusal.
- **Integrated with items 1–4**: `deliver()`'s `refuseFanOut(delivery, datasetIds)` is the row-policy
  check — the one door every subscription run, fired alert and channel test passes; it answers
  `row_policy` (a run code beside the email codes) for a policy or policy-derived dataset, and
  `compute_failed` when the check itself fails. Subscription preview and save ask
  `dashboardSendRefusal` of the dashboard's DEFINITION (`figureDatasets`): no figure computed, no
  warehouse called. The interim checks (`buildSendable`, the per-event check in `alertPosts.ts`) are
  gone; `publishHosted`, the embed build and the per-rule alert scope keep their own. The lineage
  graph (and so `figureDatasets` and the pipeline) draws its dataset edges from
  `upstream.parentsOfRecord` — one lenient definition, read as stored, so an origin that would not
  sanitize still names its parents (`test-rowPolicy` pins the agreement on composed, sql, union and
  lookup_join). An older `/p/` site has its datasets worked out once from the definitions it was
  published with (`datasetsOfRoot`) and kept on its manifest; one with a story or scorecard falls back
  to the project-wide check, remembered for 15 s per pod and forgotten when this pod saves rules.
  Explore's suggestions are metadata (META); its page shows the chip and the access state; the
  drawn figures (a waterfall's levels, a Pareto's share) come off the locked series and equal the
  explicit-filter figures with `Object.is` (`test-rowPolicySafetyNet`).

## Review round 2

Each fix is pinned by a test with a negative control that fails without it.

| # | What was wrong | Now |
|---|---|---|
| 1 | A read error on a record (not ENOENT) read as "no rules"; a failed read was memoised. | ENOENT → no rules; unparseable → closed; any other error refuses (`unreadable`), never memoised; copies refuse when the source's rules cannot be read. |
| 2 | A lock on a column that is gone was skipped by the JS fold, the resident filter and the Live adapter. | `lock: true` on a missing column refuses (`column`) in all three. |
| 3 | RFM and composer saves made a dataset from a ruled one without its rules. | Born with them (`savedFrom`), or closed rules for a derived source. |
| 4 | A dataset with its own rules skipped the upstream walk. | Upstream always walked: other rules upstream → `derived`. |
| 5 | `LiveRefusal` took a `row` prop the callers had to pass. | Reads row-vs-Live from the refusal itself. |
| 6 | `metric:check` was exempt in the safety net. | A door like the others (`sum(sales)`). |
| 7 | Live lock SQL was checked by regex; only DuckDB ran. | Exact clause per dialect; the `md5` form runs on a real Postgres column with a case-insensitive collation. |
| 8 | Entitlement dedupe was O(n²). | A Set. |
| 9 | `subscription:save` rebuilt the dashboard to refuse it. | Asked of the definition (`dashboardSendRefusal`). |
| 10 | The legacy `/p/` check walked every dataset per fetch. | Backfilled once; else a 15 s per-pod memory forgotten on a rule save. |
| 11 | `projects:list`/`:open` sent the colour map and dismissed insight ids. | Never sent. |
| 12 | A visual's custom order and series colours rode out to a restricted viewer. | Dropped for that caller (`visualForCaller`) in `visual:get`, thumbs, the gallery, `analysis:open` and a visual's version. |
| 13 | `versions:diff` of a dataset was not gated. | Gated like `versions:get` (and `:figures`). |
| 14 | A pipeline run's errors could quote a value. | Blanked on a restricted caller's dataset and quality nodes. |
| 15 | Sentiment and keyword-rule steps wrote `<col>_sentiment` / `<col>_category` unseen. | Counted as writers. |
| 16 | Anomaly keys in the list; a parameter replay served from its memo. | Keys dropped; the net runs before the memo. |

## Refutation round

A separate reviewer tried to break the first version of this design against the code. It could not
break the inventory (diffed exactly against `src/api`), the net's placement, the async scoping,
the cache keys, MCP coverage or the doors' filter semantics. What it did find, and what changed:

| Finding | What it was | What this design does now |
|---|---|---|
| B1 (blocker) | `persist` writes the in-memory `Dataset` with no lock and no re-read, so a long fold could overwrite a policy saved meanwhile. | The record write is a locked read-merge-write that copies `rowPolicy` from the STORED record (D2b); a race test. |
| B2 (blocker) | "Derived datasets don't inherit" let a SQL dataset over a policy dataset show every row. | Derived datasets are closed (`derived`) to restricted callers and fan-out; copies carry the rules (D14). |
| B3 | The allow-list read steps only; an origin (`sql`, `notebook`, `composed`) or a `lookup_join` mixes rows; `dedupe_key` can keep another team's row. | Origin and those steps count as cross-row; `dedupe_key` passes only when keyed on the policy column (D16). |
| S1 | An editor could add a step that rewrites the policy column after the rules were saved. | `stepsHash` pins the column's writers; a change refuses until an admin re-saves (D18). |
| S2 | `prepare:get` returns step bodies (other teams' values in a filter or replace step). | Refused for a restricted caller (EXPLICIT). |
| S3 | Warehouses may compare text case-insensitively; the lock would admit `east` for `East`. | Binary comparison per dialect for the lock and both lookups; no binary form → refused (D13). |
| S4 | "Skip the prepend inside an open scope" could drop the lock from a re-entry whose filters were rebuilt. | Prepend unless `filters` already starts with exactly the lock (D7). |
| S5 | A restated grant query could drift from `authorize`; a DB error could fall back to the org role. | `grantRank` reused; a DB error throws (D4). |
| N1 | One fan-out scope around `evaluateProject` would let one policy rule fail every rule. | One scope per rule (D10). |
| N2 | `lastRefreshError` and the refresh-failure push can quote a value. | Redacted for a restricted caller on a policy dataset. |
| N3 | Claiming `test-embedLock` "unchanged" hid the embed tightening; `rowPolicy` on `DatasetMeta` could ride out in a reply. | Own CHANGELOG line and explicit test edits (D1); the policy is read raw, never in `Dataset`/`DatasetMeta` (D2). |
| N4 | Door logic inside `visuals.ts` (746 lines). | Wrappers in `rowDoors.ts`, `distinctFor` in its own file, B1's helper in `datasetRecord.ts`. |
| N5 | The legacy `/p/` rule named only datasets with their own rules. | It uses the same closure: any policy-closed dataset (D10). |

Pre-existing findings logged as F21: the `ParamValues` Map in the answer-cache key, and the
fail-open share-policy lookup in `dataSearchRun.ts:97` (fixed: a failed lookup refuses the search).

## Ceilings (documented, not hidden)

- **Metadata stays visible**: dataset and column names, declared types, the dataset's total row
  count (lists, catalog, search, SQL schema, pipelines, snapshots, Prepare's step counts), relationship
  match counts, version diffs' row counts.
- **Authored content is not row-filtered**: titles, notes, column notes and examples, comments
  (including the chart point a comment is pinned to), filter values saved in a dashboard, visual or
  saved view, event annotations, the SQL text of a SQL dataset.
- **Derived datasets are closed, not filtered** (D14): a SQL, notebook, composed or combined dataset
  — or one whose steps look up another dataset — is refused to restricted viewers even when it has
  rules of its own (D16). Filtering through SQL is phase 2.
- **Default order and colours**: a restricted viewer of a chart on a dataset with rules sees it in the
  default category order and series colours — the custom order and per-series colours name values and
  are dropped from what they are sent (`visualForCaller`). The other styling stays.
- **Names someone saved**: a visual saved from an insight is named after the insight's title, and a
  report's caption can be prefilled from a chart's figures; once saved, both are authored text, shown to
  whoever can open the record, like any title.
- **The caller's own history**: Assistant threads keep what was answered under the access they had then.
- **Entitlement changes apply per request**; a published page was never built for a policy dataset.
- **Phase 2**: per-recipient subscriptions and publish, "run as the viewer" in the warehouse,
  rules across related datasets and joins, user attributes beyond id and team, row-filtered
  statistics, drivers, insights and exports.
