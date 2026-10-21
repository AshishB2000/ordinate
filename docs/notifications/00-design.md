# Notifications that reach the right person — design

Branch `feat/notifications`, item 3 of batch 3 (merge 3 of 5, after `feat/sso-lifecycle`). Migration
**0020**. Phase A is this document; a separate reviewer attacks it before any code is written.

## What you will see

- **The alert bell is yours.** Its badge counts the alerts *you* have not seen in the current
  project. Every member who can read the project — viewers included — has **Mark seen** on each alert
  and **Mark all seen** at the top, and clicking them clears *your* badge only; a colleague's stays as
  it was. **Snooze** is still an editor's, and it now says what it does: **"Snooze for everyone · 24 h"**.
  On the day this ships nobody's badge lights up: everyone starts from the inbox as it was.
- **An alert reaches its channels however it fired.** A rule that names Slack, Teams or email
  channels used to post only when the server's one-minute schedule fired it. Now it posts the same
  message when a manual ↻ Refresh, an input-table save, a snapshot restore, a refresh URL, an MCP
  refresh, a pipeline's alert step or a fresh-on-ask pull fires it — **once**, even when the schedule
  and a refresh both see the same breach.
- **A scheduled send of a dashboard with row access rules computes nothing.** Its run history says it
  was skipped, with the row-access sentence it already uses ("Not sent: this dashboard reads a dataset
  with row access rules, and subscriptions show the same figures to everyone, so they are off for
  it."), and no figure is ever calculated for it.
- **@mentions in comments.** Typing **@** in a comment, a reply or an edit opens a short list of up to
  eight people **who can read this project now** (filtered as you type; ↑ ↓ to move, Enter or Tab to
  pick, Esc to close the list without closing the panel). The picked person shows in the posted comment
  as a chip, **@Ann Lee**; if they later lose access the chip reads **@former member**. Mentioning
  anyone else is refused: "You can only mention people who can read this project." Nobody outside the
  project is ever listed or named.
- **The person you mention hears about it three ways:**
  1. a notice in their open tabs — "Ann Lee mentioned you on Revenue review" — with **Open**, which
     opens the thread;
  2. an email with the comment's words, what it is on and a link (no figures), when the server sends
     email and they have not turned it off in **Settings → You → Notifications → "Email me when
     someone mentions me"** (on by default);
  3. a **"Mentioned you"** list on Home, newest unseen first, across every project they can read.
     It has its own loading, empty ("No mentions yet") and error states, and **Mark all seen**.
- **Without a database** (dev mode) nothing changes: the bell keeps the shared seen flag, mentions are
  off, the picker never opens, and Home shows no "Mentioned you" section.

## 1. Decisions from the spec (condensed — not re-litigated)

| # | Decision |
|---|---|
| D1 | Per-user alert state in migration 0020: rows keyed `(org_id, user_email)`, RLS forced like `user_ai_model` (0013). One row per user per project: a seen-through watermark plus the ids seen one by one after it (≤ 200, the event cap `alerts.ts:153`). |
| D2 | `alerts:markSeen` becomes `access: 'read'` and writes only the caller's row; `alerts:list` returns that caller's `seen` and `unseen`. A user with no row starts from today's shared flag. Without `DATABASE_URL` the shared flag stays. |
| D3 | AlertsBell: Mark seen / Mark all seen for every reader; Snooze editor-only, labelled "Snooze for everyone · 24 h". |
| D4 | One alert send path: rename `ipc/alerts.ts`'s `deliver` → `pushAlertEvents`; every evaluation path goes through what the tick does (push + `postFiredAlerts` → `deliver()`), deduped by event id; outside a request it runs as the tick does; quality and pipeline events stay push-only; fix the comment at `ipc/alerts.ts:9-11`. |
| D5 | `runSubscription` asks `dashboardSendRefusal` first: a refused run computes nothing and records a **skipped** run with code `row_policy`. Fix the row-policy design doc line. |
| D6 | @mentions: `comment:mentionable {projectId, q}` (read) returns ≤ 8 enabled current readers (teams and org admins expanded as `readerEmails`), never the org directory. A mention is a structured token in the Markdown body holding the email, which the renderer cannot mistake for a link or HTML. Add / reply / edit refuse a mention of a non-reader with a catalog sentence. Current reader → "@Name"; lost access → "@former member". |
| D7 | Each NEW mention (not in the previous version on edit; never the author) notifies by push (`publish({org, user: email})`, a toast with Open), by email (personal send, comment text + item name + link, no figures, same reader and allowed-domain filters, budget kind `mention`, audited per recipient, only with SMTP configured and the user's setting on, default on), and by a `mentions` row (same migration) feeding Home's "Mentioned you", unseen first. |
| D8 | Without `DATABASE_URL` mentions are off and the picker never opens. |
| Out | A cross-project alert notification centre; @team mentions; List-Unsubscribe; per-user snooze; the dead `alerts:evaluate` / `alerts:explain` handlers. |

## 2. Caller inventory (read on 46bbfc3d)

### 2.1 Alert evaluation and delivery

Every place a rule's events are produced, and what delivers them today:

| Path | Where | Context it runs in | Today |
|---|---|---|---|
| Scheduler tick (full + incremental refreshes) | `app/refreshScheduler.ts:272-283` (`after()` → `evaluate`), `:212` `onTickAlerts`, wired at `server/jobs/schedules.ts:118-122` | job runner, `runInContext(systemIdentity(org))` (`jobs/runner.ts:89`, `:136`); incremental ones settle later inside the same async context | `deliverTickAlerts` (`schedules.ts:87-93`): push + `postFiredAlerts` |
| `dataset:refresh` and `connection:refresh` | `ipc/datasets.ts:404` → `refreshNow` `:296-319` → `afterRefresh` `:278-292` → `evaluateAndDeliver` `:282`; `ipc/connections.ts:361` → `refreshNow` | the request (an editor) | push only |
| Input tables | `ipc/input.ts:46` (`input:save`), `:71` (`input:setColumns`) → `afterRefresh` | the request | push only |
| Snapshot restore | `ipc/snapshots.ts:170` → `afterRefresh` | the request | push only |
| Fresh on ask | `data/freshOnAsk.ts:175` (`pull` → `afterRefresh`) | detached **system** identity in the org (`:146-149`) | push only |
| Refresh-hook URLs | `server/hooks/act.ts:69` (`start.done.then(… afterRefresh)`) | the hook creator, `runInContext` at `hooks/route.ts:193`; the `.then` continuation keeps it | push only |
| MCP refresh | `automation/handlers.ts:153` → `evaluateAndDeliver` | the request (bearer token's user) | push only |
| Pipeline alert node | `app/pipelineRunner.ts:101` → `evaluateAndDeliver` inside `asJob` | the app job, which binds the submitter's context (`app/jobs.ts:232`): a `pipelines:run` request, or the tick for a cron run (`schedules.ts:126`) | push only |
| `alerts:evaluate` | `ipc/alerts.ts:207-215` | — | **dead** (no contract): Out |

Push-only events (no rule channels, `alertPosts.ts:47-48`):

| Path | Where |
|---|---|
| Data quality | `analysis/qualityRun.ts:105-115` feature-detects `ipc.deliver` (**`typeof ipc.deliver !== 'function'` → no sink → quality events are not even recorded**), `:169` delivers; callers `ipc/datasets.ts:254`, `:286`, `:578`, `ipc/quality.ts:33`, `ipc/datasetCompose.ts:250`, `:304`, `ai/planExec.ts:125`, `automation/handlers.ts:136`, `:154`, `data/datasetDependents.ts:121`, `refreshScheduler.ts:286` (`deliver: false`) |
| Pipeline failures | `app/pipelineRunner.ts:139` — `require('../ipc/alerts').deliver(...)`, **untyped**: a rename that misses it compiles and then throws inside the catch at `:140` (logged, never pushed) |

The rest of the send path:

- `ipc/alerts.ts:42-49` `deliver` (push only) and `:69-73` `evaluateAndDeliver`; the stale comment at `:9-11`.
- `analysis/alertStore.ts:423-479` `evaluateProject`: computes outside the lock, then applies each result only if the stored rule is unchanged (`:465-478`), so **an event id is returned to exactly one evaluator**, across pods (the record lock is cross-pod). `:258-265` `recordEvents` (quality, pipeline). `:598-606` `pushableEvents`.
- `server/subscriptions/alertPosts.ts:40-64` `postFiredAlerts`: per event with rule channels, `deliver()` per channel, an audit row per event (`:57-58`, actor `ctx().user.email`). Never throws.
- `server/subscriptions/deliver.ts:126-129` `Delivery`, `:176-200` `deliver()` (the one door: `figureDatasets` → `refuseFanOut` → Slack/Teams/`sendEmail`).
- `server/jobs/schedules.ts:71-74` `pushToReaders`, `:60-64` `toReaders` (both read `ctx().org`).

### 2.2 Alert inbox state

- `analysis/alerts.ts:128-148` `AlertEvent` (`seen` at `:139`), `:319-325` sanitizer.
- `analysis/alertStore.ts:267-278` `markSeen` (shared flag, flips for everyone).
- `ipc/alerts.ts:145-159` `alerts:list` (`unseen` from `ev.seen`), `:217-224` `alerts:markSeen`.
- `api/dashboards.ts:88` `alerts:list` (read), `:106` `alerts:markSeen` (**write**).
- **`ipc/summary.ts:189-203` `alertFact`** — the Summary card names the latest *unseen* alert (`!e.seen`, `:194`). **Missed by the spec**: with per-user state it must read the caller's view, or every event after the upgrade stays "unseen" there forever (the shared flag never flips again).
- `web/src/features/dashboards/CardRuntime.tsx:302` (a KPI card's bell is accented while one of its alerts is unseen) — reads `alerts:list`, so it follows the caller's view with no change.
- `web/src/features/dashboards/AlertsBell.tsx:202-215` (Snooze, Mark seen gated by `canEdit`), `:256-260` (Mark all seen), `:236` (`useCanEdit`), `:225` (`usePausedNotice` — the app-wide toast precedent).
- Tests pinning today's behaviour, to update with the decision: `scripts/test-dashboardsServer.ts:352` (`alerts:markSeen` must be `write`), `web/src/features/dashboards/AlertsBell.test.tsx:52`, `:61` (a viewer has no Mark seen). `scripts/test-summaryCard.ts:182` and `scripts/recordsScenario.ts:151` call the store's shared `markSeen` without a database — unchanged.

### 2.3 Subscriptions

- `server/subscriptions/run.ts:164-195` `runSubscription` → `:121-157` `attempt` → `:129` `buildMessage` → `:101` `resolveFigures` (`ipc/subscriptionFigures`) — the figures are computed here, then refused per channel in `deliver()` (`deliver.ts:190`).
- `deliver.ts:157-165` `dashboardSendRefusal` (from the definition, nothing computed) — today only `subscription:save`/preview call it.
- `analysis/subscriptions.ts:31` `RunOutcome` has `skipped`; `subscriptionText.ts:15` has `row_policy`. A skipped run is not audited (`run.ts:189`) and does not count toward the pause (`:179`).
- `docs/row-policy/00-design.md:192-194` says `run.ts` refuses "before its `postToChannel` loop" — wrong today, and wrong again after this item.

### 2.4 Comments

- Model `app/commentModel.ts:46-70` (author is the email on the server), `:254` `makeComment`, `:261` `addReply`, `:268` `editBody`.
- Store `app/comments.ts:62-65` `author()` = `ctx().user.email`, `:201` `add`, `:208` `reply`, `:212` `edit` (ids minted inside with `randomUUID()`; the caller never learns the new id).
- IPC `ipc/comments.ts:63-73` `answer` (the reply every write returns), `:77-81` `changed` → `pushToReaders('comments:changed')`, `:92-106` handlers.
- Contracts `api/dashboards.ts:79-86` (all `read`, writes `audit: true`; `Body` ≤ 10 000 chars at `:39`).
- Bodies are read elsewhere: `ipc/recent.ts:46-67` (Home "Recent comments" snippet, `:60`), **`ipc/reportsServer.ts:107-128` → `analysis/reportPages.ts:328-329`** (a report's discussion page prints `plain(c.body)` — **missed by the spec**: raw tokens would print people's addresses into a report), `ipc/scorecards.ts:242` (counts only — no change).
- Web: `CommentsPanel.tsx` (bodies `:149`, `:163` through `MarkdownView`; composer `:321-334`; reply `:208-217`; edit `:137`), `Markdown.tsx:66-68` `MarkdownView`, `mdParse.ts` (pinned to the desktop parser by golden fixtures, `dashboards.test.tsx:51` → `__golden__/markdown.json` — **never changed here**), `dashboards/api.ts:130-160` hooks, `RecentComments.tsx:17-25` `threadHref`, `HomePage.tsx:119`.
- Every e2e finds the composer by label (`dashboards.e2e.ts:128`, `:132`, `:362`), so a `combobox` role on the textarea keeps them green.

### 2.5 People, push, mail, audit, settings

- `server/authz/index.ts:138-140` `readerEmails` (enabled; org admins + direct/team grants), `:118-130` `readable`.
- `server/sse.ts:70-74` `Target {org, user?, client?}`, `:128-132` `publish`; the user key is the **email** (`:137`). `publish({org, user})` already exists: **no change to `sse.ts`**.
- `server/mail/emailChannel.ts:85-109` `recipients` (`PICKED` + `READS_PROJECT` + `deliverable` = allowed domain + strict address; signed-in only), `:216-257` `sendEmail` (`:252` budget by `d.kind`); `mail/budget.ts:28-30` `sendBuckets(kind: 'dashboard' | 'alert')`; `scripts/test-email-db.ts:333-339` door scan (only `emailChannel.ts` may call `sendBatches`; only `deliver.ts`/`emailChannel.ts` `sendEmail`).
- `analysis/subscriptionEmail.ts:113`, `:134` — the email's "why you got this" line is always the channel's (`emailReason(channelName)`).
- `server/authz/audit.ts:52-58` `audit` (ids only).
- Users: `db/migrations/0003_auth.sql:17-27`. `users.name` exists but **no flow writes it**.
- Per-user settings today: `user_ai_model` (0013), `starredBy` in `org_config`. Settings page: `web/src/features/settings/SettingsPage.tsx:80-114` (You), `Rows.tsx` `Group`/`Row`, `ui/Choice.tsx:74` `Switch`.
- Home: `web/src/features/home/HomePage.tsx`; RPC mocks in Vitest answer an unknown channel with `[]` (`test-utils.tsx:41`).

## 3. Steps, in commit order

1. **This document.**
2. **Migration 0020 + the org transaction helper.** `src/server/db/migrations/0020_notifications.sql`
   (§4) and `src/server/db/inOrg.ts`: `useOrgDb(pool)`, `orgDb()`, `inOrg(fn)` — one transaction with
   `set_config('ordinate.org', org, true)` after `ORG_RE`, org from `ctx()`. Wired in `server/app.ts`
   beside `useRecordDb` (one line in, one in `onClose`).
3. **Per-user alert inbox.** `src/server/alertInbox.ts`: `seenView(projectId, events)` (the caller's
   predicate, or the shared flag with no database / no row) and `markSeenFor(projectId, eventId?)`.
   `alerts:list` and `alerts:markSeen` use it (store `markSeen` stays for no database); `alerts:markSeen`
   → `access: 'read'`; `ipc/summary.ts` `alertFact` filters with `seenView`. `alertStore` stamps each
   newly stored event's `at` strictly after the newest stored one (§5.2), in `evaluateProject`'s apply
   and `recordEvents`. `scripts/test-alertInbox.ts`; `test-dashboardsServer.ts:352` → `read`.
4. **AlertsBell.** Mark seen / Mark all seen for every reader; Snooze stays behind `canEdit` as
   "Snooze for everyone · 24 h" (toast "Snoozed for everyone for 24 hours"); empty-state wording
   unchanged. `AlertsBell.test.tsx` updated + new cases.
5. **One alert send path.** `ipc/alerts.ts`: `deliver` → `pushAlertEvents` (push only); comment
   `:9-11` rewritten. `schedules.ts`: `pushFired(projectId, events, push)` and
   `deliverFired(projectId, events, push) → { pushed, posted }`; `deliverTickAlerts` maps over
   `deliverFired` (same signature and return, so `test-alertChannels`/`test-email-db` stand).
   `evaluateAndDeliver` awaits `deliverFired(…).pushed` and never awaits the posts (as the tick).
   `qualityRun.ts:110-112` feature-detects `pushAlertEvents`; `pipelineRunner.ts:139` calls it.
   `alertPosts.ts`: claim the batch's postable event ids in `alert_posts` before posting (§5.3).
   `scripts/test-alertDelivery.ts`.
6. **Subscriptions refuse first.** `runSubscription`, after the slot fence and before `attempt`:
   `dashboardSendRefusal` → a `skipped` / `row_policy` entry, nothing computed; any other error from it
   falls through to `attempt`, which reports `dashboard_gone` etc. as today. Test in
   `scripts/test-rowPolicyFanOut.ts`. Fix `docs/row-policy/00-design.md:192-194`.
7. **Mention tokens and the reader check.** `src/app/mentionToken.ts` (pure, shared with the web):
   the syntax (§5.1), `mentionsIn(body)`, `mentionToken(email)`, `withMentionLabels(body, label)`,
   `personName(email)`. `src/app/threadPath.ts` (pure): the route that opens a thread (moved from
   `RecentComments.threadHref`, which then imports it). `src/server/mentions/people.ts`:
   `currentReaders(projectId)` (= `readerEmails`, null without a database), `peopleFor(projectId,
   bodies)` (email → name for current readers only). `ipc/comments.ts`: add / reply / edit validate
   new mentions before writing; `answer` adds `mentions: boolean` and `people`. `app/comments.ts`
   `add`/`reply` take an optional id (so the caller knows the new piece). Names replace tokens in
   `ipc/recent.ts`'s snippet and `ipc/reportsServer.ts`'s discussion bodies. `comment:mentionable`
   contract + handler (`src/server/mentions/rpc.ts`). Sentences in
   `src/server/mentions/mentionMessages.ts` (added to `MAIN_FILES`).
8. **Mention notices.** `src/server/mentions/store.ts` (rows, the setting, the list, seen) and
   `notify.ts` `notifyMentions(projectId, piece, emails)`: fresh reader check → row → push → email.
   Email goes through `deliver()` as `Delivery {kind: 'mention'}` to a one-person email channel
   (§5.6); `budget.ts` kind union gains `'mention'`; `subscriptionEmail` takes an optional reason
   line. Contracts `mentions:list`, `mentions:seen`, `mentions:prefs`, `mentions:setPrefs` in a new
   `src/api/notifications.ts` (appended to `api/index.ts`). `scripts/test-mentions.ts`.
9. **Web: chips and the picker.** `Markdown.tsx` splits `MarkdownView` into parse + `MarkdownBlocks`
   and lets a token resolver return a node; `CommentBody.tsx` (§5.1 rendering); `MentionInput.tsx`
   (the picker) used by the composer, reply and edit boxes in `CommentsPanel.tsx`. Vitest.
10. **Web: the toast, Home, Settings.** `useMentionNotice` (mounted beside `usePausedNotice`),
    `MentionedYou.tsx` on Home, the Notifications group in Settings → You. Vitest.
11. **e2e** `web/e2e/notifications.e2e.ts` (header sign-in, scratch Postgres).
12. **Docs.** Threat model R18(h) closed + a new Mentions row (next free number at merge), email doc
    §12 note, CHANGELOG, `docs/README.md` row; `node scripts/i18n-extract.js`.

## 4. Migration 0020 — exact SQL

```sql
-- Notifications that reach the right person (docs/notifications/00-design.md):
-- each member's own alert inbox state, a once-only ledger for alert posts, the
-- mentions that name a member, and their "Email me when someone mentions me".
--
-- Additive only: three new tables and one column with a constant default (no
-- backfill; Postgres 11+ adds it without rewriting the table). org_id is text,
-- as in 0007_records.sql (dev mode's org is the literal `default`). Every new
-- table is per org with row-level security forced, like 0013's user_ai_model:
-- src/server/db/inOrg.ts sets `ordinate.org` per transaction; unset → NULL →
-- no rows.

-- What one member has seen of one project's alert inbox (src/server/alertInbox.ts).
-- An event is seen when its `at` is at or before seen_through ("Mark all seen"),
-- or its id is in seen_ids (marked one by one; pruned on every write to the
-- events still stored, so never more than the 200 a project keeps). No row: the
-- shared `seen` flag the events carried before this migration decides, so no
-- badge lights up on upgrade.
CREATE TABLE alert_inbox (
  org_id       text        NOT NULL,
  user_email   text        NOT NULL,
  project_id   uuid        NOT NULL,
  seen_through timestamptz,
  seen_ids     uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(seen_ids) <= 200),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_email, project_id)
);

-- Each fired alert event goes to its rule's channels at most once, whichever
-- path delivered it (the tick, a refresh, a refresh URL, MCP, a pipeline step)
-- and on whichever pod (src/server/subscriptions/alertPosts.ts). The INSERT is
-- the claim; rows older than 30 days are deleted by the next claim in the org.
CREATE TABLE alert_posts (
  org_id     text        NOT NULL,
  event_id   uuid        NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, event_id)
);
CREATE INDEX alert_posts_age ON alert_posts (org_id, claimed_at);

-- A member named in a comment or a reply: Home's "Mentioned you". No text is
-- copied here: Home reads the comment as it is now, so an edit or a delete is
-- never shown stale, and a member who lost access to the project sees nothing
-- of it. At most 200 rows per member (src/server/mentions/store.ts).
CREATE TABLE mentions (
  org_id     text        NOT NULL,
  user_email text        NOT NULL,   -- who was mentioned
  piece_id   uuid        NOT NULL,   -- the comment (its own body) or the reply that names them
  project_id uuid        NOT NULL,
  comment_id uuid        NOT NULL,   -- the thread
  author     text        NOT NULL,   -- who wrote it: an email, as comments.json keeps authors
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at    timestamptz,
  PRIMARY KEY (org_id, user_email, piece_id)
);
CREATE INDEX mentions_inbox ON mentions (org_id, user_email, created_at DESC);

-- "Email me when someone mentions me" (Settings → You), on the membership row.
ALTER TABLE users ADD COLUMN mention_email boolean NOT NULL DEFAULT true;

ALTER TABLE alert_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY alert_inbox_org ON alert_inbox
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE alert_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_posts FORCE ROW LEVEL SECURITY;
CREATE POLICY alert_posts_org ON alert_posts
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentions FORCE ROW LEVEL SECURITY;
CREATE POLICY mentions_org ON mentions
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
```

`helm rollback` leaves all of it in place; the previous release never reads the three tables, and its
`users` queries name their columns, so the extra column is invisible to it.

## 5. Decisions where the spec leaves room

### 5.1 The mention token: `@(email)`

**Syntax.** A mention is `@(` + the address + `)`, for example `@(ann.lee@acme.com)`. The shared pure
module `src/app/mentionToken.ts` owns it, and both halves import it (the web already imports pure
`src/` modules, e.g. `src/app/format.ts`), so there is one parser, not two:

```
MENTION_RE = /@\(([^\s()<>\[\]@]{1,64}@[^\s()<>\[\]@]{1,190})\)/g     (case kept; compared lower-cased)
```

**Why it can never be a link or HTML.**

- An address cannot contain `(`, `)`, `<`, `>`, `[`, `]` or whitespace (`mailEnv.ts`'s `LOCAL`/`LABEL`
  exclude them), and the regex refuses them inside the token. So the token holds no `[…](…)` link
  shape, no `<…>` autolink or tag, and nothing that ends early.
- The web renderer never hands the address to the Markdown parser at all. `CommentBody` first
  replaces every match with an inert placeholder token, `{{<n>}}` (a private-use character no
  one types; any U+E000 already in the body is stripped first so a body cannot forge one), and only
  then calls `mdParse`. `mdParse`'s `{{…}}` rule is atomic and the placeholder contains none of `*`,
  `_`, `` ` ``, `[`, `\`, so an underscore in `first_last@acme.com` can never pair with another `_`
  and turn half a mention into italics (the bug a raw `@{first_last@…}` would have). The token resolver
  returns a React node — the chip — never markup; `mdParse` itself is untouched, so its golden
  fixtures stand.
- Inside a code span or a fenced block the placeholder is mapped back to the plain words "@Ann Lee" /
  "@former member" (a walk over the parsed tree's `code`/`pre` values), never the address.
- Server text (an email, Home's snippet, a report's discussion page, the toast) goes through
  `withMentionLabels(body, label)` — plain-string replacement, then the existing escaping of each
  surface (`renderEmail` escapes, React sets text).

**Round trip.** The picker only offers addresses that `MENTION_RE` matches whole (an address the
users table holds but the token cannot carry is simply not offered), and inserts `@(address) `.

Tests: Vitest `CommentBody.test.tsx` (chip, no `<a>`, no element from `<script>`-shaped text, the
underscore case, bold around a mention, a mention in a code span, a forged ``), and the server
half in `test-mentions.ts` (`mentionsIn` on the same table of bodies — the two halves share the module,
so this is one implementation exercised twice).

### 5.2 The alert watermark is exact

`seen(e) = row ? (Date.parse(e.at) <= seen_through) || seen_ids.has(e.id) : e.seen`.

"Mark all seen" sets `seen_through` to the newest `at` among the events stored **now** (not the clock).
That alone is not exact: `at` is the *evaluation start* (`alerts.ts` `evaluateRule`), and
`evaluateProject` computes outside the lock, so an event evaluated before the click but stored after it
would carry an older `at` and count as seen. So **the store stamps each event's `at` when it stores
it**, strictly after the newest stored one — `after(newest, now)`, the same one-line rule comments use
(`commentModel.ts:245`) — inside `withAlerts` (the cross-pod record lock), in `evaluateProject`'s apply
and in `recordEvents`. Stored order is then `at` order on every pod, whatever the clocks, and an event
stored after a Mark all seen is always unseen. The cost: `at` moves from "evaluation started" to
"stored", seconds apart.

Single marks: the upsert unions the id into `seen_ids` and prunes it to the ids still in the file (≤ 200,
the CHECK holds). A first write (no row) inserts the ids the shared flag already marks seen plus the new
one, so the inherited state is kept. Two tabs marking at once: one `INSERT … ON CONFLICT DO UPDATE`
statement each; the union makes the order irrelevant; `GREATEST` for `seen_through`.

### 5.3 The dedup key for alert posts: the event id, in Postgres

The key is the **event id** (a fresh UUID per firing). `evaluateProject` already returns each event to
exactly one evaluator (its compare-and-set under the cross-pod record lock), so two evaluators do not
mint two events for one breach. The ledger makes "posted at most once" a property **of the send door**
rather than of every caller: `postFiredAlerts` first picks the events whose rule names channels, then
claims their ids in one statement,

```sql
INSERT INTO alert_posts (org_id, event_id) SELECT $1, unnest($2::uuid[])
ON CONFLICT DO NOTHING RETURNING event_id::text
```

(in `inOrg`, with `DELETE FROM alert_posts WHERE org_id = $1 AND claimed_at < now() - interval '30
days'` first), and posts only what it claimed. It lives in Postgres because that is the one store every
pod shares and the INSERT is atomic; the alerts record would need a second locked write per firing and a
new field in the event schema. Claim-before-post means **at most once**: a pod that dies between the
claim and the post loses that post — the same promise as today ("a post that fails is logged and
left"). **Without a database** there is no ledger and every event passes: posting needs channel secrets,
which need the database, so in production nothing posts there; the test harness that injects a secret
store without a database (`test-alertChannels.ts`) keeps working unchanged (its events have fresh ids).

### 5.4 Paths outside a request already carry an org

Every path in §2.1 runs inside an `AsyncLocalStorage` context that names the org: a request (RPC, MCP),
the job runner's system identity (tick, incremental settles, pipeline crons), an app job (bound to its
submitter, `jobs.ts:232`), fresh-on-ask's detached system identity, and the refresh URL's creator (the
`.then` keeps the context). So the posts use `ctx()` for the org exactly as the tick does, and the audit
row's actor is whoever caused the firing (a member, the hook creator, `jobs@system`). Nothing new is
detached. A call with **no** context would throw inside `postFiredAlerts`' catch and post nothing, so
`test-alertDelivery` drives **every** path end to end and asserts exactly one post per path — the guard
that a future path without a context is caught.

Delivery shape: the request paths **await the push** (as today, so the bell is right when the refresh
answers) and **never await the posts** (as the tick: a slow Slack must not hold up a refresh reply). The
test waits on `alertPosts.postsSettled()`, a set of in-flight posts the module keeps for that purpose.

### 5.5 "Current reader" at send time

Three checks, each fresh, each with `readerEmails`' predicate:

1. **On write** (add / reply / edit): every NEW mention must be in `readerEmails(org, project)`, else the
   whole write is refused before anything is stored. On edit, "new" means not in the body being
   replaced; a mention kept from the previous version is not re-checked (refusing it would make a
   comment uneditable once someone leaves, and a kept mention notifies no one). The body being replaced
   is read just before the write; only the author can edit, so the window is the author's own.
2. **At send** (`notifyMentions`): `readerEmails` is run **again**, after the write, and only the
   mentioned addresses still in it get a row, a push or an email. `notifyMentions` is exported so the
   test can revoke a grant between the write and the send.
3. **The email** goes through `recipients()` itself (§5.6) — enabled, **signed in**, current reader,
   allowed domain, strict address — and the user's `mention_email` must be true.

The refusal sentence is the same whether the address belongs to an org member without access, a
disabled member, another org's member, or nobody: "You can only mention people who can read this
project." It never echoes the address. Without a database every mention token is refused with it.

### 5.6 The mention email reuses the one send door

`deliver(channel, { kind: 'mention', projectId, message })` with a one-person email channel built in
memory (`{ kind: 'email', to: { userIds: [the user's id], teamIds: [] } }`, never saved). That buys,
unchanged: `recipients()` (the reader, signed-in and `ALLOWED_EMAIL_DOMAINS` filters at
`emailChannel.ts:91-102`), the budget (`sendBuckets(org, projectId, 'mention', …)`: an org bucket and the
project's half, apart from subscriptions and alerts, so item 4 moves it with the rest), batching,
retries, logging without addresses, and the door scan in `test-email-db` (nothing new calls
`sendBatches`). `deliver()` skips `figureDatasets` for a mention (it carries no figure; the fan-out
refusal is over no datasets). The message is `composeMessage({ title: "Ann Lee mentioned you on
Revenue review", note: the comment's words with mentions as names (≤ 1 000 characters), link: the
thread, kpis: [], visuals: [] })` with a reason line of its own ("You get this because Ann Lee mentioned
you in Ordinate. Turn these emails off in Settings → You.") through an optional `reason` on the email
look. One audit row per recipient: `action 'rpc', channel 'comment:mention', actor = the author, targets
= [comment id, piece id, recipient user id], outcome`.

### 5.7 Where the "Email me when someone mentions me" setting lives

`users.mention_email boolean NOT NULL DEFAULT true` — a column on the membership row (one row per person
per org), because the send already reads that row to resolve the person's id, and a column needs no
table, no policy and no join. Read with the recipient lookup; written by `mentions:setPrefs` with
`UPDATE users SET mention_email = $3 WHERE org_id = $1 AND email = $2` (the caller's own row only — the
email comes from `ctx()`, never the input). The `users` table has no RLS (as since 0003); both queries
name the org.

### 5.8 Names

`users.name` is never written by any sign-in flow, so a person's name is derived once, on the server, from
the address: `personName('ann.lee@acme.com') === 'Ann Lee'` (local part split on `. _ - +`, words
capitalised). The server sends names only for current readers — `people` in the `comment:list` reply,
`name` in the picker, `by` in the push and the Home rows. The web never derives a name from a token, so
a former member's chip cannot be anything but "@former member". The chip's tooltip is the address
(current readers only).

### 5.9 The notice (toast)

Push channel `mentions:new`, `publish({ org, user: email }, …)` — to that person's tabs on every pod
(`sse.ts` binds a stream to org + email). Payload, ids and words only: `{ projectId, id (piece),
commentId, target: {kind, id}, analysisId?, by, on }`. `useMentionNotice()` lives in
`web/src/features/dashboards/mentionNotice.ts` and is mounted by the bell beside `usePausedNotice`, so it
is on every page. It shows `toast("Ann Lee mentioned you on Revenue review", { action: { label: 'Open',
onClick } })` (kind `info`; the shared 4 s stack, text only), and invalidates `['mentions:list']`.
**Open** marks that row seen and navigates (React Router, no reload) to `threadPath(projectId, target,
analysisId)`, which the thread's door reads on arrival (`?comment=kind:id`). The web computes the route
from ids; it never follows a URL from a push.

### 5.10 Home's "Mentioned you"

- **Data:** `mentions:list` (org-scoped, `read`; one RPC on Home, inside the 25 budget) returns
  `{ available, items }`. The handler reads the caller's 20 newest rows (unseen first, then newest),
  keeps only projects `readable()` says the caller may read **now**, reads each project's comments once,
  drops a row whose comment, reply or mention is gone (edited out, deleted), and returns per item: piece
  id, project id, target, `on` (name + analysisId, from `targetNames`), `by` (author's name), a snippet
  (the existing Recent-comments snippet rule, extracted to one function, with mentions as names), `at`,
  `seen`. `available: false` without a database. `mentions:seen {id?}` marks the caller's own rows.
- **Placement:** above "Recent comments" in Home's single column, in the same card style
  (`Comments.module.css` home classes). Header "Mentioned you" with "N new", and **Mark all seen** while
  any is unseen. Up to 8 cards; an unseen one has an accent dot and bold author. A card reads "**Ann
  Lee** mentioned you · 2 h ago", the snippet (two lines), then the record's icon, its name and the
  project's name (from the projects list Home already holds). Click → seen + open the thread.
- **States:** loading — `SkeletonRows rows={2} label="Loading mentions"`; error — `ErrorState compact
  heading={2} title="Could not read your mentions"` with Retry; empty — `EmptyState compact icon="at-sign"
  title="No mentions yet"`, "When someone types @ and picks you in a comment, it shows up here."; hidden
  entirely when `available` is false (dev mode, and every Vitest mock that answers `[]`).

### 5.11 The picker

`MentionInput` wraps the existing `Textarea` (labels unchanged, so every e2e that finds "New comment" /
"Reply" / "Edit comment" by label still does), following `QueryEditor.tsx`'s completion pattern:
`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, a `listbox` of `option`s
(name + address), ArrowUp/ArrowDown wrap, Enter/Tab insert `@(address) ` at the `@` (caret placed with
`useCaret`), Esc closes, click outside or blur closes. It opens on `@` at a word start, queries
`comment:mentionable` with what follows (debounced 150 ms, `keepPreviousData`), and shows "Searching…",
"No one who can read this project matches “q”" and "Could not search people" rows. **Trap:** Radix
catches Escape on the document in the capture phase, before the textarea, so the picker adds a
`window` capture listener while open that takes Escape (closes the list, `preventDefault`) — Radix then
sees `defaultPrevented` and leaves the drawer open. Never mounted when `comment:list` says `mentions:
false`. The picker excludes the caller.

### 5.12 Settings → You → Notifications

A `Group` "Notifications" with one `Row` "Email me when someone mentions me" and a `Switch`. Description:
"Mentions always reach you on Home and as a notice in your open tabs." When the server sends no email the
switch is disabled and the description says "This server does not send email; mentions still reach you
on Home and as a notice." Loading → a skeleton row; error → `ErrorState compact` with Retry; no database
→ the group is not shown. `mentions:prefs` → `{ available, mail, emailMe }`; `mentions:setPrefs
{ emailMe }` (org-scoped `read`: one's own setting, like `starred:set`).

### 5.13 Contracts added or changed

| Channel | Contract |
|---|---|
| `alerts:markSeen` | `access: 'read'` (was `write`); input unchanged |
| `comment:mentionable` | `read`, `project: byProjectId`, `{ projectId: Uuid, q: string ≤ 100 }` |
| `mentions:list` | `read`, `org: true`, `z.undefined()` |
| `mentions:seen` | `read`, `org: true`, `{ id?: Uuid }` |
| `mentions:prefs` | `read`, `org: true`, `z.undefined()` |
| `mentions:setPrefs` | `read`, `org: true`, `{ emailMe: boolean }` |

`comment:list`'s reply gains `mentions: boolean` and `people: Record<email, name>`.

## 6. Test plan (one-to-one with the spec's Tests)

| Spec test | Where | Assertions (and the control) |
|---|---|---|
| A marks an event seen and B's stays unseen | `scripts/test-alertInbox.ts` (-db, header sign-in) | A's `unseen` drops by one (**control**), B's is unchanged; the store's shared flag is untouched |
| a viewer marks their own | same | `alerts:markSeen` as a viewer → 200, only the viewer's row; **negative control:** a member with no grant → 403 |
| mark-all | same | all seen for the caller; an event stored **after** the click is unseen even when evaluated before it (§5.2); another member unaffected |
| a user with no row inherits the shared flag | same | events shared-seen before → seen; a first single mark keeps them seen; **control:** a shared-unseen event stays unseen |
| *(missed caller)* summary card | same | `summary:compute`'s alert sentence follows the caller's seen state (**control:** another member still sees it) |
| *(RLS)* | same | a row written under org A is invisible to a query under org B; with `ordinate.org` unset, no rows |
| each listed path posts once to Slack and to the fake SMTP | `scripts/test-alertDelivery.ts` (-db: channel secrets need the store) | for each of `dataset:refresh`, `connection:refresh`, `input:save`, `input:setColumns`, `snapshots:restore`, fresh on ask, a refresh URL, the MCP refresh tool, a pipeline alert node, the tick: exactly one Slack post and one email (`smtpFake`), and one `alerts:post` audit row |
| NEGATIVE CONTROL: a rule with no channels posts nothing | same | same paths, zero posts |
| a breach seen by both the tick and a refresh posts once | same | `tickNow` and `dataset:refresh` together on one breach → one post |
| *(dedup ledger)* | same | `postFiredAlerts` twice with the same event → one post (**control:** two event ids → two) |
| *(push-only kinds)* | same | a quality event and a pipeline failure push `alerts:fired` and post nothing; quality events are still recorded after the rename (**control:** sink resolves) |
| Subscriptions: a policy dashboard is skipped, `resolveFigures` never called | `scripts/test-rowPolicyFanOut.ts` | spy on `ipc/subscriptionFigures.resolveFigures`: 0 calls; history entry `skipped`/`row_policy`; no post. **Control:** a plain dashboard computes (spy called) and sends |
| the picker returns only current readers | `scripts/test-mentions.ts` (-db, header sign-in, `smtpFake`) | a team member and an org admin appear; a member without a grant, a disabled member and another org's member never do |
| at most 8 results | same | 12 readers → 8 |
| a mention of a non-reader is refused | same | add, reply and edit each refused with the catalog sentence; nothing stored; the sentence is identical for a member without a grant and an unknown address (no leak) |
| a mentioned reader gets the push, the email and the Home row | same | `mentions:new` published to `{org, user: B}` only; one email to B; `mentions:list` as B lists it with names, not addresses |
| an edit adding no mention sends nothing; a self-mention sends nothing | same | zero pushes/emails/rows (**control:** an edit adding a new mention notifies once) |
| the opt-out stops the email but not the Home row | same | `mentions:setPrefs {emailMe:false}` → row and push, no email (**control:** back on → email) |
| the `mention` budget holds | same | `RATE_LIMIT_EMAIL_ORG_PER_HOUR=2` → the second mention email in the hour is not sent; its row and push still are; the `alert` and `dashboard` buckets are untouched |
| a reader who loses access before the send gets nothing | same | write, revoke B's grant, then `notifyMentions` → nothing for B (**control:** C, still a reader, gets all three) |
| *(names never leak)* | same | `comment:list` `people` holds current readers only; a former member's address appears in no name; Home snippet, report discussion page and email say "@Ann Lee" / "@former member", never the address |
| *(audit)* | same | one `comment:mention` row per recipient, target ids = comment, piece, recipient |
| *(no database)* | same file, run without `DATABASE_URL` | `comment:list` says `mentions: false`; a body with a token is refused; `alerts:markSeen` uses the shared flag |
| Vitest: viewers see Mark seen, only editors see Snooze | `AlertsBell.test.tsx` | viewer: Mark seen + Mark all seen, no "Snooze for everyone · 24 h"; editor: all three |
| Vitest: the picker's keyboard behaviour | `MentionInput.test.tsx` | ↑/↓ wrap, Enter and Tab insert `@(addr) `, Esc closes the list and **not** the drawer (control: a second Esc closes the drawer); never opens when mentions are off |
| Vitest: the chip and "@former member" | `CommentBody.test.tsx` | §5.1's table |
| *(Home and Settings)* | `MentionedYou.test.tsx`, `settings.test.tsx` | loading, error (Retry), empty, unseen first, Mark all seen, hidden when unavailable; the switch and its disabled state |
| e2e: A mentions B on a dashboard; B's tab toasts and B's Home lists it | `web/e2e/notifications.e2e.ts` (header sign-in, scratch Postgres; skips without `DATABASE_URL`) | B's page open on Home; A picks B in the dashboard's comments and posts; B sees "… mentioned you on …" with Open, and the "Mentioned you" card; Open lands on the thread; ≤ 25 RPCs per load; light + dark screenshots of the picker, B's toast and B's Home |
| Must stay green | — | alerts, alertChannels, email(-db), smtp, comments, subscriptions suites, `test-rowPolicySafetyNet`, the dashboards e2e; `test-dashboardsServer` with `alerts:markSeen` now `read` |

## 7. Risks and traps

**Cross-user.**
- Every per-user read or write takes the email from `ctx()`, never from input: `alert_inbox`, `mentions`
  (list, seen) and `users.mention_email`. `mentions:seen {id}` matches `user_email` too, so another
  member's piece id changes nothing.
- The push target is `{org, user}`; `sse.ts` delivers only to streams bound to that org and email.
- The picker discloses a project's readers to its readers — inherent to the feature, and no wider than
  "Who has access", which every reader already sees.

**Cross-org.**
- Every new table is org-keyed with RLS forced, and `inOrg` refuses an org that fails `ORG_RE`.
- `readerEmails` names the org, so a token holding another org's address is refused on write and is
  "@former member" on read.
- Mentions on a project an org admin's id-check would allow but which no longer exists: `comments.list`
  fails and the row is skipped.

**Name leaks.**
- The refusal sentence never echoes the address and does not distinguish its cases.
- Names are sent only for current readers.
- The raw body still carries addresses, exactly as `author` carries the author's address today. So a
  reader with devtools sees a former member's address. That was visible when the comment was written,
  to the readers of that time. Accepted, and written into the new threat-model row.
- Reports and the Home snippet go through the labeller (§2.4's missed caller).

**Two `deliver`s, four names.**
- `ipc/alerts.deliver` is renamed first (step 5), before anything is routed.
- `qualityRun`'s feature-detect and `pipelineRunner:139` use untyped `require`. `tsc` will not catch a
  miss: quality alerts would silently stop being recorded.
- `refreshScheduler`'s private `deliver` and `AlertSink.deliver` keep their names, because they are
  scheduler-internal and test-facing.

**The watermark (§5.2).**
- "Mark all seen" marks everything stored when the server handles the click, including an event that
  landed between the client's last read and the click. Today's shared flag has the same race.
- A rule deletion that removes the newest event, together with a pod clock behind it, could stamp a
  later event at or under a member's watermark. That needs both at once; accepted.

**Budgets are per pod** until item 4, which moves every kind, `mention` included, to the shared
counter. An author toggling a mention in and out by editing re-notifies each time. The email budget
bounds the expensive channel; the push and the Home row are not limited.

**At-most-once posts (§5.3)**: a crash between claim and post drops that post.

**Escape in the drawer (§5.11)**, and **`role="combobox"`** on the textarea: e2e selectors are by label,
which still works.

**Merge collisions.**
- `budget.ts` (item 4): additive union member.
- `sse.ts`: untouched.
- `server/app.ts` (items 1, 4): two additive lines.
- Home, CommentsPanel and AlertsBell (item 5): additive components, labels kept.
- `api/index.ts`: append-only, one import and one spread.
- `MAIN_FILES`: append one file.

**Size.**
- `alertStore.ts` (606) and `alerts.ts` (620) gain only the stamp and nothing else. New logic is in
  new modules.
- `ipc/comments.ts` (114), `CommentsPanel.tsx` (355) and `emailChannel.ts` (257) stay far below 500.
