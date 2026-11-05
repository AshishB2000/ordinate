# Semantic layer part 7, step e1: Cube — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A company running Cube adds it under Connections, sees its cubes and views, adds one as a dataset, and every chart and KPI on it is Cube's own figure, asked over Cube's REST API with values as JSON, through the SSRF guard, its token a connection secret; a Cube server in a CI container re-checks the whole matrix nightly.
**Architecture:** A new registry entry `src/connectors/cube.ts` (family `cube`, in a new **Semantic layers** picker group) with the `semantic` capability: listing and describing from Cube's metadata endpoint, `run` a JSON POST through `httpShared.httpRequest` with polling while Cube says to wait. `listTables` lists models; `run` (the copy path) refuses. The encoder `src/engine/live/semantic/cube.ts` turns b1's `SemanticQuery` into Cube's query object. A test-only decoder of that object lets the fake layer answer it per PR. Built before dbt (owner: no dbt Cloud account yet).
**Tech Stack:** `src/connectors`, `src/engine/live/semantic`, `node:crypto` (HS256), self-checks, `.github/workflows/warehouse-nightly.yml`.
**Spec:** docs/semantic-layer/07-portability.md (D14, D15, D16; Owner's answers 3; Tests "Real engines, nightly", "Refusals and guards") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-e1-cube` off `origin/develop` after c1 merges (shared files: `adapters.ts`, `connectors/index.ts`). One PR. Release 2.

## Everything Cube-specific is (to verify) until Task 1 says otherwise

Not facts: the endpoints (`/cubejs-api/v1/meta`, `/cubejs-api/v1/load`), the "Continue wait" reply and how to poll it, the query object's keys (`measures`, `dimensions`, `timeDimensions` with `granularity`, `filters` with `member`/`operator`/`values`, `order`, `limit`) and the operator names, whether `values` are strings only, how a null is filtered (`set`/`notSet`, `or` groups), Cube's default row limit, the measure types that add up, the time granularities and week start, the auth header and whether a token is an HS256 JWT signed with the API secret, and the image to pin. Task 1 settles each against a Cube container and records them.

## Global Constraints

- **Fields:** `url` (the deployment's base URL, https; http only to a host `SSRF_ALLOW` admits), `auth` select `token` (a token the deployment accepts, sent as is) or `secret` (the API secret: a JWT is signed per request with `node:crypto`, `iat` now, `exp` +5 minutes), and `token` (`secret: true`, stored as `connection.token` through `src/ipc/connectionSecrets.ts`; no new secret kind). Replies carry `secretSet` flags only.
- **Every socket through the SSRF guard** (`httpRequest` checks and pins each request, `src/connectors/httpShared.ts:52`, and never follows a redirect). A self-hosted Cube on a private address needs `SSRF_ALLOW`; `docs/server/live-data.md` says so (the variable is already in `docs/server/configuration.md`).
- **Values are JSON, never code.** Every filter value goes into `values` as JSON (strings, if Task 1 confirms). A filter Cube cannot express (a null inside an `in` list, if `or` groups are not available) is refused `layerFilter`, never approximated.
- **Always an explicit `limit`** (Cube applies a default, to verify): text ranks 51, other questions `LIVE_ROW_LIMIT + 1`, and a full answer is refused `tooManyGroups` as Live SQL is.
- **Additive** only for measure types Task 1 lists as a plain sum or count (`sum`, `count`, never `countDistinct`, `avg`, `min`, `max` or `number`).
- **Grains:** a time dimension offers the granularities Task 1 confirms that map to `DateGrain` (`day`, `week` only if Cube's week starts where `categoryKey`'s does, `month`, `quarter`, `year`).
- **Polling** while Cube says to wait, under `LIVE_QUERY_TIMEOUT_MS` and the caller's signal (the socket is destroyed on abort; "at least we stop polling", D18). Each `run` is one counted statement however many polls it takes.
- `caps`: `lookups` as Task 1 finds (a dimension-only query), `binaryCompare: false` (D17: restricted callers refused).
- **New picker group** `'Semantic layers'`: the `category` union (`src/connectors/types.ts:202`), `CATEGORY_ORDER` (`src/connectors/index.ts:39`), and `scripts/test-connectors.ts`'s family and category sets (`:36`). A logo only if `assets/connectors/SOURCES.md` can name a licence for it; otherwise `ConnLogo`'s fallback.
- **Golden requests** `scripts/fixtures/golden/semantic-cube.json`, the same `SHAPES` as c1, recorded once, never re-recorded.
- No dependency (no Cube client, no JWT library), no migration.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Token canary.** The token, a signed JWT and the API secret appear in no reply, error, log line or connection listing. Task 3.
- **Private Cube.** A `10.x` URL is refused without `SSRF_ALLOW`, answered with it; a redirect to a private address is never followed. Task 3.
- **Null in a filter list** is either expressed exactly (`or` with `notSet`) or refused; never dropped. Task 2.

---

### Task 1: Spike against a Cube container (no product code)
**Files:** Create `scripts/fixtures/cube/` (a model over the live-parity fixture's table in a Postgres the container reads, and a `docker compose` file for local runs), `docs/live-data/cube.md` (the findings)
- [ ] **Step 1:** Start Cube (latest stable image, then pin it by version and digest) against Postgres seeded with the fixture; ask each "(to verify)" item with `curl` and paste request and reply into the doc.
- [ ] **Step 2:** Decide in the doc: operators per `SemanticFilter` kind, null handling, the granularity map and week start, additive types, the poll rule, the auth header, the image pin.
- [ ] **Step 3: Commit.** `git add scripts/fixtures/cube docs/live-data/cube.md` · "Record what Cube's REST API accepts, before the connector"

### Task 2: The encoder, its golden and the fake that answers it
**Files:** Create `src/engine/live/semantic/cube.ts`, `scripts/semanticFakeCube.ts` (test-only `decodeCube(body): SemanticQuery`, and replies shaped as Cube's `data`), `scripts/test-semanticCube.ts` · Modify `src/engine/live/semantic/adapters.ts` (register `cube`)
**Interfaces:** Produces `cubeAdapter: SemanticAdapter`; `encode(q, model)` → `{ kind: 'semantic', body: { query: CubeQuery }, columns }`, member names `<model>.<name>`.
- [ ] **Step 1: Write the failing test.** For each `SHAPES` entry: `decodeCube(encode(q).body)` deep-equals `q`; every value sits in a `values` array, never in a member name; the golden matches; a null inside an `in` list encodes as Task 1 decided or refuses `layerFilter` (negative control: an encoder that drops the null fails the round trip).
- [ ] **Step 2–4:** red → implement, record the golden once → `npm run build:ts && node scripts/test-semanticCube.js` green.
- [ ] **Step 5: Commit.** `git add src/engine/live/semantic scripts/semanticFakeCube.ts scripts/test-semanticCube.ts scripts/fixtures/golden/semantic-cube.json` · "Encode semantic questions as Cube queries, values as JSON"

### Task 3: The connector
**Files:** Create `src/connectors/cube.ts` · Modify `src/connectors/index.ts:25-39` (`'./cube'`, the category), `src/connectors/types.ts:202`, `src/connectors/jwt.ts` (`signJwtHs256(claims, secret)`, ≤ 10 lines), `scripts/test-connectors.ts:36`, `scripts/test-secrets.ts` (the canary), `scripts/test-ssrf.ts` (§ cube) · Test `scripts/test-connectorsCube.ts` (a stub HTTP server, as `scripts/test-connectorsHttp.ts` uses)
**Interfaces:** Produces `CONNECTORS: ConnectorDef[]` with one `cube` entry: `fields` as above, `listTables` (models), `run` → `{ ok: false, error: 'A semantic layer has no rows to copy. Add it as a Live dataset.' }`, `semantic: { backend: 'cube', caps, listModels, describeModel, run }`.
- [ ] **Step 1: Write the failing test.**
```ts
ok('meta → models', isDeepStrictEqual((await cube.semantic!.listModels(ctx)).models.map((m) => m.name), ['orders', 'orders_view']));
ok('describe: dimensions typed, measures with additive', describeOf('orders').metrics.find((m) => m.name === 'revenue')!.additive === true && describeOf('orders').metrics.find((m) => m.name === 'avg_amount')!.additive === false);
ok('a load that says "Continue wait" is polled until it answers', (await runAgainst(stubWaitTwice)).ok && stub.loads === 3);
ok('the signal stops the polling and destroys the socket', (await runAbortedAfterFirstWait()).error === 'Cancelled' && stub.openSockets === 0);
ok('secret auth: a fresh HS256 JWT per request, valid for 5 minutes', jwtOf(stub.lastAuth).header.alg === 'HS256' && jwtOf(stub.lastAuth).payload.exp - jwtOf(stub.lastAuth).payload.iat === 300);
ok('run (copy) refuses', !(await cube.run(ctx, 'select 1')).ok);
ok('SSRF: a private URL is refused without SSRF_ALLOW', /not allowed/i.test((await listWith('http://10.0.0.5:4000')).error));
ok('NEGATIVE CONTROL: with SSRF_ALLOW=10.0.0.0/8 it is asked', (await withAllow('10.0.0.0/8', () => listWith('http://10.0.0.5:4000'))).ok);
ok('a redirect is never followed', stub.redirectFollowed === false);
// test-secrets: plant the token and the API secret; grep connections:list, every error, the log
```
- [ ] **Step 2–4:** red → implement → `node scripts/test-connectorsCube.js && node scripts/test-connectors.js && node scripts/test-secrets.js && node scripts/test-ssrf.js` green.
- [ ] **Step 5: Commit.** `git add src/connectors scripts/test-connectors*.ts scripts/test-secrets.ts scripts/test-ssrf.ts` · "Add Cube as a semantic-layer connection, its token a connection secret"

### Task 4: Parity through the doors
**Files:** Test `scripts/test-semanticCube.ts` (§ doors: a semantic dataset over a Cube connection whose transport is the fake)
- [ ] **Step 1: Write the failing test.** b2's `DOOR_CASES` agree with the extract under `Object.is`; each D16 code is refused with "Cube" in the sentence; a restricted caller is refused `layerRowPolicy` (negative control: unrestricted answers).
- [ ] **Step 2–4:** red → fix → green with `node scripts/test-semanticCube.js && node scripts/test-rowPolicyLive.js`.
- [ ] **Step 5: Commit.** `git add scripts/test-semanticCube.ts` · "Hold Cube answers to the extract through every door"

### Task 5: The nightly container
**Files:** Create `scripts/test-semanticCubeLive.ts` · Modify `.github/workflows/warehouse-nightly.yml` (a `cube` job beside `clickhouse`: Postgres and the pinned Cube image as services, the fixture model mounted, no secret), `docs/server/live-data.md` ("Cube": fields, auth, `SSRF_ALLOW` for a private deployment, what is refused)
- [ ] **Step 1:** The script runs b2's `DOOR_CASES` against the real Cube (`CUBE_URL`, `CUBE_API_SECRET` from the job's env) and the extract; it skips green without `CUBE_URL`.
- [ ] **Step 2:** Locally: `docker compose -f scripts/fixtures/cube/compose.yml up -d`, then `node scripts/test-semanticCubeLive.js` → green; without it → the skip line, exit 0. `node scripts/test-serverDocs.js` → `ok`.
- [ ] **Step 3: Commit.** `git add scripts .github/workflows/warehouse-nightly.yml docs/server/live-data.md` · "Run the semantic parity matrix nightly against Cube in a container"

**Before the PR:** `npm test`, `npm run test:web` (the picker group renders), `npm run lint`, `node scripts/check-contracts.js`.
