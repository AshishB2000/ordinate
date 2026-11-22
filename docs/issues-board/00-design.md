# Data issues board

Feature 8 of the 10 Lightdash-parity AI features. The owner's plan page is https://claude.ai/artifact/EYcSQhNs8brUwyXq7cEvFq.
Built on #584 (thumbs, `assistant_feedback`) and #583 (metric proposals).

## What it is and why

A weekly background check reads the Assistant's **stored** answers, runs **no new query**, and finds where it struggled. It groups the
same problem into one **issue** with a title and a suggested fix. An editor opens Model → Assistant → **Issues**, turns an issue into a
metric proposal (#7), sends it to Linear or Jira, or marks it resolved or ignored. A resolved issue that comes back reopens itself.

Lightdash's version does the same over its agents' threads and sends to Linear or Jira.

## Decided by the owner

1. **Q1: editors see question text and the reason, never answers.** An example is a question's words and the signal that flagged it
   (its reason). Never an answer, a figure, a row, or who asked (only a count of people). The Assistant tells people, in one line under
   the composer, that editors may see questions that didn't get a good answer.
2. **Q2: a ticket carries the title, the summary and a link back.** No question text leaves Ordinate.
3. **Q3: Linear and Jira Cloud.** Jira Server and Data Center are out.

## Calls made in the design (settled unless the owner objects)

- Editors and admins see the board (`write` access on the project). The project's admin turns the check on (`admin`, project scope);
  it is **off by default**. The **org admin** connects Linear or Jira (Admin → Integrations, `admin`, org scope).
- **No new queries.** The check reads `assistant_turns`, `assistant_threads` and `assistant_feedback` rows only. A test spies on every
  engine query path and on `getDataset` and proves none is called.
- **The model never sees a figure.** One call per new group, seeing question texts, signal names, a missing name and dataset names. Never
  an answer's words, a ledger, a card, a figure or a row. A canary test plants them and greps the prompt and every output.
- **Nothing leaves until an admin connects and an editor presses Send.** The weekly job makes no outbound tracker call.

## The signals (all read from stored turns)

Hidden conversations (a suite run's, `assistant_threads.hidden`) and deep-research turns are never read.

| Signal | Where it is stored | Cause key |
|---|---|---|
| `needs_link`, `needs_copy` | assistant turn body `needs` (and `link`) | the two datasets of the link, or the dataset to copy |
| `undefined_name` | body `define` (#7) with `suggest.said` | the name nobody defined |
| `refused` | body `suggest` without `define` | the part and the name it could not find |
| `outside` | body `outside.dataset` | the dataset the Project assistant answers from |
| `untraced` | the turn text holds the number audit's note (`Contains a figure the app did not compute: `). Only the marker is tested; the figures after it are never copied | none: question words |
| `thumbs_down` | `assistant_feedback` (value `down`, with its reason and the question) | none: question words |
| `asked_again` | two user turns in one conversation within 60 seconds, in other words (similar, not equal) | none: question words |

A signal's **question** is the user turn just before the assistant turn (the asker's own words). Its `dataset_ids` are `shows(turn)`
(turnsOpen) and its `dashboard_ids` are `dashboardsFrom`, kept so the board can apply the folder rule at read time.

## Grouping

Pure (`src/ai/issueGroups.ts`):

1. Signals with a cause key group by key.
2. Signals with no key (untraced, thumbs-down, asked again, an undefined name with no `said`) first join a keyed group whose name
   they contain, else cluster by similar question words (content words, Jaccard at least 0.4), or by meaning when an embedding model is
   set up (cosine at least that model's minimum, `fingerprints.minSimilarity`; a failed call falls back to words).
3. A group's key is its cause key, or `words:` plus its three most frequent words. A new group **joins an existing issue** with the
   same key, or (words groups) one whose stored words overlap at least 0.5. A resolved or ignored issue is matched too.
4. **A group under 3 questions is stored but hidden** (`MIN_QUESTIONS`). It appears when it grows to 3, and then keeps growing.
   An issue on the board always grows.
5. A resolved issue that gets a **new** signal dated after it was resolved reopens (`reopened` counts how often). An ignored one stays
   ignored.

## Names and suggested fixes

One model call per issue that is on the board and not yet named (`named = false`), at most 10 a run. The prompt
(`src/ai/issueName.ts`) holds the signal names, the missing name, the dataset names and up to 12 question texts (each cut to 200
characters, one line). The reply is `{"title","fix"}`, parsed and checked, never repaired: a reply with a digit, a newline or too
long a text is dropped, and the app's own sentence stands in (a `t()` sentence from the cause). No model, or a failed call, leaves it
unnamed for the next run. The model never writes a count: the board shows the app's counts.

## Privacy: who sees what

- A signal row keeps the question text and its asker (`owner`). **Replies never carry the asker**, only a count of people.
- **Examples follow the folder rule of #5's inbox** (`openRows`, `levelsOf`): a question whose answer showed a dataset or dashboard
  closed to the caller is not shown to them. Because the title and the fix were written from every question of a group, an issue
  with **any** signal on something closed to the caller is **hidden from them entirely** (fail closed; an admin opens everything).
  This goes one step past the plan, which only hid the example. See Open points.
- The Assistant notice (Q1): "Editors may see questions that didn’t get a good answer." (its tooltip adds: They never see the answers.)
- Signals older than 90 days are deleted by the job, and an issue left with none.

## Storage (`0048_issues_board.sql`, additive)

All tables: forced RLS on `ordinate.org`. The job runs inside the org's context, so no system scope is needed.

- `issue_settings (org_id, project_id)`: `enabled` (default false), `enabled_by`, `last_run_at`, `last_error`.
- `issues (org_id, id)`: `project_id`, `key` (unique per project), `tokens`, `kind`, `title`, `fix`, `named`, `status`
  (`open | resolved | ignored`), `status_by`, `status_at`, `reopened`, `proposal_id`, `created_at`, `updated_at`.
- `issue_signals (org_id, project_id, turn_id, kind)`: `issue_id`, `reason`, `question`, `owner`, `dataset_ids`, `dashboard_ids`, `at`.
  The primary key makes a rerun, or an overlapping window, add nothing twice.
- `issue_tickets (org_id, issue_id, provider)`: the tracker's reference and URL, so Send makes **one** ticket per issue and tracker.
- `tracker_integrations (org_id, provider)`: non-secret settings (Linear team id and key; Jira site, email, project key).
  The token is in the **secrets store** (`tracker.token`, ref = provider, never `config.json`).

## The weekly job

`issues:weekly`, one scheduled row per org (`defineJob`, any pod, FOR UPDATE SKIP LOCKED under a lease, `src/server/jobs/runner.ts`),
every 6 hours. Per project with the check on and `last_run_at` older than 7 days (or never): read turns and thumbs since `last_run_at`
(7 days the first time, at most 5,000 turns), extract, group, store, reopen, name new groups, sweep, stamp `last_run_at`. A failure is
recorded in `last_error` and retried at the next wake. A crash repeats safely (primary keys). "Check now" (admin) runs the same function.

## Contracts (`src/api/issues.ts`)

| Channel | Access | What |
|---|---|---|
| `issues:list` | write, project | the board: issues with counts, examples, fix, tickets; the check's on/off and last run; which trackers are connected (one call, so the tab loads cheaply) |
| `issues:setEnabled` | admin, project | switch the check |
| `issues:checkNow` | admin, project | run the check now |
| `issues:setStatus` | write, project | `open`, `resolved`, `ignored` |
| `issues:propose` | write, project | calls #7's `proposeFromQuestions` with the issue's open questions |
| `issues:send` | write, project | one ticket to `linear` or `jira` |
| `tracker:status` | admin, org | per provider: connected, settings, `hasToken` |
| `tracker:connect` / `tracker:disconnect` | admin, org | save (token to the secrets store) or remove |

Every reply carries has-token flags only. `proposeFromQuestions` and `raiseProposal` trust the emails they get and check no access of
the askers (their header says so), so they are called only from `issues:propose`, an editor-scoped contract, with the board's own
questions (those open to the caller).

## Linear and Jira Cloud (`src/server/issues/trackers/`)

- Every call goes through `safeFetch` (`src/connectors/ssrf.ts`) with `redirect: 'error'` to the provider's own host: `api.linear.app`, or
  the admin's `<site>.atlassian.net` (a strict hostname pattern; no scheme, port, path or user info accepted).
- Linear: GraphQL `issueCreate` with the team id found at connect time from the team key; the API key goes in `Authorization`.
- Jira Cloud: REST v3 `issue`, Basic auth (email and API token), the project's **default issue type** (the project's own issue types:
  `Task` if it has one, else the first that is not a sub-task). Required custom fields are not handled (version 1, as the plan says).
- A ticket is the title, the summary (the fix, and the counts of questions and people) and a link back to the issue in Ordinate.
  No question text (Q2).
- Connect checks the token with one read call (the viewer's name, the team, the project); that is the only call an admin triggers.
- Tests replace the transport (`setTransport`) with a stub provider; no test makes a network call.

## Screens

- Model → Assistant → **Issues** section (editors): a header with the on/off state and the last check, then rows: title, a count of
  questions and people, the signal badges, the suggested fix, the examples (words only) and the actions Propose a definition, Send to
  Linear / Jira (only when connected), Resolve, Ignore, Reopen. Real empty, loading and error states, light and dark.
- The project admin sees the switch and **Check now**.
- Admin → **Integrations**: Linear and Jira cards with the has-token state, Connect, Disconnect.
- Under the Assistant's composer, the one-line notice.

## Tests

- `test-issueSignals`: the extractor on fixed turns, each signal, hidden and research turns skipped, the audit marker found without its
  tokens, asked-again at 59 and 61 seconds, equal text not counted.
- `test-issueGroups`: keyed groups, word clusters, the join of an unkeyed question to a named group, under 3 hidden, growth, the key of a
  group stays when a word is added, meaning similarity (injected vectors), a negative control (unrelated questions stay apart).
- `test-issueName`: prompt shape, no digit in a reply, one call per group.
- `test-issuesStore` (DB, ordinary role): forced RLS and a negative control, the primary key's idempotence, reopen only on a newer
  signal, ignored stays ignored.
- `test-issuesJob` (DB): the whole check on seeded conversations; **no engine query** (spies on `queryAsync`, `execAsync`, `getDataset`);
  a canary (a planted figure and row value in answers, snapshots and the audit note) never in the prompt or the board; off by default; a
  second run adds nothing; the folder rule.
- `test-issuesAccess` (DB): viewer refused; editor reads; only the project admin switches; propose calls #7 as the editor; folders.
- `test-trackers`: stub provider for both; one ticket per issue; secret canary (plant the token, grep every reply, the log and the
  database rows); SSRF host rules and `redirect: 'error'`; **no transport call** from the job or a refused Send; admin-only.
- Vitest for the board and Integrations; Playwright `web/e2e/issues.e2e.ts`.

## Open points

1. **Hide an issue from an editor if any of its questions is closed to them** (not only the example). The plan hid only the example, but
   the title and fix are written from all of a group's questions, so showing them would leak a closed folder's wording.
2. **"Weekly per project"** is an org job that wakes every 6 hours and works the projects whose last check is a week old, so enabling a
   project does not wait up to a week for the next fixed day.
3. **Jira's "default issue type"** has no field of that name in Jira Cloud: the rule above (Task, else the first non-sub-task).
4. **`issues:checkNow`** is not in the plan. It lets an admin test the setup, and lets the e2e run the check.
