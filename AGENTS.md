# Ordinate

Ordinate is a self-hosted, open-source (MIT) BI web app. A company runs it in its own
infrastructure (Docker Compose, Helm, ECS); people open a URL and sign in with the company's IdP.
Data comes in from files, paste, Excel, SQL/HTTP/SaaS connectors, a URL or a screenshot, is
**prepared** by a reversible pipeline, **visualized** as charts, maps and tables, and published as
**dashboards** shared at a URL. AI is optional and model-agnostic.

This is the agent guide for the whole repo (`CLAUDE.md` imports it). The detail for each area is
in `.claude/rules/`, listed under [Area guides](#area-guides).

## Core principle: engines do the math, never a model

- For a copied (**extract**) dataset the engine is ours: server code and DuckDB over our Parquet.
- For a **Live** dataset it is the source warehouse, running SQL the app compiled from a validated
  spec. A parity test proves that SQL and our engine agree on the same rows.
- React only formats what the server returns. It never sums, averages or rounds a figure the
  server did not.
- A model only extracts structure (a table from a screenshot) or narrates figures an engine
  computed. It never writes a computed number.
- A screen that needs a number the API lacks gets it added on the server, with a differential test.

## Commands

```bash
npm run server        # build:ts, then the server on 127.0.0.1:8080 (./data), serving web/dist.
                      # Needs DATABASE_URL (password sign-in, the default) or AUTH_MODE=dev
npm run dev:web       # Vite dev server, /api proxied to 127.0.0.1:8080
npm run build:ts      # tsc: writes the gitignored .js next to each .ts
npm run build:web     # web/dist (tsc + vite build)
npm test              # every server self-check suite, in parallel
node scripts/test-<name>.js         # one suite, after build:ts
npm run test:web      # Vitest
npm --prefix web run e2e            # Playwright e2e against the built server
npm --prefix web run size           # initial JS must stay ≤ 300 KB gzip
npm run lint          # oxlint: zero findings, blocking in CI
npm run loadtest      # 20 virtual users × 5 iterations over real HTTP, 1M rows
```

`npm start` is the same entry point; `prestart` and `pretest` compile automatically. `postinstall`
builds and fetches only missing map GeoJSON (the committed `assets/geo` is what ships).

## Shipping a change

The exact commands are in the `feature-branch-workflow` skill. Review with `ordinate-review`.

- **One worktree per change, off `develop`:**
  `git worktree add -b feat/x .claude/worktrees/x origin/develop`, then a PR to `develop`, CI
  green, merge, remove the worktree, and `git pull` on `develop`.
- **Never commit to `develop`** (its ruleset refuses a direct push). **Never `git checkout` or
  `git switch` in the shared clone**: it moves the tree under other running sessions, which has
  already cost work.
- **Never add a `Co-Authored-By` line** or any AI co-author trailer to a commit.
- **No release without the owner:** no `v*` tag, GitHub release or manual image push unless asked.
- **Resolve conflicts keeping both sides, then re-check the merged tree.** One-sided merges lost
  routes and log entries (#193, #227), and commits pushed after a merge lost fixes (#235).
- **Required checks on `develop`:** `smoke (all shards)` and `oxlint (blocking)`. A PR with no
  checks at all is not passing: it has a stale `branches:` filter or a merge conflict, so read
  `mergeStateStatus`. Checks that fail in seconds with no steps are GitHub billing, not code.

## Rules that must not be broken

**Correct figures**
- **Parse strictly** (`src/data/parse.ts`): `007`, ZIP codes and ids over 15 digits stay text. Cast
  only on a column's **declared** type, never by inference.
- **Two implementations must agree.** Every fast SQL path keeps its pure-JS reference and a
  differential test using `Object.is`. Change one, then change or re-verify the other.
- **A Live dataset has no rows on our side:** `getDataset` throws `LiveDatasetError`. Never catch
  it into `[]` or `null`. A new row-reading channel joins `scripts/test-liveSafetyNet.ts`. A new
  figure path goes through `vizDataFor`, `computeCardMetric` or `computeCard`.

**Isolation and security**
- **No contract, no channel.** Every RPC handler needs a contract in `src/api/` with a real zod
  input, the narrowest `access` and a `project` or `org` scope. `src/api/index.ts`,
  `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only.
- **Key every in-memory cache with `orgKey()`.** Record ids repeat across orgs after an import.
- **Row access rules hold on every reader.** A reader that returns rows, labels or figures takes the
  row lock (`withLockOf`, `src/ipc/rowDoors.ts`). Classify each new `read` contract in
  `scripts/rowPolicyReaders.ts` (`test-rowPolicySafetyNet`). Design: `docs/row-policy/`.
- **Validate ids before building a path.** Record ids match `UUID_RE`, org ids match `ORG_RE`
  (`src/app/paths.ts`). GeoJSON is served by exact name from a whitelist. Writes are atomic (temp
  file then rename, or one upsert in Postgres). A corrupt record is skipped, never fatal.
- **Secrets never reach a log or a browser** (`REDACT_PATHS` in `src/server/app.ts`, `scrubbed()`,
  `safeError`). They live in the secrets store, never `config.json`, and replies carry has-key
  flags only. A new secret field gets a canary test: plant it, grep every output.
- **No dataset origin reaches a browser:** no file path, keyed URL or SQL text.
- **Input never becomes code.** No `eval` or `new Function` (lint-enforced). A child process takes
  an args array, never `shell: true`, and is never built from a user, model or config string. User
  SQL passes the gate in `compile()`. User regex runs in the regex worker.
- **Every outbound socket goes through the SSRF guard** (`src/connectors/ssrf.ts`).
- **CSP forbids inline script and style.** `dashboardExport.sanitizeBundle` is a security control.

**Runtime**
- **Never block the event loop.** Request paths use `queryAsync`/`execAsync`, never the sync
  DuckDB calls (`test-asyncReach` checks).
- **Never `terminate()` a DuckDB worker** or exit the process around one. Close it through its
  own queue.
- **Any pod serves any request.** Nothing a later request needs lives in one pod's memory or disk.
- **Migrations are additive** (`helm rollback` does not undo them). Never edit an applied one.

**Code**
- **Ask before adding a runtime dependency.** Prefer the standard library, the platform, or
  something already installed.
- **No telemetry and no surprise network calls.** Nothing installs at run time.
- **File size:** 500 lines soft, 800 hard. See `.claude/rules/file-size.md`.

## Architecture

Stateless pods (`src/server/main.ts`, port 8080) behind the operator's ingress serve the React SPA
(`web/dist`) and the API from one origin. Metadata is in Postgres. Parquet is on `DATA_DIR` or
`s3://` (through DuckDB `httpfs`) under `orgs/<org>/<project>/`.

| Area | Where |
|---|---|
| RPC `POST /api/rpc/<channel>`: contracts, handlers, wire encoding | `src/api/`, `src/ipc/`, `src/server/wire.ts` |
| Request context (`ctx()`, `orgKey()`), auth, push, jobs, secrets, migrations, org settings | `src/server/` |
| Published dashboards `/p/<id>/` | `src/server/published.ts`, `src/publish/` |
| DuckDB (one worker per org) and queries over stored Parquet | `src/engine/` |
| Live datasets | `src/engine/live/`, `src/ipc/liveRoute.ts`, `web/src/features/live/` |
| Connectors (a registry of read-only sources) | `src/connectors/` |
| Parsing, prepare steps, formulas | `src/data/parse.ts`, `src/data/transforms.ts`, `src/formula/` |
| Visuals and dashboards | `src/analysis/` (`vizData.ts` is the bridge to charts) |
| AI (optional) | `src/ai/`, `src/server/aiConfig.ts` |
| MCP for agents, `POST /api/mcp` | `src/automation/serverMcp.ts` |

**A dataset** is a metadata record + `<id>.parquet` + `<id>.source.parquet` (the immutable prepare
source), capped at 1,000,000 rows. Columns are stored VARCHAR with Ordinate's own `ColumnType` in
the record, because a typed column turns `007` into `7`. On S3 the record upsert is the atomic
switch.

## Area guides

Read a guide before changing files in its area. Claude Code loads it when it opens a matching file.

| Guide | Covers | Loads for |
|---|---|---|
| `.claude/rules/server.md` | RPC and contracts, request context, auth, push, jobs, files, publish, Postgres, records, secrets, MCP | `src/server`, `src/ipc`, `src/api`, `src/app`, `src/publish`, `src/automation` |
| `.claude/rules/engine.md` | DuckDB workers, user SQL and regex, the resident-query layer and its SQL rules | `src/engine` |
| `.claude/rules/live-data.md` | Live datasets: schema, compile, executor, doors, budget, web gating | `src/engine/live`, `src/ipc`, live files in `src/data`, `src/connectors`, `web` |
| `.claude/rules/workspace.md` | Connectors, captures, prepare, formulas, visuals, dashboards, AI | `src/data`, `src/connectors`, `src/formula`, `src/analysis`, `src/ai` |
| `.claude/rules/web.md` | The React app: stack, states, charts, maps, CSP, size budget, e2e | `web` |
| `.claude/rules/deploy.md` | Image, Compose, Helm, CI jobs, edge and release images | `deploy`, `.github/workflows` |
| `.claude/rules/file-size.md` | The 500/800-line rule and its allowlist | always |

## Conventions

- **TypeScript with in-place sibling emit.** New files are `.ts`. `npm run build:ts` (tsc; Vite is
  only for `web/`) writes the gitignored `.js` beside each one. `strict` everywhere except
  `tsconfig.site.json` (`src/publish/site/**`, a named `.oxlintrc.json` override). No `any`
  without a comment.
- **Lint is a gate.** `npm run lint` (type-aware oxlint over `src`, `scripts`, `web/src`,
  `web/e2e`) must report zero findings. Not `typescript-eslint` (it refuses TS 7). Prettier is advisory.
- **Server sentences go through the catalog:** `t('key', { params })` in `MAIN_FILES`
  (`scripts/i18n-extract.ts`). Write the English literal, then run `node scripts/i18n-extract.js`
  after `build:ts`: it regenerates `src/i18n/en.json` and adds `null` drafts to es/de/fr/ja. Never
  hand-edit `en.json`; after a rebase, take develop's and rerun. Format figures before `t()`.
  `test-i18n` fails on a hard-coded string, a missing or unused key, or a dropped `{param}`. The
  React UI is English-only.
- **Every env var is documented** in `docs/server/configuration.md`; `test-serverDocs` enforces it.
- **Skills:** `.claude/skills/` is for developing Ordinate. `plugins/ordinate/` is the product
  plugin for agents using an Ordinate server over MCP (`.claude-plugin/marketplace.json`). Change a
  plugin skill with the tool it describes; `test-pluginSkills` builds its examples against the
  sample project.

## Testing

- **Self-check files, no framework.** `npm test` is `node --test "scripts/test-*.js"`, so a new
  `scripts/test-<name>.ts` needs no wiring. Suites report through `scripts/selfcheck.ts` (`ok`,
  `failureCount`, `finish`) and end on `finish()`, never a bare `process.exit(0)`: `finish()`
  closes every DuckDB worker first (`test-selfcheckExit`).
- **Gate runs:** no `DATABASE_URL`, with one, and the CI env (password Postgres + MinIO). A
  scratch-DB `pg` Pool needs an `'error'` listener (57P01 at teardown).
- **Differential tests are the house style.** Two implementations means asserting they agree with
  `Object.is`, not against hand-written values. Several spy on `datasets.getDataset` to prove the
  table was never hydrated.
- **Golden fixtures** (`scripts/fixtures/golden/`, `web/src/**/__golden__/`, wire-encoded) stand in
  for a deleted reference (the desktop renderer). Never re-record one to make a test pass.
- **Every guard ships a negative control:** a test proving the guard fails when it should.

## Docs and history

History lives in `docs/`, not here; the index is `docs/README.md`. Re-litigate a decision with
numbers, not opinion.

- `docs/phase-7-web/`: the move to the web, with the plan, a task log of every measurement, the
  threat model and the retro. Older `docs/phase-*/` folders are desktop-era history.
- Design docs: `docs/live-data/`, `docs/any-pod/`, `docs/row-policy/`, `docs/ai-models/`,
  `docs/analysis/00-model.md`. Operator docs: `docs/server/`.

## Out of scope (don't build unprompted)

- deck.gl: `@loaders.gl` fetches workers from unpkg.com.
- Apache Arrow: not achievable with the current binding.
- Any desktop shell: Electron is deleted, and Tauri was costed and closed (`docs/phase-6/`).
- MapLibre v5/v6 without re-checking its CSP worker.
- Next.js/SSR, Redux, Tailwind, MUI or Ant (rejected in `docs/phase-7-web/00-plan.md` §2).
- A marketing site, spreadsheet export, or a memory/summarization step (`memoryModel` exists,
  but nothing consumes it).

A hosted web version is in scope: it is the product.
