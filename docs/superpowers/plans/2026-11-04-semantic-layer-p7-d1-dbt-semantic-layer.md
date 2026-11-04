# Semantic layer part 7, step d1: the dbt Semantic Layer, labelled beta — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A company on dbt Cloud adds its Semantic Layer under Connections (marked beta), adds a dataset from it, and charts and KPIs on it are dbt's own figures, asked over dbt's GraphQL API with plain JSON POSTs; because dbt's filters are template text, every filter value is written by a closed literal encoder that refuses anything it cannot write exactly, proved by a fuzz suite.
**Architecture:** A new registry entry `src/connectors/dbt.ts` (family `dbt`, group **Semantic layers**) with the `semantic` capability: GraphQL documents as fixed strings, variables as JSON, a create-then-poll query cycle through `httpShared.httpRequest`. The encoder `src/engine/live/semantic/dbt.ts` turns b1's `SemanticQuery` into the request, its `where` text built only through `src/engine/live/semantic/literals.ts`. There is no dbt Cloud account yet (owner), so every reply in the tests is a fixture written from dbt's published API reference, marked so, and the label says beta until a real account runs the nightly.
**Tech Stack:** `src/connectors`, `src/engine/live/semantic`, self-checks.
**Spec:** docs/semantic-layer/07-portability.md (D14, D15 "dbt", D16, D18; Owner's answers 3; Tests "The dbt literal encoder") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-d1-dbt-semantic-layer` off `origin/develop` after e1 merges. One PR. Release 2, **beta**.

## Everything dbt-specific is (to verify), and stays so until an account exists

Not facts, and the code says so in a comment at each use: the GraphQL host per region; the auth header for a service token; the `environmentId` argument; the queries and mutations for listing metrics and dimensions, creating a query and polling it; the result encoding (JSON vs Arrow) and its field; status names; whether a query can be cancelled; the `where` filter shape (`{{ Dimension('entity__name') }}` text); `orderBy` and `limit`; time granularities; how a metric's type and aggregation are reported; saved queries; dimension-value lookups. Task 1 writes them down from dbt's documentation with links and dates, and every fixture is built from that page, never invented.

## Global Constraints

- **What a dataset is (left to the builder; my call):** a dbt **saved query** when the API lists them (its metrics and group-by dimensions are the dataset); if Task 1 finds no saved-query listing, a dataset is **one semantic model's metrics and its own dimensions**. Task 1 records which; the other is not built.
- **Fields:** `host` (a select of the regional hosts Task 1 lists; `ConnectorDef.hosts` allowlists them so the request code refuses any other host, `src/connectors/types.ts`'s `hosts` rule), `environmentId` (digits only), `token` (`secret: true`, the `token` slot, no new secret kind). Label "dbt Semantic Layer (beta)", blurb "Beta: not yet checked against a live dbt Cloud account."
- **The literal encoder** (`literals.ts`, shared with c1 if c1 needed it), the only way a value reaches template text:
  - numbers: finite, written by `String(n)` only when it matches `^-?\d+(\.\d+)?$` (no exponent, no `NaN`/`Infinity`), else refused;
  - dates and timestamps: `^\d{4}-\d{2}-\d{2}$` or the ISO instant form the fixture uses, quoted;
  - booleans: `TRUE` / `FALSE`; `null` only through `IS NULL` / `IS NOT NULL`;
  - text: 1–200 characters, each in `[\p{L}\p{M}\p{N} _.,:;/&()#@+%-]` or `'` (written doubled), quoted with `'`. Refused: `{`, `}`, `\`, `"`, NUL, any control, format or line-break character, every quote look-alike (U+2018, U+2019, U+02BC, U+FF07 are outside the class), and anything longer.
  - identifiers inside `Dimension('…')`: only names from the dataset's synced list matching `^[a-z_][a-z0-9_]*(__[a-z0-9_]+)*$`.
  - A refusal is `layerFilter` with the column's name, never a dropped filter.
- **Polling** under `LIVE_QUERY_TIMEOUT_MS` and the caller's signal; on abort, cancel if Task 1 found a cancel, and in every case stop polling (D18). One counted statement per question.
- **Additive** only for a simple metric whose one measure aggregates `sum` or `count`; ratio, derived, cumulative, conversion, `count_distinct` and anything unknown are `additive: false`.
- `caps`: `lookups` only if a dimension-values query exists (Task 1); `binaryCompare: false` (D17).
- **Golden requests** `scripts/fixtures/golden/semantic-dbt.json` (c1's `SHAPES`), recorded once, never re-recorded.
- **Nightly**: the job reads `DBT_SL_HOST`, `DBT_SL_ENVIRONMENT_ID`, `DBT_SL_TOKEN` and skips green without them; the beta label comes off in the PR that first sees it pass (the owner's call).
- No GraphQL client, no Arrow reader: if Task 1 finds results only as Arrow, stop and ask the owner (it would be a dependency). No migration.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **No raw value in template text.** The fuzz suite, plus the negative control proving a raw value would have broken out of the template. Task 2.
- **Only allowlisted hosts.** A `host` outside the list is refused before a socket opens. Task 3.
- **Beta means beta.** The picker label, the doc and the CHANGELOG say so. Task 4.

---

### Task 1: Write down the API from dbt's documentation (no product code)
**Files:** Create `docs/live-data/dbt-semantic-layer.md` (each "(to verify)" item: the documented request and reply, the page and the date read), `scripts/fixtures/dbt-sl/` (reply fixtures copied from those documented examples, one file per call)
- [ ] **Step 1:** Read dbt's Semantic Layer GraphQL reference; record each item with its link.
- [ ] **Step 2:** Decide in the doc: what a dataset is (saved query or semantic model), the result format, the poll rule, the cancel, the where grammar, the granularities, how additivity is read. If results are Arrow only, stop and ask the owner.
- [ ] **Step 3: Commit.** `git add docs/live-data/dbt-semantic-layer.md scripts/fixtures/dbt-sl` · "Record the dbt Semantic Layer API as documented, before the connector"

### Task 2: The literal encoder and its fuzz suite
**Files:** Create `src/engine/live/semantic/literals.ts` (unless c1 created it: then extend), `scripts/test-semanticLiterals.ts`
**Interfaces:** Produces `literal(value: Cell, type: ColumnType): { ok: true; text: string } | { ok: false }`; `dimensionRef(name: string, synced: ReadonlySet<string>): string | null`; `whereText(f: SemanticFilter, synced): { ok: true; text: string } | LiveRefusal`.
- [ ] **Step 1: Write the failing test.**
```ts
for (const v of ["O'Brien", 'Zürich', 'São Paulo', '50% off', 'a/b (c)', '東京']) ok(`encoded exactly: ${v}`, unquote(literal(v, 'text').text) === v);
for (const v of ['{{ x }}', '{% if %}', 'a}b', 'back\\slash', 'nul\u0000', 'line\nbreak', 'tab\t', '’quote', '＇', 'say "hi"', 'x'.repeat(201), '']) ok(`refused: ${JSON.stringify(v)}`, !literal(v, 'text').ok);
for (const n of [0, -0, 12, -3.5, 1e21, NaN, Infinity, 1e-7]) ok(`number ${n}`, literal(n, 'number').ok === /^-?\d+(\.\d+)?$/.test(String(n)));
ok('a date is a quoted ISO day; a non-date is refused', literal('2024-03-01', 'date').text === "'2024-03-01'" && !literal('2024-3-1', 'date').ok);
// fuzz: 20,000 seeded random strings over printable ASCII, the refused set and Unicode punctuation;
// each is either refused, or parseTemplate(whereText(eq(col, s))) yields exactly one predicate whose value === s
ok('fuzz: every string is encoded exactly or refused', fuzz(20_000).every((r) => r.refused || r.roundTrips));
ok('NEGATIVE CONTROL: a raw inliner breaks out of the template', parseTemplate(rawWhere("x' OR 1=1 --")).predicates.length > 1);
ok('a dimension outside the synced list is refused', dimensionRef('orders__region', new Set(['orders__status'])) === null);
```
- [ ] **Step 2–4:** red → implement → `npm run build:ts && node scripts/test-semanticLiterals.js` green.
- [ ] **Step 5: Commit.** `git add src/engine/live/semantic/literals.ts scripts/test-semanticLiterals.ts` · "Write filter values into dbt's template text only through a closed encoder"

### Task 3: The encoder, the connector, and parity on fixtures
**Files:** Create `src/engine/live/semantic/dbt.ts`, `src/connectors/dbt.ts`, `scripts/semanticFakeDbt.ts` (test-only: `decodeDbt(body): SemanticQuery`, parsing our own where grammar, and fixture-shaped replies), `scripts/test-semanticDbt.ts`, `scripts/test-connectorsDbt.ts` · Modify `src/connectors/index.ts` (`'./dbt'`), `src/engine/live/semantic/adapters.ts`, `scripts/test-connectors.ts:36`, `scripts/test-secrets.ts`, `scripts/test-ssrf.ts`
**Interfaces:** Produces `dbtAdapter: SemanticAdapter`; the `dbt` `ConnectorDef` (`listTables` lists datasets as Task 1 decided, `run` refuses as Cube's does, `semantic: { backend: 'dbt', caps, listModels, describeModel, run }`).
- [ ] **Step 1: Write the failing test.** For each `SHAPES` entry, `decodeDbt(encode(q).body)` deep-equals `q` and the golden matches; off the documented fixtures, listing, describing (`additive` per the rule) and a create-then-poll cycle answer, and an aborted poll stops with `Cancelled` and no further request; a `host` off the list is refused before any socket; the token canary finds nothing in any reply, error or log; b2's `DOOR_CASES` over the dbt-encoded fake agree with the extract under `Object.is`; each D16 code names "dbt"; a filter value the encoder refuses gives `layerFilter`, never a wider figure (negative control: the same chart without that filter answers).
- [ ] **Step 2–4:** red → implement, golden once → `node scripts/test-semanticDbt.js && node scripts/test-connectorsDbt.js && node scripts/test-connectors.js && node scripts/test-secrets.js && node scripts/test-ssrf.js` green.
- [ ] **Step 5: Commit.** `git add src scripts` · "Add the dbt Semantic Layer as a beta semantic-layer connection"

### Task 4: Beta, documented, and a nightly that waits for an account
**Files:** Create `scripts/test-semanticDbtLive.ts` · Modify `.github/workflows/warehouse-nightly.yml` (a step with the three secrets, skipping without them), `docs/server/live-data.md` ("dbt Semantic Layer (beta)": fields, the service token's permissions as documented, what a dataset is, what is refused, why it is beta), `CHANGELOG.md`
- [ ] **Step 1:** `node scripts/test-semanticDbtLive.js` without the variables → the skip line, exit 0; with only some → fails. `node scripts/test-serverDocs.js` → `ok`.
- [ ] **Step 2: Commit.** `git add scripts .github/workflows/warehouse-nightly.yml docs/server/live-data.md CHANGELOG.md` · "Mark dbt beta until a real account runs the nightly"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`, `node scripts/check-contracts.js`.
