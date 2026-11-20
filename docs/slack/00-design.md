# Ordinate in Slack

Feature 2 of the ten Lightdash-parity AI features. Agreed with the owner on 2026-11-14; brought up to date
with the new ask flow on develop on 2026-11-19 (the changes are listed under "What changed with the new ask
flow"). The illustrated version, with every step and its server detail, is the claude.ai page "Ordinate in
Slack". The research behind it, on Lightdash and nine other tools, is `01-research.md` beside this file.

## Why

People live in Slack, not in a BI tool. A quick "what was X last month" should be answered where it was
asked, in the thread where the team discusses it. Every tool that does this today (Lightdash, Metabase,
ThoughtSpot, Omni, Hex, Databricks) either posts the answer for the whole channel, whatever each member
may see, or makes every answer private. Ordinate knows which datasets an answer showed and what decided
each person's view of them, so it can do better: post when it is safe, and only then.

## What people see

1. **Setup, once, by an org admin.** Admin → Slack shows an app template (manifest) with this server's
   address filled in. The admin creates the app in Slack, pastes its keys back, and picks how Slack
   reaches Ordinate: Slack calls Ordinate (needs a public address; the default) or Ordinate calls Slack
   (Socket Mode; works behind a firewall). A project admin ties channels to agents on the agent's page.
2. **Linking, once per person.** The first question from an unknown Slack user gets a private Connect
   button. The person signs in to Ordinate, then "Sign in with Slack" confirms their Slack account, and
   the link is saved. Their question is then answered.
3. **Asking.** `@Ordinate` in a channel tied to an agent (the answer goes in a thread), or a private
   message to Ordinate. A channel with no agent gets a reply that it isn't connected yet and that a
   project admin can connect it; no project is guessed.
4. **The answer.** A sentence, a Slack chart when the result fits Slack's chart block, otherwise a table,
   plus Open in Ordinate and Helpful / Not helpful. A footer names the agent, the datasets and whose access
   was used.
5. **When it can't be posted.** The channel gets a fixed note ("I sent you the answer privately…") with
   Open in Ordinate; the asker gets the full answer by direct message.

## Rules

Agreed with the owner:

1. **Each company creates its own Slack app** from a manifest Ordinate generates. No vendor service in the
   path. This also keeps the app "internal customer-built", which Slack exempts from its 2025 rate limits
   on unlisted distributed apps.
2. **Link accounts with two sign-ins; never match by email.** `users:read.email` is not requested. A link
   stores who someone is, never what they may see; every question re-reads the Ordinate account.
3. **Same ask as the app, on Ordinate's server,** as the linked user, with the org's configured AI model.
   Slack carries text in and out only. Answer only: nothing is built from Slack.
4. **One agent per channel,** set by a project admin. An unmapped channel gets a reply, never a guess.
5. **Direct messages** use the linked user's selected assistant, or the composer's preselection rule. The
   asker is the only member, so the check always passes.
6. **Case A, no restricted data.** If no dataset the answer showed is restricted, the answer is posted in
   the thread, even when some members haven't linked or have no Ordinate account: a project admin chose
   to connect this channel to this assistant.
7. **Case B, restricted data.** Every channel member must be linked, able to read that data, and see it
   exactly as the asker does. Anyone unlinked, unable to read it, or with a different view sends the
   answer to the asker privately. Both directions fail: an admin asking with a restricted viewer present,
   and a restricted viewer asking with an admin present (the admin would see partial figures that look
   like totals).
8. **Channels shared with another company never get figures,** in case A or B. People from another
   Slack organization can never link and are never answered.
9. **A thread belongs to its first asker.** Another member's question in that thread becomes their own
   conversation, run as them and checked on its own.
10. **Share to channel** re-runs the check against the channel's current members. Only an org admin
    setting (off by default) can let an asker post past a failed check.
11. **Charts use Slack's `data_visualization` block only when the result fits exactly.** Anything else
    is a table plus Open in Ordinate. No forced fits: no stacking Slack can't draw, no "Other" bucket the
    engine never computed.

Known limit, accepted: the check runs when the answer is posted, so people who join the channel later can
read earlier answers.

## What changed with the new ask flow (2026-11-19)

Reading develop changed five things. The first two are departures the owner should confirm.

1. **Restricted includes team folders.** Team folders now decide who opens a dataset (0036,
   `src/server/authz/folderGate.ts`). A dataset in a folder that is not open to everyone is restricted,
   like one with row rules or hidden columns: it goes through case B. Case A is a dataset with no row
   rules, no hidden columns, and open to everyone who can read the project.
2. **A Slack post is a new share path.** Whatever leaves the app passes the project's share policy
   (`src/app/sharePolicy.ts`; export, report, publish, bundle). A Slack post leaves the app, so `slack` is
   appended to `SHARE_PATHS` with default `mask`, and `applyToChart` / `applyToTable` run on the card
   before it is posted, in a channel or a DM. When the policy masks or drops anything in the card, the
   post uses a fixed caption instead of the model's sentence, which could quote a raw value.
3. **The ask is called through its handler, after the RPC layer's check.** A Slack question calls the
   registered `copilot:ask` handler, as `src/ipc/reportsServer.ts` already does for reports, inside
   `runInContext(user)`. Calling a handler skips the RPC layer, so the job first runs the same
   `authorize()` (`src/server/authz/index.ts`) for that user on the contract and the channel's project.
   No change to `copilot.ts` is needed: no `askId` means no streaming and no activity chips, and Slack
   simply ignores any non-answer `suggestedAction`, so nothing is ever built.
4. **Which datasets the answer showed comes from the stored turn,** not a recording scope: `shows()` in
   `src/ipc/turnsOpen.ts` (the chart's dataset, every "Did you mean" option's, every one an SQL answer
   read, and `factsFrom`, which a prose answer has too), plus `dashboardsFrom`. The reply to the browser
   strips `factsFrom` and `dashboardsFrom`, so the check reads the stored turn.
5. **Comparing two people's views uses `accessPrint`** (`src/ipc/answerSnapshots.ts`: row lock, hidden
   columns and view, as one sha256), run as each member with `asMember` (`src/server/requests/where.ts`).
   Dashboard requests already compare prints this way. The print covers rows and columns only, so the
   check also asks each member's project read and folder level.

