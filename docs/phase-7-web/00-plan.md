# Phase 7 — Ordinate as a self-hosted web app

Ordinate stops being an Electron desktop app and becomes a **web app a company deploys in its own
infrastructure** (Docker Compose, EKS, ECS, GKE, AKS) — the OpenMetadata / Metabase / Superset
model. Users open a URL and sign in with company SSO. The UI is rewritten in **React**.

This file is the plan of record. `01-tasks.md` holds one copy-paste prompt per task for a Claude Code
session. Every session reads this file first.

## 1. What stays, what goes

| Keep (moves unchanged or nearly) | Rewrite | Delete at cutover (T8.1) |
|---|---|---|
| `src/data`, `src/formula`, `src/analysis`, `src/ai`, `src/engine`, `src/connectors` (minus local), `src/publish`, `src/automation` | The UI: `renderer/hub/` (289 files, 81k lines) → `web/` in React | Electron, electron-builder, `preload/`, `renderer/`, `src/windows/`, `src/main.ts` |
| Parquet storage, DuckDB, the resident fast paths and their differential tests | `src/ipc/*` handlers → contract-checked HTTP RPC routes | Screenshot overlay, global hotkey, `desktopCapturer`, OS menus/notifications |
| "The app does the math" — the server computes every figure; React only formats | Storage of metadata: JSON files → Postgres | Local CLI model execution (`src/cli/`) — never safe on a shared server |
| Chart.js 4, MapLibre, pdfmake / pptxgenjs / docx; the published-site renderer (`renderer/publish/` → `src/publish/site/`, T2.9) | Parquet location: local disk → S3 (local disk still works) | Local-folder connectors, folder watch, sync folder + `lock.json` |
| | | Mosaic/vgplot (`plotRender`, vendor bundle), the Svelte spike |

Captures survive as a **source**: "Upload or paste a screenshot" → the existing
`captureDataset:draft` → composer → `composeSave`. Only the OS-level capture goes.

## 2. Locked decisions

Merging this plan is the approval for the dependencies listed here. Anything else still needs a
question first (CLAUDE.md rule).

| Area | Decision |
|---|---|
| Runtime | Node 24, one process per pod, `npm run server` |
| HTTP | **Fastify 5** + `@fastify/cookie`, `@fastify/multipart`, `@fastify/static`, `@fastify/rate-limit` |
| Validation | **zod** — every RPC input is parsed at the boundary |
| Request context | `AsyncLocalStorage` (stdlib) carries `{ user, org, requestId }` — no handler signature changes |
| API shape | RPC: `POST /api/rpc/<channel>`. Channel names stay the current IPC names |
| Push | Server-sent events, `GET /api/events` (no WebSockets) |
| Login | **OIDC** via `openid-client` (Okta, Azure AD, Google, Keycloak) + one bootstrap admin from env |
| Metadata DB | **Postgres** via `pg` (already a dependency); migrations are plain numbered `.sql` files |
| Table storage | Parquet on a `DATA_DIR` volume **or** S3 (`s3://`) through DuckDB `httpfs` — no AWS SDK |
| Secrets | Envelope encryption, master key from `ORDINATE_MASTER_KEY` (Kubernetes secret / KMS-decrypted) |
| Jobs | Postgres `jobs` table claimed with `FOR UPDATE SKIP LOCKED`; cross-pod events via `LISTEN/NOTIFY` |
| Web build | **Vite** + **React 19** + TypeScript `strict` |
| Routing / data | **React Router 7** (library mode) + **TanStack Query 5** |
| UI primitives | **Radix UI** primitives (dialog, menu, popover, tabs, tooltip, select) — styled by us |
| Virtual lists | `@tanstack/react-virtual` |
| Styling | CSS Modules + the existing tokens in `renderer/theme.css` (copied to `web/src/theme.css`). No Tailwind, no component kit |
| Charts / maps | Chart.js 4 and MapLibre used **directly** inside small wrapper components (no `react-chartjs-2`) |
| Web tests | Vitest + `@testing-library/react`; e2e with Playwright (already a devDependency) |
| Lint | oxlint stays the gate, extended to `web/` (TSX, `react` + `react-hooks` plugins) |
| Navigation | URL routes. The in-app tab strip (`tab*.ts`) is **not** ported — browser tabs replace it |

