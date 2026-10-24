# The identity provider decides who gets in, with what role and teams: design

Batch 3, item 2, branch `feat/sso-lifecycle`, migration **0019**. Base: `origin/develop` @ 46bbfc3d.
Every file:line below was re-read on that base.

**What you will see.** Under SSO, an admin maps IdP groups to an org role and to teams in
Admin → People → "Identity provider groups". From then on, each person's role and linked teams follow
their IdP groups: at every OIDC sign-in, and in header mode whenever the proxy's groups header changes.
People shows "From your identity provider" where the role picker was, and a linked team shows its
source instead of the member picker. Every API token has an end date. Disabling someone ends their
sessions, revokes their tokens for good and closes their open event streams on every pod. A restricted
viewer no longer receives a chart's waterfall totals from another team's rows.

---

## 1. The spec's decisions, condensed (not re-litigated)

- **Groups come from the IdP.** OIDC reads `OIDC_GROUPS_CLAIM` (unset = off); `OIDC_EXTRA_SCOPES` adds
  scopes for IdPs that send groups only on request. Header mode reads `TRUSTED_GROUPS_HEADER`
  (comma-separated), believed only from `TRUSTED_PROXY_CIDRS`, like `X-Forwarded-Email`.
- **The map is a table** (0019), not `org_config`: group → org role, group → team. Contracts
  `admin:idpGroups` and `admin:setIdpGroup`, both `access: 'admin'`, `org: true`.
- **When it applies.** At every OIDC sign-in, before the session is created. In header mode, when the
  header's groups differ from the last applied set: a digest on `users`, compared per request, written
  only on change.
- **The rules.** The highest mapped role wins. No mapped group means viewer. `ORDINATE_ADMIN_EMAIL`
  stays admin. The org's last admin is never removed: the role is kept and an error logged. A linked
  team gets exactly the IdP's members; unlinked teams stay manual.
- **A missing claim is not an empty list.** An absent claim, or Entra's overage marker
  (`_claim_names` / `hasgroups`), keeps the current role and teams and logs a warning. Only an
  explicit list changes anything.
- **Managed means managed.** Once any group maps to a role, `admin:setRole` refuses with 409 and a
  catalog sentence for people who sign in through the IdP. `admin:teamMember` refuses on linked teams.
  People shows "From your identity provider" instead of the control: hidden, never disabled.
  `admin:invite` still pre-creates the row, and the first sign-in applies the mapping.
- **Audit** each change as #311 audits a send: one row per user whose role or teams changed, channel
  `idp:sync`.
- **API tokens expire.** `tokens:create` takes `expiresInDays`, 1 to `API_TOKEN_MAX_DAYS` (default
  365). The page offers 30, 90 or 365 days (default 90) and shows each token's expiry. A token made
  before this change expires at `created_at + API_TOKEN_MAX_DAYS`, a read-time rule with no data
  migration, and the page marks those.
- **Disable is final.** It revokes the user's tokens (`revoked_at`, so re-enabling cannot revive them)
  and closes their event streams on every pod through the bus (closes R5).
- **Sessions keep their defaults.** `sso.md` recommends `SESSION_ABSOLUTE_HOURS=12` under SSO. Fix
  `sso.md:183`.
- **The #312 leak: filter, don't strip.** For a restricted caller, keep only the `waterfallTotals` and
  `y2Series` labels that appear in that caller's own locked result. Add both to R19.
- **SCIM is out** (phase 2). This item bounds the window to one session lifetime and one token
  lifetime.

---

## 2. Caller inventory

### 2.1 Sign-in and identity

| What | Where | What changes |
|---|---|---|
| OIDC authorize URL, `scope: 'openid email profile'` | `src/server/auth/oidc.ts:87-95` (`:89`) | Append `OIDC_EXTRA_SCOPES` |
| OIDC callback: claims → email check → `provision` → `createSession` | `oidc.ts:133-151` (`claims()` `:133`, `provision` `:141`, `createSession` `:147`) | `applyIdpGroups` between `provision` and `createSession`; the logged role is the applied one |
| `headerIdentify`: trusted-peer check → `member` → `provision` | `src/server/auth/index.ts:42-55` | Reads the groups header after the peer check; compares the digest; applies on change |
| Bearer path: a bearer header decides alone, in every mode | `auth/index.ts:88-92` | Unchanged; never reads groups (§3.10) |
| `provision` (first sign-in viewer; break-glass admin on every sign-in) | `src/server/auth/store.ts:52-65` | Unchanged; the mapping runs after it |
| `member` (per-request header lookup, no write) | `store.ts:73-79` | Also returns `id` and `idp_groups_digest` in the same SELECT (no extra query) |
| `createSession` / `sessionIdentity` | `store.ts:87-99`, `:108-124` | Unchanged (the role is read from `users` per request) |
| `endAllSessions` (logout-everywhere) | `store.ts:136-142`, route `auth/index.ts:142-149` | The route also closes the user's streams (§3.9) |
| First-admin setup upsert sets `disabled_at = NULL` | `src/server/auth/passwordStore.ts:76-80` | Is an enable path: revokes that user's tokens if it was disabled (§3.8) |
| `/api/auth/me` (identify per call) | `auth/index.ts:100-113` | Unchanged; header sync may run inside its identify |
| Who calls `identify` | `src/server/app.ts:277` (onRequest gate, before `runInContext` `:309`), `published.ts` via `app.ts:457`, embeds `app.ts:460` | All outside a request context (§3.7) |

### 2.2 Authorization memo

| What | Where | Note |
|---|---|---|
| Per-request memos `ranks` and `callers`, a WeakMap keyed by the context store | `src/server/authz/caller.ts:34-45` | Created on first `callerOn`, after identify (§3.7) |
| `resolve`: rank, then teams from `team_members` | `caller.ts:52-68` | Fail-closed DB error throws |
| `callerOn` | `caller.ts:71-83`; users `src/data/rowAccess.ts:206,225,261` | Gains `forgetCaller()` (§3.7) |

### 2.3 Admin → People and Teams

| What | Where | What changes |
|---|---|---|
| `OTHER_ADMINS` (the last-admin rule) | `src/server/admin/people.ts:39` | setRole/setDisabled run it under the org people lock (§3.6) |
| `admin:users` | `people.ts:50-60` | Unchanged shape |
| `admin:invite` | `people.ts:62-74` | Unchanged; the web hides the role picker when roles are managed |
| `admin:setRole` | `people.ts:76-83` | 409 `idp_managed` when roles are managed (§3.5); demotion under the lock |
| `admin:setDisabled` | `people.ts:85-98` (`:91` enable, `:96` sessions) | Disable: revoke tokens + delete sessions in ONE statement, then close streams; enable from disabled: revoke again (§3.8) |
| `admin:teamMember` | `people.ts:132-155` | 409 `idp_managed` on a linked team |
| Contracts | `src/api/admin.ts:22-67` | Adds `admin:idpGroups`, `admin:setIdpGroup` (in `adminContracts`; `src/api/index.ts` untouched) |
| Registration | `src/server/app.ts:493-498` | Adds the idp handlers' `register` |
| Typed 409s from a handler | `app.ts:398-430` | One more branch: `isIdpManaged(err)` → 409 `idp_managed` + catalog sentence |
| Web: People | `web/src/features/admin/UsersTab.tsx:29-72` (invite, role `Select` `:68`), `:74-123` (row, role `Select` `:87-95`) | Hidden controls + "From your identity provider"; the new groups panel below the table |
| Web: Teams | `web/src/features/admin/TeamsTab.tsx:51-89` (members dialog), `:148-153` (row menu) | Linked teams: "From your identity provider", no "Members…" item |
| Web: types, refusals, hooks | `web/src/features/admin/api.ts:77-83` (`ApiToken`), `:154-176` (`REFUSAL`), `:180` (`useTokens`) | `IdpGroups`, `useIdpGroups`, token fields, `expiry` refusal |
| Web: Admin page | `web/src/features/admin/AdminPage.tsx:134-136` | Passes `mode` to the People tab |