Also: migrations are at 0040, so this is `0041_slack.sql` (no open PR adds one today; CI's migrations job
catches a clash). Slack's OpenID sign-in answers with a `form_post` back to the callback, a cross-site
POST that carries no SameSite session cookie, so the callback authenticates by its one-time state row,
never the session.

## Changes after the independent review (2026-11-20)

The build was reviewed against the code; each finding below changed behaviour, and has a test in `scripts/test-slackReview.ts`
(and `test-slackRls.ts`, `test-slackLogs.ts`).

- **Source tables are never offered to Slack.** A Slack ask has context `{kind:''}`, a Home question, which would offer the
  project's source tables; an answer over one names a document id that no folder, row rule or column rule is recorded for.
  `ask.ts` adds `context.noSources` after the input has parsed (the contract has no such field, so an RPC caller cannot set it)
  and `homeTables` returns none for it. As a second guard, any turn with `answer.table` or `sql.table` is never posted in a channel.
- **Every replayed turn is checked.** The handler hands the earlier turns' words to the model, which may quote them. The check
  takes the union of `shows()` and `dashboardsFrom` over every assistant turn the model was replayed (`openTurns` of the
  conversation), not only the last one.
- **An `outside` turn never goes to a channel.** It names a dataset but records no `factsFrom`; it is private to the asker.
- **Share policy, whole answer.** When the card was masked or dropped, the model's title is replaced as well as its sentence.
  When any dataset the answer was built from has a marked column and the `slack` policy is not `include`, the sentence is
  replaced by the fixed caption even if the card was untouched (a sentence cannot be shaped, only kept or replaced). An SQL
  card is withheld whole when the statement names a marked column the result does not (`phone AS contact`), for every such column.