Rejected: Next.js (SSR buys nothing for an authenticated tool and adds a second server), Redux
(TanStack Query owns server state; local state is `useState`/`useReducer`), Tailwind, MUI/Ant
(Ordinate has its own look — see `ui-polish-bar`).

## 3. Target architecture

```
Browser ── web/ (React SPA, served by the same server)
   │  HTTPS: session cookie (httpOnly, SameSite=Lax) + CSRF header
   ▼
Ingress / ALB  (theirs)
   ▼
ordinate pods (N, stateless)
   src/server/   Fastify · auth · rpc · sse · upload/download · static
   src/api/      contracts: channel → { input zod, access, output type }
   src/ipc/*     handlers, registered through the RPC registry instead of ipcMain
   src/data · formula · analysis · ai · connectors · publish · automation   (unchanged core)
   src/engine/   resident layer → per-org DuckDB worker pool (async)
   ▼                                   ▼
Postgres (theirs: RDS / Cloud SQL)   S3 bucket or /data volume (theirs)
 users · orgs · teams · roles ·        <org>/<project>/<id>.parquet
 records · jobs · audit · secrets      <org>/<project>/<id>.source.parquet
```

### Repository layout at the end

```
src/                 server (Node)
  server/            app.ts, rpc.ts, wire.ts, sse.ts, files.ts, auth/, context.ts, static.ts
  api/               contracts, one file per area, plus index.ts (generated)
  ...existing areas
web/                 React app
  src/app/           shell, routes, providers, error boundary
  src/api/           client.ts (typed from src/api), hooks per area
  src/ui/            primitives (Button, Dialog, Menu, DataGrid, EmptyState, Toast, Icon…)
  src/charts/        chart + map + pivot + cohort renderers (ported pure modules + wrappers)
  src/features/<area>/
  e2e/               Playwright specs
deploy/
  Dockerfile, docker-compose.yml, helm/ordinate/
docs/phase-7-web/    this plan, task log, measurements
```

## 4. The RPC contract (the most important seam)

```ts
// src/api/datasets.ts
export const datasets = {
  'datasets:list':   rpc({ access: 'read',  input: z.object({ projectId: Uuid }) }),
  'datasets:delete': rpc({ access: 'write', input: z.object({ id: Uuid }) }),
} as const;
```

- A channel is reachable over HTTP **only** if it has a contract. No contract → 404. This is what
  lets the API grow screen by screen without ever exposing an unchecked handler.
- `access` is `read | write | admin`, checked against the caller's role on the target project (or
  org for `admin`) before the handler runs. Unknown → deny.
- Handlers keep their current bodies. `src/server/rpc.ts` provides an `ipcMain`-shaped registry so
  `register(deps)` in each `src/ipc/*.ts` keeps working; each file swaps one import.
- `event.sender` (15 sites in 10 files) becomes `ctx().client`, whose `.send(channel, payload)`
  writes to that browser tab's SSE stream.
- **Wire codec (`src/server/wire.ts`)**: JSON loses `NaN`, `±Infinity`, `-0`, `undefined` in
  arrays, `Date`, `Map`, `Set`, `Uint8Array`/`Buffer`, `BigInt`. The codec tags them so the client
  gets exactly what structured clone gave the renderer. A differential test runs real handler
  outputs through structured clone and through the codec and compares with `Object.is`. Without
  this, a `NaN` becomes `null` and a figure is silently wrong — a breach of the core principle.
- Files: `POST /api/files` (multipart, streamed to temp, size-capped) returns a `fileToken` that
  import handlers accept instead of a path. Exports return `{ downloadToken }`; the browser fetches
  `GET /api/files/<token>`. The 16 open dialogs and 10 save dialogs become these two flows.