### 2.4 Tokens

| What | Where | What changes |
|---|---|---|
| Contract `tokens:create` `{name}` | `src/api/tokens.ts:11` | `{name, expiresInDays}` (int 1–3650; the handler holds it to `API_TOKEN_MAX_DAYS`) |
| `tokenIdentity` (`expires_at IS NULL OR > now()`) | `src/server/auth/tokens.ts:36-49` (`:42`) | `coalesce(t.expires_at, t.created_at + $max days) > now()` |
| `tokens:list` | `tokens.ts:75-82` | `{tokens, maxDays}`; each row `expiresAt` (effective) and `legacy` (no stored end) |
| `tokens:create` INSERT, cap of 50 live | `tokens.ts:84-97` (`:90-91`) | Sets `expires_at`; the cap counts unexpired, unrevoked tokens |
| `tokens:revoke` | `tokens.ts:99-105` | Unchanged |
| Other `tokens:create` callers | `scripts/test-tokens-db.ts`, `test-refreshHooks-db.ts:158`, `test-rowPolicyFanOut.ts:304`, `web/e2e/admin.e2e.ts`, `web/src/features/admin/admin.test.tsx` | All pass `expiresInDays` (required) |
| Web | `web/src/features/admin/TokensPage.tsx:27-93` (dialog, name input `:88`), `:148-176` (table) | Expiry picker; "Expires" column; legacy and expired marks |
| Refresh-URL tokens follow their creator's current state | `src/server/hooks/route.ts:99-103` | Unchanged, by decision (§3.8) |

### 2.5 Streams and the bus

| What | Where | What changes |
|---|---|---|
| `deliverLocal`, `publish` | `src/server/sse.ts:109-130` | The reserved channel `CLOSE` closes matching streams; `publish` drops it |
| Stream open / close / registry | `sse.ts:92-99`, `:166-225`, `:228-251` | `closeStreamsOf(org, email)`; `localOwners()` for the sweep |
| Bus receive → `deliverLocal`; send → `setFanOut` | `src/server/jobs/bus.ts:67-71`, `:160-163` | No change: CLOSE travels as an ordinary message (§3.9) |
| Bus start / stop | `app.ts:222`, `:227-230` | Also starts and stops the stream sweep |

### 2.6 Audit

| What | Where |
|---|---|
| The writer: `audit(pool, {org, actor, action, channel, projectId, targets, outcome, requestId})` | `src/server/authz/audit.ts:52-59` |
| #311's use: `action: 'rpc'`, `channel: 'alerts:post'` (no CHECK change) | `src/server/subscriptions/alertPosts.ts:58` |

### 2.7 Every path that returns a stored visual's overrides to a caller

A restricted caller is a project viewer (`caller.ts:71`), so only `read` contracts reach one. An
independent sweep of every `getVisual` / `readVisual` / `.overrides` site gave this table.

| Path | Handler | Returns | Today | This design |
|---|---|---|---|---|
| `visual:get` | `src/ipc/visuals.ts:562` | record + `tag` | `visualForCaller` (strips `sortOrder`, `seriesColors`) | filter; recompute `tag` |
| `visual:thumbs` | `src/ipc/visualsServer.ts:55-66` (`:63`) | `overrides` | `visualForCaller` | filter against the reply in hand |
| `versions:get` (visual) | `src/ipc/versions.ts:71-79` (`:78`) | version record | `visualForCaller` | filter against the version's own question |
| `versions:get` (dashboard) | `versions.ts:75` | old dashboard record incl. `card.visual` | **nothing** | each inline `card.visual` filtered |
| `analysis:gallery` | `src/ipc/analysesServer.ts:56-72` (`:65`) | preview defs | `visualForCaller` | filter |
| `analysis:open`, `visuals[]` | `analysesServer.ts:77-88` (`:85`) | every visual + `tag` | `visualForCaller`, tag unchanged | filter; recompute `tag` |
| `analysis:open`, `analysis` | `analysesServer.ts:87` | dashboard record incl. `card.visual` | **nothing** | each inline `card.visual` filtered |
| `story:figures` | `src/ipc/reportsServer.ts:234-249` → `storyVisual` `src/analysis/reportPages.ts:383-401` (`:398`) | raw `overrides` of any visual id the client names | **nothing** (a door refusal still sends them) | filter against the chart data in hand |
| `report:preview` / `report:build` / `story:export` | `reportsServer.ts:222-225`, `:251-256` | raw overrides | `exportScope` refuses a restricted caller on a ruled dataset (sticky, `rowAccess.ts:66-71`) | moot |
| publish, `/p/`, embeds, subscriptions, summary, lineage, version diffs, search, recent, catalog, trash, comments, templates, copilot | see the sweep | names, chart type, or figures without overrides | — | no change |
| `visual:save` / `:update` / `:duplicate`, restores, `analysis:create`/`:update`, MCP `create_*` | — | full record | `write`: no restricted caller | no change |

`card.visual` is vestigial (`src/analysis/dashboards.ts:160-170`) but `sanitizeCard` still stores it
(`:396-399`), so an editor's `analysis:update`, an old record or an imported bundle can carry one.

Two neighbours found on the way:

- **The tag oracle.** `visual:get` and `analysis:open` return a `tag` that is the sha256 of the
  stored record (`src/app/editConflict.ts:41-42`, `:60-62`), so a viewer can confirm a guessed label
  offline. Fixed here (§3.12).
- **A chart whose labels come from another dataset.** `visualForCaller` asks only the base dataset
  (`rowDoors.ts:116`). A visual on a rule-free dataset whose category comes from a ruled one
  (`categoryDatasetId`, `seriesDatasetId` or a relationship-supplied column) is refused at
  `visual:data`, because the related read hits the storage net, but its stored labels still go out.
  Fixed here (§3.12).

---

## 3. Decisions this design makes (where the spec leaves room)

### 3.1 Environment variables

| Name | Value | Default | Valid in | Why |
|---|---|---|---|---|
| `OIDC_GROUPS_CLAIM` | the claim's name, looked up as a TOP-LEVEL key (so a namespaced `https://acme.com/groups` works; no dotted paths) | unset: groups not read | `AUTH_MODE=oidc` only; otherwise startup refuses | A group mapping that silently does nothing is worse than a refused start |
| `OIDC_EXTRA_SCOPES` | space- or comma-separated scopes, each an RFC 6749 scope-token; added after `openid email profile`, duplicates dropped | unset | `oidc` only | Okta custom authorization servers send `groups` only with a `groups` scope |
| `TRUSTED_GROUPS_HEADER` | a header name (`X-Forwarded-Groups`), lower-cased, `[A-Za-z0-9-]+`; never `x-forwarded-email`, `authorization`, `cookie` or `host` | unset: groups not read | `header` only | Same trust as the email header; a nonsense name is caught at startup |
| `API_TOKEN_MAX_DAYS` | whole days, 1–3650 | `365` | every mode | Tokens exist in every mode with Postgres |

