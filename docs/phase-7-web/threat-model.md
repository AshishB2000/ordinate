# Threat model — Ordinate server (Phase 7)

The self-hosted web server (`src/server/`, the contracted handlers in `src/ipc/`, the React app in
`web/`). Written in T6.3 after P3–P5 and T6.1–T6.2 landed; every mitigation names the self-check
(`scripts/test-*.ts`, run by `npm test`) or e2e spec (`web/e2e/*.e2e.ts`) that fails if it breaks.
Re-verify a row by running that file: `npm run build:ts && node scripts/<name>.js`.

The desktop app (one local user, no network listener except the loopback MCP transport) is out of
scope here; it is deleted at cutover (T8.1). The operator/software split is plan §8.

## 1. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Tables (customer data) | Parquet: `DATA_DIR/orgs/<org>/userData/projects/<project>/<id>[.source].parquet` or `s3://…/orgs/<org>/<project>/<id>.<version>.parquet` | The reason anyone runs this. |
| Records (projects, datasets' metadata, visuals, dashboards, pipelines, conversations, versions, trash) | Postgres `records` (RLS) — or per-org JSON files without `DATABASE_URL` | Names, formulas, filters, a dataset's **origin** (file path, URL that may carry a key, SQL). |
| Connection passwords/tokens, AI provider keys | Postgres `secrets`, AES-256-GCM under a per-org data key wrapped by `ORDINATE_MASTER_KEY` | Reach into the company's databases and paid APIs. |
| `ORDINATE_MASTER_KEY`, `DATABASE_URL` password, OIDC client secret, S3 credentials | Pod environment / IRSA | Unwrap every secret; impersonate the app to the IdP. |
| Sessions, API tokens, upload/download tokens, CSRF tokens | Postgres (sha256 only) / process memory | Bearer credentials. |
| Membership, roles, grants, audit log | Postgres `users`, `teams`, `project_grants`, `audit_log` | Who may see what; evidence afterwards. |
| The pod itself | Node process, DuckDB workers, filesystem, network position inside the VPC | SSRF pivot, file read, DoS. |

## 2. Actors

| Actor | Starts with |
|---|---|
| Anonymous internet / intranet user | Network reach to the ingress. No session. |
| Member of org A, by role | `viewer` / `editor` / `admin` org role; per-project grants (user or team). |
| Member of org B | A valid session in another org on the same deployment. |
| Holder of a leaked API token | `Authorization: Bearer ord_…` of one user. |
| A hostile web page | Runs in a signed-in member's browser (CSRF, XSS attempts). |
| A hostile data source | A database or URL a member connects to (SSRF target, malicious content). |
| A model provider | Returns text the app renders (prompt injection: it never writes a number — CLAUDE.md core principle). |
| The operator | Root on the deployment. Trusted (plan §8); out of scope as an attacker. |

## 3. Trust boundaries

```
 browser (web/ SPA)          programs (CLI, MCP clients)
   │ cookie session + CSRF       │ Bearer ord_… (no cookie)
   ▼                             ▼
 ┌─────────────────────── B1: the HTTP edge (src/server/app.ts) ───────────────────────┐
 │ headers.ts → csrf.ts → limits.ts (per IP) → auth (identify) → limits (per user)      │
 │ → contract (zod input) → authz (project/org role) → handler → wire encode            │
 └──────────────┬───────────────────────────────┬───────────────────────────┬──────────┘
                │ B2: org boundary              │ B3: process boundary      │ B4: egress
                ▼                               ▼                           ▼
   ctx().org → per-org paths, RLS,      per-org DuckDB worker          safeFetch / pinned
   orgKey() caches, SSE binding         (allowed_directories, locked)   lookup (SSRF guard)
                │                               │                           │
                ▼                               ▼                           ▼
        Postgres (theirs)              DATA_DIR / S3 (theirs)      their DBs, URLs, AI APIs
```

- **B1 — browser/program → server.** Everything from a client is untrusted: body, headers (incl.
  `X-Forwarded-*` unless the TCP peer is a trusted proxy), cookies, filenames, ids.
- **B2 — org A ↔ org B.** The org comes from the session/token only (`ctx().org`), never from input.
- **B2' — project P ↔ project Q inside one org.** The contract's `project` resolver names the
  project the role is checked on; the handler must not touch a record of another project.
- **B3 — Node ↔ DuckDB.** SQL text the app generates runs in a worker locked to the org's root.
- **B4 — server → the network.** Connectors, URL sources and AI gateways reach hosts a member
  names; the pod sits inside the operator's VPC.
- **B5 — server → logs / browser.** Secrets and origins must not cross outward.

## 4. Mitigations and the tests that prove them

### 4.1 Authentication (T3.2, T3.4)

| Threat | Mitigation | Proven by |
|---|---|---|
| Open admin server in prod | `AUTH_MODE=dev` (everyone is admin) refuses to start with `ORDINATE_ENV=prod`; dev binds 127.0.0.1 | `test-server-boot` ("prod without auth: exits non-zero…"), `test-auth` |
| Forged identity in header mode | `X-Forwarded-Email` believed only when the **socket** peer is in `TRUSTED_PROXY_CIDRS`; `X-Forwarded-For` and Fastify `trustProxy` never decide | `test-auth-db` (spoofed header from untrusted v4/v6 peers, incl. a trusted-looking XFF; real-socket 127.0.0.1 vs ::1) |
| Session theft / fixation | 256-bit id, only sha256 stored; httpOnly, SameSite=Lax, `__Host-` + Secure in prod; rotated at every sign-in (a planted live session is ended); idle 8 h / absolute 7 d on the DB clock; logout and logout-everywhere delete rows | `test-auth-db` (rotation, planted id, idle/absolute expiry, logout-everywhere), `web/e2e/auth.e2e.ts` |
| OIDC flaws (code injection, replay, open redirect) | Authorization code + PKCE S256 + state + nonce via `openid-client`; tx cookie scoped to the callback, 10 min; `email_verified=false` refused; `next` must be a same-origin path | `test-auth` (`safeNext` cases), `web/e2e/auth.e2e.ts` against `scripts/mockOidc.ts` (PKCE + client secret checked by the mock) |
| Disabled / demoted user keeps access | Role read from `users` on every request (session, header and bearer); disable deletes sessions; tokens of a disabled user identify nobody | `test-admin-db`, `test-tokens-db` |
| Leaked API token made permanent | Tokens stored as sha256; shown once; a token cannot mint a token; revoke → 401 at once | `test-tokens-db` |
| Brute force | Sign-in 60/min per client IP; RPC **and /api/mcp** 3000/min per IP, 1200/min per user (T6.3 added MCP) | `test-webHardening` §3 (incl. "mcp per user…", "mcp per IP…") |

### 4.2 Authorization and tenant isolation (T0.3, T3.3, T5.1, T5.2, T4.3)

| Threat | Mitigation | Proven by |
|---|---|---|
| Unchecked handler reachable over HTTP | No contract → 404 even with a handler registered; every contract has a zod input and is project- or org-scoped (compile-time + `check-contracts`) | `test-rpc`, `test-authz` (runs `scripts/check-contracts.ts`, with a negative control) |
| Viewer writes / member of P reads Q | Role on the resolved project must reach `access`; unresolvable → 403 before the handler | `test-authz-db` (role × access × own/other project/other org matrix, zero unexpected allows), `test-projects-server`, `test-visualsServer`, `test-analyticsServer`, `test-settings-server`, `test-admin-db` (denied calls never reach the handler) |
| Org B reads org A's records | Org from the session only; per-org paths; Postgres RLS **forced** on `records`, `storage_objects` + an app-level `org_id` filter | `test-records` ("tenancy: …", "rls: …"), `test-server-context` |
| Module caches keyed by record id leak across orgs | `orgKey()` on every id-keyed cache (14 path caches + 7 caches found and fixed in T0.3/T5.1) | `test-server-context`, `test-records` ("the answer cache keys the same dataset id differently per org") |
| User SQL / generated SQL reads another org's Parquet or the server's files | One DuckDB worker per org: `allowed_directories` = the org root (+ its S3 prefix), `enable_external_access=false`, `lock_configuration=true` before it reports ready; compute threads lease the org worker | `test-duckdbPool` (refuses B's Parquet, sibling-prefix org, `..`, `/etc/passwd` via read_text/read_csv/glob, COPY TO, ATTACH, LOAD, SET — with an unlocked control), `test-storageS3`, `test-serverModeResident` |
| Org B reads org A's S3 objects or cached copies | Per-org `credential_chain` secret scoped to the org prefix; prefix in `allowed_directories` | `test-storageS3` (org `evil` vs `acme`, `..`, sibling prefix `acmex/`, cached copy) |
| Upload/download token used by someone else | Tokens bound to org + user, single use, 1 h, one message for every refusal | `test-files` ("org-b using org-a…", "another user in org-a: refused", "download from org-b: 404") |
| Staged import saved by another org/user | `importStage` keyed per org + user (T0.4 follow-up, closed in T2.4) | `test-importServer` |
| Another tab's / user's events | SSE stream bound at open to org + user; `X-Ordinate-Client` honoured only for the caller's own stream; cross-pod receivers re-check the binding and refuse line breaks | `test-sse` ("another org opening A's id → 403"…), `test-jobs-pods` |
| Cross-project credential delete | `connection:delete` checks the connection belongs to the named project (T2.5 fix) | `test-connections-server` |
| A connection secret adopted by another project | Import re-ids every connection; deleting a project drops its connections' secrets (T6.3 F2) | `test-securityReview` F2 |
| A crafted bundle / backup reading server files | No `file` origin survives on the server (T6.3 F1); bundle entries whitelisted by path, ids remapped, CRC + size caps | `test-securityReview` F1, `test-projects-server`, `test-settings-server` |
| Project data pushed to members without a grant | Tick pushes (`alerts:fired`, `hub:dataset-refreshed`) go to the project's readers only (T6.3 F5) | `test-securityReview` F5 |

### 4.3 Browser-side attacks (T6.2, T0.6)

| Threat | Mitigation | Proven by |
|---|---|---|
| CSRF | Every non-GET: Origin must equal Host (or no cross-site `Sec-Fetch-Site`), then double-submit `X-CSRF-Token` = `__Host-ordinate_csrf` (timing-safe). Exempt only where a bearer token decides identity, and `/api/mcp` (bearer only) | `test-webHardening` §2 (CSRF matrix on rpc/files/logout/logout-everywhere), `scripts/csrfPair.ts` used by 14 suites |
| XSS / injected script | Header CSP `script-src 'self'`, no inline script or style anywhere, `object-src 'none'`, `base-uri 'self'`; `/api/*` gets a deny-all CSP so a user file opened directly runs nothing; React escapes; MapLibre popups use `setDOMContent` (never `setHTML`) | `test-webHardening` (every route class), every e2e spec via `failOnConsoleError` (fails on any CSP violation) |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | `test-webHardening` |
| Download served as active content | Downloads: `Content-Disposition: attachment`, `application/octet-stream`, `nosniff`, `no-store`, RFC 6266 filename (header injection refused) | `test-files` ("download: attachment…", "download: octet-stream, nosniff…") |
| Path traversal to the server's files | Static: `@fastify/static` root = the built `web/dist`; `/api/*` misses are JSON 404s; GeoJSON served by exact name from a whitelist | `test-server-static`, `test-geoRoutes` (10 traversal attempts → 404) |

### 4.4 Secrets (T5.3, T2.5, T2.12, T0.1)

| Threat | Mitigation | Proven by |
|---|---|---|
| Secrets readable at rest | Envelope encryption, AAD = org + kind + ref (a row copied to another org or ref fails to decrypt); `KeyObject` never prints | `test-secrets` (4 AAD cases, `pg_dump` + `row_to_json` dumps clean, canary in no spelling) |
| Connection password / AI key in `config.json`, a reply, an SSE frame, a log | T5.3 follow-ups **done**: connections (T2.5) and AI keys (T2.12) route through the store in server mode; no store → saving refused | `test-connections-server` (canary absent from DATA_DIR, dumps, logs, every reply, the DOM), `test-dockServer` (canary absent from files, 15 tables, logs, replies, SSE frames; config.json sabotage fails it) |
| Secrets in logs | pino redaction of credential header/field names at depths 0–4; query string dropped and file tokens masked in the request log; pg errors rebuilt without the URL password | `test-server-boot` ("logs: … never reaches the log"), `test-files` ("log: no token appears anywhere"), `test-db-migrate` / pool canary, `test-tokens-db` (negative control on `apiToken`) |
| Dataset origin (path, URL with key, SQL) reaches a browser | No contract for `dataset:meta`; `dataset:source` returns kind/label only; refresh errors cut to host / file name; lineage and pipeline node ids masked; the raw bundle (`projects:export`) is project-admin only (T6.3 F6) | `test-dataViews` (canary in the origins absent from every reply; negative control), `test-prepareServer`, `test-projects-server` |
| Error message leaks a value | RPC 400 lists zod paths + codes only; 500 says "handler failed" (message to the log) | `test-rpc` |

### 4.5 Egress — SSRF (T6.1)

| Threat | Mitigation | Proven by |
|---|---|---|
| A connector / URL source / AI gateway reaching metadata, loopback, RFC 1918, link-local | `checkHost` (WHATWG canonicalization, every DNS answer checked) + `pinnedLookup` (connect to the checked address) + `safeFetch` (http(s) only, no URL credentials, ≤ 5 redirects each re-checked, credential headers dropped cross-origin); wired into the four connection dispatches, the 7 HTTP engines, URL sources, SaaS HTTP, the AI gateway | `test-ssrf` (49 hostile URLs refused before any socket, 20 DB-host spellings, rebinding on a redirect hop, 0 DB sockets opened; negative controls) |
| DuckDB fetching a URL a user names | `enable_external_access=false` in every org worker (httpfs only for the org's own S3 prefix) | `test-duckdbPool` (`LOAD httpfs` refused) |

### 4.5b Connectors and user SQL (T2.5, T6.3)

| Threat | Mitigation | Proven by |
|---|---|---|
| A write on the member's own database through a "read-only" connection | Postgres family: read-only session + **extended protocol** (one statement); MySQL `multipleStatements:false`; MSSQL/Oracle keyword guard + batch refusal; ClickHouse `readonly=2` | `test-securityReview` F3 (real Postgres), `test-connectorsPostgres`, `test-connectorsMysql`, `test-connections-server` |
| Unbounded result buffered in the pod | Every query bounded server-side; the user's text sits on its own line inside the wrapper so a comment cannot remove the `LIMIT` | `test-connectorsPostgres`, `test-connectorsMysql`, `test-securityReview` F3 |
| User SQL over DuckDB reading files / another project | Org-locked worker (org boundary) + `sqlGate` (one SELECT-shaped statement, no file functions, no path in table position) + `FROM ( … )` wrapper — see R2 | `test-duckdbPool`, `test-sqlDatasets`, `test-securityReview` F4 |

### 4.6 Availability (T6.2, T4.3, T0.4)

| Threat | Mitigation | Proven by |
|---|---|---|
| Huge bodies | JSON body cap `MAX_RPC_BODY_KB` (413); uploads capped and cut without buffering (`MAX_UPLOAD_MB`, per-org lower cap); MCP 1 MB | `test-webHardening` §4, `test-files` (oversize cases, RSS growth) |
| Runaway query | `RPC_TIMEOUT_SECONDS` → 504 and the abort interrupts DuckDB; per-org `DUCKDB_QUERY_TIMEOUT_SECONDS`, memory and thread limits; a hang-up cancels | `test-webHardening` (timeout), `test-duckdbPool` (timeout, cancel) |
| Event-loop blocking | No sync DuckDB on the main thread (guard on) | `test-asyncReach` (106 roots, zero sync sites), `test-server-boot` |
| User regex backtracking (ReDoS) | Subset patterns in the regex worker under a 2 s per-call deadline (terminate + replace); formula patterns on V8's linear engine; sync folds refuse a user regex on the server (T6.4, R1) | `test-regexDeadline` (hostile patterns time out with the loop serving, byte-identical ordinary results, backstop, negative control) |
| Wire decode bombs | Codec refuses malformed tags; `__proto__` stays a key | `test-wire` ("decode refuses: …", "__proto__ stays a key and pollutes nothing") |

### 4.7 Warehouses and live data (`docs/live-data/00-plan.md` §7)

| # | Risk | Control | Proven by |
|---|---|---|---|
| R-L3 | **Key theft via a crafted BigQuery key file** (L1.3). The key file is user input; its `token_uri` names where to send the signed assertion (a bearer credential for an hour), so a free-form one would aim it — and the pod's egress — anywhere. | `token_uri` must equal `https://oauth2.googleapis.com/token` character for character, else the key is refused before any request, and the exchange goes to that constant regardless; `type: service_account`, `client_email` and an RSA key required; a foreign `universe_domain` refused. Two declared hosts (`bigquery.googleapis.com`, `oauth2.googleapis.com`), https only, every request through `httpRequest`'s SSRF guard; the project id validated and URL-encoded into a fixed path; a hostile `jobReference` is never followed. The key lives in the `token` secret slot (the encrypted store); every error is scrubbed of the key file, its PEM and each PEM line, the key id, the assertion and the access token — raw replies are scrubbed before they are cut. Read-only: the token carries read-only scopes only, and every statement is dry-run and refused unless `statementType` is `SELECT` (the scope spike is unverified — `docs/live-data/log.md`); IAM is Data Viewer + Job User. Cost: `maximumBytesBilled` on every billed query (`LIVE_MAX_BYTES_BILLED`), cancel on hang-up or timeout. | `test-connectorsBigquery` (12 `token_uri` look-alikes refused with no request; JWT verified with `crypto.verify`; the dry-run gate on 7 statement types + a SELECT negative control; named parameters vs 10 adversarial literals), `test-bigqueryBounds` (secret canary: 50+ planted values against a server echoing them in every error, absent from every result, error and output line; host guard + negative control; cancel on abort, in-flight abort and timeout; the bytes-billed matrix) |

## 5. T6.3 review — findings

Review method: `git log 6391e6f..HEAD` (159 commits) by hand over `src/server/`, `src/api/`, the
contracted `src/ipc/` handlers, `src/connectors/ssrf.ts`, `src/engine/duckdbPool.ts`, `src/publish/`,
`src/automation/serverMcp.ts`, plus every "For T6.3" / "Open:" item in `log.md`. (The
`security-review` skill reviews a branch's pending diff, which was empty here, so the review was
done by hand over the history.)

Severity is for a multi-org deployment with untrusted members. "Fixed" rows name the regression
check. The checks for F1–F5, F7 and F8 were run against the unfixed code (fix reverted in the built
`.js`) and failed there; F3b and F6 change an asserted SQL text / role cell, which the old code cannot meet.

| # | Finding | Severity | What was done | Regression check |
|---|---|---|---|---|
| F1 | **Arbitrary server file read.** `sanitizeOrigin` kept `{kind:'file', path}` on the server and `dataset:refresh` parsed that path with Node `fs` (no DuckDB lock). An org editor imports a crafted bundle (`projects:import`, org write) whose dataset names `DATA_DIR/orgs/<other-org>/…` or any mounted `.csv/.tsv/.json/.xlsx` (e.g. a cloud credential JSON), refreshes, and reads it with `dataset:page`. Also via `backups:restore` and the auto-refresh tick. | **High** | A server keeps no file origin: `sanitizeOrigin` drops it in server mode (every load passes it), `refreshFromFile` refuses as a backstop. | `test-securityReview` F1 (negative control: the canary file's row landed in the table); `test-dataViews` updated |
| F2 | **Connection-secret adoption.** Secrets are keyed `(org, kind, connId)`; `projects:delete` left them behind, and bundle import kept any connection id not currently in use — a bundle naming a deleted project's connection id (known to its former viewers) adopted its password/token and sent it to the importer's host. | **High** | Import always gives a connection a fresh id; `projects:delete` drops its connections' secrets. | `test-securityReview` F2 |
| F3 | **Postgres connector: writes on the source and no row cap.** User SQL went over pg's simple protocol (several statements), so `select 1 ) x; commit; begin read write; …; select * from (select 1` escaped the read-only session; a trailing `--` removed the server-side `LIMIT` (whole table buffered in the pod). 11 wire-compatible sources. | **High** | `queryMode: 'extended'` (one statement per call) and the user text on its own line inside the wrapper. | `test-securityReview` F3 against real Postgres (negative control: the table WAS created), `test-connectorsPostgres` |
| F3b | MySQL family (8 sources): a trailing `-- `/`#` comment removed the wrapper's `LIMIT` (memory DoS; `multipleStatements:false` already blocked writes). | Medium | User text on its own line. | `test-connectorsMysql` |
| F4 | `sqlGate` missed a string/path-shaped name inside a parenthesised join (`FROM ('/x.csv' CROSS JOIN …)`) and `json_execute_serialized_sql(…)`. **Latent**: the org worker allows the whole org root, so the gate is the only project boundary for user SQL inside an org — but the server's SQL-dataset / `query_sql` path is not reachable today (see R2). | Medium | A `(` in table position keeps table position; the function joins the deny list; `values` ends a FROM list. | `test-securityReview` F4 (5 refused, 4 legitimate forms still allowed), `test-sqlDatasets` |
| F5 | `alerts:fired` and `hub:dataset-refreshed` were pushed to **every tab of the org** — alert figures, dataset names and raw refresh errors (a source URL with its key) reached members with no grant on the project. | Medium | Pushed only to members who may read the project (`readerEmails`: org admins + user/team grantees); the refresh error is cut by `redactOriginText`. | `test-securityReview` F5 |
| F6 | `projects:export` was `read`: any viewer downloaded the bundle with every dataset's raw origin (URL with key, SQL text, connection settings) — what `dataset:meta` is withheld for. | Medium | Project **admin**; the switcher offers Export to admins only. | `test-projects-server` role matrix, `projects.test.tsx`, `projects-share.e2e.ts` |
| F7 | `/api/mcp` had no rate limit (logged open in T6.2). | Low | Shares the RPC per-IP and per-user buckets. | `test-webHardening` ("mcp per user…", "mcp per IP…"; negative control 3 FAIL) |
| F8 | `dataset:composeSave` linked a capture with **no** project (no role ever checked on it) and wrote the new dataset id into it. | Low | On the server only the caller's project's captures link. | `test-securityReview` F6 |

Earlier tasks' items checked and **closed**: T0.4's unbound `stagedId` (bound to org + user in T2.4 —
`importStage.get`, `test-importServer`); T5.3's two required follow-ups (connections in T2.5, AI keys in
T2.12 — `test-connections-server`, `test-dockServer`); T2.5's cross-project `connection:delete`;
T2.12's capture context and unguarded gateway `baseUrl` (guarded in T6.1, `test-ssrf`); T0.5's job
ownership and result path (`jobs.publicJob`, `test-home`). No cross-project IDOR was found in the
213 contracts: every store getter takes `(projectId, id)` under `projects/<projectId>/`.

## 6. Accepted and open risks

| # | Risk | Severity | Why it is accepted / what closes it |
|---|---|---|---|
| R1 | **ReDoS in user regex on the main thread.** Prepare/text steps (`checkRegex` subset, `qualityRegex`) ran in V8 on the request thread; `(\w+)+!`, `(a&#124;a)+!` or `\w+\w+…\w+!` over a ~40-char cell stalled the pod for every org. `text:preview` needs only `read`. T6.4 also found formula `regexp_*` (calculated fields, any server formula). | **High (availability) — MITIGATED (T6.4)** | V8's linear engine does not run `u` patterns (T6.3: > 5 s with `--enable-experimental-regexp-engine-on-excessive-backtracks`), so **subset patterns** (regex split / replace, keyword rules, quality `regex` rules, input-table rule checks, "show failing rows") run in `src/engine/regexWorker.ts`: one message per batch of DISTINCT texts (≤ 20,000 texts / 4M chars), a **2 s deadline per call**, the thread terminated and replaced on overrun; the step is skipped / the rule errors with a translated sentence. Async entry points in `src/data/regexOffThread.ts`; a sync fold that reaches a user regex on the server without the worker's answers **refuses** (backstop), so an unconverted caller (e.g. a regex step smuggled into a loose `filters` list) warns instead of hanging. **Formula patterns** (no `u`) run on V8's linear engine (`l` flag) on the server; a backreference/lookahead is null there. Desktop unchanged. Measured (`test-regexDeadline`, loaded machine): 6 hostile calls at once (replace ×3 patterns, split, keyword, quality) all time out in 2.0–4.0 s (2 queued behind the 4-thread cap), **max event-loop delay 10.6–28.8 ms**, a 5 ms ticker kept firing, 6 threads killed and replaced; the R1 formula answers in 1.5 ms; the old inline path is still running at 2× the deadline (negative control), and sabotaging either guard makes the suite hang past 60 s. Cost on an ordinary 100k-row step (median of 9, desktop inline → server): replace 38.8 → 47.2 ms, split 58.9 → 93.0, keyword 33.3 → 51.8, formula `regexp_replace` 37.9 → 106.3, quality rule 3.7 → 23.9; at 1k rows every path is ≤ 1.1 ms, so no cost model — every size goes through the worker on the server. Also found by the T6.4 sweep: story Markdown (T2.13) trimmed lines with `/\s+$/` — quadratic on user text (100k spaces + x = 28 s) → `trimEnd()` (same character set, now 2 ms). Still open, same class (fixed pattern, user text): story `INLINE_RE`'s link alternative scans to the line end from every `[` (50k `[` = 2.9 s per exec, shared with the desktop parser), and `notebook/exportMd.ts` keeps a `/\s+$/`. |
| R2 | User SQL over DuckDB rests on a lexer denylist (`sqlGate`) for the **project** boundary inside an org (the org lock holds the org boundary). The review also reports that the server's SQL path (`query_sql`, SQL-dataset refresh) is refused today because `hardenConnection` re-issues `SET` on an already locked worker — unverified; a functional bug either way. | Medium — OPEN | Before server SQL is turned on: replace the denylist with an allow-list over DuckDB's own AST (`json_serialize_sql`: only known dataset/CTE base tables, no table functions) and skip `hardenConnection` behind the router. |
| R3 | Bundle / backup import inflates up to 4 GB (`MAX_TOTAL_BYTES`) in memory from a ≤ `MAX_UPLOAD_MB` upload; the org backup is built in memory too. | Medium (availability) | Bounded, editor/admin-only. Stream entries to disk or cap the inflated total per server when an org outgrows it. |
| R4 | A source URL with an API key in its query is stored in the dataset origin as plaintext (Postgres `records`), not in the secrets store. Never reaches a browser (F6, `test-dataViews`). | Low | Operator's DB is encrypted at rest (plan §8). A URL-connector "secret parameter" would move it into the store. |
| R5 | An open event stream outlives logout, logout-everywhere and disable until the socket closes; it receives only its own user's pushes (and org-level `pipelines:changed`). | Low | Pushes are scoped to the user (F5); a re-auth check per push costs a query per event. |
| R6 | `pipelines:changed` goes to every tab of the org: a project id and masked node states — no names, no figures. | Low | Ids only; every RPC re-authorizes. Scope it like F5 when pipelines carry more. |
| R7 | A handler's `err.message` reaches the operator log (pino redacts by key name, not text); a connector error could quote a keyed URL. Never the wire (500 = "handler failed"). | Low | Operator-only; a walking serializer is the upgrade (T0.1 `ponytail:`). |
| R8 | Rate limits, upload/download tokens and plan runs are per pod (N pods allow N× the limit; sticky sessions needed for tokens). | Low | Documented `ponytail:` — a shared store (Postgres) when N > 1 matters. |
| R9 | SSRF (T6.1): an allowlist entry also allows its IPv4-mapped IPv6 form (same range — informational); `SSRF_ALLOW=0.0.0.0/0` turns the guard off (operator's choice, out of scope in SECURITY.md); SQL Server named-instance UDP 1434 lookup is unpinned (one datagram; TCP stays pinned); Oracle ADB connect strings are checked, not pinned, and listener redirects are not re-checked; no Content-Encoding decoding (rules out decompression bombs). | Low | Each needs a hostile DNS or listener plus a reachable internal service; the TCP connection itself is checked and pinned. |
| R10 | A locked DuckDB worker still accepts `CREATE SECRET` (T5.2). | Low | Unreachable from user SQL: one statement, must start SELECT/WITH/FROM/VALUES, and runs inside `FROM ( … )`. |
| R11 | Header-mode sign-ins leave no audit row (the proxy has none to hand us). `onboarding:status` tells any member the sample's ids; `project:access` (read) shows grantees' emails. | Info | The proxy logs sign-ins; ids and emails within one org are not secrets here. |
| R12 | MapLibre 4.7.1 has a critical `DOM.sanitize()` bypass (GHSA-jrc7-96c5-q579). | Low (unreachable) | The web app never calls `setHTML` — popups use `setDOMContent` with DOM it built — and `script-src 'self'` stands behind it (the desktop renderer's one `setHTML` escapes its input and is deleted at T8.1). Pinned to v4 on purpose (CLAUDE.md). Allowlisted in `scripts/audit-gate.ts` until 2027-01-04 (user decision, 2026-10-04). |
| R13 | T3.3 decision still pending with the user: org **editors** may call org-level write channels (create a project, upload, import a bundle). | Info | One line in `orgAllows` to make them admin-only. |
| R-L4 | **SSRF via the Snowflake account name** (live data, L1.2). The Snowflake connector reaches a host derived from a typed field, so a crafted "account" (`evil.com/`, `a@b`, `169.254.169.254`, a URL) could aim the request — and its bearer token — elsewhere. | Medium — **MITIGATED (L1.2)** | There is no host field: the account must match `^[a-z0-9_-]+(\.[a-z0-9_-]+){0,3}$` (lower-cased first; a pasted `.snowflakecomputing.com` suffix is stripped) and **we build** `https://<account>[.privatelink].snowflakecomputing.com`, re-checked after URL parsing — so every request names a subdomain of snowflakecomputing.com. The socket goes through `safeFetch` (resolve, refuse any internal address, pin; a PrivateLink endpoint needs `SSRF_ALLOW`), no redirect is followed (`redirect: 'error'`), and a `statementStatusUrl` from a reply is used only as a path on our own origin. Gzip partitions are decoded with `maxOutputLength` (a decompression bomb stops at the 100 MB ceiling — the R9 note no longer holds for this transport). Tests: `test-connectorsSnowflake` (21 refused identifiers, 2,000 fuzzed inputs all landing on an https subdomain of snowflakecomputing.com, a negative control showing the unguarded string names `evil.com`, a foreign status-URL host ignored), `test-connectorsSnowflakeHttp` (loopback refused until `SSRF_ALLOW`, redirect refused, gzip bomb bounded). |

## 7. Dependency audit (`npm audit --omit=dev`, 2026-10-04)

CI gate: job `audit` in `.github/workflows/ci.yml` runs `scripts/audit-gate.ts` over the root and
`web/`: it fails on any high/critical advisory outside a three-entry allowlist (below, each with a
reason and a 2027-01-04 review date), on an entry past its review date, and on an entry no longer
reported. Negative controls: dropping the maplibre entry fails 3 checks; an expired date fails 3. The
in-range `npm audit fix` (lockfile only: `fast-uri` 3.1.8, `brace-expansion` 1.1.21/2.1.7/5.0.12) was
applied with the user's approval on 2026-10-04.

| Package (path) | Severity | Advisory | Reachable from the server/web app? | Fix |
|---|---|---|---|---|
| `maplibre-gl` 4.7.1 (root + web, direct) | critical | GHSA-jrc7-96c5-q579 — `DOM.sanitize()` bypass | No — `setHTML` never called in the web app (R12) | 6.12.0 (major; CLAUDE.md pins v4) — **allowlisted** |
| `pptxgenjs` 4.0.1 → `image-size` 1.2.1 (root) | high | GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr — JXL/HEIF/ICNS parser infinite loops | No — reports (`src/ipc/reports.ts`) are not registered on the server; images are chart PNGs the app drew | none (audit offers a downgrade to 4.0.0) — **allowlisted** |
| `fast-uri` 3.1.2 via `ajv` (fastify) | high | 8 advisories — host confusion / SSRF in URI parsing | No — parses Fastify's own JSON-schema `$id`s, never a request URL | **fixed**: in-range `npm audit fix` (lockfile only) |
| `brace-expansion` 1.1.15 / 2.1.3 / 5.0.6 via `glob`/`minimatch` (`@fastify/static`, `exceljs` → `archiver`) | high | 6 advisories — ReDoS/OOM on crafted brace patterns | No — patterns are fixed in code (static root listing, xlsx writer) | **fixed**: in-range `npm audit fix` (lockfile only) |
| `exceljs` 4.4.0 → `uuid` 8.3.2 (root) | moderate | GHSA-w5hq-g745-h8pq — v3/v5/v6 with a caller buffer | No — exceljs calls v4 | none in range |

`web/` alone: only `maplibre-gl` (critical).
