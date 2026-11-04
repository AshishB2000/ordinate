# Semantic layer, part 4 — governance

Status: draft, not built (2026-11-03). Builds on [part 1](00-design.md) and reuses the machinery of
row access rules ([`docs/row-policy/00-design.md`](../row-policy/00-design.md), "row-policy" below).

Part 1 makes Ordinate the one place that says what Revenue means. Part 4 says which definitions
the company stands behind, which are on the way out, and who may see a column at all.

## What you will see when this is done

```
Data model · Retail demo · Metrics                         Filter: [All] [✓ Certified] [Retired]
Revenue        ✓ Certified · ana@acme.com · Nov 3          sum(amount)     used by 31
Net revenue    ✓ Certified · changed Nov 5, needs review   sum(amount)−…   used by 12   [Review]
Gross revenue  Retired · use Net revenue                   sum(gross)      used by 6    [Show charts]
Payroll        🔒 Uses salary, which only HR can see        (as a viewer outside HR sees it)
```

- **Badges wherever a metric, term or dataset is named:** pickers (certified first, retired
  collapsed), chart and KPI captions, Explore, the Assistant's answer cards.
- **A chart on a retired metric keeps drawing,** captioned "Retired metric"; an editor gets **Switch
  to Net revenue**, an ordinary chart save. Nothing switches by itself.
- **Editing a certified metric** warns first (*Revenue is certified by ana@acme.com. Saving changes
  31 charts and needs a project admin to certify it again.*), then reads "changed since certified"
  until an admin reviews the diff and certifies again.
- **Dataset → Access** (project admins only) gains **Who sees each column** beside the row rules:
  `salary — Only: HR`, `bonus_pct — Only: HR (hidden too: computed from salary)`.
- **A viewer outside HR**: "Headcount by department" draws as before; "Pay by department" says *This
  uses salary, which only HR can see.* The grid says "2 columns hidden". The Fields tab lists
  `salary` with a lock. The Assistant and MCP agents never get its values or a figure made from it.

## Intent

- **Trust you can see:** a badge means a named person checked this exact definition.
- **Retire without breaking:** old metrics fade out of new work; old dashboards keep working.
- **Hide a column honestly:** a figure that needs it is refused, never computed without it.

## Goals

1. Certified and retired ("use X instead") status on metrics, terms and datasets, pinned to
   content so an edit visibly undoes certification.
2. Pickers, the Assistant and MCP prefer certified items and flag retired ones.
3. A project admin hides a column from every viewer but named users and teams, on every reader,
   with the inventory test row access has.
4. Every status and access change is in the version history or the audit log.

## Non-goals

- An approval queue or a second "proposed" copy of a metric (Approaches, B).
- Certifying dashboards, visuals or reports: dashboards already have drafts and Publish
  (`docs/analysis/00-model.md` §0.5).
- Hiding columns from editors: they rewrite Prepare and read every row (row-policy D4); Power BI's
  object-level security also binds only viewers. Per-team field lists (part 6). Auditing views.

## Anti-goals (a failure even if it works)

- **A silently wrong number:** a filter on a hidden column dropped, a measure on it read as empty, a
  retired metric swapped for its replacement without a word.
- **A badge that lies:** "Certified" after a version restore, a duplicate, or an edit to a term or
  metric it depends on.
- **A rule that fails open:** a refresh that drops the rules, a rename that walks a hidden column out
  under a new name, a corrupt record read as "no rules".
- **Hiding by decoration:** gone from the picker, still in the grid, the CSV, the prompt or MCP.

## Approaches

**A. Status pinned to content; column rules on the row-access machinery (my call).** Status lives
in the catalog with a hash of what was certified: nothing copied, no edit blocked, and the badge
stops claiming certification when the hash moves. Column rules live beside `rowPolicy` and are
enforced by the doors (`src/ipc/rowDoors.ts`), net and scopes (`src/data/rowAccess.ts`) and
inventory (`scripts/rowPolicyReaders.ts`) that enforce row rules. *Trade-off:* an editor can still
change a certified metric, moving every chart at once (part 1 D16); the badge says so.