Parsing goes in a new pure module, `src/server/idpEnv.ts` (the `liveEnv.ts` pattern). `env.ts`
(503 lines) gains only the four `src.NAME` reads and the calls, so `test-serverDocs` still sees each
name. `AuthEnv` gains `groupsFrom: {claim} | {header} | null` and `apiTokenMaxDays`; `OidcEnv` gains
`extraScopes`.

### 3.2 Where the OIDC groups come from: the ID token only

The groups are read from `tokens.claims()`, the ID token's claims that openid-client has already
verified (signature, `iss`, `aud`, `exp`, nonce). There is no userinfo call. Reasons:

- The ID token is the signed statement bound to this client and this login. Userinfo is a second,
  usually unsigned, HTTP response, and one more way for a sign-in to fail.
- All the target IdPs can put groups in the ID token: Okta (a groups claim), Entra (Token configuration
  → groups claim, or app roles in `roles`), Keycloak (the Group Membership mapper's "Add to ID token",
  on by default), and Auth0 (an Action adding a namespaced claim).
- An IdP set up to send groups only in userinfo shows up as "claim absent" on every sign-in: a warning,
  and nothing changes. That fails closed and is easy to see. `sso.md` gives each IdP's setting.

### 3.3 Reading the claim, and overage detection

`groupsFromClaims(claims, name)` is pure and returns `string[] | 'absent' | 'overage'`:

1. **Overage first.** `claims._claim_names` is an object with `name` as an own key, OR `name ===
   'groups'` and `claims.hasgroups` is `true` or `"true"` → `'overage'`. Overage wins even if a list is
   also present (a contradiction is not trusted). `hasgroups` counts only for the `groups` claim: with
   Entra app roles (`roles`), a groups overage is irrelevant.
2. Missing, `null`, a number, an object or a boolean → `'absent'`. Malformed is treated as absent,
   never as `[]`.
3. An array whose every element is a string → the list. An array with any non-string element →
   `'absent'`. A partial list could demote someone, so it is not trusted.
4. A single string → a one-element list (ADFS-style issuers send a lone group that way).

The same function reads a header: `groupsFromHeader(raw)` → missing header → `'absent'`; a value →
split on `,`. An empty value is an explicit empty list.

### 3.4 Group names: canonical form and matching

`canonGroup(s) = s.normalize('NFC').trim()`. Empty names are dropped and duplicates removed. Names
are stored in this form (the contract caps them at 256 characters, no control characters), and
**matched exactly: case-sensitive, whitespace inside the name significant.**