- The web client is typed from the contracts (`web/src/api/client.ts` imports types only from
  `src/api`), so a renamed channel or changed input fails `tsc` in both halves.

## 5. Phases

| Phase | What | Runs in parallel with |
|---|---|---|
| **P0 Foundations** | server skeleton, RPC + codec, request context + paths, files, SSE, web shell, UI kit, e2e harness | — (mostly sequential) |
| **P1 Rendering core** | charts (39 types), pivot/cohort/funnel grids, maps, data grid | P3, P4 |
| **P2 Screen ports** | 14 areas, one session each | each other, P3–P5 |
| **P3 Identity** | OIDC, orgs/teams/roles, sharing, admin, audit, API tokens | P1, P2 |
| **P4 Engine** | async resident layer via the compute pool, per-org DuckDB workers, load test | P1, P2 |
| **P5 Storage** | Postgres records, S3 Parquet, secrets, jobs table, cross-pod events | P2 |
| **P6 Security** | SSRF guard, CSRF/headers/limits, SQL lockdown, threat model, dependency audit | after P3–P5 |
| **P7 Packaging** | Dockerfile, compose, Helm, release workflow, operator docs | after P5 |
| **P8 Cutover** | delete Electron and the legacy UI, rewrite CLAUDE.md/README/CI | last |

Dependency graph (task ids from `01-tasks.md`):

```
T0.1 → T0.2 → T0.3 ─┬→ T0.4 (files) ─┐
                    ├→ T0.5 (sse)  ──┤
                    └→ T0.6 (web shell) → T0.7 (ui kit) → T0.8 (e2e) ─┐
                                                                     ├→ P1 (T1.1–T1.4) → P2 (T2.1–T2.14)
T0.3 → P3 (T3.1→T3.2→T3.3→T3.4)                                       │
T0.3 → P4 (T4.1→T4.2→T4.3)                                            │
T0.3 → P5 (T5.1→T5.2, T5.3, T5.4)                                      │
P3+P4+P5 → P6 (T6.1–T6.3) → P7 (T7.1–T7.3) → P8 (T8.1–T8.2) ←── all of P2
```

### Milestones

- **M1 — "it runs in a browser"** (end of P0 + P1 + T2.1–T2.3): one dev user, local disk, Home,
  Data and Visuals work in Chrome against `npm run server`.
- **M2 — "one team can use it"** (all of P2 + T7.1 + T7.2, P3 header-auth mode): a Docker image a
  single team runs behind `oauth2-proxy`.
- **M3 — "OpenMetadata-class"** (P3–P7): SSO, roles, Postgres + S3, N replicas, Helm chart,
  security review done.
- **M4 — cutover** (P8): the desktop app is gone from the repo.

### Effort

About 45 tasks. A task is one Claude Code session (1–4 hours of agent time) plus your review.
With 3–4 sessions in parallel during P2–P5, **10–14 weeks of calendar time** if reviews keep pace.
The bottleneck is review, not typing: every screen port must meet the UI bar (see §7) and a human
has to look at it.

## 6. Rules for every session (non-negotiable)

1. **Read first:** `CLAUDE.md`, this file, and your task in `01-tasks.md`. If the task contradicts
   CLAUDE.md, this plan wins only where it says so explicitly (Electron removal, React, the
   dependencies in §2, "hosted web version" now in scope).
2. **One task = one worktree = one PR to `develop`.**
   `git worktree add -b <branch> .claude/worktrees/<name> origin/develop` (worktrees must live under
   `.claude/worktrees/` on this machine). Never commit to `develop` directly.
3. **Stay in your lane.** Edit only the directories your task names. Shared files —
   `src/api/index.ts`, `web/src/app/routes.tsx`, `web/src/app/nav.ts`, `.gitignore`,
   `package.json` — are **append-only**; never reorder or reformat them (keeps parallel PRs
   conflict-free).