**B. Drafts and approval,** a published copy and a draft per certified metric and term, like
dashboards. Strongest, but every metric reader (three doors, `resolveMetric`, formula operands, D16's
chart path, the Assistant, MCP) must pick a copy per caller: the dashboard drafts work
(`test-dashboardDraftsViewer`) again, twice, plus drafts of metrics that name an edited term.

**C. Hide columns through the share policy** (`src/app/sharePolicy.ts`: mask, drop or include on
export, report, publish, bundle), with an in-app path per team. It shapes replies after computing
them (the silently-wrong-number risk), enumerates chart shapes by hand (`applyToChart`), and
sensitivity is editor-set (`catalog:setColumn` is `write`).

A wins: honest with no copies. B can come later for metrics if pinning proves too loose.

## Decisions

### Status

**D1. Two stored states, four read.** Stored: `certified` or `retired`; absent is no status. Read on
the server as `certified`, `needs_review` (certified, pin moved; computed, never stored),
`retired` or none. The UI never calls the default "draft": a draft dashboard is invisible to viewers
(§0.5); a metric without a badge is not.

**D2. Status lives in the catalog, not on the record (my call).** A new `status: Record<ref,
StatusDoc>` section of `CatalogFile` (`src/app/catalog.ts`) beside `records`, `columns` and part 1's
`tables`, for `metric:`, `term:` and `dataset:` refs (`'term'` joins `CATALOG_KINDS` and the `Ref`
regex in `src/api/catalog.ts`). Status is not content, so a version restore, a duplicate or a bundle
round trip never certifies, and `setDoc` never touches it. Written through `mutate` (the catalog's
lock). An unreadable catalog shows no badges: that fails safe.

```ts
interface StatusDoc {
  status: 'certified' | 'retired';
  by: string; at: string;   // signed-in email (catalog.osUser), server-stamped
  note: string;             // ≤ 500, shown on hover
  pin?: string;             // certified: pinOf() at certify time (D4)
  versionKey?: string;      // certified: the version the certify event wrote (D11)
  replacedBy?: string;      // retired: a ref of the same kind, not itself retired
}
```

**D3. Project admins (and org admins) certify, retire and clear (my call; question 1).**
`model:certify`, `model:retire`, `model:clearStatus`: `access: 'admin'`, project scope, zod inputs,
in a new `src/api/governance.ts` appended to `src/api/index.ts`. No new role: `project_grants.role`
is `CHECK (role IN ('admin', 'editor', 'viewer'))` (`0006_authz.sql`), and `RANK`, `grantRank`,
`rolesOf` (`src/server/authz/index.ts`), the IdP mapping (`src/server/auth/idpGroups.ts`) and the
share dialog know three roles. `model:certify` takes the content tag the admin reviewed (`Base`,
`src/api/contract.ts`); a moved item is refused 409 `record_changed`.

**D4. The pin covers everything the figure depends on.**

| Kind | `pinOf` hashes | Left out |
|---|---|---|
| Metric | `datasetId`, `definition`, `filters`, `format`, `name`, part 1's `timeColumn` and `snapshot`; the pin of every metric its formula names and every term its filters name (recursive, bounded) | `description`, `direction`, `tree` |
| Term | `datasetId`, `filters`, `name` | `aliases`, `description` |
| Dataset | `pipelineHash(steps)` (`src/engine/queryCache.ts`), origin kind and connection, mode, declared column types, part 1's Live `baseFilters` | the data (a refresh keeps it certified), docs, key, row rules |

Editing the EMEA term turns certified "EMEA revenue" to `needs_review`.

**D5. Change control is the pin, not a lock (my call; question 2).** No edit is refused. Before a
figure-changing save to a certified item the editor's dialog names the certifier and the usage
count (`metric:usage`, `src/analysis/metricUsage.ts`); after it the item reads `needs_review`
everywhere until an admin certifies again, reviewing `versions:diff` from `versionKey` to now. That
is the minimum honest version: the badge never covers a definition nobody checked.

**D6. Retiring changes no figure.** A retired item still computes, refreshes and alerts.
`replacedBy` must be the same kind and not retired; chains and cycles are refused with a sentence.
Deleting stays separate (Trash, `src/api/trash.ts`).

