# Email for subscriptions and alerts — design

Branch `feat/email`, item 4 of the five-item round (`next-five.md` §4). Email becomes a third kind of
**channel**, next to Slack and Teams. It is sent by Ordinate's own small SMTP client to **one relay the
operator configures**, and it reaches only people who can read the project **at the moment of sending**.
Phase A is this document. It is attacked by a separate reviewer before any code is written.

## What you will see when this is done

- **Admin → Channels → Add a channel** offers a third platform, **Email**, but only when the operator
  has set `SMTP_HOST` and the server has `DATABASE_URL`. Otherwise the option is not there. The tab's
  existing "this server cannot keep webhook URLs" notice also says that email needs the database.
  An email channel has a name and **recipients**. They are picked from the organization's people and
  teams through a filterable checklist. **No address can be typed.** The table's third column shows
  "4 people · 1 team" for an email channel where a webhook channel shows its *Stored* badge.
- **Send a test email** sends one fixed message, with no data in it, **to the admin who clicked**. The
  message names the channel and says how many people it reaches today. It is rate-limited per
  organization: after the 10th test in an hour the admin sees "Ten test emails were sent from this
  organization in the last hour. Try again later."
- **Subscribe** (and Reports → Subscriptions) and the alert dialog's **Also post to** list email
  channels beside Slack and Teams, each with an envelope mark. The subscription preview gains an
  **Email** tab, which draws the message as it will be sent.