4. **The app does the math.** React never aggregates, sums, averages or rounds a figure the server
   did not round. It formats. If a screen needs a number the API does not return, add it to the
   server and its differential test.
5. **No contract, no channel.** Expose a handler only by adding its contract with a real zod input
   schema and the narrowest `access` level that works.
6. **Parity checklist.** Every screen PR lists each control, state and empty state of the legacy
   screen (read the legacy `renderer/hub/*.ts` files named in the task) and marks it *ported*,
   *changed (why)* or *dropped (why)*. The desktop app (`npm start` on `develop`) is the reference
   until P8.
7. **Tests:** server logic → `scripts/test-*.ts` self-checks (house style, differential where two
   implementations exist); web → Vitest next to the component; every screen → one Playwright spec
   in `web/e2e/` covering its main flow and **failing on any console error**.
8. **Gates before the PR:** `npm run build:ts`, `npm test`, `npm run lint` (zero findings),
   `npm --prefix web run build`, `npm --prefix web test`, the e2e spec for your area. File size:
   500 soft / 800 hard, applies to `web/` too.
9. **Bulk mechanical edits are scripts** (a Node script in the scratchpad), not hundreds of `Edit`
   calls.
10. **Git:** no `Co-Authored-By` or any AI trailer. No push / PR creation on weekdays 08:00–18:00
    local time (a hook blocks it) — commit locally and push after 18:00. A PR with zero checks is
    not green: read `mergeStateStatus`.
11. **New dependency not in §2 → stop and ask.**
12. **Record decisions with numbers** in `docs/phase-7-web/log.md` (append-only): what was measured,
    what was chosen.

## 7. UI bar for the React port

The port is not a "functional first, pretty later" exercise — rough screens get rejected.

- Use the existing visual language: tokens from `theme.css`, spacing scale, type scale, icon set
  (`renderer/hub/icons.ts` SVGs → `web/src/ui/icons/`). Match the current screen's layout unless the
  task says otherwise.
- Every list, panel and chart has a designed **empty**, **loading** (skeleton, not spinner) and
  **error** state.
- Expanded layouts over small centered boxes; dense tables are fine.
- Keyboard: every action reachable by keyboard, focus visible, dialogs trap focus (Radix gives
  this), command palette (`commandDefs.ts`) ported in T2.14.
- Light and dark themes both checked; the e2e spec takes one screenshot per theme into
  `web/e2e/__screens__/` for review.

## 8. Security split (who owns what)

**The operator** (the company running it): VPC and network reachability, ingress/TLS, IAM for the
pod (S3 access through IRSA), the Postgres and bucket themselves (encryption, backups), patching the
cluster, their IdP and who may sign in, applying our releases.

**We** (the software): authentication and authorization inside the app; tenant isolation (org A
never reads org B's records or files); SSRF protection in every connector that fetches a URL;
DuckDB locked so user SQL cannot read the server's filesystem; secrets encrypted at rest and never
returned to a browser; no secret in a log; CSRF, CSP and security headers; dependency CVEs and
timely patched images; a published `SECURITY.md` with a disclosure address. We also ship
**recommended** network policies (Helm values) — the operator decides whether to apply them.

## 9. Risks and how the plan contains them

| Risk | Containment |
|---|---|
| Wire codec silently changes a number | T0.2 differential test over real handler outputs; `NaN`/`Infinity` cases pinned |
| UI port drifts in quality or loses features | Parity checklist per PR (rule 6); legacy app is the reference until P8 |
| Chatty UI over the network (it was written for instant IPC) | T0.8 counts RPCs per screen in e2e and fails above a budget; batch endpoints where it trips |
| Sync DuckDB blocks the event loop | P4; until then only one dev user, so it is tolerable |
| `allowed_directories` lock is process-wide | P4 per-org workers, each locked to its own org directory at start |
| Parallel PR conflicts | Append-only shared files, one area per session |
| Plan rot | Each task PR ticks its box in `01-tasks.md` and appends to `log.md` |
