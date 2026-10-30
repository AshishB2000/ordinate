---
paths:
  - "src/server/**"
  - "src/ipc/**"
  - "src/api/**"
  - "src/app/**"
  - "src/publish/**"
  - "src/automation/**"
---

# Server: requests, auth, storage, secrets

## RPC and contracts

- RPC is `POST /api/rpc/<channel>` (Fastify 5). The body is wire-encoded by `src/server/wire.ts`,
  which tags NaN, ±Inf, -0, undefined, holes, BigInt, Date, Map, Set and Uint8Array. Plain JSON
  silently changes figures.
- **No contract, no channel.** A handler (`src/ipc/*.ts`, registered on `src/ipc/bus.ts`) is
  reachable only if `src/api/` has its contract: a real zod input, the narrowest `access`
  (`read`, `write` or `admin`), and a scope of `project: (input) => id` or `org: true` (neither or
  both fails `tsc`). No contract → 404. Denied → 403 before the handler runs.
- `node scripts/check-contracts.js` runs in `npm test` and must list 0 unresolved.
- `src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only.

## Request context

- `src/server/context.ts` keeps the request in `AsyncLocalStorage`. `ctx()` carries the user, org,
  request id, client, and an abort signal that fires when the client hangs up. Outside a request
  it throws.
- **Every in-memory cache is keyed with `orgKey()`.** Record ids repeat across orgs after an
  import; audits T0.3 and T5.1 found 21 caches leaking across orgs.

## Auth (`src/server/auth/`, chosen by `AUTH_MODE`)

- `password` is **the default**, for trying Ordinate out: its own accounts, scrypt, a first-run
  setup code printed in the log, and temporary passwords an admin sets that must be changed
  (`password.ts`). Startup warns to move to SSO.
- `oidc`: code + PKCE through `openid-client`.
- `header`: `X-Forwarded-Email`, believed only from a TCP peer in `TRUSTED_PROXY_CIDRS`.
- `dev`: everyone is admin, no Postgres. **Explicit only**, for the test harness, and refused when
  `ORDINATE_ENV=prod`.
- Personal API tokens (`ord_…`, stored as sha256) work for the RPC API and `/api/mcp`. Roles,
  grants and audit are in `src/server/authz/`.

## Any pod serves any request

No sticky sessions (R8, `docs/any-pod/`). Before this, more than one replica needed them.

- **Push** is SSE at `GET /api/events?client=<uuid>`, bound to org + user, carried across pods by
  Postgres `LISTEN/NOTIFY` (`src/server/jobs/bus.ts`).
- **Jobs** are a Postgres table claimed with `FOR UPDATE SKIP LOCKED` under a lease
  (`src/server/jobs/`).
- **Files:** `POST /api/files` returns a `fileToken`; an export returns a `downloadToken` for
  `GET /api/files/<token>`. Tokens are single-use Postgres rows (sha256 only, bound to org + user
  + kind). The bytes sit in the org's staging area: the shared `DATA_DIR`, or `orgs/<org>/staging/`
  on S3.

## Headers and CSRF

- CSP is a header (`src/server/headers.ts`): `APP_CSP` outside `/api/`, deny-all under it.
  `script-src 'self'`, no inline script or style.
- CSRF (`src/server/csrf.ts`) compares Origin with Host, so the ingress and the Vite dev proxy
  must preserve Host.

## Publish

- `/p/<publishId>/` (`src/server/published.ts`, pages from `src/publish/`) is for org members only,
  unless the org turns on `public_links`.
- `dashboardExport.sanitizeBundle` is a **security control**: it whitelists labels, numbers,
  strings and `data:image` only.

## Postgres and records

- `pg`, with numbered plain `.sql` files in `src/server/db/migrations/`, applied in one transaction
  under an advisory lock. An edited applied file or an out-of-order number refuses startup.
- **Migrations must be additive:** `helm rollback` does not undo them. CI's `migrations` job fails
  a PR that adds a number another open PR also adds.
- Records go through `src/app/recordFs.ts`: a JSON file without `DATABASE_URL`, a `records` row
  (RLS forced) with it.
- The org's settings document (`src/app/config.ts`: formats, branding, starred, onboarding) is a
  row of `org_config` through `src/server/orgConfig.ts`, never a pod's `config.json`. It is read at
  most once a second per pod, written before the reply is sent, and stored with keys and passwords
  blanked (`config.storable`).

## Secrets (`src/server/secrets/`)

- Envelope encryption under `ORDINATE_MASTER_KEY`, with a data key per org. Connection passwords
  and AI keys go through it, never `config.json`. With no database or no key, saving a secret is
  refused.
- Browser-safe views are `publicConfig()` and `publicByok()` (`src/app/execConfig.ts`): has-key
  flags only.
- Never logged: `REDACT_PATHS` in `src/server/app.ts`, `scrubbed()`, `safeError`. A new secret
  field gets a canary test: plant it, grep every output.
- `npm run secrets:rotate` re-wraps the org data keys (`ORDINATE_MASTER_KEY_OLD` / `_NEW`).

## Desktop import

`npm run import-desktop -- <userData> [--org id]` is a one-time import of a desktop install.

## Automation

- The live surface is HTTP MCP at `POST /api/mcp` (`src/automation/serverMcp.ts`): bearer token,
  runs as its user.
- The CLI (`cli.ts`, `argv.ts`) has had no entry point since T8.1.
- `node scripts/gen-automation-docs.js`, after `build:ts`, regenerates `docs/automation.md`.
