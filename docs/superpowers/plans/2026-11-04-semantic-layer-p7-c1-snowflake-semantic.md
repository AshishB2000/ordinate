# Semantic layer part 7, step c1: Snowflake semantic views — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Snowflake connection lists its semantic views beside its tables, and a semantic view added as a dataset answers charts and KPIs with Snowflake's own metrics, through the same account, role and secrets, values bound, every request pinned by a golden and the whole matrix re-run nightly against the real account.
**Architecture:** The existing `snowflake` registry entry gains `semantic` (D14): listing and describing in a new `src/connectors/snowflakeSemantic.ts` (`snowflake.ts` is 443 lines), `run` delegating to its own bound execution. The encoder `src/engine/live/semantic/snowflake.ts` turns b1's `SemanticQuery` into one `SELECT … FROM SEMANTIC_VIEW(…)` statement with `?` binds and registers in b2's adapter registry. A test-only decoder of our own SQL grammar lets the fake layer answer it, so per-PR parity proves the encoder; the nightly proves Snowflake.
**Tech Stack:** `src/connectors`, `src/engine/live/semantic`, self-checks, `.github/workflows/warehouse-nightly.yml`.
**Spec:** docs/semantic-layer/07-portability.md (D14, D15, D16, D17; "Left to the builder") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-c1-snowflake-semantic` off `origin/develop` after b3 merges. One PR. Release 2.

## Everything Snowflake-specific is (to verify) until Task 1 says otherwise

The spec leaves these to the builder, and they are **not facts**: the `SEMANTIC_VIEW` clause's exact syntax; how semantic views are listed and described (`SHOW SEMANTIC VIEWS`, `DESCRIBE SEMANTIC VIEW`, `SHOW SEMANTIC DIMENSIONS / METRICS`); whether `?` binds are accepted inside the clause; whether a date dimension can be truncated inside the clause or only the view's own time dimensions exist; whether a dimension-only query lists values; whether `TO_BINARY` works inside the clause; what the role needs. Task 1 settles each against the real account and records the answers before any adapter code.

## Global Constraints

- **Same connection (D14).** No new fields, no new secret: the account, user, role, warehouse, key or PAT already stored. Every request goes through `warehouse()` (b1) → `runSemanticBound` → `semantic.run` → Snowflake's bound execution (`execute(..., 'live', bindings)`, `src/connectors/snowflake.ts:214`): the same SSRF pin, `QUERY_TAG`, timeout, cancel and row cap as Live SQL.
- **Values are bound, never inlined.** If Task 1 finds binds refused inside the clause, the fallback is decided there and recorded: (a) filters on grouped dimensions go in an outer `WHERE` with binds, and (b) a filter that must act inside the clause (the "Other" exclusion, a filter on an ungrouped dimension) is written by the closed literal encoder `src/engine/live/semantic/literals.ts` (built here, reused by d1; the rules are d1's Global Constraints) or refused. Raw text is never inlined.
- **Identifiers.** A view name is `db.schema.view` parts each matching `IDENT_RE` (`snowflake.ts:366`) and quoted; dimension and metric names come only from the dataset's synced lists (as columns must be declared, plan D4).
- **Additive (D16)** only when the metric's expression, as `DESCRIBE` returns it, is one `SUM(…)` or `COUNT(…)` (not `COUNT(DISTINCT …)`) around an argument with no further aggregate or operator outside it; anything else is `additive: false`. Failing safe means a refused running total, never a wrong sum.
- **Grains.** Only what Task 1 shows the clause can do. If a date dimension cannot be truncated inside the clause, each date dimension is offered at its own grain only (`day` for a DATE), and a month view needs the view to define a month dimension; the picker shows only those (b3).
- **Row access (D17).** `caps.binaryCompare` stays `false` unless Task 1 shows `TO_BINARY(…) = TO_BINARY(?)` works inside the clause; then Task 4 pins it in `test-rowPolicyLive` and the nightly before it is set to `true`.
- **Golden requests** `scripts/fixtures/golden/semantic-snowflake.json`: `encode` of each IR shape in `SHAPES` (text top 51, "Other", date at each grain, split ranks and cells, KPI, every filter op, an answer top N, the lookups), recorded once and never re-recorded.
- `snowflake.ts` grows by the `semantic:` property only (≤ 5 lines). No dependency, no migration, no stored field (b2's block holds `backend: 'snowflake'`).
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A bind inside the clause** (or the literal fallback) for every filter value and the "Other" exclusion; the golden shows no value in the SQL text. Task 2.
- **Additivity fails safe:** `SUM(a)/SUM(b)`, `AVG(a)`, `COUNT(DISTINCT a)` are each `additive: false`. Task 3.
- **The role sees only what it may:** a view the role cannot describe is a sentence, and its error text goes to the log only. Task 3.

---

### Task 1: Spike: what Snowflake really accepts (no product code)
**Files:** Create `docs/live-data/snowflake-semantic-views.md` (the findings), `scripts/fixtures/snowflake-semantic-view.sql` (a `CREATE SEMANTIC VIEW` over the live-parity fixture's table, for the owner to run once in the nightly account)
- [ ] **Step 1:** With the nightly's account (the owner runs the SQL script once, or gives a scratch schema), try each "(to verify)" item above by hand in a worksheet, and paste the exact statement and Snowflake's answer for each into the doc.
- [ ] **Step 2:** Decide, in the doc, the bind strategy (inside / outer + literal / refuse), the grain rule, the listing and describing statements, the additivity source, whether lookups work, and whether `TO_BINARY` works. If the account is not available, write the doc from Snowflake's documentation, mark every line "(unverified)", and stop: tell the owner, because Tasks 2–5 need these answers.
- [ ] **Step 3: Commit.** `git add docs/live-data/snowflake-semantic-views.md scripts/fixtures/snowflake-semantic-view.sql` · "Record what Snowflake's semantic views accept, before the adapter"

### Task 2: The encoder, its golden and the fake that answers it
**Files:** Create `src/engine/live/semantic/snowflake.ts`, `scripts/semanticFakeSnowflake.ts` (test-only `decodeSnowflake(sql, params): SemanticQuery`, a parser of exactly the grammar `encode` writes), `scripts/test-semanticSnowflake.ts` · Modify `src/engine/live/semantic/adapters.ts` (b2: register), and `literals.ts` if Task 1 chose the fallback
**Interfaces:** Produces `snowflakeAdapter: SemanticAdapter` (`encode(q, model) → { kind: 'semantic', body: { sql: string; params: LiveParam[] }, columns }`).
- [ ] **Step 1: Write the failing test.**
```ts
for (const [name, q] of SHAPES) {
  const req = snowflakeAdapter.encode(q, 'DB.SALES.ORDERS_SV');
  ok(`${name}: decodes back to the same question`, isDeepStrictEqual(decodeSnowflake(req.body.sql, req.body.params), q));
  ok(`${name}: no filter value in the SQL text`, valuesOf(q).every((v) => !req.body.sql.includes(String(v))));
}
ok('the golden requests are unchanged (never re-recorded)', stableStringify(SHAPES.map(([n, q]) => [n, snowflakeAdapter.encode(q, 'DB.SALES.ORDERS_SV').body])) === fs.readFileSync(GOLDEN, 'utf8'));
ok('a view name part outside IDENT_RE is refused', throwsRefusal(() => snowflakeAdapter.encode(Q, 'DB.SALES."x";drop')));
ok('NEGATIVE CONTROL: an encoder that inlines a value fails the value check', !valuesOf(Q).every((v) => !inliningEncode(Q).includes(String(v))));
```
- [ ] **Step 2:** Run → red (`snowflakeAdapter` missing). **Step 3:** implement; record the golden ONCE, read it by hand. **Step 4:** `npm run build:ts && node scripts/test-semanticSnowflake.js` → green.
- [ ] **Step 5: Commit.** `git add src/engine/live/semantic scripts/semanticFakeSnowflake.ts scripts/test-semanticSnowflake.ts scripts/fixtures/golden/semantic-snowflake.json` · "Encode semantic questions as SEMANTIC_VIEW statements with bound values"

### Task 3: Listing, describing and the registry entry
**Files:** Create `src/connectors/snowflakeSemantic.ts` · Modify `src/connectors/snowflake.ts:402-441` (`semantic: snowflakeSemantic`) · Test `scripts/test-connectorsSnowflake.ts` (recorded replies, as today), `scripts/test-semanticSnowflake.ts`
**Interfaces:** Produces `snowflakeSemantic: ConnectorSemantic` with `backend: 'snowflake'`, `caps` from Task 1, `listModels`, `describeModel` (types through the Snowflake column mapping `liveColumns` already uses), `run(ctx, body)` → the bound execution; `additiveExpression(expr: string): boolean`.
- [ ] **Step 1: Write the failing test.** Off recorded replies (the `setTransport` seam, `snowflake.ts:56`): the listing gives `DB.SCHEMA.VIEW` names; describing gives dimensions typed and metrics with `additive`; `additiveExpression` is true for `SUM(amount)`, `count(order_id)`, and false for `SUM(a)/SUM(b)`, `AVG(a)`, `COUNT(DISTINCT a)`, `SUM(a) + 1`, `MAX(a)`; an error carrying the PAT is redacted; `connectorCatalog()` marks Snowflake `semantic: true`.
- [ ] **Step 2–4:** red → implement → `node scripts/test-connectorsSnowflake.js && node scripts/test-semanticSnowflake.js && node scripts/test-connectors.js` green.
- [ ] **Step 5: Commit.** `git add src/connectors scripts/test-connectorsSnowflake.ts scripts/test-semanticSnowflake.ts` · "List and describe Snowflake semantic views on the existing connection"

### Task 4: Parity through the doors, and the row-access pin
**Files:** Test `scripts/test-semanticSnowflake.ts` (§ doors: a semantic dataset over a `snowflake`-backend fake connection whose `run` is `decodeSnowflake` → b1's `runFake`), `scripts/test-rowPolicyLive.ts` (only if Task 1 found `TO_BINARY` works)
- [ ] **Step 1: Write the failing test.** b2's `DOOR_CASES` over the Snowflake-encoded fake agree with the extract (`Object.is`); each D16 code is refused with "Snowflake" in the sentence; if `binaryCompare` is to be set: a restricted caller's lock compiles to `TO_BINARY` predicates inside the clause, is answered, and equals the extract under the same lock, with a negative control where the lock is dropped and the figure differs.
- [ ] **Step 2–4:** red → implement (`caps.binaryCompare: true` only with the pin) → `node scripts/test-semanticSnowflake.js && node scripts/test-rowPolicyLive.js` green.
- [ ] **Step 5: Commit.** `git add scripts src/connectors/snowflakeSemantic.ts` · "Hold Snowflake semantic answers to the extract through every door"

### Task 5: The nightly against the real account
**Files:** Create `scripts/warehouseLiveSnowflakeSemantic.ts` · Modify `scripts/test-warehouseLive.ts` (call it after the Snowflake parity), `.github/workflows/warehouse-nightly.yml` (`SNOWFLAKE_SEMANTIC_VIEW` from a secret), `docs/server/live-data.md` ("Semantic views": what the role needs, what is refused, the one-time view script for testing)
- [ ] **Step 1:** The script runs b2's `DOOR_CASES` against the real view and an extract of the same literal rows, `Object.is` per cell (pinned float tolerance only), plus the secret canary; it skips green when `SNOWFLAKE_SEMANTIC_VIEW` is unset, and fails when it is set without the other Snowflake variables.
- [ ] **Step 2:** `node scripts/test-warehouseLive.js` locally without the variables → prints the skip, exits 0. `node scripts/test-serverDocs.js` → `ok` (the variable is a test input, documented with the others under "Testing against a real account", not a server setting).
- [ ] **Step 3: Commit.** `git add scripts .github/workflows/warehouse-nightly.yml docs/server/live-data.md` · "Run the semantic parity matrix nightly against a real Snowflake semantic view"

**Before the PR:** `npm test`, `npm run lint`, `node scripts/test-file-size.js`. Ask the owner to run `scripts/fixtures/snowflake-semantic-view.sql` once and add the secret.
