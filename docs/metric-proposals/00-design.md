# Metric proposals

Feature 7 of the 10 Lightdash-parity AI features. Agreed with the owner on 2026-11-21. The plan page is
https://claude.ai/artifact/S82qYBptbWJ2EgHXUenGGi.

## What it is and why

When the Assistant cannot answer because a name is not defined ("gross margin"), a person can press
**Propose a definition** on the refused answer. One model call drafts the missing **metric** or **business term** as
structure (a name, a formula over existing columns, a description, other names). The app checks the draft; it is never
repaired. The draft waits in **Data model → Proposals** for an editor, who sees the definition and a live preview
computed under their own access, and approves it, edits it, or declines it. Approval is the normal metric or term save.
The people who asked are told, so they can ask again.

Lightdash opens a dbt pull request. Ordinate is the data model itself, so the fix lands in the app, and a person
approves it. The model writes words and a formula. **The engine computes every preview figure**; a model never
writes a number (AGENTS.md core principle).

## Decided by the owner

1. **Anyone who can read the project may press "Propose a definition"** on a refused answer. Only editors and admins
   see the queue and decide. The editor sees the question text, never the asker's figures. The button says so.
2. **Metrics and business terms only.** No column descriptions, no calculated columns.
3. **No dbt pull requests.** Proposals land in Ordinate's own model.

## Calls made in the design (settled unless the owner objects)

- **A draft is structure.** The model's reply is parsed by a whitelist parser into a `Draft`. It carries no figure.
- **Same checks as an editor.** A proposal can save nothing an editor could not save by hand. Approval goes through
  `saveMetricChecked` / `saveTermChecked` (`src/ipc/metricSave.ts`, `src/ipc/terms.ts`), after the draft is parsed
  against the `metric:save` / `term:save` zod input. Those run the name check, the period, funnel, snapshot, date and
  target checks, `mustEditRecord` (Edit on the dataset's folder) and `versions.record`.
- **A draft is checked twice, each time as the person acting:** at proposal as the proposer, at approval as the
  approving editor. Both times the columns it may use are those of a dataset the person opens now, minus
  `hiddenColumnsFor`. A hidden column is an unknown column. A failed check is shown, never repaired.
- **One card per need.** A partial unique index on open proposals `(org, project, kind, name key)` plus
  `ON CONFLICT` makes a repeat proposal add an ask to the existing card. Two proposals at once cannot make two cards.
- **A person counts once per question.** An ask is `(proposal, person, question key)`; pressing the button twice on
  the same question, or the same person asking the same words again, does not raise the count.
- **The preview is not a new channel.** The queue returns structure only. The card calls the existing `metric:check`
  (a formula: verdict and figure) or `metric:preview` (a column metric; a term as a count of matching rows) as the
  reviewer. Those channels are classified in every reader table and the live net, so a new figure-returning channel is
  avoided.
- **The core takes question texts and askers, not a turn id**, so feature 8 (the issues board) can open or raise a
  proposal from a group of questions: `proposeFromQuestions` (draft and raise) and `raiseProposal` (a draft already
  made). The RPC is a thin wrapper that reads the caller's own refused turn.
- **Notification** follows dashboard requests: a bell row for each approver at open (editors and admins with Edit on
  the dataset, never the proposer) and for each asker when it is decided, a push `proposals:changed` (ids, names and the
  state, never the definition), and the unseen badge. No email in this version.
- **History says who.** The saved record's first version carries a structured `proposal` mark (`asks`), next to the
  existing `by` (the approver). The versions page words it: "Proposed by the Assistant from 7 questions, approved by Ana".

## Open points (the plan was wrong or silent; the safest option that keeps its intent was taken)

1. **`needs` cannot be the trigger.** The plan says a refused answer already records what an editor must add in the
   turn's `needs`. `needs` is only `'link' | 'copy'` (a missing join, a table to copy first), and `sanitizeNeeds` drops
   anything else. Nothing marks "this name is not defined". **Fix:** `checkAction` (`src/ipc/answerCheck.ts`) knows when a
   spec was refused because a *measure* or *filter* name was not found (`SpecMiss`), after the link and copy cases have
   been ruled out. It now sets `define: true` on the `Failure`, and the turn stores `define: true` (whitelisted in
   `normalizeTurns` / `appendTurn`, never beside `answer`). The button shows on such a turn. `needs` is untouched, so Ask
   an editor and the link card behave as before. Limit: a refusal the model writes in prose with no action has no marker
   and no button.
2. **A metric has no "other names".** Only terms have `aliases`. A proposal keeps the names, checks each against the
   metric and term names (so it cannot make a name ambiguous), and on approval a metric gets them as a closing sentence of
   its description ("Also called: margin, GM."), which the Assistant already reads. Terms keep real aliases.
3. **A formula metric cannot be a chart measure** (`SpecMetric`: "Formula metrics cannot chart"). After approval the
   Assistant is told the metric in its facts ("Metrics that match the question": its name and formula) and answers in words;
   it cannot chart "gross margin by region" from a formula metric. A column-and-aggregation metric charts.
   The e2e's last step shows exactly that: the question is no longer refused.
   The draft may be either kind; the card says which.
4. **A name clash is checked for what the proposer can see.** `nameRefusal` looks at the whole project (`wholeProject`).
   For a proposer that would tell a viewer a name exists in a folder closed to them. At proposal the clash is checked
   against the metrics and terms the proposer may list; at approval the editor's own `saveMetricChecked` runs the whole
   project check.
5. **Term values are the model's guess.** The model is never shown a column's values (a row rule could hide them), so a
   term's filter values come from the question's words. The preview (rows matched, by the engine) shows a wrong one, and
   the editor corrects it. Editing a term in the queue changes its name, other names and description, not its filters.
6. **A column metric preview vs. a formula.** The card shows the figure only (and "N rows" for a term), not the plan
   mock's bars: a chart would need a new figure channel. Noted for a later version.

## Storage: `0047_metric_proposals.sql`

Develop has 0043; migrations 0044 to 0046 are other branches'. **Merge after the PR holding 0046 (Autopilot phases 2 to
4); if merged in another order, renumber first.** The runner tolerates a gap.

