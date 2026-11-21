# Embedded Assistant

Feature 10 of the 10 Lightdash-parity AI features. The owner's plan page is
https://claude.ai/artifact/HZqc9pTPdjiTYuMUhdhA36. This is the riskiest of the ten: it is the only feature
where a person with no account, outside the company, talks to the Assistant. One reader that skips the
customer lock is a data leak between customers.

## What it is

A software company puts "Ask about your data" inside its own product. Its backend signs a short token naming
an Assistant agent, the customer who is asking, and **locked filters** (`customer_id = 123`). The page in the
iframe sends the token and the question to Ordinate. Ordinate checks the token, builds an **embed asker**
(no account, viewer rights), asks the agent with the lock on every read, and returns the answer with its
chart. Nothing is saved but an audit row. Dashboards are embedded the same way today (`docs/embed/`); this
adds a chat.

## Decided by the owner

1. **An iframe with a signed link only.** No React package.
2. **The conversation lives only while the page is open.** Nothing is kept after it, apart from the audit row.
3. **Only datasets an admin marks embeddable, each with a filter column every token must lock.**
4. **A daily org cap and a per-customer per-minute cap, set by an admin.**

## Calls made in the design (settled unless the owner objects)

- **Build order:** phases 1 and 2 are PR 1 (this one), phases 3 and 4 are PR 2.
- **No SQL answers, no drivers, no joins, no metrics, no terms.** SQL writes its own query, which a row lock
  cannot wrap. Drivers and a related dataset already refuse under any row lock (`lockedViz`); a saved metric
  measure refuses too (`reachesOther`). Kept as they are, and tested for an embed asker.
- **Tokens live at most 1 hour** (dashboards: 24 h), because every question is a model call.
- **Viewer rights only:** nothing is saved, shared or exported from an embedded Assistant. There is no RPC
  for an embed asker at all: the token works on one route and nowhere else.
- **Lock values are strings.** A number in `params` becomes its `String()`; the required column must be a
  declared **text** column (as row access rules require), so `007` stays `007`.