- **Case-sensitive** because folding is a fail-open. Keycloak and Google Groups let differently-cased
  groups be different principals, so `admins` must not inherit `Admins`'s role. IdPs that treat names
  case-insensitively still emit one canonical spelling (Entra object ids, Okta's stored name). A
  mismatch simply does not match, so nobody is promoted by a typo. The panel says "matched exactly, as
  your IdP sends it".
- **Trim and NFC** because surrounding whitespace and Unicode normal form are encoding accidents, not
  identity. Header values arrive as `a, b`.
- **A comma makes one group read as several in header mode** (the header is comma-separated, as
  oauth2-proxy writes it): a group named `sales-emea,ordinate-admins` would grant `ordinate-admins`'s
  role (review S-L4, corrected). So every mapped name must be a group only IdP admins create and name —
  never a self-service or owner-renamable group. There is no encoded format for now. `sso.md` and R20(e)
  say so.

### 3.5 Who "signs in through the IdP", for the `setRole` refusal

**Every member of the org, when the server reads groups (`groupsFrom !== null`: `AUTH_MODE=oidc` with
`OIDC_GROUPS_CLAIM`, or `header` with `TRUSTED_GROUPS_HEADER`) AND at least one `idp_groups` row maps
a role.** In those modes the IdP (or its proxy) is the only door. Password sign-in is not registered,
dev mode is excluded, and a token can be minted only from a session. Pending invitees count: their
first sign-in replaces any role set now. The break-glass admin counts too: `ORDINATE_ADMIN_EMAIL`
already overrides any change.

- Roles are managed by the same condition (`roleManaged(org)`). A team is linked when that team has
  an `idp_groups` row and `groupsFrom !== null`.
- With the variable unset, the mapping is **dormant**: nothing is applied, nothing refused, and the
  panel says how to turn it on. A dormant mapping leaves roles and teams as manual as they were before.

### 3.6 The apply transaction, the last-admin rule and concurrency

One **people lock per org**, `pg_advisory_xact_lock(hashtextextended('people:' || org, 0))` (the
`passwordStore.ts:62` / `usageStore.ts:108` pattern), is taken first by every transaction that can
change a role or a linked team, or the map:

- `applyIdpGroups`;
- `admin:setIdpGroup`;
- `admin:setRole`;
- `admin:setDisabled` (disable).

The lock is always taken before any row lock, so there is no lock-order inversion. Under it:

1. Read the map (`SELECT group_name, role, team_id FROM idp_groups WHERE org_id = $1`).
2. `SELECT role, idp_groups_digest FROM users WHERE id = $u AND org_id = $org AND disabled_at IS NULL
   FOR UPDATE`. None → stop (disabled meanwhile). In header mode, re-compare the digest: equal → stop.
   A parallel request already applied it.
3. `rolesAndTeams(groups, map, breakGlass)`. This is pure: role is `null` (roles not managed),
   `'admin'` (break-glass), the highest mapped role, or `'viewer'`. Teams are the linked teams of the
   matched groups.
4. Role: when the new role is not admin and the current one is, `keepLastAdmin(current, next,
   otherAdmins)` (pure). `otherAdmins` counts other **enabled admins who have signed in**
   (`last_login_at IS NOT NULL`).
   - A pending invitee with a stored admin role does not count: under managed roles their first
     sign-in replaces it.
   - If it is 0: keep admin, log an error, audit `idp:sync` with outcome `denied`.
5. Teams: add the missing ones, delete the extra ones, both only within the linked set (unlinked teams
   are never touched).
6. Write the digest. Commit. Audit one `idp:sync` row if the role or teams changed: actor = the
   user's email, targets = the user id plus every team added or removed.
7. `forgetCaller()` (§3.7).

Serializing per org costs a few milliseconds per OIDC sign-in. That is what makes "never remove the
last admin" hold when a mapping change demotes several admins at once. Without it, three admins'
parallel header requests would each see two others and all be demoted.

`setRole` and `setDisabled` take the same lock, which also closes their pre-existing write skew (two
admins demoted at once). Their `OTHER_ADMINS` still counts pending invitees, as today (§9).

### 3.7 The teams memo

- **No sync ever runs inside a request context.**
  - Header mode applies inside `identify`, which `app.ts:277` calls before `runInContext` (`:309`).
  - OIDC applies in `/api/auth/callback`, which is exempt from the gate (`:274`) and has no context.
  - So the memo of the request doing the sync does not exist yet, and is built afterwards from the
    synced rows.
- **A request already in flight on any pod** keeps its memo, so its view is the pre-sync one for at
  most that request (bounded by `RPC_TIMEOUT_SECONDS`), as if it had arrived a moment earlier. That is
  the per-request consistency the memo exists for. A subscription run or job context is likewise
  short.
- **Defence in depth for the trap.** `caller.ts` exports `forgetCaller()`: if a request context is
  current, it deletes that context's `ranks` and `callers` entries (team grants feed the rank as well).
  `applyIdpGroups` calls it after commit, so a future caller that syncs mid-request cannot leave a
  stale memo. A test runs a sync inside a context, with a negative control (§7, test 1i).

### 3.8 Disable, enable and token revocation

- **Disable** is one statement, run under the people lock:

  ```sql
  WITH u AS (UPDATE users SET disabled_at = coalesce(disabled_at, now())
              WHERE org_id = $1 AND id = $2 AND (role <> 'admin' OR <OTHER_ADMINS> > 0) RETURNING id, email),
       t AS (UPDATE api_tokens SET revoked_at = now() WHERE user_id IN (SELECT id FROM u) AND revoked_at IS NULL),
       s AS (DELETE FROM sessions WHERE user_id IN (SELECT id FROM u))
  SELECT email FROM u
  ```

  So the disable, the revocation and the sign-out commit together. The streams close after commit
  (§3.9).
- **Enable from disabled also revokes** (one statement: a CTE reads the user while still disabled,
  revokes their live tokens, and the UPDATE clears `disabled_at`).
  - This holds the invariant "re-enabling never revives a token" where revival happens. It covers
    users disabled before this release and a disable done by an old pod during a rolling upgrade.
  - So no data migration is needed.
  - Enabling someone already enabled revokes nothing.
- The first-admin setup upsert (`passwordStore.ts:76-80`) can re-enable a disabled address, so it
  revokes that user's live tokens in the same transaction when the row was disabled.
- **Refresh URLs** (`refresh_hooks`) are not revoked. They are a dataset's automation, can do only one
  rate-limited refresh, stop while their creator is disabled (`hooks/route.ts:99-103`) and resume on
  re-enable. A writer revokes one in the dataset's panel. Stated in `sso.md` and R5.

### 3.9 How a stream close travels across pods

- **No new bus message type.** `sse.ts` reserves one channel name, `CLOSE = 'auth:closed'`:
  - `deliverLocal(target, CLOSE, '')` closes every stream bound to the target instead of pushing to
    it;
  - `publish` drops CLOSE, so no handler can send it;
  - `closeStreamsOf(org, email)` = `deliverLocal({org, user}, CLOSE, '')` + `fanOut?.(…)`.
- The bus carries it as any message (`bus.ts:160-163` send, `:67-71` receive), and every other pod's
  `deliverLocal` closes its own matching streams. The binding check is the delivering pod's, as for
  every event.
- **Who calls it:** `admin:setDisabled` (disable) and `/api/auth/logout-everywhere`. The latter is
  one line, so both "end every session of a user" paths close R5. A single-tab logout navigates away,
  which ends that tab's stream.
- **After the close,** the browser's EventSource reconnects to `/api/events`, which is behind the 401
  gate (no session, or a disabled user in header mode), so it stays closed.
- **Backstop for a lost message.** The bus does not replay an event published while its LISTEN
  connection is down (`bus.ts:26-28`), and a failed flush is only logged (`:155`). So each pod
  runs a **stream sweep** every 30 s, started and stopped beside the bus: one query over its local
  streams' `(org, email)` pairs,

  ```sql
  SELECT u.org_id, u.email FROM users u JOIN unnest($1::text[], $2::text[]) AS o(org, email)
    ON u.org_id = o.org AND u.email = o.email WHERE u.disabled_at IS NOT NULL
  ```

  and it closes those. One query per pod per 30 s, whatever the stream count. So the bound is about
  1 s with the bus and at most 30 s without it.

### 3.10 Header mode, request by request

```
peer untrusted → null (groups never read)
bearer → token decides alone (groups never read)
known = member(email)        -- the existing SELECT, now with id and idp_groups_digest
groups = groupsFromHeader(headers[TRUSTED_GROUPS_HEADER])   -- or 'absent'
d = digest(groups, breakGlass)
d === known.digest → return known            (no write, no extra query)
else → applyIdpGroups(..., compareDigest: true) → identity with the applied role
new member → provision → applyIdpGroups
```

### 3.11 The digest

- `idp_groups_digest` is `sha256(JSON.stringify([breakGlass ? 1 : 0, ...sortedCanonicalGroups]))`
  in hex, or the literal `'absent'` when the header was missing. It covers every per-user input of the
  decision (the groups and the break-glass flag).
- **The map** is covered by clearing every digest of the org in `admin:setIdpGroup`'s transaction, so
  each header user re-applies on their next request.
- **An absent header** writes `'absent'` once and warns once: no write and no log per request. When
  the header returns, the digests differ and the apply runs again, idempotently.
- OIDC applies at every sign-in without comparing, but writes the digest too, so one code path serves
  both modes.

### 3.12 The R19 label filter (revised after refutation, M5/M6/m1/B1)

`visualForCaller(projectId, v)` in `src/ipc/rowDoors.ts` never computes:

1. **Unchanged** (the same object back) unless the caller is restricted on the project (`restrictedOn`,
   memoised per request) and the visual is **closed**: `closedToCaller(base)` (an unknown dataset is
   closed, as today), or a dataset the question reaches is closed to them (`relatedClosed`, the B1
   gate below).
2. **Closed:** drop `sortOrder`, `seriesColors` (#12) and **`waterfallTotals`**; keep `y2Series` ∩
   `measureNames(encoding)` (`validateDualAxis` makes those the series names of any locked result:
   verdict 2); strip the drivers labels (`encoding.drivers.path` → `[]`, a `bucket` compare's
   `label`/`prev` → `''`; drivers tiles are refused to restricted callers anyway, `rowDoors.ts:73`).
3. **The waterfall still marks its totals, server-side.** `visual:data`, `visual:dataBatch` and
   `analysis:tiles` accept `visualId` (in `FigureAskFields`). When a waterfall request carries no
   `waterfallTotals` and names a visual of the same project AND the same dataset, the server fills the
   STORED totals into the ask (`storedFigureAsk`, rowDoors). `chartShapes.waterfall` marks only labels
   already in the reply (`chartShapes.ts:72-110`), so nothing foreign leaves. The web always sends
   `visualId` for a saved visual's tile, tooltip tile and builder; a request's own totals win (an
   editor's builder). `visual:thumbs` and `story:figures` ask with the stored overrides server-side
   already; their returned `overrides` go through the same strip.
4. **Tags (m1).** For ANY restricted caller every tag in the reply is recomputed over what is sent
   (`contentTag(kind, sent)`): `visual:get`'s, each `analysis:open` visual's and the dashboard's own.
   The stored tag hashes the raw bytes (`editConflict.ts:41-55`), so even an "unchanged" record's
   stored tag can confirm a guess. A restricted caller cannot write, so nothing uses it.
5. **Funnel `steps` (M6): an authored ceiling, R19(a).** They are the definition the server runs;
   dropping one would change every conversion figure, so they are not filtered. Same class as saved
   filter values. Column names a prepare pivot makes from row values are R19(a) metadata (verdict 2).

**B1 — the related-dataset gate (its own commit).** `lockedViz` and `lockedMetric` returned the body
when the base dataset has no lock (`rowDoors.ts:72`, `:89`), so the body's answer cache
(`visuals.ts:464-473`; key = base dataset + spec, no caller state) handed a restricted viewer the
editor's joined labels and figures from a ruled dataset. Now, when the lock is null and the caller is
restricted, every OTHER dataset the question reaches is gated first, before the body and its cache:
`categoryDatasetId`, `seriesDatasetId`, `values[].datasetId`, and the related datasets that supply a
name it uses (`relatedColumnSources`, relationships.ts). Any `closedToCaller` → refuse `related`. The
other null-lock return, `withLockOf`, serves single-dataset bodies (answer cards check every column is
their own, the grid, distinct values) and needs no gate. Copilot facts and tiles go through these doors.

### 3.13 Linked teams when the map changes (revised, verdict 3)

`admin:setIdpGroup` runs under the exclusive people lock and refuses while the mapping is dormant
(`dormant`; the panel hides the editor then). In one transaction:

1. upsert or delete the row;
2. a team whose set of linking groups changed (gained, lost, or lost its last: unlink too) has its
   members deleted;
3. **re-apply at once** for every enabled member with stored groups (`users.idp_groups`, the canonical
   list of their last explicit sync): role (last-admin rule, sequential) and linked teams, one
   `idp:sync` audit row per changed member. That refills the cleared teams immediately: no 7-day OIDC
   gap, and a mapping mistake is fixed without a disable. Members with no stored groups sync at their
   next sign-in or request. ponytail: one loop over the org's synced members per mapping change, fine
   for thousands; set-based if an org outgrows it.

### 3.14 Token-expiry details (revised, M4)

- `tokens:create` requires `expiresInDays` (contract 1–3650; above `API_TOKEN_MAX_DAYS` → `{ok:false,
  error:'expiry'}`); `expires_at = now() + n days`.
- **The effective end of every token** is `least(coalesce(expires_at, 'infinity'), created_at +
  API_TOKEN_MAX_DAYS)`: in `tokenIdentity`, in the list's `expiresAt` and in the 50-token cap. Lowering
  the maximum shortens every token, old and new.
- `tokens:list` → `{tokens, maxDays}`; each row `expiresAt` (effective), `expired`, `legacy`
  (`expires_at IS NULL`). Expired, unrevoked tokens stay listed and do not count toward the cap.
- The page offers 30 / 90 / 365 minus any above `maxDays`, plus `maxDays` below 365; default 90 when
  offered, else the largest.

### 3.15 The Admin → People panel

- **Visibility.** Shown under the people table when `AUTH_MODE` is `oidc` or `header`. Hidden for
  password and dev, where there is no IdP.
- **`admin:idpGroups`** returns `{source: 'oidc'|'header'|null, from: <claim or header name>|null,
  roleManaged, groups: [{group, role, teamId, teamName}], linkedTeamIds}`.
- **States:**
  - dormant (`source` null): a designed notice naming the variable to set;
  - empty: "No groups mapped yet", plus what mapping does;
  - loading skeleton;
  - error state with retry;
  - all in both themes, from the existing `ui` primitives.
- **Edit dialog:** group (text), role (None / Viewer / Editor / Admin), team (None / the org's
  teams).
  - Removing a mapping is setting both to None (`setIdpGroup` with both null deletes the row).
  - The dialog warns: "Anyone in no mapped group becomes a viewer at their next sign-in. Map your
    admins' group first."
- **Unknown team** → `{ok:false, error:'unknown team'}` (the existing `REFUSAL` text).

---

## 4. Migration 0019

`src/server/db/migrations/0019_idp_groups.sql`:

```sql
-- IdP groups → org role and teams (docs/sso-lifecycle/00-design.md).
--
-- Additive only: a new table and two new nullable columns. An older release
-- ignores both: it never reads groups, and keeps roles and teams as stored.
--
-- One row per (org, group): the group maps to an org role, a team, or both.
-- The name is stored as sign-in compares it (Unicode NFC, trimmed) and is
-- matched exactly, case-sensitive. A team named here is LINKED: its members
-- come from the IdP only. The composite key proves the team is the row's
-- org's (teams_id_org, 0006). No RLS, like the other identity tables
-- (users, teams, sessions, api_tokens): it is read at sign-in, before any
-- request context sets ordinate.org, and every statement names its org.
CREATE TABLE idp_groups (
  org_id     text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 256),
  role       text CHECK (role IN ('admin', 'editor', 'viewer')),
  team_id    uuid,
  PRIMARY KEY (org_id, group_name),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  CHECK (role IS NOT NULL OR team_id IS NOT NULL)
);

-- A member's last EXPLICIT group list as sign-in read it (canonical, sorted),
-- so a mapping change re-applies every synced member at once. NULL = none seen.
ALTER TABLE users ADD COLUMN idp_groups text[];

-- What header mode compares per request (writes only on change): the hex
-- sha256 of [break-glass flag, ...idp_groups], or 'kept:<sha>' when the last
-- admin was kept (cleared whenever the org gains an admin). NULL = re-apply
-- at the next request.
ALTER TABLE users ADD COLUMN idp_groups_digest text;
```

- No index on `team_id`: the table holds a few rows per org, and every query names `org_id`, the PK
  prefix.
- `ON DELETE CASCADE` on the team only matters if a team delete is ever added. None exists today
  (grep), and a deleted team cannot stay linked.
- No `updated_at`: nothing reads it.

---

## 5. Steps, in commit order

Each step is one or two small commits. Gates run after each.

1. **R19 label filter.**
   - Code:
     - `rowDoors.ts` `visualForCaller(projectId, v, drawn?)` (§3.12);
     - callers in `visuals.ts:562`, `visualsServer.ts:63`, `versions.ts:75-78`,
       `analysesServer.ts:65,85,87`, `reportsServer.ts` `story:figures`.
   - Tests: `scripts/test-rowPolicyLabels.ts`.
   - Commit: "Filter row-derived chart labels for restricted viewers".
2. **Migration 0019 and the pure mapping.**
   - Code:
     - `0019_idp_groups.sql`;
     - `src/server/idpEnv.ts` + the env reads;
     - `src/server/auth/idpGroups.ts`, with the pure parts (`canonGroup`, `groupsFromClaims`,
       `groupsFromHeader`, `digestOf`, `rolesAndTeams`, `keepLastAdmin`) and `applyIdpGroups`;
     - `withPeopleLock` in `auth/store.ts`;
     - `forgetCaller` in `caller.ts`.
   - Tests: `test-idpGroups` part 1 (pure).
   - Commit: "Add migration 0019 and the IdP group mapping".
3. **Wire the sign-ins.**
   - Code:
     - the OIDC callback and scopes;
     - `headerIdentify` with the digest;
     - `member()` returns id and digest.
   - Tests: `test-idpGroups` parts 2–4.
   - Commit: "Apply IdP groups at OIDC sign-in and in header mode".
4. **Contracts, refusals and the panel.**
   - Code:
     - the `admin:idpGroups` / `admin:setIdpGroup` contracts, and handlers in
       `src/server/admin/idpGroups.ts`;
     - `IdpManagedError` and its app.ts branch;
     - `src/server/idpMessages.ts` (appended to `MAIN_FILES`, i18n regenerated);
     - the `setRole` / `teamMember` refusals, and `setRole` under the people lock.
   - Web:
     - `IdpGroupsPanel.tsx`;
     - People hidden controls, the Teams linked state;
     - Vitest tests;
     - the `admin.e2e.ts` scenario.
   - Commits: "Add IdP group contracts and managed-role refusals", then "Admin → People: identity
     provider groups".
5. **Token expiry.**
   - Code:
     - the contract, handler, read rule, list shape and cap;
     - `TokensPage` picker and column;
     - every `tokens:create` caller updated.
   - Tests: the token suite extended.
   - Commit: "Expire API tokens".
6. **Disable is final.**
   - Code:
     - the atomic disable statement, enable-time and setup revocation;
     - `closeStreamsOf` + CLOSE;
     - logout-everywhere closes streams;
     - the stream sweep.
   - Tests: `test-sse` (unit), `scripts/test-disable-pods.ts`, the token suite.
   - Commit: "Disable revokes tokens and closes streams on every pod".
7. **Docs.**
   - `sso.md`:
     - group mapping for Okta, Entra (overage, "Groups assigned to the application", `roles`) and
       Keycloak;
     - header mode;
     - token expiry;
     - the session advice;
     - the `:183` fix.
   - `configuration.md` rows.
   - Threat model: R5 updated, R19 updated, R20 new.
   - CHANGELOG (Added; Changed: old tokens expire after `API_TOKEN_MAX_DAYS`; Security).
   - A `docs/README.md` row.
   - `deploy/.env.example` lines.
   - The PR body file.
   - Commit: "Document IdP groups, token expiry and disable".

---

## 6. Every fail-open path, and how it fails closed

| # | Path | How it fails closed |
|---|---|---|
| 1 | Claim absent from the ID token | No change, warning per sign-in (spec). Never read as `[]`. |
| 2 | Entra overage (`_claim_names`, `hasgroups`) | No change, warning. Overage wins over a present list. |
| 3 | Malformed claim (non-array, non-string elements) | Treated as absent, never as a partial or empty list. |
| 4 | Groups header from an untrusted peer | `identify` returns null before any header is read (`index.ts:47`). |
| 5 | Groups header on a bearer request | The token decides alone; groups are never read (`index.ts:91`). |
| 6 | A client-sent `X-Forwarded-Groups` passed through the proxy | Outside Ordinate's reach: the same trust as `X-Forwarded-Email`. `sso.md`: the proxy must set or strip it on every request. oauth2-proxy 7 strips the headers it injects; others must be configured to. R20. |
| 7 | Differently-cased or space-padded group | Exact, case-sensitive match after NFC + trim: no inherited role. |
| 8 | A comma inside a group name in header mode | Splits into several names, which CAN match a mapped one (S-L4): mapped names must be groups only IdP admins control (`sso.md`, R20(e)). |
| 9 | DB error during the apply | OIDC: `/sign-in?error=failed`, no session. Header: identify throws → 503. Never proceeds on the old role with a half-applied sync (one transaction). |
| 10 | Mapping variable unset | Dormant: nothing applied, nothing refused (manual as before); the panel says so. |
| 11 | Demoting the last admin, including several admins demoted at once | Org people lock, then `keepLastAdmin` over signed-in admins only. Kept, error log, audit `denied`. |
| 12 | Manual members of a newly linked team | Cleared at link time and refilled by sync (§3.13). |
| 13 | A sync racing a map change (stale digest) | The same people lock: the map change waits, then clears digests. |
| 14 | A token with no stored end | Read-time `created_at + API_TOKEN_MAX_DAYS`. |
| 15 | Re-enable reviving a token | Disable revokes atomically; enable-from-disabled and the setup path revoke again. |
| 16 | Close message lost (bus down) | Stream sweep ≤ 30 s; the stream carries only that user's own pushes meanwhile. |
| 17 | Labels when the locked result is unavailable (refusal, failure, no handler) | Empty labels: every total dropped. |
| 18 | A visual whose labels come from a related ruled dataset | `reachesOther` makes it closed. |
| 19 | Unknown dataset (a version of a deleted visual) | Closed, as today. |
| 20 | Tag oracle | Tag recomputed over what was sent. |

---

## 7. Test plan, one-to-one with the spec's Tests

**1. `scripts/test-idpGroups.ts` (new, -db; part 1 needs no DB).**

- a. **The pure mapping** (`rolesAndTeams`, `keepLastAdmin`):
  - the highest role wins;
  - no match → viewer;
  - no role row → `null` (untouched);
  - break-glass → admin;
  - the last admin is kept, with the control that a second signed-in admin lets the demotion through;
  - canonical form, with the control that `Admins` ≠ `admins`.
- b. **`groupsFromClaims` / `groupsFromHeader`:** absent, null, number, object, an array with a
  number, a string, `_claim_names`, `hasgroups` for `groups` vs `roles`, overage plus a list, an empty
  header.
- c. **OIDC sign-in** through `scripts/mockOidc.ts` (`extraClaims.groups`) sets the role and the
  linked teams. Moving the user between groups changes both at the next sign-in. `OIDC_EXTRA_SCOPES`
  appears in the authorize URL.
- d. **Absent claim and `_claim_names` overage change nothing** (role, teams and digest compared).
  NEGATIVE CONTROL: an explicit `[]` demotes to viewer and removes from linked teams, but not from an
  unlinked team.
- e. **Header groups from a trusted peer apply.** The same header from an untrusted peer leaves the
  DB untouched (control). An unchanged header writes nothing, checked by the users row's `xmin`
  staying the same over three requests. A mapping change makes the next request re-apply.
- f. **`admin:setRole` → 409 `idp_managed`** with the catalog sentence for a managed user. Control:
  200 / ok with no role mapping, and with the variable unset. **`admin:teamMember` → 409** on a linked
  team; control: a manual team.
- g. **The last admin over concurrency.** Three admins and a map that demotes them all; three parallel
  header requests leave exactly one admin. Negative control: without the people lock (a test seam),
  zero.
- h. **Audit:** one `idp:sync` row per changed user (actor, targets); none for an unchanged sync;
  `denied` for a kept admin.
- i. **The memo:** inside `runInContext`, `callerOn` → team A; `applyIdpGroups` moves the user to B;
  `callerOn` → B. NEGATIVE CONTROL: a raw `team_members` change without `forgetCaller` still answers A.
- j. **Linked-team clearing** (§3.13): newly linked → cleared, then refilled by sync; gaining a second
  group → kept.
- k. **Env:** `OIDC_GROUPS_CLAIM` under header mode, a bad header name, `x-forwarded-email` as the
  groups header, and `API_TOKEN_MAX_DAYS=0` / `3651` each refuse to start.

**2. The token suite (`scripts/test-tokens-db.ts`, extended).**

- `expiresInDays` bounds: 0 and 3651 → 400, `max + 1` → `expiry`, 1 and `max` → ok with
  `expires_at` = created + n days.
- An expired token (`expires_at` in the past) → 401.
- A pre-change token (`expires_at` NULL, `created_at` = now − (max + 1) days) → 401. Control: one at
  now − (max − 1) days → 200.
- Disable → re-enable → the old token is still 401.
- Plus:
  - a token of a user disabled the old way (SQL) → re-enable → 401;
  - the list carries `expiresAt`, `legacy` and `maxDays`;
  - expired tokens do not count toward the cap.
- `test-refreshHooks-db` and `test-rowPolicyFanOut` pass `expiresInDays`.

**3. SSE.**

- `scripts/test-sse.ts` (unit, no DB):
  - `closeStreamsOf` closes the target user's local streams only;
  - CLOSE through `deliverLocal` closes;
  - `publish` refuses CLOSE (control: an ordinary channel is pushed).
- `scripts/test-disable-pods.ts` (new, -db): **two real `main.js` pods** (header mode, the
  `test-jobs-pods` spawn pattern):
  - Carol's streams on both pods end within 1 s of `admin:setDisabled` on pod A;
  - control: Dave's streams stay open;
  - `logout-everywhere` closes the same way;
  - with the bus stopped on pod B (a test seam), the sweep closes B's stream within its interval.

**4. Row policy: `scripts/test-rowPolicyLabels.ts` (new, -db, `rowPolicyHarness`).**

- Setup: a waterfall on *Orders* with `waterfallTotals = ['c1', W_CANARY_2]`, a dual-axis visual with
  `y2Series`, and a dashboard holding the visual plus an inline `card.visual` carrying the canary.
- **East (restricted) through every caller of §2.7** (`visual:get`, `visual:thumbs`, `versions:get`
  visual and dashboard, `analysis:gallery`, `analysis:open` visuals and record, `story:figures`) gets
  no canary.
- **Differential:** east's `waterfallTotals` `Object.is`-equals the stored totals filtered by the
  labels the editor's `visual:data` draws on the physical *East* twin.
- **The y2 differential:** `measureNames` ∩ `y2Series` equals the names among the locked reply's
  series names.
- **Control:** the editor gets all of them.
- **Tag:** east's tag ≠ the stored tag and = `contentTag` of what east got.
- **A visual on *Plain* whose `categoryDatasetId` is *Orders*:** east gets no `sortOrder`; control: the
  editor does.
- **The cost:** a spy counts computes. East's `analysis:open` with N closed waterfalls computes N, and
  the thumbnails afterwards compute 0.

**5. Vitest.**

- People shows "From your identity provider" and no role picker for a managed user. Control: the
  picker with no mapping.
- The invite dialog hides the role when managed.
- The IdP panel's dormant, empty, loading, error and list states.
- A linked team shows its source and no "Members…". Control: a manual team.
- `TokensPage`: the picker offers 30 / 90 / 365 with 90 chosen; it is clipped by `maxDays` = 60;
  `expiresInDays` is sent; the "Expires" column, plus the "Expired" and "Made before tokens expired"
  marks.

**6. e2e (`web/e2e/admin.e2e.ts`, a second scenario with `TRUSTED_GROUPS_HEADER` in its env).**

1. The admin maps `bi-editors` → Editor + team Analysts in the panel.
2. A new browser context signs in with `x-forwarded-email: carol@…` and `x-forwarded-groups:
   bi-editors`; `/api/auth/me` says editor.
3. People shows Carol "From your identity provider".
4. Teams shows Analysts with Carol.
5. Light and dark screenshots of the panel, People and Teams, each one looked at.

**Must stay green:** `test-auth`, `test-auth-db`, `test-authz`, `test-authz-db`, `test-admin-db`,
`test-tokens-db`, `test-sse`, `test-jobs-pods`, `test-rowPolicySafetyNet`, `test-embedLock`,
`test-serverDocs`, `test-i18n`, `check-contracts`, `test-file-size`, the admin Vitest and the admin
e2e.

**Measurement for the PR:**

- header mode's per-request cost on an unchanged digest: 0 writes and 0 extra queries (`xmin`, query
  count);
- the cross-pod close latency in ms;
- the label filter's extra computes and `visual:get` cold/warm latency for a restricted caller on a
  waterfall.

---

## 8. Risks and traps

- **Proxy header injection (R20).** If a proxy forwards a client's own `X-Forwarded-Groups`, anyone
  can claim an admin-mapped group. Ordinate cannot tell. The mitigation is the proxy's configuration,
  as for the email header today. `sso.md` states it in bold, with oauth2-proxy's behaviour and the rule
  for others.
- **"Absent keeps" keeps privileges.** Someone moved out of every group whose IdP then omits the
  claim (Okta omits an empty groups claim) keeps their role until an explicit list arrives.
  - This is the spec's accepted tradeoff: it prevents a mass demotion on an IdP misconfiguration.
  - `sso.md` advises a filter that always matches (Okta: include `Everyone`) so the claim is always
    present. Disable remains the immediate stop. R20.
- **The admin locks themselves out of admin.** Mapping roles without mapping their own group demotes
  them at their next sync. Mitigations: the last-admin rule, break-glass, and the dialog's warning.
- **OIDC staleness.** A role or team change at the IdP waits for the next sign-in, at most
  `SESSION_ABSOLUTE_HOURS` (spec; 12 h advised). Tokens carry the user's CURRENT DB role, so a
  token-only user is re-synced only when they sign in.
- **The label filter's compute** on record paths: one cached locked aggregate per closed waterfall with
  totals (§3.12), measured and stated.
- **Shared files with siblings:**
  - `env.ts` and `configuration.md` (item 1): append only;
  - `sse.ts` (item 3): CLOSE, `closeStreamsOf` and `localOwners` are additive;
  - `app.ts` (items 1 and 4): one registration line, one 409 branch, the sweep start and stop beside
    the bus;
  - the threat model: R5, R19 and the new R20 only;
  - i18n: append `idpMessages.ts` and regenerate.
- **The spec's traps:**
  - overage and an absent claim are both tested (§7.1d) with a negative control;
  - header mode never writes per request (§7.1e, `xmin`);
  - the memo (§3.7, §7.1i).

## 9. Found while tracing, outside this item

- `people.ts:39` `OTHER_ADMINS` counts pending invitees as admins for `setRole` / `setDisabled`. The
  IdP path counts signed-in admins only. Left as is for manual edits.
- `analytics[].at` (an annotation pinned to a category) and a visual's own `filters` can name values.
  They are R19(a)'s authored-content ceiling; restated in R19.
- `story:figures` sent raw overrides even when its door refused the chart. Fixed in step 1, recorded
  as a finding.

## 10. Refutation round

An independent reviewer checked this design against d81ebe26. It confirmed the peer check on every
path, `email_verified` refused first, the lower-cased break-glass email, `tokenIdentity` as the one
verifier (the MCP included), the cross-org bindings and the `tokens:list` callers. What it found, and
what the design does now (this table supersedes §3, §5–§7 where they differ):

| Finding | What it was | What this design does now |
|---|---|---|
| B1 (blocker, on develop since #312) | A null lock on the base dataset skipped `reachesOther`, so the answer cache handed a restricted viewer the editor's joined labels and figures from a ruled related dataset. | Gate every reached dataset before the body and its cache; refuse `related` (§3.12). Own commit after the R19 label commit, own CHANGELOG line, named in R19. Test: editor warms the cache, the viewer is refused; NEGATIVE CONTROL with the gate off leaks. |
| M1 | The digest short-circuit would stop header mode restoring the break-glass admin. | `index.ts:51`'s condition (`adminEmail === email && role !== 'admin'`) still sends them through `provision`; `rolesAndTeams` returns admin for break-glass, managed or not. |
| M2 | One exclusive org lock per header apply piles up (a page load is ~25 RPCs, pool max 10). | Single-flight per (org, email) per pod in `headerIdentify`. Syncs take `pg_advisory_xact_lock_shared`; `setIdpGroup`, `setRole`, `setDisabled`, `teamMember` take it exclusive. A sync whose read would demote an admin rolls back and redoes under the exclusive lock, deciding again from a fresh read. |
| M3 | The digest hides drift (a manual change, a kept admin). | `setRole`, `teamMember` and enable clear the target's digest in the same statement. A kept last admin gets `'kept:' + digest` (the short-circuit treats it as current); any transaction that gains an admin clears the org's `kept:` markers. The denied log and audit are rate-limited (once per member per hour per pod). |
| M4 | Lowering `API_TOKEN_MAX_DAYS` left new tokens long. | `least(coalesce(expires_at,'infinity'), created_at + max)` everywhere (§3.14). |
| M5 | Computing a locked result on record paths (`analysis:open` loops every visual; the full handler refreshes, spends Live budget, overlays). | Record paths DROP `waterfallTotals`; the server fills stored totals into the ask from `visualId` (§3.12). |
| M6 | Encoding label fields: funnel `steps`, drivers `path[].value`, a bucket compare's `label`/`prev`. | Drivers labels stripped; funnel steps an R19(a) authored ceiling (§3.12). |
| m1 | Tags. | Every tag recomputed for any restricted caller (§3.12). |
| m2 | `teamMember`'s check-then-insert raced `setIdpGroup`. | Under the exclusive people lock. |
| m3 | Two last-admin rules. | One rule everywhere: other enabled admins who have signed in (`OTHER_ADMINS` in `people.ts` included). |
| m4 | Other session ends left streams open; a disable racing a stream open. | Streams carry their session's hash. `admin:resetPassword` and `endOtherSessions` (keeping the current session's stream) close streams too. The 30 s sweep also closes streams whose session is gone, expired or idle. A stream cannot open after the disable commits: sessions go in the same statement and `identify` refuses a disabled user; one that opened just before is the sweep's. |
| m5 | An absent header must not write. | Absent → `known` as is, no write; a warning once per member per hour per pod and a counter (`idp_groups_absent`). |
| m6 | Tests that pass with the bug. | 1g uses a barrier hook (released when `pg_locks` shows the second sync waiting, or, lock off, when both arrived); the y2 differential plants a raw `y2Series` in a VERSION record; the related case warms the cache. Added: bearer + groups header from a trusted and an untrusted peer, break-glass in header mode, the kept admin re-evaluated, the maximum lowered. |
| Verdict 3 | Linked-team refill gap. | Clear on unlink too; store `users.idp_groups`; `setIdpGroup` re-applies every synced member at once (§3.13). |
| Verdict 4 | Absent header = no change. | Acceptable with a stated requirement: `sso.md` and R20 require the proxy to admit only members of an allowed group (oauth2-proxy `--allowed-group`) and to set or strip the groups header itself; plus m5. |
| Verdict 5 | ID token only. | `sso.md`: Okta "Include in: ID Token", Keycloak "Add to ID token", Entra overage (> 200 groups → permanently absent: use "Groups assigned to the application" or `roles`). |

Steps (§5) gain step 1b, the B1 gate, right after the label filter. No `console.*` in `src/`: each
module logs through the logger it is handed (`app.log`, the request's log).

## 11. Review round (two reviewers, head 749f5509)

Confirmed sound: the locks, the disable CTE and enable/setup revoke, the token `least()` rule and bounds,
CLOSE routing, `visualId` scoping, recomputed tags, the groups header behind `isTrustedPeer`, bearer
decided by the token alone, the claim parsing, NFC and case-sensitive matching, the admin contracts, the
last-admin rule across pods, the R19 paths and the B1 gate's placement. Fixed, each with a test that
fails before the fix:

| Finding | What it was | What the code does now |
|---|---|---|
| C1 | The B1 gate checked every dataset reachable through relationships, so a star schema with rules on one dimension refused charts over the OPEN ones; `visualForCaller` over-stripped the same way. | Only what the body reads is gated: the datasets named by id and the join plan's tables (`chartReads` = `resolveVizJoin(...).plan.tables`, `metricReads` = `planTables` with `resolveColumnOwner`). Relationships are listed once per call. NEGATIVE CONTROL: east's chart, KPI and custom order over an open dimension. |
| C2 | A kept marker survived the org gaining an admin through an invited admin's first sign-in (admin → admin). | `provision` clears `kept:` markers after the upsert whenever the member is an admin; every non-kept admin sync does too. |
| C3 | The member-by-member re-apply was order-dependent. | Promotions to admin are counted first (kept in the set-based re-apply). |
| C4 | An invite kept its role under IdP-managed roles. | Stored as viewer server-side; the web sends viewer and resets a cancelled invite. |
| C5 | People drew the live role picker while `admin:idpGroups` loaded or failed. | The role is text until it is known who decides. |
| C7 | Header single-flight joined requests with different groups. | Keyed by `org, email, digest`. |
| C8 | The tokens page hid "New token" when the list failed. | The dialog uses the default maximum until the server's is known. |
| C9 | Weak tests. | The bearer test asserts the row was not written (`xmin`); the reconnect refusal is checked on both pods. |
| S-M1 / C6 | Re-applying 15,000 members held the exclusive lock 27.4 s here; 21 of 30 concurrent syncs could not get a pool connection and an unrelated `SELECT 1` timed out at 3 s. | The re-apply is set-based (`auth/idpReapply.ts`: four reads, the decision in memory, at most five writes, the audit in one statement): **1.5–1.8 s for 15,000 members, `SELECT 1` 16–23 ms, 30/30 syncs applied** (`scripts/measure-idpReapply.ts`). A sync takes one of 3 per-pod slots and waits at most 2 s for it and for the lock (`lock_timeout`); past that, header mode answers the member as stored (nothing written) and OIDC tries once more, then signs in with the stored role. An unchanged mapping re-applies nobody; an unchanged sync writes nothing. |
| S-L3 | A map change granted from stale stored groups (a token-only leaver). | 0019 adds `users.idp_groups_at`. A re-apply always takes away; it GRANTS (role up, team adds) only from a list read within `SESSION_ABSOLUTE_HOURS`, and clears the digest of a member whose grant it withheld, so header mode re-reads them at their next request. |
| S-L4 | A comma can grant a mapped group. | Design §3.4, R20(e) and `sso.md`: mapped names must be groups only IdP admins control. |
| S-L5 | A bearer-token event stream outlived the token. | Streams record the token's hash; `tokens:revoke` closes that token's streams over the bus (`token:<hash>`); the sweep closes streams of revoked or expired tokens. |
