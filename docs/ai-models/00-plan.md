# AI models: admins set them up, members pick one

Status: plan, not started. Base: `origin/develop` @ c110491.

## 1. The problem

Today AI setup lives in the wrong place and is shaped wrong:

- The **Assistant dock** holds the "Connect a provider" form (`web/src/features/assistant/Connect.tsx`).
  An admin pastes a key in the chat panel; a member sees "ask an admin" in the same spot.
- The org has **one active provider and one model** (`byok.activeProvider` + that provider's `model`).
  Members cannot choose; switching changes it for everyone.
- **Admin → Settings** has only "AI providers members may use" checkboxes (`org_settings.ai_providers`),
  which is a provider gate, not a model list.
- **A real bug behind it:** everything except the key (which provider is connected, verified,
  active, which model, the gateway URL) is in a per-org **`config.json` on the pod's local
  disk** (`src/app/config.ts` → `DATA_DIR/orgs/<org>/userData/config.json`), with an in-process
  cache. With 2+ pods, an admin connects on pod A and pod B still says "not set up". The key
  itself is fine (Postgres secrets store, `src/server/aiKeys.ts`).

## 2. What we build

**Admins** get an **Admin → AI** tab. They connect each provider once (key is write-only and
encrypted) and choose the **exact models** members may use, plus one **default**. It's an
allow-list: a model the provider releases tomorrow is not available until an admin adds it, so
cost stays in their hands.

**Members** never see keys or connect forms. The dock header has a **model picker** listing only
the models the admin enabled. Each person's pick is remembered on the server, so it follows them to
every tab and every AI feature (Assistant, Home ask, suggestions, captures, explain). If nobody has
set AI up, a member reads "AI isn't set up for your organization yet. An admin can turn it on in
Admin → AI." An admin sees the same message with a **Set up AI** button.

All of it moves to **Postgres**, which fixes the multi-pod bug.

### Decisions (and what we are not doing)

| Decision | Why |
|---|---|
| Allow-list of models, not a block-list | New/expensive models never appear on their own |
| One org default; per-user pick stored server-side | The server picks the model on every call, so every AI feature honours it with no contract changes |
| A pick whose model was removed falls back to the default, silently | Nothing to fix for the member; the picker shows what will answer |
| Connect = save key + live test in one action; "connected" means the test passed | Same rule as today (Active requires Connected), one button instead of three |
| AI needs Postgres + `ORDINATE_MASTER_KEY` (as today for keys) | No DB = nowhere safe for a key; the tab says so to the admin |
| The separate "AI providers members may use" checkboxes go away | The model list *is* the policy; a provider with no enabled model is off |
| **Not now:** models per role/team, per-user budgets, usage/cost reporting, renaming models | No need yet. Add per-role access when someone asks; usage needs token counts we don't record |

## 3. Data model — `src/server/db/migrations/0013_ai_models.sql` (additive only)

```sql
-- An org's connected AI providers. The API key is NOT here: it is in the
-- secrets store (0002), (org, 'ai.apiKey', provider). verified_at is the last
-- passing connection test; NULL = saved but not connected.
CREATE TABLE org_ai_providers (
  org_id      text        NOT NULL,
  provider    text        NOT NULL,           -- zod-validated: anthropic|openai|gemini|gateway
  base_url    text        NOT NULL DEFAULT '',
  verified_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider)
);

-- The models members may pick, in list order. Exactly one default per org.
CREATE TABLE org_ai_models (
  org_id     text    NOT NULL,
  provider   text    NOT NULL,
  model      text    NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  label      text    NOT NULL,                 -- the provider's display name, or the id
  position   integer NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, provider, model),
  FOREIGN KEY (org_id, provider) REFERENCES org_ai_providers ON DELETE CASCADE
);
CREATE UNIQUE INDEX org_ai_models_one_default ON org_ai_models (org_id) WHERE is_default;

-- Each person's pick. Removing the model removes the pick → the org default.
CREATE TABLE user_ai_model (
  org_id   text NOT NULL,
  user_id  <same type as users.id> NOT NULL,
  provider text NOT NULL,
  model    text NOT NULL,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, provider, model) REFERENCES org_ai_models ON DELETE CASCADE
);
```

Forced RLS on all three, the same pattern as `0007_records.sql` / `0012_live_usage.sql`.
`org_settings.ai_providers` stays (additive rule) but is no longer read after the legacy import.

## 4. Server

New module **`src/server/aiConfig.ts`**, the one owner of this state, read from Postgres on
every call (no in-process cache, same reasoning as `aiKeys.allowedProviders()`):

- `adminView()` returns the providers with `{connected, hasKey, baseUrl, verifiedAt}`, the models, the
  default, and `keyStore` (`aiKeys.keyStoreUnavailable()`). It never returns a key.
- `connect(provider, {apiKey?, baseUrl?})`: stores the key with `aiKeys.putKey`, upserts the row, runs
  `testProvider`, and sets `verified_at` only on a pass. Returns the test result.
- `disconnect(provider)`: `aiKeys.deleteKey`, then deletes the row (cascade removes its models and picks).
- `setModels(list, defaultIndex)`: replaces the list in one transaction. Every provider must be
  connected, there are at most 50 models, and exactly one is the default.
- `memberView(userId)` returns `{ready, reason?, models, mine}`. `mine` is the effective model,
  meaning the user's pick if it is still enabled, otherwise the default.
- `resolve(userId)` returns the `{provider, model, apiKey, baseUrl}` for one call, or a typed not-ready.
- **Legacy import, once per org.** It runs when the org has no `org_ai_providers` row.
  - It reads the org's `config.json` byok block. For each provider with `keyStored`, it inserts a
    row (`verified_at = now()` if `verified`) and that provider's model.
  - The model of the old active provider becomes the default. Providers that `ai_providers`
    disallowed are skipped.
  - It uses `ON CONFLICT DO NOTHING`, so two pods racing is harmless. It never edits `config.json`.

Wiring:

- `src/ai/byok.ts` `resolveByok()` / `modelStatus()`: in server mode, delegate to
  `aiConfig.resolve(ctx().user.id)`. This one resolver is used by every model call, so every
  feature follows the user's pick. `execConfig.byokCredentials()` on the server reads `base_url`
  from `aiConfig` rather than `config.json`.
- `testProvider(provider, model?)` uses the given model, then the provider's first enabled model,
  then `BYOK_DEFAULTS`.
- `src/ai/models.ts` `listModels()` already fetches a provider's live model list. Reuse it.

New contracts in **`src/api/ai.ts`**, appended to `src/api/index.ts`:

| Channel | Access | Input | Does |
|---|---|---|---|
| `ai:status` | `read`, org | none | `memberView` |
| `ai:setMine` | `read`, org | `{provider, model}` | refused unless the model is enabled |
| `ai:admin` | `admin`, org | none | `adminView` |
| `ai:connect` | `admin`, org | `{provider, apiKey?(≤4096), baseUrl?(url ≤2048)}` | save and test |
| `ai:disconnect` | `admin`, org | `{provider}` | |
| `ai:providerModels` | `admin`, org | `{provider}` | `listModels(provider)` (SSRF-guarded via `providerFetch`) |
| `ai:setModels` | `admin`, org | `{models: [{provider, model, label}] ≤50, defaultIndex}` | |

- Every write publishes the existing `key:changed` SSE to the org, so open docks re-read.
- `key:status` and `byok:saveProvider|test|activate` stay registered (contracts are append-only)
  as thin wrappers over `aiConfig`, so nothing that still calls them breaks. `key:status.isReady`
  equals `ai:status.ready`.
- Server sentences go through `t()`. Reword `errNoKey` and the "does not allow" message to:
  "AI isn't set up for your organization. An admin can turn it on in Admin → AI."

## 5. Web

### Admin → AI tab: `web/src/features/admin/AiTab.tsx` (+ `AiModelsDialog.tsx`)

- **If no key store:** show one panel naming `DATABASE_URL` / `ORDINATE_MASTER_KEY`, with a link to
  `docs/server/configuration.md`. Nothing else renders.
- **Providers:** a row for each of Anthropic, OpenAI, Google Gemini, and OpenAI-compatible gateway.
  - The status badge shows *Connected · tested 3 min ago*, *Not connected*, or *Test failed: …*.
  - When not connected, **Connect** expands an inline form.
    - The API key field is a password input. It is write-only, never prefilled, and cleared after sending.
    - The base URL field is required for the gateway and sits under "Advanced" for the others.
    - The Connect button saves the key and tests it, then shows the provider's error inline if it fails.
  - When connected, the row offers **Test again**, **Replace key**, and **Disconnect**. Disconnect
    asks for confirmation: "Members lose 2 models."
- **Models members can use:** a table with columns Model, Provider and Default (radio), plus a
  remove button on each row.
  - **Add models** opens a dialog. Pick a connected provider and its live list loads
    (`ai:providerModels`) with search and checkboxes, plus an "Enter a model id" field for the
    gateway or unlisted ids. Then **Save**.
  - Empty state: "No models yet. Connect a provider, then add the models your team may use."
- A footnote: "Keys are encrypted with this server's master key and never shown again."
- Remove the "AI providers members may use" group from `SettingsTab.tsx`, and make `aiProviders`
  optional in the `admin:setOrgSettings` input if the form no longer sends it.
- Every list has a designed loading (skeleton), empty and error state, in both themes.

### Dock and every other AI surface: `web/src/features/assistant/`

- **Delete** `Connect.tsx` / `Connect.module.css`, and remove "Connect a provider…" from `ModelChip`'s menu.
- **`ModelPicker`** goes in the dock header, replacing `AiPill` / `ModelChip`.
  - It uses the existing `ui/Select`. Options are grouped by provider and show the label, with
    "Default" marked on the default.
  - Changing it calls `ai:setMine` and invalidates `ai:status`.
  - With exactly one model there is no dropdown, just the label as text.
- **`AiNotReady`** is one shared component.
  - A member sees the sentence above.
  - An admin also gets a **Set up AI** button that goes to `/admin?tab=ai`.
  - When there is no key store, an admin sees the operator line.
  - Use it everywhere that now shows a connect prompt or reads `useKeyStatus`: Dock, AnalysesPage,
    NewWizard, Visuals Editor, NewVisualDialog, VisualsPage, and Home. Grep `useKeyStatus` and
    "Connect a provider".
- "Powered by X" names the picked model, not just the provider.
- `useKeyStatus` becomes `useAiStatus` (`ai:status`), so there is one hook.

## 6. Tasks, order, owners

```
AI1 server  ──►  AI2 admin tab   ┐
                 AI3 dock+surfaces├─►  AI4 docs + security review
```

AI2 and AI3 run in parallel after AI1 is merged. They share no files: AI2 owns `features/admin/*`, and
AI3 owns `features/assistant/*` plus the call sites listed in §5. Only AI1 touches `src/api/index.ts`,
the migrations and `src/server/*`.

| Task | Done when |
|---|---|
| **AI1** | Migration, `aiConfig.ts`, the contracts and handlers, `resolveByok` wiring, legacy import. `test-aiModels-db` covers everything listed under "AI1 tests". `npm test`, `npm run lint` and the contract check are clean, CI is green, and the PR is merged. |
| **AI2** | The Admin → AI tab as in §5, Vitest tests, `web/e2e/admin.e2e.ts` covering the tab (connect with a stubbed provider, add models, set the default), screenshots looked at in light and dark, the size budget held. |
| **AI3** | The picker, `AiNotReady` everywhere, `Connect.tsx` deleted, Vitest tests, the assistant e2e updated, no surface still says "Connect a provider" or "add one in Settings". |
| **AI4** | `docs/server/ai.md` (an admin's walkthrough), the threat-model row updated, the CLAUDE.md AI bullet updated (one or two lines), a `docs/README.md` index entry, and an adversarial pass with every finding fixed or written down. |

**AI1 tests** (`scripts/test-aiModels-db.ts`, Postgres; providers stubbed the way `test-dockServer` does it):

- **Two pools = two pods.** Connect on A, and B is ready with the same models. NEGATIVE CONTROL: the
  old `config.json` path reports not-ready on B.
- **Picks.**
  - A member's pick is what `resolveByok` returns.
  - When the admin removes it, the call uses the default.
  - `ai:setMine` with a model that isn't enabled is refused.
  - A pick in org A is invisible in org B.
- **Access.**
  - A member calling `ai:admin`, `ai:connect`, `ai:setModels` or `ai:providerModels` gets 403
    before the handler runs.
  - A viewer can `ai:status` and `ai:setMine`.
- **Canary.** A planted key is absent from every reply (`ai:admin` included), every log line, every
  SSE frame and `DATA_DIR`.
- **Legacy import.** An org with an old `config.json` (2 providers, one disallowed by
  `ai_providers`) imports exactly the allowed one with its model as the default. Two pods importing
  at once leave one set of rows.
- **RLS.** Running as an ordinary role, with the wrong `ordinate.org`, returns no rows.
- `setModels` with a provider that isn't connected is refused. Two defaults, or none, are refused.

## 7. Rules every agent follows

These come from CLAUDE.md, with the extra ones for this work:

- **Worktree.** Use one worktree per task off `origin/develop` under `.claude/worktrees/`. Never
  commit to `develop`, and never `git checkout` in the shared clone.
- **Pushing.**
  - No push or PR on weekdays between 08:00 and 18:00. A hook blocks it. Commit, stop, and report.
  - No `Co-Authored-By` trailer.
  - **No tag, no release, no image push.**
- **Server code.**
  - The server does the math.
  - Every channel has a zod contract with the narrowest access.
  - Every cache is keyed with `orgKey()`. This plan adds none.
  - Secrets are never logged or sent to the browser.
- **Size, strings and dependencies.** Files are ≤500 lines (soft) and ≤800 (hard). Server strings go
  through `t()`, then `i18n-extract`. Ask before adding a dependency (none is needed).
- **Web pages.** Every new page state is designed, in both themes. The e2e must have no console
  errors and no CSP violations, and must stay within the RPC budget.
- **Branches.** If a PR shows no checks, read `mergeStateStatus`. Resolve conflicts by keeping both
  sides.