- `metric_proposals`: `org_id`, `id`, `project_id`, `kind` (`metric` | `term`), `name`, `name_key`, `dataset_id`,
  `draft jsonb`, `state` (`open`, `approved`, `declined`), `decided_by`, `decided_at` (set on an open row: an approval
  under way, stale after ten minutes, as dashboard requests), `edited`, `answer` (the decline note), `saved_id`,
  `created_at`. Partial unique index on open `(org_id, project_id, kind, name_key)`.
- `metric_proposal_asks`: `org_id`, `proposal_id`, `user_email`, `qkey`, `question` (clipped), `created_at`. Primary
  key `(org_id, proposal_id, user_email, qkey)`. Never the assistant's answer, a figure or a turn.
- `metric_proposal_inbox`: the bell's rows (`approver` | `asker`), 200 a member, as `dashboard_request_inbox`.
- Forced RLS through `current_setting('ordinate.org')` on all three. Additive only. A deleted project deletes its
  proposals (`src/server/authz/share.ts`).

## Contracts (`src/api/proposals.ts`, appended to `src/api/index.ts`)

| Channel | Access | What |
|---|---|---|
| `proposal:propose` | read, audit | `{ projectId, threadId, turnId }` from the caller's own refused turn; AI must be ready; 10 a day a person |
| `proposal:list` | write | `{ projectId, state: 'open' \| 'decided' }` the reviewer's cards, structure only, with `problem` when the draft no longer passes the reviewer's checks |
| `proposal:approve` | write | `{ projectId, id, edit? }` re-check as the reviewer, then the checked save |
| `proposal:decline` | write | `{ projectId, id, note }` |

Reviewers are editors and admins with Edit on the dataset (`mustEdit`, `openers` at `edit`).

## Files

Server: `src/ai/proposalDraft.ts` (prompt, parser, pure), `src/server/proposals/{check,store,proposals,tell,rpc}.ts`,
`src/server/proposalMessages.ts`, `src/api/proposals.ts`, `src/server/db/migrations/0047_metric_proposals.sql`. Small
edits: `answerCheck.ts`, `answers.ts` (`define`), `copilot.ts`, `ipc/copilot.ts`, `versions.ts`, `metricSave.ts`,
`ipc/terms.ts`, `mentions/{store,rpc}.ts`, `authz/share.ts`, `app.ts`, `metricCheck.ts` (export `knownMetrics`),
`scripts/i18n-extract.ts`, the reader tables.

Web: `features/model/proposals/` (`ProposalsTab`, `ProposalCard`, `api`), the Proposals tab in `DataModelPage`, the
button in the Assistant transcript, the bell section and `proposals:changed` toast, the version line.

## Tests (every guard with a negative control)

- `test-proposalDraft` (pure): the parser takes a metric (formula and column kinds), a term and `none`, and refuses
  prose, two objects, a figure where a name goes, an unknown kind.
- `test-proposalStore` (DB, ordinary role): forced RLS; one card per need under two concurrent proposals; the same person
  and question counts once; decide once; claim; the inbox cap.
- `test-proposalAccess` (DB, rowPolicyHarness world, a scripted model): any reader proposes from their own refused turn
  (not another's, not a turn without `define`); only editors list, approve, decline; a stored draft passes; NEGATIVE
  CONTROLS: an unknown column, a hidden column, a bad formula, a name clash and a term on a closed folder are each refused
  and stored nothing; approval saves the metric through the checked save with the history mark; an approver who cannot edit
  the dataset's folder is refused (`edit`); the asker is told; a repeat raises the count; the canary (an asker's question
  text only, no answer text or figure, reaches the queue).
- `test-liveSafetyNet`, the column-access and folder nets and the reader tables stay green with the new channels.
- Vitest for the card, the queue and the button; Playwright `web/e2e/proposals.e2e.ts`: a refused question, a draft, an
  approval, the question answered.