- **`params` may only name required columns.** A token whose `params` names a column that is not the required
  column of some embeddable dataset of the agent is refused (the plan's "a filter on a column the dataset
  lacks"). A token that lacks the required column of any embeddable dataset of the agent is refused as a whole.

## The shape: an embed asker is a restricted caller with a forced lock

The row access machinery (`docs/row-policy/`) already makes every reader of the app either take a lock or
refuse for a **restricted caller**. An embed asker reuses it instead of adding a parallel check at each reader.
The difference from a viewer with row rules is that a viewer's lock exists only where an admin set rules; an
embed asker's lock exists on **every** dataset, and a dataset that cannot honour it is refused. Two choke
points make that so, both **fail closed**:

- `rowLockFor` (`src/data/rowAccess.ts`): for an embed asker it never returns `null`. It returns the token's
  lock on the dataset's required column, or throws `RowPolicyError`: a dataset that is not embeddable for this
  agent (`none`), one with row rules of its own or built from one (`derived`), a required column that is
  missing, not text, or gone from the warehouse (`column`), a prepare step that stores a cross-row value, or one
  that reads a dashboard parameter (`pipeline`), as-of (`asOf`), an export or a fan-out (`export`, `fanout`).
- `closedReason` (the storage net, `gateRows`, `closedToCaller`): for an embed asker **every** dataset is
  closed outside the lock scope of exactly that dataset (`reader`), whether or not it has rules. A reader that
  skips the lock is refused by the net, not read.

`callerOn` answers `restricted` for an embed asker without any `users` query, and `grantRank` answers rank 1 on
the agent's project and 0 anywhere else. So every `restrictedOn`, `closedToCaller`, `withLockOf`, `lockedViz`,
`lockedMetric`, `hiddenColumnsFor` and folder check behaves as for a viewer with no team. A dataset in a team
folder the viewer cannot open is refused by the folder gate (an embeddable dataset must be open to everyone).

The identity is `Identity.embed` (`src/server/context.ts`): the agent, the project, the customer id (`sub`),
and per embeddable dataset its required column and the token's values. It is built **only** by
`src/server/embed/asker.ts` from a verified token and a stored marking, and exists for one request.

## The token (phase 1)

A JWT, HS256 only, signed by the host's backend with the org's embed secret (`kid` = org id), exactly like a
dashboard token: `readHeader`, then the MAC in constant time, **then** the claims. A new claims parser
(`src/server/embed/askToken.ts`) with its own closed set:

| Claim | Meaning |
|---|---|
| `agent` | uuid of the Assistant agent (must be marked embeddable) |
| `sub` | the customer's own user id: a string, 1 to 200 characters, not blank, no control character |
| `params` | locked filters: column → 1 to 100 literal values (the dashboard token's `lockValues`) |
| `exp`, `iat` | seconds; `exp` at most 1 hour ahead (+60 s skew), not in the past (-60 s) |

Anything else is refused: `pub`, `dash`, `prv`, `theme`, `hide`, any unknown claim. The dashboard parser
already refuses `agent` and `sub`, and requires `pub`, so a token of one kind never verifies as the other
(tested both ways). A token is verified with the org's secret only, never the preview key.

`sub` is the customer's id and a filter value is data, so neither is logged: a log line carries the token's
fingerprint (its MAC prefix) and ids of our own records only. The token travels in the **body** of a `POST`
(`/embed/ask`), never in a URL, so no access log has it; `maskEmbedUrl` and `maskEmbedTokens` are also taught
`/embed/ask/<token>` (the page URL of phase 3), with a test.

## What is embeddable (storage, migration 0049)

One migration holds all four phases, so round 2 does not touch it.

- `embed_agents (org_id, agent_id, project_id, datasets jsonb, enabled, updated_by, updated_at)`: which agents
  may be embedded, in which project, and `datasets = [{ id, column }]`: each embeddable dataset and the column
  every token must lock. An agent with no embeddable dataset is not embeddable.
- `embed_assistant_limits (org_id, daily_cap, per_minute_cap, updated_at)`: Q4. No row: 1,000 a day, 10 a
  minute per customer. Counted across pods with `src/server/counters.ts`.
- `embed_asks (org_id, id, at, agent_id, customer, outcome)`: the audit row of every question, written after
  the token's MAC held. No question, no answer, no filter value. Its own table, so the shared `audit_log`
  CHECK is not widened (another PR also widens it).

Forced RLS on `ordinate.org`, as 0041 to 0043. The route reads these before any request context exists, so the
store runs `inOrg(pool, org, …)`. The agent record stays a project record (`src/ai/agents.ts`); the marking is
beside it, never on it, so an older release's `sanitizeAgent` cannot drop it.

Saving a marking (phase 4) checks each dataset: it exists in the agent's project, the column is a declared
text column, the dataset has no row rules and is not built from one, no cross-row prepare step
(`ruleState`). The route checks all of it **again** on every ask, from the
current record: a marking is a claim, the record is the truth.

## The ask (phase 2): a thin path, not `copilot:ask`

`copilot:ask` persists a thread, snapshots, onboarding and verified answers, and falls back to the Project
assistant when an agent is not usable. None of that is right for an outside customer, so the embed ask
(`src/ipc/embedAsk.ts`) is its own short function over an **explicit allow-list of readers**:

1. The agent, read by id: missing, or not marked, is a refusal. **Never a fall-back** to the Project assistant.
2. The set of datasets it may read is the marking, whatever the agent's topic says. A topic only narrows it.
3. **Facts**, built here: the schema (names, declared types, the editors' column notes and table notes) of each
   embeddable dataset, with columns hidden from the caller dropped. No sample values, no profile, no insights,
   no row, no count, no project name, no list of other datasets.
4. **Guidance:** the embedded agent's own instructions only.
5. One `askCopilot` call with the client's transcript (text only, untrusted, bounded; Q2 under any-pod).
6. The action: only `answer` goes on. `sql`, and every other action, is dropped server-side.
7. `answers.answerFromAction` with `only` = the marking: the chart is built by the app through the doors, under
   the lock. Value matching, "did you mean" and nearest values read only the locked rows.
8. The number guard (`guardAnswer`) over the facts' ledger and the card's.
9. The reply: text and a **whitelisted** card (title, chart type, dataset name, data, caption, headline,
   bullets, filter labels, notes, as-of). Not the spec's steps, not the chips (they call RPCs an embed asker
   does not have), not `uses`.

**Nothing is saved:** no thread, no turn, no visual, no Story, no History, no onboarding tick. A guard in
`copilot.appendTurn` and `createThread` refuses an embed asker as a second layer.

### Policy for each reader with no row to lock

| Reader | Policy | Why |
|---|---|---|
| Rows, facts, answer cards, value matching, nearest values | locked through `rowLockFor` | the lock |
| Sample column values (`copyValues`, Live profile samples) | **omitted** | they come from an index of every row; a closed dataset gets none |
| Insights, dataset stats, quality | **omitted** | computed over every row |
| Verified question examples and word-for-word verified answers | **omitted** | an editor's question text can name a customer; a hit persists a turn |
| Knowledge documents (project's and the agent's) | **omitted** | a document cannot be row-locked and may name a customer |
| Project instructions, dataset guides | **omitted** | written for the project's own people |
| Metrics, glossary terms | **not offered** | a metric measure already refuses under a lock; a term can carry a customer's value |
| Out-of-scope offer ("try the Project assistant") | **omitted**, a fixed sentence | it names datasets outside the agent |
| Search (`assistantSearch`) and value index | **not used** | no project-wide search runs; datasets are the marking's |
| Drivers, joins, SQL, source tables | **refused** | already refused under a lock, or off |

**Metadata ceiling (stated in Admin, phase 4):** the names of the embeddable datasets and their columns, the
editors' notes on them, and the agent's instructions are shown to every customer. Do not put a customer's name
in them.

## The leak safety net (phase 2's main deliverable)

`scripts/test-embedLeakNet.ts`, in the row-access world (a scratch Postgres, two customers, `acme-1` and
`beta-2`). It runs the real embed ask with a **scripted model** and plants another customer's value (a canary
string, and a distinctive row count) in every place a reader could carry it: a cell, a column's sample values,
the value index, a verified question, a knowledge document, an insight, a column note, the dataset's own
total. It asserts that it **never** reaches:

- the prompt sent to the model (the real request, captured at `analyze.dispatch`);
- the reply, the card, and a "did you mean" or nearest-values option;
- a log line (every logger and Fastify line), or an error message;
- the audit row.

It cannot pass by saying nothing: for each reader it first asserts that the asking customer's **own** planted
value does reach the prompt or the card through it (so an empty reader fails the net), then that the other
customer's does not. It also asks a question that **names** the other customer's value, and checks a second
value of theirs that the question did not contain.

**Negative controls**, each proven to fail the net: the `rowLockFor` embed branch off; the `closedReason`
embed branch off; one reader (the value-matching reader) run without its lock; the sample-values reader run
without the closed check. Plus: a plain editor's ask on the same data shows the canary (the canary is real).

Also: token tests with a negative control each (expired, too far, wrong key, unknown claim, `pub` present, kind
confusion both ways, a lock on a column the dataset lacks, a missing required lock, a blank value, a
`[[param]]` value, a non-text required column, row rules on the dataset), and the coverage rule: a dataset
read that goes through `getDataset` outside a lock scope is refused for an embed asker (the storage net).

## The route (phase 1 and 4)

`POST /embed/ask` body `{ token, question, history? }`, outside `/api/`, so no cookie, no CSRF cookie. In order:

1. header shape, the org's secret, the MAC (a bare refusal for any failure, as dashboards do);
2. the org has embedding on (`org_settings.embed_enabled`);
3. the claims, the marking, the asker (every refusal audited from here);
4. the caps (phase 4): per customer per minute, the org per day; over: 429 with `Retry-After`;
5. `runInContext(identity, …)` and the ask; an audit row; the reply.

Phase 3 adds `GET /embed/ask/<token>`: the small page (its own bundle, CSP `frame-ancestors` = the org's
origins). Phase 4 adds the admin section and the snippets.

## Files (round 1)

New: `src/server/embed/askToken.ts`, `asker.ts`, `assistants.ts` (the store), `askRoute.ts`;
`src/ipc/embedAsk.ts`; `src/server/db/migrations/0049_embed_assistant.sql`; `src/server/embedAskMessages.ts`.
Touched: `src/server/embed/token.ts` (export `lockValues`, a shared MAC check), `src/server/embed/route.ts`
(masking), `src/server/context.ts` (`Identity.embed`), `src/server/authz/caller.ts` and `authz/index.ts`
(`grantRank`), `src/data/rowAccess.ts` (the two choke points), `src/ai/copilot.ts` (no persistence guard),
`src/server/app.ts` (register the route), `src/i18n/*`.
Tests: `scripts/test-embedAskToken.ts`, `test-embedAsker.ts`, `test-embedLeakNet.ts`.

## Open points

1. **Verified question examples, knowledge documents, project instructions and guides are off for embed
   askers.** The plan lists verified examples and documents among the readers that take the lock. They have no
   rows to lock: they are text an editor wrote, which may name a customer. Safest option that keeps the plan's
   intent: omit them. Proposed later: a per-document and per-verified-question "may be shown to customers" flag.
2. **No sample values for the model.** The plan locks `sampleValuesNote` and `copyValues`. Both read an index
   of every row, which cannot be locked; the existing rule for a closed dataset is "none", and it holds here.
   The model matches words to values through the app's loose match under the lock (step 7) instead.
3. **`params` names required columns only.** A host cannot add a narrowing lock the agent has no column for.
4. **`copilot:ask` is not reused.** See "The ask". Verified word-for-word answers do not run for embed askers.
5. **The page's follow-ups use a client-held transcript.** Untrusted text: the customer could write the same
   words as a question. It carries no figure the server trusts (every figure is recomputed and audited).
6. **Round 1 has no admin screen.** Until phase 4, an agent is marked through `assistants.ts` only; the route
   answers every token with the bare refusal while no agent is marked, so it is dormant on develop.