**D7. Everyone who reads the project sees the status,** `needs_review` included (hiding it would be a
badge that lies), attached on the server to the replies that already list these items
(`metric:list`, `metric:table`, `dataset:list`, `catalog:list`, part 1's term and Data model reads).
Computed once per request and never part of a figure, so no figure cache changes.

**D8. Pickers** order certified, then none (`needs_review` ranks here), then retired, collapsed with
its replacement linked. Part 1's "To fill in next" strip gains "retired, used by n" and "certified,
changed since".

**D9. The Assistant prefers certified items, by code.** `factMetrics` (`src/ipc/copilot.ts`),
`specMetrics` (`src/ipc/answers.ts`) and the plan facts carry `status`. Retired items leave the
model's vocabulary unless a question names one exactly; then the figure is computed as asked and a
server sentence adds "Gross revenue is retired; Net revenue replaces it." Wherever code picks among
candidates (fuzzy match, "Did you mean"), it ranks certified, none, retired. The prompt says "prefer
certified" too, but correctness never rests on the model.

**D10. MCP.** `list_metrics`, `list_datasets`, `describe_dataset` and part 1's `list_terms`
(`src/automation/registry.ts`, `handlers.ts`) return `status`, `certifiedBy`, `certifiedAt`,
`replacedBy` (a name); `metric_value` on a retired metric adds both. One sentence joins the server
`instructions` (`src/automation/mcp.ts:68`). `docs/automation.md` is regenerated.

**D11. History.** Each status change records a version event: `VersionEvent` (`src/app/versions.ts`,
today `published | unpublished | discarded`) gains `certified | retired | cleared`, recorded even
when content did not move, like Publish. `'term'` joins the version types (`TYPES` there,
`VersionType` in `src/api/versions.ts`) if part 1 has not added it.

### Hiding columns (object-level security)

**D12. Hiding protects a column's values and every figure computed from it, not its name (my call;
question 3).** Names already sit in authored definitions, diffs, lineage and comments (row-policy
ceilings); a sensitive name is renamed in Prepare. A rule is an **allow-list**, `{ column,
visibleTo: (userId | teamId)[] }`, so someone added to the project later does not see it until named.
Restricted means what row access means (`callerOn`, `src/server/authz/caller.ts`): a project viewer.
Org admins and project editors and admins see every column.

**D13. Stored raw on the dataset record beside `rowPolicy`:** `columnAccess = { columns,
readersHash, updatedBy, updatedAt }`, never in `Dataset` or `DatasetMeta` (row-policy D2).
`writeRecordKeepingPolicy` (`src/data/datasetRecord.ts`) copies only `rowPolicy` from the stored
record today: **it must copy `columnAccess` too, or the first refresh drops the rules.** The same for
copies (`withFirstWritePolicy` there; `rulesForCopyOf`, `savedFrom` in `rowAccess.ts`). A value that
does not sanitize reads as closed. Set by `dataset:setColumnAccess`, read by `dataset:columnAccess`
(both `admin`; the read `audit: 'denials'`, like `src/api/rowPolicy.ts`).

**D14. Columns computed from a hidden column are hidden too.** On save the server finds the Prepare
outputs that carry a hidden column: steps naming it (as `columnWriters` in `src/data/rowPolicy.ts`
finds them), formulas referring to it (`Compiled.refs`, `src/formula/formula.ts`), steps writing
columns they do not name (`UNNAMED_WRITERS`) or of an unknown type. It adds them to the rule; the tab
shows "hidden too: computed from salary". `readersHash` pins every step that reads a hidden column,
as row-policy D18 pins writers: a change refuses hidden-from callers (`pipeline`) until an admin
saves again. A rule naming a column the dataset no longer has refuses too (`gone`): a source rename
may have moved the data.

**D15. The gate, at the three figure doors** (`rowDoors.ts`), before the row lock, the answer-cache
key and the Live split: a restricted caller's question that names a column hidden from them, in any
role (category, series, measure, filter, sort, facet, map, formula, LOD), is refused. Checked
**after** metric and term expansion (`withLeafMeasures` in `src/analysis/metricMeasures.ts`, formula
`refs`), per table read (`chartReads` / `metricReads`), and **before** the server's own steps: the
row lock, Prepare and Live base filters may use a hidden column (they define the dataset, not the
question). Matching is conservative, like `namesIn`: a false match refuses, never leaks. The refusal
is `RowPolicyError` with a new reason `hidden` (code `row_policy`), so every rethrowing catch, the
route's 409 and the web's `refusalOf` already handle it. A passing question reads no hidden column,
so its cached answer is safe to share.