- **In an inbox**, the email comes from the operator's sender (`SMTP_FROM`, for example "Acme Analytics
  <bi@acme.com>"). Its subject is the subscription's title, or "Alert: <rule>". The body has the
  sender's name, the title, the date / view / filter / data-as-of line, the KPI tiles, one table per
  visual (up to 10 rows), a **Open in Ordinate** button in the org's accent colour, the schedule footer,
  and a line saying why the reader got it ("You receive this as a member of “Sales leadership” in
  Ordinate. An organization admin manages that list."). A plain-text part says the same.
- **Run history** gains sentences for the new outcomes: "Not sent to Sales leadership: nobody on it
  can read this project.", "Not delivered to Sales leadership: the mail server answered 550.", and
  others (§9). The relay's own words never appear there.
- **Operators** get `docs/server/email.md` (relays, TLS modes, SES / Postfix / Office 365 examples),
  seven rows in `configuration.md`, and `SMTP_PASSWORD` in the Helm chart's list of refused secret
  names. With `SMTP_SECURITY=plaintext` the server logs a warning at every start.

## 1. Decisions

The first block comes from the plan and is not re-litigated. The second block is the room the plan
left, decided here.

| # | Decision | Why |
|---|---|---|
| P1 | **No new dependency.** A small SMTP client on `node:net` / `node:tls` in `src/server/mail/`. | Plan; CLAUDE.md "ask before a runtime dependency". |
| P2 | **TLS is required.** Implicit TLS (465) or STARTTLS (587). The client refuses before AUTH or MAIL when STARTTLS is not offered or fails. Plaintext only when the operator sets it explicitly, which logs a startup warning. Certificate verification is always on. | Plan. §6 lists every place this is enforced. |
| P3 | **Protocol:** EHLO, AUTH PLAIN / LOGIN, MAIL FROM, RCPT TO, DATA with dot-stuffing. **Message:** multipart/alternative (text + HTML), base64 bodies, RFC 2047 subject, `Message-ID`, `Date`. **Hardening:** CR / LF / NUL refused in every address, name and subject; connect, command and total timeouts; a cap on recipients per message. | Plan. |
| P4 | **One relay per deployment, from env vars.** The password comes from env (Helm `existingSecret`). It is never stored in org_config and never sent to a browser. | Plan. |
| P5 | **The relay connects through the SSRF guard**, with the operator's host admitted explicitly. A host taken from a user or a record never is. | Plan. See §5. |
| P6 | **No SMTP → no email.** The kind is hidden, and the server refuses with a catalog sentence. | Plan. |
| P7 | **Channel kind `email`.** Recipients are users and teams picked by id, **resolved to addresses at send time and intersected with who can read the project then**. No typed external addresses. Without `DATABASE_URL` there is no directory, so no email. | Plan. This closes R15(b) for email. |
| P8 | **One shared send function**, `deliver(channel, model)` in `src/server/subscriptions/deliver.ts`. It replaces the three `postToChannel(… renderX …)` calls and picks Slack, Teams or email. Item 5 adds its row-policy refusal **inside it**. | Plan and the pre-made seam decision (§2). |
| P9 | **One model, three renderings.** The email is drawn from the same `MessageModel` as the Slack and Teams posts: the server's figures (never recomputed), the dashboard's name, its link, a text part that mirrors the HTML. | Plan. |
| P10 | **"Send a test email" is for admins and rate-limited. Each send is audited like a Slack send. Failures are typed:** the SMTP reply text goes to the log, and the user sees a catalog sentence. | Plan. |
| P11 | **Out:** report schedules (desktop-era, `src/server/jobs/schedules.ts:30`), attachments and PDF, per-recipient figures (item 5's phase 2). | Plan. |
| D1 | **A test email goes only to the admin who asked.** It holds no data, and its body says how many people the channel reaches today. | A test to a 300-person list is spam, and it would report nothing the admin can see. The count proves that the list resolves. |
| D2 | **One message per batch of ≤ 50 recipients**, each recipient as its own `RCPT TO`. The header is `To: undisclosed-recipients:;`. | Amazon SES takes at most 50 recipients per message. Office 365 SMTP submission is limited in **messages** per minute (30), so one message per person would hit that limit on a 40-person list. Recipients never see each other's addresses, so a reply-all goes nowhere. |
| D3 | **No org brand name is invented.** The sender, and the small brand line above the title, is `SMTP_FROM`'s display name, or "Ordinate" when it has none. The org's **accent colour** (`branding.accent`) styles the top rule and the button. | `orgs.name` is the org id, and `Branding` holds accent, logo and style, with no name (`src/app/branding.ts:24`). A per-org name is a new setting, with UI and a sanitizer, and is Out. |
| D4 | **No logo** (CID or remote). | §7.3. |
| D5 | **Recipients pass four checks at send time, in one query:** an enabled user row of this org, picked directly or through a team of this org, who can read the project now (an org admin, or a grantee directly or through a team: `readerEmails`' predicate), and whose domain is in `ALLOWED_EMAIL_DOMAINS` when that is set. | That is exactly "who could open this dashboard right now". A user row outside the allowed domains cannot sign in, so it cannot read either. |
| D6 | **Limits:** `RATE_LIMIT_EMAIL_ORG_PER_HOUR` counts **recipients** per org per hour, per pod (default 1000). A send that would exceed it is **refused whole**, never cut short. Test emails also have a fixed cap of 10 per org per hour. | Relays meter recipients (SES per recipient, Office 365 per recipient per day). On a shared multi-org deployment, one org must not use up the relay's quota or reputation. "Per pod" is the documented ceiling of every other limit (`src/server/limits.ts:29`). |
| D7 | **Retries:** up to 3 attempts per batch, with 1 s and then 4 s backoff (`deliver.ts`' own constants and sleep hook), on a transient failure only: a refused connection, a timeout **before the final dot**, or a 4xx reply. **Never after the final `.` has been written.** A 5xx, TLS or AUTH failure is final. | After the final dot the message may already be queued, so a retry would send it twice. |
| D8 | **A partly rejected RCPT list still sends.** At least one `RCPT TO` accepted → the batch is sent. Rejected recipients are counted in the log, together with the relay's reply. Every recipient rejected → `mail_failed`. | Most bounces arrive later as DSNs to `SMTP_FROM` anyway. Failing a 40-person send over one stale mailbox would punish everyone else. |
| D9 | **For an email channel, `secretSet` means "mail is ready"** (SMTP configured and a directory). An email channel has no per-channel secret. | Every picker already greys out a channel whose `secretSet` is false (`AlertChannels.tsx:23`, `Steps.tsx:269`). When the relay is removed, that is the right behaviour. Only the hint text changes per kind. |
| D10 | **`to` (the recipient ids) is in replies to org admins only.** Members see `{id, name, kind, secretSet}` as today. | Only admins can see the directory (`admin:users`, `admin:teams`). `channel:list` is a `read` contract that every member can call. |
| D11 | **No HELO fallback, no PIPELINING, no SIZE, no 8BITMIME/SMTPUTF8, no XOAUTH2.** | Every supported relay speaks ESMTP. Bodies are base64 and headers are ASCII. XOAUTH2 is Out (§12, with what it means for Office 365). |
| D12 | **The email preview tab is in scope.** `subscription:preview` returns `email: {model, bytes, size, notes}` (null when mail is off). | Senders are shown what is sent, as for Slack and Teams. `Preview` is indexed by `ChannelKind`, so the type needs the key anyway. |

## 2. The seam with item 5: `deliver(channel, model)`

```ts
// src/server/subscriptions/deliver.ts (planned)
export interface Delivery {
  /** The message, composed once (analysis/subscriptionMessage.composeMessage). */
  message: MessageModel;
  /** The project whose figures it holds: whose readers an email may reach. Null ONLY for a channel
   *  test, which holds no figures and goes to the calling admin alone (D1). */
  projectId: string | null;
  /** Every dataset whose figures `message` holds ([] for a test). ITEM 5 refuses a dataset with a
   *  row policy HERE, first thing, before a recipient is resolved or a webhook URL is read. */
  datasetIds: string[];
}
export async function deliver(channel: Channel, model: Delivery): Promise<PostResult>; // never throws
```

- `deliver` is the **only** function that sends anything. It routes by `channel.kind`: Slack and Teams
  render with `renderSlack` / `renderTeams` and post through the existing `postToChannel`, and email goes
  to `src/server/mail/emailChannel.ts`. A structural check in `test-email-db` asserts that `postToChannel`,
  `postJson` and the SMTP entry point are called from no other source file. Its negative control
  plants a call in a synthetic file map and must see it.
- **Item 5's insertion point** is the first statement of `deliver`:
  `if (await refusesPolicy(model.datasetIds)) return { ok: false, code: 'row_policy', attempts: 0 }`.
  It covers subscriptions, alerts and every kind, email included. `RunCode` / `PostCode` are open unions,
  so item 5 appends its code.
- **What `datasetIds` holds.** It deliberately over-approximates, so that a miss fails closed. It is computed by
  `figureDatasets()` (planned, in a new `src/ipc/subscriptionDatasets.ts`) from the definitions, **not**
  from what the doors happened to read: a cached answer reads nothing, and a recorder at the read layer would
  miss it.
  1. Every UUID under a `datasetId` key anywhere in each sent card: the metric card, the visual record or
     its inline copy, and its encoding, which includes a related measure's `datasetId`.
  2. Every saved metric a card or encoding names (`metricId`) contributes its record's `datasetId`. A
     **formula** metric also contributes the metrics its formula names, transitively
     (`compileMetricFormula(…).program.metricRefs` over `metricsByName`, with a visited set).
  3. Every dataset named by the dashboard's parameter options (`ParamOptions = {datasetId, column}`,
     `src/analysis/params.ts:43`). A parameter's value can appear in the title and in the filter line.
  4. **Closed over the project's relationships**: every dataset connected to any of the above, in either
     direction (`listRelationships`). Joins can reach a related dataset for a column or a filter
     (`joinedMetricFor`, `joinedVizDataFor`, `src/ipc/relationships.ts:94,127`).
  - Subscriptions: `resolveFigures` returns it in `Figures.datasetIds`, and `buildMessage` carries it in
    `Built`. Alerts: `figureDatasets` over `rule.datasetId` and `rule.metric.metricId`. Test: `[]`.

## 3. Caller inventory (read on b5377dd2)

| What changes | Where | Every caller / reader |
|---|---|---|
| The three sends → `deliver` | `src/server/subscriptions/deliver.ts:102` `postToChannel`, `:74` `postJson` | `run.ts:139` (a subscription run, inside `runInContext(owner)` `run.ts:123`); `alertPosts.ts:54` (a fired alert, from `jobs/schedules.ts:80-84` `deliverTickAlerts`, hooked at `:113` and run under the tick job's `jobs@system` identity, `jobs/runner.ts:89,136`); `rpc.ts:111` (`channel:test`, an RPC). Tests: `test-subscriptions-server.ts:215` (`postJson` directly), `test-alertChannels.ts:87-118`. |
| Renderers + model | `src/analysis/subscriptionRender.ts:82,192`; `subscriptionMessage.ts:80` (`MessageModel`), `:177` `composeMessage`, `:198` `trimModel` | `run.ts:139`, `alertPosts.ts:54`, `rpc.ts:111,151-152` (preview). Tests: `test-subscriptionMessage.ts`, `test-alertChannels.ts:96`, `test-alertDiagnosis.ts:94`. A new `subscriptionEmail.ts` renders the same model. |
| Channel record + sanitizer | `src/app/channels.ts:26` `ChannelKind`; `:87` `getChannel` (rejects any kind but slack/teams, **must admit `email` and sanitize `to`**); `:129` `saveChannel` (`:139` refuses without the secret store, **not applicable to email**; `:145` kind); `:118` `publicChannel`; `:167` `webhookOf` | `run.ts:124`, `alertPosts.ts:52`, `rpc.ts:71,99-100,105,108,164`, `job.ts:28,38`. The `channels/` record root is in `recordFs.ts:76`. No bundle, backup or import carries channel records (grep). |
| Contracts | `src/api/subscriptions.ts:23` `Kind`, `:54` `channel:save` (gains `to: {userIds ≤ 200, teamIds ≤ 50}`), `:59` `channel:test` (`org: true` + `admin`) | No new channel. `check-contracts` is unaffected. `channel:test` is audited by the RPC route (`app.ts:357-365`: every admin call). |
| Web kinds | `web/src/features/subscriptions/api.ts:11,109`; `ChannelMark.tsx:8`; `MessagePreview.tsx:117,138`; `admin/ChannelsTab.tsx:22,87-96,204,250,253,287`; `AlertChannels.tsx:23-24`; `Steps.tsx:266-271` | `Record<ChannelKind,…>` makes `tsc` list every one. |
| Run codes + sentences | `src/analysis/subscriptionText.ts:10` `RunCode`, `:49` `runText` (in `MAIN_FILES`, `scripts/i18n-extract.ts:365`) | `run.ts`, `rpc.ts:36,112,196`. |
| Figures → datasets | `src/ipc/subscriptionFigures.ts:71` `Figures`, `:84` `resolveFigures`; `run.ts:75` `Built`, `:97` `buildMessage` | `run.ts:128`, `rpc.ts:149` (preview, which ignores it). |
| Who may read now | `src/server/authz/index.ts:137` `readerEmails` (org admin OR grant by user or team, enabled); `:67` `authorize`; `run.ts:64` `ownerIdentity` | Reused as the recipient predicate (§8). `jobs/schedules.ts:59` `toReaders` uses the same one. |
| Directory | `users` / `teams` / `team_members` (`0003_auth.sql`), `project_grants` (`0006_authz.sql`); `admin:users` / `admin:teams` (`src/server/admin/people.ts:50,100`; `src/api/admin.ts:24,34`; web `admin/api.ts:190-191`) | The picker reuses the two admin lists. `admin:invite` already enforces `ALLOWED_EMAIL_DOMAINS` (`people.ts:66`). |
| Audit | `run.ts:179` (`subscription:send`), `alertPosts.ts:58` (`alerts:post`), `authz/audit.ts:17,52` | Unchanged. Email sends are covered by the same rows. |
| SSRF | `src/connectors/ssrf.ts:93` `refusedRange`, `:127` `checkHost`, `:165` `pinnedLookup` | All existing callers keep the one-argument form (an optional second parameter, §5). |
| Running outside a request | `context.ts:95` (`ctx()` throws outside one), `:113` `runInContext` | `deliver` runs only inside the three contexts above. The email module reads `ctx().org.id`, and, for a test only, `ctx().user.email`. |
| Rate limiting | `src/server/limits.ts` (Fastify plugin, per request) | Not reusable: a scheduled send has no request. A per-org window counter in `emailChannel.ts` (D6). |
| Env + docs gate | `src/server/env.ts:164` `parseEnv` (499 lines), `:256` return; `scripts/test-serverDocs.ts:80-81` (reads `src.NAME` from env.ts only), `:126`; `docs/server/configuration.md:73` | env.ts passes `src.SMTP_*` to a pure parser in `mail/mailEnv.ts` (the `liveEnv.ts` pattern). env.ts becomes ~502 lines, over the 500 soft line, with nothing else moved. |
| Wiring + logs | `app.ts:207,237` (`wireSubscriptions` / `unwire`), `:78` `REDACT_PATHS` (`password` already redacted at depths 0–4); `subscriptions/job.ts:26-33` | `wireSubscriptions` also hands the mail module the pool and the log. The startup warnings are in `app.ts`. |
| Helm | `deploy/helm/ordinate/templates/_helpers.tpl:44` `$secretNames`; `values.yaml:30,35,69,165-172` | `SMTP_PASSWORD` is added to the refused names. Comments name the SMTP knobs and a 587 egress example. |
| Threat model | `docs/phase-7-web/threat-model.md:65` (B4'), `:158` §4.8, `:262` R15 | §4.11 and R18 are new; R15(b) is edited. |

## 4. The relay: env vars (final)

The names follow `configuration.md` (infrastructure variables carry no `ORDINATE_` prefix: `DATABASE_URL`,
`SSRF_ALLOW`, `OIDC_*`) and the limits' `RATE_LIMIT_*` family. They are parsed in `parseEnv` (startup and
the Helm migration Job), so a typo stops `helm upgrade` before a pod rolls.

| Variable | Meaning | Default | Refused at startup when |
|---|---|---|---|
| `SMTP_HOST` | The relay's host name or IP literal. Bare: no port, no scheme, no path (the `checkHost` canonicalization). Unset = email off. | unset | it is not a bare host; or any other `SMTP_*` is set without it |
| `SMTP_PORT` | 1–65535 | `587` (starttls), `465` (tls), `25` (plaintext) | not a whole number in range |
| `SMTP_SECURITY` | `starttls` \| `tls` \| `plaintext` | `starttls` | another value |
| `SMTP_USER` | AUTH user. Unset = no AUTH (an IP-trusted relay). | unset | set with `SMTP_SECURITY=plaintext` (**a password never crosses a cleartext socket**); set without `SMTP_PASSWORD` |
| `SMTP_PASSWORD` | Secret. Held as a `KeyObject` (as `ORDINATE_MASTER_KEY` is, `env.ts`), so it never reaches JSON, `util.inspect` or a log line; exported only at AUTH. | unset | set without `SMTP_USER` |
| `SMTP_FROM` | `addr@domain` or `Display Name <addr@domain>`: envelope sender, `From:`, `Message-ID` domain. Printable ASCII address (≤ 254). The display name is UTF-8 (≤ 100), RFC 2047-encoded when it is not plain ASCII. | — | missing while `SMTP_HOST` is set; any CR, LF, NUL, `<`/`>`/`"` in the name; an address that fails the strict pattern |
| `RATE_LIMIT_EMAIL_ORG_PER_HOUR` | Recipients per org per rolling hour, per pod (D6). | `1000` | not a positive whole number |

- **Mail is "ready"** when `SMTP_HOST` is set **and** a pool exists. Without `DATABASE_URL` and with
  `SMTP_HOST` set, the server starts and warns "email needs DATABASE_URL (the user directory); email is off".
- **Startup warnings** (logged by `app.ts`): `SMTP_SECURITY=plaintext` → "SMTP_SECURITY=plaintext: emails,
  and the figures in them, cross the network to SMTP_HOST unencrypted". Neither the warnings nor any
  `EnvError` echo the password; `SMTP_FROM` and `SMTP_HOST` are not secret.
- **A private CA** for an internal relay uses `NODE_EXTRA_CA_CERTS` (documented in `configuration.md`
  for Postgres already). **There is no knob that turns verification off**, now or later.
- **EHLO name:** the host of the public origin (`publicOrigin(ORDINATE_PUBLIC_URL, OIDC_REDIRECT_URL)`), or
  the address literal `[127.0.0.1]`. Never a value from a request. Validated as a host name before use.
- **Helm:** `SMTP_PASSWORD` joins `$secretNames` (`_helpers.tpl:44`), so `config.SMTP_PASSWORD` fails the
  render. The `existingSecret` comment lists it, and `SMTP_HOST`, `SMTP_FROM`, `SMTP_SECURITY`, `SMTP_PORT`
  and `SMTP_USER` go in `config`. The `networkPolicy.egress` example gains port 587.

## 5. SSRF: admitting the operator's relay and nothing else

- `checkHost(raw, admit?)` gains an **optional** set of range names to admit (planned). Every existing
  caller passes nothing, so it behaves exactly as today. `OPERATOR_HOST` (exported from `ssrf.ts`) admits
  `loopback`, `private network`, `carrier-grade NAT`, `unique-local IPv6` and `site-local IPv6`: an
  internal relay, or a sidecar on `localhost`, is normal. The following stay refused **even when admitted**:
  `link-local (cloud metadata)`, `unspecified`, `IPv4 embedded in IPv6`, `reserved`, `multicast or
  broadcast`, and the two metadata addresses that sit inside admitted ranges: `100.100.100.200` (Alibaba,
  CGNAT) and `fd00:ec2::254` (AWS IPv6, ULA).
- The relay is resolved **once per connection** and the socket is pinned to that address
  (`pinnedLookup`), while TLS identity is checked against the **name** in `SMTP_HOST` (`servername`).
- **No host can come from anywhere but the env.** The session opener in `smtp.ts` takes **no host
  argument**: it reads the frozen, startup-validated `env().mail`. A channel record has no host field.
  The contract is `strictObject`, and `getChannel` rebuilds the record field by field. `OPERATOR_HOST` is
  referenced from exactly one source file. `test-smtp` asserts this by scanning the source, with a
  negative control over a synthetic file map.
- `SSRF_ALLOW` plays no part. **No MX lookup ever happens:** Ordinate hands mail only to the relay, and
  onward delivery (and its TLS policy) is the relay's.

## 6. The SMTP state machine, and where TLS is enforced

One connection per batch (D2). Each step has its timer. The connect timeout is 10 s. Each command reply
gets 30 s, the reply after the final dot gets 60 s, and a whole batch gets 120 s. Past any of them the
socket is destroyed, and the timeout is retried only if it came before the final dot (D7).

```
CONNECT   starttls/plaintext: net.connect(pinned addr : port)   tls: tls.connect(…) — TLS from byte one ①
  ← 220                      anything else → QUIT, typed failure
→ EHLO <name>   ← 250 (multi-line capabilities)
[starttls]
  STARTTLS not in the capabilities          → destroy, 'tls'  — no AUTH, no MAIL ever sent  ②
  → STARTTLS   ← 220 (anything else         → destroy, 'tls')                                ②
  bytes already buffered after that 220?    → destroy, 'tls'  (response injection)          ③
  tls.connect({ socket, servername, rejectUnauthorized: true, minVersion: 'TLSv1.2' })       ①
  handshake / chain / name failure          → destroy, 'tls'  — never continue on the plain socket
  → EHLO <name>   ← 250   capabilities are re-read HERE; the pre-TLS list is discarded        ④
[SMTP_USER set]
  assertEncrypted(socket)                                                                     ⑤
  AUTH PLAIN base64("\0" user "\0" pass)  if PLAIN offered, else
  AUTH LOGIN → 334 → base64(user) → 334 → base64(pass)  if LOGIN offered, else 'auth' (unsupported)
  ← 235, else 'auth'
assertEncrypted(socket)  (skipped only in plaintext mode)                                     ⑤
→ MAIL FROM:<SMTP_FROM addr>  ← 250
→ RCPT TO:<a> … (≤ 50)        ← 250/251 accepted · 4xx/5xx counted per recipient (D8)
  none accepted → RSET, QUIT, 'rejected' (5xx) or 'temporary' (4xx)
→ DATA  ← 354
→ message, dot-stuffed, then CRLF.CRLF   (after this write, no retry: D7)
  ← 250, else 'rejected' / 'temporary'
→ QUIT  (the reply is not awaited for the result)
```

**Where TLS is enforced, and nothing else may relax it:**

1. ① TLS options are **literals in `smtp.ts`**: `rejectUnauthorized: true`, `minVersion: 'TLSv1.2'`, Node's
   default `checkServerIdentity`, `servername = SMTP_HOST` (left out for an IP literal, which is checked
   against the certificate's IP SAN). No env var, record or argument reaches them.
2. ② In `starttls` mode, a missing `STARTTLS` capability or a reply other than 220 ends the session.
   **No branch continues in plaintext.** This is the STARTTLS-stripping defence.
3. ③ After the 220, the read buffer must be empty before the handshake. Bytes a man-in-the-middle
   pipelined into the plaintext phase are never read as post-TLS replies.
4. ④ AUTH mechanisms are chosen from the **post-TLS** EHLO only.
5. ⑤ `assertEncrypted(socket)` — the socket is a `TLSSocket` with `encrypted && authorized` — runs right
   before AUTH and before MAIL FROM whenever the mode is not `plaintext`. It is an invariant check that
   would catch a future refactor that skips a step. It throws, which is a `tls` failure.
6. Config: `plaintext` + `SMTP_USER` is refused at startup (§4), so credentials never cross cleartext.

**Reply parsing:** `NNN-text` continues and `NNN text` (or `NNN`) ends. All lines must carry the same
code. A reply is capped at 16 KB and 100 lines. A garbled reply, or one over the cap, is a `protocol`
failure.

**DATA safety:** the payload is built with CRLF only. Before it is written it is **checked**: no bare
CR or LF anywhere (the SMTP-smuggling family, e.g. CVE-2023-51764), no line over 998 octets. Then every
line that starts with `.` gets another `.`. Base64 bodies make the check true by construction; the check
makes it enforced.

## 7. The message

### 7.1 MIME

```
From: <SMTP_FROM, as validated>          Sender name: RFC 2047 B-encoded when not plain ASCII, else a quoted-string
To: undisclosed-recipients:;             (D2: recipients only in RCPT TO)
Subject: <title>                         plain when printable ASCII; else =?UTF-8?B?…?= words of ≤ 75 chars, split on code points, folded
Date: <RFC 5322, +0000>
Message-ID: <uuid@SMTP_FROM's domain>
MIME-Version: 1.0
Auto-Submitted: auto-generated           RFC 3834 — out-of-office replies stay quiet
X-Auto-Response-Suppress: All            the same for Exchange
Content-Type: multipart/alternative; boundary="=_ord_<hex>"     ('=' and '_' never occur in base64 lines)
  text/plain; charset=utf-8   Content-Transfer-Encoding: base64   (76-char lines)
  text/html;  charset=utf-8   Content-Transfer-Encoding: base64
```

Every header value goes through `assertHeaderSafe` before a socket opens. A CR, LF or NUL **throws** with
type `input` and nothing is sent. The subject has already passed `clean` in `composeMessage` (control and
bidi characters out). The mail layer is the second wall, and the test proves it without relying on the
first.

### 7.2 The rendering (pure, `src/analysis/subscriptionEmail.ts`)

- `renderEmail(model, { channelName, accent, brand })` returns `{ subject, text, html, model, bytes, notes }`,
  after `trimModel(model, { kpis: 30, sections: 30, rows: 10 })` (Slack's section limit). What was cut is
  said as "+N more in the dashboard". The model's own bounds (`TOP_ROWS` 10, `TABLE_COLS` 5, ≤ 50 chosen
  cards) bound the size. The test measures a worst case and prints it.
- **HTML:** a 600-px table layout with inline styles (mail clients drop `<style>`). Every string is
  HTML-escaped (`& < > " '`). The **only** `href` is `model.link.url`, the server's own `dashboardLink`
  (`ORDINATE_PUBLIC_URL`), and it must be `https:` (or `http:` with `ORDINATE_ENV=dev`). The only
  dynamic style value is the accent, which `sanitizeHex` has already validated. There are no images, no
  `<style>` and no script. `lang` is the org language.
- **Text part:** the same content in the same order: "Label: value (change)", "• row — figure · figure",
  "Open in Ordinate: <url>", the footer, and the reason line.
- **Parity with Slack on links:** a data value that *looks* like a URL may be auto-linked by a mail
  client, as Slack auto-links a bare URL. Data can never produce a link whose **label differs from its
  target**, because no `<a>` is ever built from data. This is R18(c).

### 7.3 The logo: left out (D4)

Reasons: a stored logo is PNG **or SVG** (`branding.ts:28`), and Gmail and Outlook do not render SVG, so
a broken-image box would be the most common outcome. A CID part makes the message `multipart/related`,
which several clients (Outlook desktop, some Apple Mail views) list as an **attachment**, and
attachments are Out. A logo can be 512 KiB (≈ 700 KB in base64) on every batch, as decoration. A remote
`<img>` would be a **read beacon**, and it would need an unauthenticated logo route. The brand is carried
by the sender name and the accent colour. **Next**, if wanted: a PNG ≤ 64 KB as CID, SVG skipped.

## 8. Recipients, resolved at send time

`emailChannel.ts` (planned) runs one parameterised query. `$2` (the project id) is UUID-checked first.
There is **no NULL branch**, so a missing project id cannot widen the list.

```sql
SELECT u.email FROM users u
 WHERE u.org_id = $1 AND u.disabled_at IS NULL
   AND (u.id = ANY($3::uuid[])
        OR EXISTS (SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id
                    WHERE m.user_id = u.id AND t.org_id = $1 AND t.id = ANY($4::uuid[])))
   AND (u.role = 'admin' OR EXISTS (
         SELECT 1 FROM project_grants g
          WHERE g.org_id = u.org_id AND g.project_id = $2
            AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))))
 ORDER BY u.email
```

- The last predicate is `readerEmails`' (`authz/index.ts:137`) word for word. Item 4 writes one query
  rather than intersecting two lists, so a single snapshot answers both questions.
- Then, in JS: drop any address whose domain is not in `ALLOWED_EMAIL_DOMAINS` (when set), and any
  address that fails the strict ASCII pattern (≤ 254). The log records the count only, never the
  address.
- **A test** (`projectId === null`) never runs this query. Its one recipient is `ctx().user.email`, sent
  only if that is an enabled user row of the org. The `jobs@system` identity has no row, so a test that
  somehow ran from a job sends nothing. The "reaches N people" count runs the same query without the
  project predicate, and it counts; it never sends.
- **On save:** `channel:save` with kind `email` refuses when mail is not ready, when there are no
  recipients, or when any id is not a user or team **of the caller's org**. That is checked by a query
  in the handler, not in `src/app/channels.ts`, which stays free of Postgres. At send time, ids that no
  longer exist simply match nothing.
- **No recipients after the checks** → `no_recipients`. Nothing is sent, and the run says so.

## 9. Typed failures: what reaches a browser, what reaches the log

`PostCode` and `RunCode` gain six codes. The sentence is written from the catalog when it is read
(`subscriptionText.runText`, `{channel}` = the channel's name).

| Internal (smtp.ts) | Code | The user reads | The log gets |
|---|---|---|---|
| — | `mail_off` | "Not sent: email is not set up on this server." | — |
| — | `no_recipients` | "Not sent to {channel}: nobody on it can read this project." | channel id, project id |
| — | `rate_limited` | "Not sent to {channel}: this organization reached its email limit for this hour." | org, count, limit |
| `unreachable`, `timeout` | `unreachable` (existing) | "Not delivered: {channel} could not be reached." (existing) | the relay host and port, the error **message** only (never the error object), attempt |
| `tls` | `tls_failed` | "Not delivered to {channel}: the mail server's encryption could not be verified, so nothing was sent." | which check: no STARTTLS / 454 / buffered bytes / the certificate error's code and reason |
| `auth` | `auth_failed` | "Not delivered to {channel}: the mail server did not accept this server's sign-in." | the reply code and text, **redacted** |
| `rejected`, `temporary`, `protocol`, `input` | `mail_failed` | "Not delivered to {channel}: the mail server answered {status}." (status = the 3-digit reply code; 0 → "refused the message") | the reply code, enhanced status and text (≤ 500 chars), **redacted** |

- **Redaction** runs before **every** reply text is logged: the password, the PLAIN blob
  `base64("\0"+user+"\0"+pass)` and `base64(pass)` are cut out, as `redactWebhook` cuts a URL. This is
  needed because a hostile or buggy relay can echo the AUTH line.
- **Never in a reply, a run's history, an SSE event or the audit trail:** reply text, recipient
  addresses, the relay's host, the password. A relay's 5xx that names an address reaches the log only.
- **One info log line per batch:** `{channel id, recipients, accepted, rejected, ms}`, with no
  addresses and no body.
- **Audit:** unchanged rows. `subscription:send` (actor = the owner; targets = subscription + channel
  ids, `run.ts:179`), `alerts:post` (`alertPosts.ts:58`), and the RPC route's own row for
  `channel:test`. Who was on the list at that moment is **not** recorded (§12).

## 10. Test plan (house style: differential with `Object.is`, every guard with a negative control, `finish()`)

**`scripts/smtpFake.ts`** (a helper, not a suite): an in-process SMTP server on `node:net` / `node:tls`
that records each command line and the un-stuffed DATA. A script controls it: capabilities, per-command
replies, STARTTLS on/off, a buffered injection, stalls, echoing the AUTH payload, and implicit-TLS mode.
Its certificate is a committed **test-only** EC P-256 self-signed pair in
`scripts/fixtures/smtp/` (SAN `DNS:localhost` only, 100-year validity). The `openssl` line that made it
is in the file header. The client is told to trust it through a test hook (`trustCaForTest`, never set
by the server).

**`scripts/test-smtp.ts`** (no Postgres):
1. **Transcript:** starttls + AUTH PLAIN, two recipients. The command lines equal the expected array
   exactly. Also implicit TLS, AUTH LOGIN when only LOGIN is offered, and no AUTH without `SMTP_USER`.
2. **STARTTLS required.** NEGATIVE CONTROL: a server that never offers it is refused with `tls`, and
   the fake saw **no AUTH, MAIL, RCPT or DATA**. Control: the same server under explicit `plaintext` with
   no user delivers.
3. **STARTTLS answered 454** → `tls`, with nothing after it. **Injection:** `220 go\r\n250 x` in one
   write → `tls`.
4. **Verification on:** without the test CA → `tls`, nothing sent (control: with it → delivered). With
   the CA trusted but `SMTP_HOST=127.0.0.1`, whose name is not in the SAN → `tls`.
5. **`assertEncrypted`** on a plain socket throws (a direct unit test).
6. **Dot-stuffing:** a raw payload with `.`, `..` and `.x` lines. The wire carries the extra dots, and
   the fake's un-stuffed DATA equals the original byte for byte. A bare `\n` in a payload is refused
   before connecting (control: CRLF passes).
7. **Header-injection canary:** a subject, a sender name and an address each carrying `\r\nBcc:
   canary@evil.test`, or a NUL, → `input`, and the fake saw **zero connections** (control: the same
   subject without the CR is delivered).
8. **MIME:** multipart/alternative; both parts decode back to their inputs; a non-ASCII subject
   decodes back to the original; no encoded word over 75 chars and no body line over 76; `Message-ID`
   and `Date` are well formed.
9. **Timeouts** (shrunk by a hook): no greeting → `timeout`. A stall after the final dot → `timeout`,
   **one** attempt. NEGATIVE CONTROL: a stall before DATA is retried, 3 attempts.
10. **Batching:** 120 recipients → 3 transactions of 50 / 50 / 20. One RCPT 550 → the others delivered.
    All rejected → `rejected`.
11. **Password canary:** a fake that echoes the AUTH payload in its 535. No log line, result or error
    holds the password, `base64(pass)` or the PLAIN blob. NEGATIVE CONTROL: the fake **did** receive
    the PLAIN blob.
12. **SSRF:** `SMTP_HOST=169.254.169.254`, `100.100.100.200` or `0.0.0.0` is refused with no socket.
    `checkHost('127.0.0.1')` without the admit set still refuses (the unchanged callers). The source scan
    finds `OPERATOR_HOST` in exactly one file (NEGATIVE CONTROL: a planted second reference fails).
13. **mailEnv:** every row of §4's refusal column is an `EnvError`, each naming its variable.
    `plaintext` returns the warning text. Defaults per mode. The password never appears in
    `JSON.stringify` / `util.inspect` of the parsed object.

**`scripts/test-email-db.ts`** (needs `DATABASE_URL`; otherwise one skip line). It uses the real app
(`buildApp`), a scratch database, and `smtpFake` as `SMTP_HOST`:
1. Save an email channel as an org admin. Ids from another org are refused (a catalog sentence;
   control: same-org ids accepted). `channel:list` as a member has no `to`, and as an admin it does.
2. **Intersection.** Users: A (viewer grant), B (no grant), C (in team T, which holds a grant), D
   (disabled), E (org admin), plus a planted id from another org. Send now → RCPT set = {A, C, E},
   exactly. **Lost access:** revoke A → the next send excludes A. NEGATIVE CONTROL: grant B → B now
   receives. **Teams:** add C2 to T → receives; remove → does not.
3. **Differential:** every KPI value, row label and figure string in the text part is `Object.is` to
   the string in `renderSlack(built.model).model` for the same build: one model, no recomputation.
4. **Alert end to end:** `deliverTickAlerts` with a rule naming the email channel → the fake receives
   the rule's sentence, with the same intersection.
5. **Mail off:** with SMTP unset, `channel:save` of kind email is refused, `canEmail` is false, and an
   existing email channel's send is `mail_off` with **zero connections**. `ALLOWED_EMAIL_DOMAINS` drops
   an off-domain user (control: the domain allowed → received).
6. **`no_recipients`, `rate_limited`** (the budget set to 3 with 4 readers → refused whole, zero RCPT),
   **the test-send cap** (the 11th test in the hour is refused; another org is unaffected), and **a test
   goes to the caller only**.
7. **`SMTP_PASSWORD` canary:** absent from every app log line, every RPC reply, every `records` row,
   `audit_log`, `jobs` and every SSE event (control: the fake received it).
8. **One door:** a source scan shows `postToChannel`, `postJson` and the SMTP entry point referenced
   from no file but `deliver.ts` / `emailChannel.ts` (NEGATIVE CONTROL: a planted call is found).
   **Audit:** an email send leaves its `subscription:send` row.
9. **`figureDatasets`:** a visual joined to a related dataset, a formula KPI naming a metric on a third
   dataset, and a parameter over a fourth → all four are in `Built.datasetIds`. NEGATIVE CONTROL: a
   dashboard with no relationships, metrics or parameters → exactly its base datasets.

**Must stay green:** `test-subscriptions-server`, `-db`, `test-subscriptionMessage`, `test-alertChannels`,
`test-alertDiagnosis`, `test-subscriptionsLive`, `test-serverDocs` (7 new rows), `test-securityReview`,
`test-ssrf` (the one-argument `checkHost` is unchanged).

**Vitest** (`channels.test.tsx`, `subscriptions.test.tsx`): Email is offered only when `canEmail`
(control: hidden without it); the picker lists people and teams from the admin lists, and saving sends
`{kind: 'email', to}`; there is no address input anywhere; the Email preview tab draws from `email.model`.

**e2e** (`channels.e2e.ts`, extended): the fake SMTP runs in the spec's process, with
`SMTP_SECURITY=plaintext` (TLS is `test-smtp`'s job). An admin adds an email channel with a person and a
team, sends a test (it arrives at the fake), and a subscription's preview shows the Email tab.
Screenshots `channels-email`, `channel-email-dialog` and `subscription-email-preview`, light and dark,
are looked at.

## 11. Steps (each a local commit)

1. This document.
2. `mail/mailEnv.ts`, its three lines in `env.ts`, the startup warnings in `app.ts`, the
   `configuration.md` rows, and Helm (`$secretNames`, values comments, the egress example) →
   `test-serverDocs`.
3. `checkHost`'s optional admit, `mail/mime.ts`, `mail/smtp.ts`, `scripts/smtpFake.ts` and the fixtures,
   and `test-smtp`.
4. The `email` kind: the record and sanitizer (`channels.ts`), the contract's `to`, the `channel:save` /
   `channel:list` handlers (`canEmail`, `to` for admins, refusals), and the sentences.
5. `subscriptionEmail.ts` (render), the `email` preview in `subscription:preview`, and
   `node scripts/i18n-extract.js`.
6. `figureDatasets`, then `deliver(channel, model)` replacing the three call sites, then
   `mail/emailChannel.ts` (recipients, limits, batches, retries, typed results, log lines). Then
   `test-email-db`, and updates to the subscription and alert suites wherever a call site moved.
7. Web: the kind, the recipient picker, the Email preview tab, the per-kind hints, and Vitest.
8. e2e and screenshots.
9. Docs: `docs/server/email.md`, `subscriptions.md`, `docs/server/README.md`, threat model §4.11 + R18 +
   R15(b), CHANGELOG, a `docs/README.md` row.
10. Gates (agent-rules §5), then a self-review of `git diff b5377dd2...HEAD`.

## 12. Out, and the ceilings this leaves

- **XOAUTH2 / OAuth relays.** Microsoft is retiring Basic-auth SMTP AUTH on Exchange Online, so **Office
  365 is documented through a relay connector**: port 25, STARTTLS, IP- or certificate-trusted, no
  `SMTP_USER`. Clouds that block outbound 25 (GCP always; AWS by default) need SES, a 587 provider, or an
  internal Postfix.
- **Unsubscribe / `List-Unsubscribe`.** The list is admin-managed internal mail. The footer says who
  manages it. A one-click unsubscribe needs a signed-token route.
- **A per-recipient audit** (who was on the list at the moment of sending). The audit row names the
  channel. Recipient ids can join `target_ids` with the migration that adds a `subscription_send` action
  (R15(f)).
- **Rate limits are per pod** (N pods allow N × the limit), like every other limit (R8).
- **A recipient count in the subscription dialog** ("reaches 4 people who can read this project"). Today
  a send with nobody to reach says so in its run.
- **A per-org brand name, the logo, PDF and attachments, per-recipient figures** (item 5 phase 2), and
  report schedules.
- `env.ts` sits at ~502 lines (soft limit 500), and the parsing itself lives in `mail/mailEnv.ts`.

## 13. Threat-model changes (written in step 9)

- **§4.11 Email (new):** a table in §4.8's form. Threats: exfiltration to an address nobody approved;
  a recipient without access; downgrade / STARTTLS stripping / response injection; certificate
  impersonation; header injection and SMTP smuggling; SSRF through the relay; the password leaking; a
  hostile relay's replies reaching a browser; a flood or quota exhaustion; mail loops. Each row names its
  test from §10.
- **R18 (new):** (a) the relay sees the full message and recipient list, by design, and onward TLS is
  its policy; (b) rate limits per pod; (c) mail clients auto-link URL-shaped data (label = target, as in
  Slack); (d) partly rejected RCPT lists send (D8); (e) a recipient's access is checked at send time,
  not at read time: a forwarded email is out of Ordinate's control, as with any export; (f) no
  per-recipient audit.
- **R15(b) (edited):** "…to every member of that Slack / Teams channel whether or not they have access
  in Ordinate. **Email channels do not have this gap: their recipients are resolved at send time and
  intersected with the project's readers (§4.11).**"