- **`tokens_revoked`.** Only a revoked bot token of this install (`tokens.bot` holds its bot user) switches the install off, as
  `app_uninstalled` does. A person's user token (`tokens.oauth`) drops only that person's link.
- **A channel belongs to one project.** Moving a channel that another project's agent holds needs an admin of that project (or an
  org admin). The picker says only "used by another project", never that project's or its agent's ids. A channel whose project is
  deleted or archived stops answering and its mapping is dropped (on use, and by the sweep).
- **No copy of the card.** `slack_questions.answer` holds ids and names only (where the stored turn is, what it showed, the
  asker's view then). Delivery and Share to channel re-read the stored turn and its snapshot, so a card is shown only while the
  asker's access is what it was when it was computed.
- **A retaken question repeats nothing.** The ask's outcome is stored before anything is posted; `delivered_at` and `dm_at`
  record the post and the private answer. A pod whose heartbeat reports the lease lost stops (its signal aborts).
- **The ask is bounded like an RPC:** the same time limit (`RPC_TIMEOUT_SECONDS`, an aborted ask stops its DuckDB queries) and
  the same per-user budget (`RATE_LIMIT_RPC_PER_MINUTE`, per pod); over either, a fixed sentence. A first question's conversation
  is made as `copilot:newThread` makes it, refusing an agent the asker may not use. A person who must change their password gets
  a fixed sentence.
- **Linking.** The id_token's RS256 signature is verified against Slack's JWKS (`verifySignature` in `linking.ts`) as well as its
  claims. Only the sha256 of a Connect token is stored. A parked question is dropped, and its text with it, when its Connect
  state expires.
- **Row-level security** is forced on the six Slack tables that hold org data (`0041_slack.sql`), on four scopes
  (`ordinate.org`, `ordinate.slack_team`, `ordinate.slack_state`, `ordinate.slack_scope = 'system'`); `db.ts` `scoped()` sets them,
  and `test-slackRls.ts` runs the store as an ordinary role.
- **Idle.** The worker does not claim while no workspace is switched on.

## Approaches considered

1. **Customer-created app; Events API by default, Socket Mode as an option; Postgres queue.** (Chosen.)
   Fits "any pod serves any request" and works behind a firewall.
2. **One vendor-hosted Slack app relaying to every install.** Rejected: puts a vendor service in the data
   path and breaks "no surprise network calls".
3. **Answer inline on the pod that received the event** (Metabase's design). Rejected: a pod dying
   mid-answer loses the reply, and Metabase's code has no retry de-duplication.

For the channel question: broadcasting under the asker's rights (Lightdash, Metabase, ThoughtSpot) leaks;
making every answer private (Power BI; an option in Omni and Databricks) loses the shared thread; link-only
replies (Hex, Lightdash) put no number in Slack. The case A / case B check is the chosen middle.

## How it is built

**Code layout.** A new `src/server/slack/` folder, one job per file and each under 500 lines: routes,
signature, events, queue, worker, client (Web API calls), linking (OIDC), check, render, socket, admin.
Contracts in `src/api/slack.ts`. Web: `web/src/features/admin/slack/` (setup), a "Slack" row on the
profile page (link), and a "Slack channels" field on the agent page (`web/src/features/model/assistant/`).

**Routes** (Fastify, self-authorizing like `src/server/hooks/route.ts`: no session, CSRF-exempt, the
signature or the state row is the credential):

- `POST /api/slack/events` and `POST /api/slack/interactions`: verify HMAC-SHA256 of
  `v0:<timestamp>:<raw body>` with the signing secret in constant time; refuse a timestamp more than
  5 minutes off; answer `url_verification` after the check. Keep the raw body for the HMAC.
- `GET /api/slack/connect?s=<token>`: the normal session gate; records the signed-in Ordinate user on the
  state row, then redirects to Slack.
- `GET` and `POST /api/slack/connect/callback`: CSRF-exempt; authenticates by the state row (single use,
  10 minutes) and the verified id_token, never the session cookie.

**Receiving, inside Slack's 3 seconds:** `INSERT INTO slack_events (event_id) … ON CONFLICT DO NOTHING`
(a retry hits the unique key and is acknowledged as a no-op), insert a `slack_questions` row `pending`,
reply 200. An unknown `team_id` is acknowledged and dropped.

**Reading events:** `app_mention` and `message.im`; ignore anything with a `bot_id`, any `subtype`
(edits, deletes) and Ordinate's own posts; strip the `<@U…>` mention and decode Slack's `&lt;` `&gt;`
`&amp;`; the same length cap as `copilot:ask`. `app_uninstalled` and `tokens_revoked` mark the install off
and drop pending questions.

**Answering, on any pod.** Claim a `slack_questions` row with `FOR UPDATE SKIP LOCKED`, a lease and a
heartbeat (the `src/server/jobs/runner.ts` pattern), so a crashed pod's question is retaken. Then:

1. Post a "Working on it…" placeholder with `chat.postMessage`, keeping its `ts`.
2. `slack_links` → user; read their org role (`users`, not disabled), as `asMember` does. Unknown or
   disabled → treated as unlinked.
3. Choose the project and agent: the channel's `slack_channel_agents` row, or for a DM the person's
   selected assistant, else the composer's preselection rule (`agent:list`).
4. `runInContext(identity)` with no `via` (so the agent applies; `via: 'token'` would force the Project
   assistant), then `authorize()` for `copilot:ask` on that project. Refused → a fixed sentence, nothing
   read.
5. Call the registered `copilot:ask` handler with `{ projectId, question, threadId, agentId }`.
6. Read the stored turn (`copilot.loadHistory`) for `shows()` and `dashboardsFrom`.
7. Run the check, build the message (share policy first), `chat.update` the placeholder, send the
   private answer by DM if needed (`conversations.open` + `chat.postMessage`; never an ephemeral message,
   which vanishes on reload), write an audit row.

Slack `429`: wait for `Retry-After` while keeping the lease. Slack allows about one message per second per
channel: each answer is one post and one edit.

**Linking.** An unknown `(team_id, user)` parks the question as `awaiting_link`, creates a
`slack_link_states` row (random 32-byte token, team, Slack user, question id, 10-minute expiry, single
use) and sends `chat.postEphemeral` with the Connect button. `/api/slack/connect` writes the signed-in
Ordinate user onto the state row and redirects to `https://slack.com/openid/connect/authorize` (scope
`openid`, `state`, `nonce`) through `openid-client` (already a dependency), with discovery at
`https://slack.com/.well-known/openid-configuration` and keys at `https://slack.com/openid/connect/keys`.
The callback exchanges the code at `openid.connect.token`, verifies the id_token (signature, `aud`, `nonce`)
and requires its `https://slack.com/user_id` and `https://slack.com/team_id` to equal the state row's;
otherwise it refuses ("This Connect button belongs to another Slack account"). Then it inserts
`slack_links`, marks the state used, and sets the question back to `pending`. Users from another Slack
organization (`users.info`: other `team_id`, or `is_stranger`) are refused at Connect. Outbound calls go
through the SSRF guard the way `src/server/auth/oidc.ts` already reaches its IdP.

**The check.**

1. `conversations.info`: `is_ext_shared` → private, in both cases. A DM (`im`) → pass.
2. Restricted? For each dataset in `shows()`: row rules (`policyClosed()`), column rules, or a folder not
   open to everyone. None restricted and no `dashboardsFrom` → case A → post.
3. Case B: `conversations.members` (paginated, bots removed; more than 500 members → private);
   `users.info` for each (another `team_id` or `is_stranger` → fail; `is_restricted` or
   `is_ultra_restricted` guests fail unless the org setting allows guests); one `slack_links` query (any
   unlinked → fail). Then, as each linked member (`asMember`): `authorize()` read on the project, folder
   level not `'none'` for every dataset and dashboard, and `accessPrint()` equal to the asker's for every
   dataset. Any difference fails. Memoize within one check only, never across questions.

**The message.** The card comes from the stored turn's snapshot (`AnswerSnapshot.card`, wire-encoded) or
the reply's browser turn. Figures are the engine's, formatted on the server before `t()`. The model's
sentence has passed `guardAnswer` and the number audit inside the ask; it is then escaped for Slack
(`&`, `<`, `>`) so it can never produce `<!channel>`, `<!here>`, `<@U…>` or a hidden link. The share
policy (`slack` path) runs on the card first. A table block shows at most 20 rows ("Open in Ordinate for
all N rows"). No SQL text, file path or connection URL. Open in Ordinate is
`ORDINATE_PUBLIC_URL/assistant?slack=<question id>`: the asker lands on their conversation; anyone else
gets the question asked again as themselves. A failed-check note is a fixed `t()` sentence with no model
text and no figures.

**Charts** (Slack's `data_visualization` block, per its reference page read 2026-11-14):

| Ordinate chart | Slack chart |
|---|---|
| `column`, `clustered_column` | `bar` (bars grouped by label) |
| `line`, `line_markers` | `line` |
| `area` (single or overlapping series) | `area` (layered, first series at the back) |
| `pie`, `donut` with every value above 0 | `pie` |
| anything else (`stacked_*`, `pct_stacked_*`, `scatter`, maps, `gauge`, `treemap`, `funnel`, …) | none: table |

Used only when: at most 12 series (or 12 pie segments); at most 20 points per series, one for every
category; category, series and segment labels unique after a 20-character limit; a title within 50
characters; at most 2 charts per message. The block has no alt-text field, so the sentence always stays.

**Data:** `0041_slack.sql`, additive. Every table is keyed by org, and cleanups ride the per-org sweep in
`src/server/sharedState.ts`.

| Table | Key | Holds | Cleaned up |
|---|---|---|---|
| `slack_installs` | `team_id` | org, enterprise id, app id, bot user id, mode, on/off, allow guests, allow share override | on uninstall |
| `slack_links` | `org_id, team_id, slack_user_id` | Ordinate user, linked at | when the user leaves the org |
| `slack_link_states` | `token` | Slack user, team, Ordinate user (after /connect), parked question, nonce, expiry, used | after 10 minutes |
| `slack_events` | `event_id` | received at | after 24 hours |
| `slack_questions` | `id` | status, lease, channel, thread, placeholder ts, project, agent, outcome | 30 days after done |
| `slack_threads` | `team_id, channel_id, thread_ts` | project, conversation id, asker | with the conversation |
| `slack_channel_agents` | `team_id, channel_id` | project, agent (one agent per channel) | when the agent is deleted |
| `slack_socket_slots` | `slot` (1–10) | lease owner, expiry | the lease lapses |

The first question in a thread creates an `assistant_threads` row with its `agent_id`, shown in the asker's
History as "from Slack".

**Secrets:** four kinds appended to `SECRET_KINDS` (`src/server/secrets/store.ts`): `slack.botToken`,
`slack.signingSecret`, `slack.clientSecret`, `slack.appToken`. Replies carry has-key flags only. Each gets
a canary test.

**Contracts** (zod input, narrowest access, appended to `src/api/index.ts`; read contracts classified in
`scripts/rowPolicyReaders.ts` and `scripts/columnAccessReaders.ts`): `slack:status`, `slack:install`,
`slack:uninstall`, `slack:settings`, `slack:links` (org admin); `slack:myLink`, `slack:unlink` (the
caller's own link); `agent:slackChannels` and `slack:channels` (project admin; the picker).

**Slack app:** bot scopes `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`,
`channels:read`, `groups:read`, `users:read`. Events `app_mention`, `message.im`, `app_uninstalled`,
`tokens_revoked`. Not requested: `users:read.email`, `chat:write.public`, `channels:join`,
`channels:history`, `files:write`. The channel picker uses `users.conversations` (only channels the bot is
in). The manifest is built from `ORDINATE_PUBLIC_URL` (`src/server/publicUrl.ts`), never a request's Host;
without it, only Socket Mode is offered. Every outbound call goes through `src/connectors/ssrf.ts`, to
`slack.com` only.

**Socket Mode:** a pod takes one of 10 lease rows in `slack_socket_slots`, calls `apps.connections.open`
with the `xapp-` token, connects with Node 24's built-in `WebSocket` (no new dependency), acknowledges each
envelope by `envelope_id`, reconnects on `disconnect`. Pods without a slot still claim and answer
questions.

## Build plan

Four phases, in order. Each ends with every gate green and a commit; nothing is pushed.

1. **Install, link, and answer in a DM.** Migration, secrets, contracts, manifest, Admin → Slack page;
   events route, signature, de-duplication, queue and worker; linking (OIDC) and the profile row; the ask
   through the handler after `authorize()`; the share-policy `slack` path; text and table answers in a DM.
   A DM needs no audience check, so this phase is useful on its own.
2. **Channels and the check.** `agent:slackChannels` and the picker; `slack_threads` and thread ownership;
   unmapped-channel reply; the check (external channels, case A, case B with folders and `accessPrint`,
   guests, member cap); the fixed channel note, the private DM and Open in Ordinate; Share to channel and
   the admin override.
3. **Socket Mode.** Slots, the WebSocket client, acknowledgement and reconnect; the setup page's choice.
4. **Charts and feedback.** The `data_visualization` mapping and its fallbacks; Helpful / Not helpful
   stored with the answer.

## Tests

Self-check suites, each guard with a negative control:

- Signature: good passes; a changed body, an old timestamp or a wrong secret fails.
- Retries: the same `event_id` twice gives one question and one answer.
- Crash: a lease that lapses mid-answer is retaken, and the thread gets one answer.
- Authorization: a linked user with no read on the channel's project gets the fixed sentence, and the
  handler is never called.
- Linking: a state whose Slack user differs from the id_token, an expired state, a used state and a
  callback with no state row are each refused; the callback works with no session cookie.
- Outsiders: an `is_ext_shared` channel never gets figures; a stranger is never answered.
- The check: case A posts with unlinked members present. Case B fails with an unlinked member, fails when
  an admin asks with a restricted viewer present, fails when a restricted viewer asks with an admin
  present, fails when a member's folder level is `'none'`, passes when all prints are equal, fails over
  the member cap. A dataset in a non-Everyone folder makes it case B. A direct message always passes.
- Leaks: after a failed check, the channel post contains no digit from the answer and no model text.
- Share policy: a masked personal column never reaches Slack unmasked, and the model's sentence is
  replaced when anything was masked.
- Pings: model text containing `<!channel>` arrives escaped.
- Charts: each mapped type builds a valid block; 21 points, 13 series, a label collision after
  20 characters and a pie with a zero value each fall back to the table.
- Secrets: each Slack canary is absent from every log, reply and outbound body.
- Live: a Slack question on a Live dataset joins `scripts/test-liveSafetyNet.ts` if it adds a reader.
- Vitest for the setup page, the profile row and the channel field; a Playwright e2e for setup and linking
  against a local stub of Slack (Web API, OpenID and the event sender), never the real Slack.

## Owner's checklist on a real workspace

The build is tested against a stub only. Before release, on a real Slack workspace:

1. Create the app from the generated manifest; check the scopes Slack shows match the list above.
2. Install it, paste the keys, see Admin → Slack say connected; invite `@Ordinate` to a test channel.
3. Ask in a DM: the Connect button, Sign in with Slack, the answer arriving after linking.
4. Tie the channel to an agent; ask there; check case A posts and a row-ruled dataset goes private.
5. Check the chart block on desktop and on a phone; check a table answer.
6. Try Socket Mode with the public URL unset.

## Not in this change

Chart images (a server renderer or a headless browser), Microsoft Teams, scheduled questions in Slack,
building from Slack.

## Rules the build keeps (AGENTS.md)

The engine computes every figure. No contract, no channel. Row access rules on every reader. `orgKey()`
on any in-memory cache. Any pod serves any request. Additive migrations. No new runtime dependency.
Secrets never reach a log, a browser or Slack. Every outbound socket through the SSRF guard. Every
sentence through `t()`; every env var documented. Files under 500 lines. `npm run lint` clean. No
`Co-Authored-By` trailer.