**D16. Row readers drop hidden columns and say so.** `pageFor` (`dataset:page`, `visual:rows`,
`visual:rowsDownload`) removes them from header and cells and replies `hiddenColumns: n`; a filter,
sort or search on one is refused. The distinct reader refuses a hidden column; `dataset:profile`
drops it. A drop changes no figure and is announced.

**D17. Everything else reuses the row-policy treatment.** `closedReason` (`rowAccess.ts`) answers
"governed for this caller" when a dataset has row rules **or** hides a column from the caller, its own
or upstream (`upstreamIds`, `src/data/upstream.ts`). So NET readers (SQL, stats, drivers, segments…)
refuse, EXPLICIT and SKIP rows refuse or skip, exports refuse a restricted caller (row-policy D11),
and derived datasets are closed (`derived`). **Fan-out is narrower than for rows:** inside
`fanOutScope` the gate runs as the least-entitled audience, so a publish, embed, subscription or alert
refuses only when it **reads** a hidden column. A `/p/` site whose datasets gained column rules after
it was published stops being served until republished.

**D18. REDACT additions** for a hidden-from caller: `catalog:columns` drops the column's `example` and
part 1 value labels; `format:colors:get` its colours; `visualForCaller` its custom order, colours and
saved filter values; `quality:list` samples and `args`; `dataset:liveSchema` profile samples.
`dataset:columns`, `sql:schema` and `describe_dataset` mark it `hidden: true`.

**D19. Metrics and terms are hidden by what they read (my call).** One whose resolved columns include
a column hidden from the caller is listed `hidden: true` with a lock, left out of pickers, the
Assistant and `list_metrics`, and refused on a tile. No separate switch: hiding Payroll while
`salary` stays visible protects nothing.

**D20. Joins and row rules.** A join through a hidden key still runs (no key value reaches the
reply); grouping or filtering by it is refused. Row and column rules apply independently; the policy
column may itself be hidden (the lock is the server's step). The `related` refusal is unchanged.

**D21. The Assistant and MCP never see a hidden column.** Facts drop it entirely (name, stats,
samples, notes) for that caller, through the plumbing that withholds sensitive values
(`withheldColumns` in `sharePolicy.ts` and `src/ai/columnNotes.ts`, `assistantColumnDocs`). MCP
`aggregate` and `metric_value` are doors; `query_sql` is NET-refused. A per-caller SQL view is later.

**D22. Sensitivity and the share policy stay.** Sensitivity (editors, `ColumnDoc`) says how values
*leave* the app; column access (admins, the record) says who *inside* it sees them. The Access tab
suggests hiding columns marked personal or financial; on publish, hidden beats masked. Finding:
`markedLevels` (`sharePolicy.ts`) carries a mark across `rename_column` only, so a calculated column
made from a sensitive one leaves unmasked. D14's carrier helper fixes it (own commit, logged).

### History and audit

**D23. What exists:** every write and admin RPC is audited with channel, actor, org, outcome and ids
only, kept `AUDIT_RETENTION_DAYS` (`src/server/authz/audit.ts`); 50 versions per dataset, visual,
dashboard, metric and report, with `by` and `event` (`src/app/versions.ts`); Trash for 30 days
(`src/api/trash.ts`); edit-conflict tags; catalog `updatedBy`/`updatedAt`. **What is added:** the
status events (D11); three status channels, so an audit row's `channel` says what happened (a row
holds only ids); column rules stamped on the record and audited through `dataset:setColumnAccess`.
Rules are not versioned, like row rules: the audit log is their history.

## Constraints from the repo's rules

- **Contracts:** five new channels, zod inputs, `access: 'admin'`, project scope; `index.ts`
  append-only. **Row access holds on every reader:** same doors and net, every `read` contract
  classified. **Fail closed:** corrupt rules, a missing column or a changed pipeline close; a
  Postgres error in `callerOn` throws (row-policy D4).
- **Caches** keyed with `orgKey()`; the gate runs before the answer cache; status is in no figure
  key. **Engines do the math:** status and hiding refuse or label a number, never change it.
- **Sentences** through `t()` (`src/data/rowAccessMessages.ts`). **No migration, dependency or env
  var.** **File size:** new `src/data/columnAccess.ts`; `rowAccess.ts` (346 lines), `rowDoors.ts`
  (265) take calls only; `copilotFacts.ts` (577) no new block.

## Tests

- **`test-governanceStatus`** (pure + store): `pinOf` table-driven per kind, each in-pin field moves
  it and no other does. Negative control: an unclassified new `Metric` field fails. A term edit
  turns a certified metric `needs_review`; a restore, a duplicate and a bundle import never certify;
  a stale `base` is refused; bad `replacedBy` is refused; the channels 403 an editor and a viewer
  (control: an admin passes).
- **`test-columnAccessSafetyNet`** (DB, real route, `rowPolicyHarness.ts`): **coverage**, a
  `COLUMN_TREATMENT` beside `TREATMENT` in `rowPolicyReaders.ts` for every `read` contract (191
  today), control: a planted contract is reported. **Canaries** in every `salary` cell, grepped in
  every reply a non-HR viewer gets (read channels, pushes, MCP, **and every prompt sent to the fake
  model provider**), control: an HR viewer's and an editor's replies contain them. A planted
  `tablePath` reader is reported; a planted `getDataset` reader is refused. **No figure moves:** a
  question not reading `salary` is `Object.is`-equal to the editor's. **Fail closed:** a carrier
  column, a later step reading `salary`, a renamed source column, a derived SQL dataset, a corrupt
  record (controls: without the rule). **Cache order:** the editor asks `sum(salary)`, then the
  viewer is refused; control: with the gate after the cache (test seam) the viewer gets the answer.
  Rules survive every writer, including a refresh racing the setter. **Fan-out:** a publish reading
  `salary` refuses, one not reading it publishes, an older site stops. **Live:** refused before
  compile; profile samples redacted.
- **Vitest:** badges, picker order, retired collapsed, the locked field, the grid note, the Access
  tab for admins only (control: an editor). **e2e** `governance.e2e.ts`, screenshots in both themes.

## Build order (chained PRs)

1. Status store, `pinOf`, the three channels, version events, `test-governanceStatus`.
2. Status in replies, pickers, captions, the Data model section and the strip.
3. Status in the Assistant and MCP; `docs/automation.md`.
4. Column access without a setter: the record field and its writer survival, carriers and
   `readersHash`, the door gate, the row readers' drops, the `closedReason` predicate.
5. REDACT rows, Assistant and MCP dropping, fan-out and `/p/`, `test-columnAccessSafetyNet` in full.
6. `dataset:setColumnAccess` / `:columnAccess` and the Access tab. **The setter ships last**, so no
   rule exists before every reader enforces it.

## Dependencies

- **Part 1:** terms (D10–D12); D16, which is why the pin matters; `timeColumn`/`snapshot`; the Data
  model section, strip and `metric:usage`; value labels. **Row access:** reused whole; part 4 widens
  its predicate, not its shape. **Part 3:** verified questions cite certified metrics. **Part 6:**
  views declutter (D19 is not that). **Part 7:** exports status in files; column rules never leave.

## Owner's answers

The owner took every recommended answer below (2026-11-03). They are decisions now, not open questions.

1. **Who certifies?** Recommended: project and org admins, no new role. A steward role means a grant
   constraint change, IdP mapping and a fourth rank. Revisit if admins become a bottleneck.
2. **Can an editor change a certified metric?** Recommended: yes, and the badge drops to "changed
   since certified" until an admin re-certifies (D5). Refusing editors' edits instead needs every
   writer covered (`versions:restore`, and any term the metric names) for what the pin already shows.
3. **Are column names secret?** Recommended: no. Values and figures are hidden, names shown with a
   lock, and a sensitive name renamed in Prepare. Hiding names means redacting authored definitions,
   diffs, lineage and comments across dozens of channels.

## Left to the builder

- Names of channels, fields and files; the Access tab layout (after mockups). Making `namesIn`-style
  matching precise per encoding without losing conservatism. Which Assistant matchers need D9's
  ranking. A bundle import's foreign `by` (keep it; the pin decides). Whether exports can run D15
  per part instead of refusing whole (D17 refuses for now).
