# Assistant agents

Feature 1 of the ten Lightdash-parity AI features. Agreed with the owner on 2026-11-14.

## Why

Today a project has one Assistant. Everyone shares its instructions, it searches every dataset, and each
person's own model answers. A team means its own words: for Finance "revenue" is recognized revenue and the
year starts in February; for Sales it is booked deals. One shared set of instructions cannot be right for
both, and an assistant choosing from 40 datasets picks the wrong one more often than one choosing from 5.

An **agent** is the same AI with a saved bundle of settings: a short list of data (a topic), its own
instructions, an optional model, what it may do, and the teams that use it. It is better informed and
looks at less. It is never smarter and it never grants access.

## What people see

**The composer** (Assistant page, side dock, Home's ask bar):

```
[ Finance assistant ▾ ]  What was payroll cost last quarter?
```

- Shown only when the person can use at least one agent besides the Project assistant.
- Preselected: the agent of the person's latest conversation in this project, if they may still use it;
  otherwise the first agent (in list order) given to one of their teams; otherwise the Project assistant.
- Switching agents starts a new conversation.

**Data model → Assistant**, an Agents section above the existing instructions and verified questions:

```
Agents                                              [ + New agent ]
● Project assistant    Everyone        All data         default
● Finance assistant    Finance team    Finance topic
● Sales assistant      Sales team      Sales topic
```

**An agent's page:**

```
Finance assistant                                   [ Delete ]
  Description   Invoices, costs and payroll
  Topic         Finance ▾            (none = all data)
  Instructions  + "Revenue means recognized revenue"
                + "Our year starts in February"
  Model         Claude Opus ▾        (empty = each person's own)
  Can           ☑ answer   ☐ build charts and dashboards
  Teams         Finance ×   + Add team
```

The existing test chat on that tab gets the agent picker too, so an editor can try an agent before teams
use it.

**A question outside the agent's data:**

```
Finance assistant
  This isn't in the Finance data.
  The Project assistant can answer it from "orders".
  [ Ask the Project assistant ]
```

One click starts a new Project assistant conversation with the same question.

**History** shows which agent each conversation was with.

## Rules

Agreed with the owner:

1. **The Project assistant** is always there, for everyone, and is the default. It is today's Assistant,
   unchanged: the project's instructions, all data the person can read, the person's own model. It is not
   a record and cannot be deleted. With no other agents, nobody sees a picker and nothing looks different.
2. **Preselect from team, picker to switch.** Picking which agents a person may use is code, never AI.
3. **An agent only narrows.** It never shows a person anything they could not already read. Who sees which
   data stays with project roles, row access rules, hidden columns and (later) team folders.
4. **The project's instructions apply to every agent.** The agent's own instructions come after them and
   win where the two disagree. The prompt says so.

Proposed and accepted with the playback:

5. Project admins create, change and delete agents and choose their teams, topic, model and actions.
   Editors may change an agent's instructions only, as they edit the project's instructions today.
6. An agent's **topic** is optional. No topic means all data, with the agent's own instructions.
7. An agent's **model**, if set, is used for everyone in that agent. If it is empty, or no longer enabled in
   Admin → AI, the person's own pick is used.
8. **Actions**: "answer" is always on. "Build charts and dashboards" (the Assistant's plans) is a switch.
   An agent never raises a role: a viewer still cannot build, whatever the agent allows.
9. **Examples**: verified questions whose dataset is in the agent's topic are shown to the model first.
   Nothing new to tag.
10. **Out of scope**: the agent never answers quietly from outside its topic. When it cannot answer inside
    it, Ordinate's code (not the AI) looks for the data among what the person can read and offers the
    Project assistant in one click. If the person can read it nowhere, the usual "Ask an editor" message.
11. **Each conversation belongs to one agent.**
12. **Deleting an agent** sends it to Trash. Its conversations stay readable. New questions in them go to
    the Project assistant, with a line saying so. Restoring it brings it back.
13. **MCP and API tokens** keep using the Project assistant in this change.

Not in this change: knowledge documents and skills (feature 3), Slack (2), the router (9), evaluation
suites (5), embedding (10), team folders (the Assistant design's phase E).

## Approaches considered

1. **An agent is its own record that points at a topic.** (Chosen.) Topics stay what they are: an
   editor's short list, never access control (semantic layer D15). The agent adds who uses it, its
   instructions, model and actions. An agent with no topic exists naturally.
2. **Put the agent settings on the topic.** Rejected: it mixes "who may use this" into a list that is
   explicitly not access control, and "all data with Finance's instructions" would need a fake topic.
3. **Agents inside `catalog.json`, beside the project's instructions.** Rejected: every agent edit would
   lock the one catalog document, there is no Trash kind for a sub-entry, and edit conflicts could not be
   told apart per agent.

## How it is built (owner's calls marked; the rest is the builder's)

**Record.** `projects/<projectId>/agents/<id>.json` through `src/app/recordFs.ts`, like topics
(`src/analysis/topics.ts`): ids checked against `UUID_RE` before a path is built, one atomic write, the
record lock, an edit-conflict tag (docs/edit-conflicts), a sanitizer that drops a corrupt record instead of
failing, and a Trash kind `agent` (`src/api/trash.ts`). Shape, roughly:

```
{ id, name, description, topicId: string | null,
  instructions: string[],                // same rules and limits as src/app/instructions.ts
  model: { provider, model } | null,
  build: boolean,
  teamIds: string[], order: number,
  createdBy, createdAt, updatedAt }
```

A cap on agents per project (follow `MAX_TOPICS`).

**Contracts** (`src/api/`, append to `src/api/index.ts`):

- list the agents the caller may use, with the preselected one; project admins also get every agent and
  its teams for the Agents section;
- save and delete (project `admin`);
- change an agent's instructions only (`write`);
- `copilot:ask` (and the thread calls that create conversations) take an optional agent id. The server
  checks the caller may use it. A missing or deleted agent falls back to the Project assistant with a
  line in the reply, never an error that costs the answer.

Classify every new `read` contract in `scripts/rowPolicyReaders.ts`. Server sentences go through `t()`.

**Who may use an agent**: the caller is in one of its teams, or is a project admin or org admin (so they
can test it). Teams and membership come from `team_members` (`src/server/authz/`, `src/server/admin/`).

**The ask.** With an agent:

- the facts are the topic's datasets, metrics and terms. `copilot:ask` already takes
  `context: { kind: 'topic', id }`; reuse that path rather than adding a second one;
- guidance (`src/ipc/guidance.ts`, `src/ai/guidanceFacts.ts`) is the project's instructions, then the
  agent's, labeled so the agent's win on a conflict, inside the existing size limits;
- examples (`src/ai/verifiedPick.ts`) rank the topic's datasets first;
- the model is the agent's if set and still enabled, else the person's own;
- with build off, the model is not offered the plan action and `plan:start` refuses for that agent.

**Out of scope** detection is code. One option: when the model finds no answer inside the topic, match
the question's words against the datasets, metrics and terms outside the topic that the caller can read
(the ⌘K search index, `src/server/searchIndex.ts`, already holds dataset names). Whatever the method, it
must never compute a figure from outside the topic, and a test must prove it (spy on
`datasets.getDataset`).

**Conversations.** This branch stacks on `feat/assistant-threads-tables`, which moves conversations into
their own Postgres tables (migration `0023_assistant_threads.sql`). Record the agent on the conversation:
an additive migration (a nullable column; null means the Project assistant) and the same field in the
file-store path. Never edit an applied migration.

**Web.** The picker sits in `web/src/features/assistant/Composer.tsx` beside the model picker and is
used on the Assistant page, the dock and Home's ask bar. The Agents section and the agent page go in
`web/src/features/model/assistant/`. History (`History.tsx`) shows the agent. Empty and loading states
designed like the rest of the tab, not a blank box. No new nav item and no new top-level route needed.

## Tests

Self-check suites in `scripts/test-*.ts` (no framework, end on `finish()`), each guard with a negative
control:

- the record: sanitize, store, cap, edit conflict, Trash and restore;
- access: a team member can use the agent; a non-member cannot (refused on the server, not only hidden);
  a viewer cannot save; an editor can change instructions but not teams, topic, model or build;
- the ask: facts hold only the topic's datasets; guidance order (project then agent); topic examples
  first; agent model used, and falls back when disabled; build off refuses `plan:start`; a deleted agent
  falls back to the Project assistant;
- out of scope: the offer names a dataset the caller can read; nothing outside the topic is computed;
  a dataset the caller cannot read is never named;
- conversations: the agent is stored and shown; switching starts a new conversation;
- the preselection rule, including a person in two teams.

Vitest for the picker, the preselection display and the Agents section. One Playwright spec
(`web/e2e/`) for the whole path: an admin creates a Finance agent with a topic and a team; a team member
opens the Assistant and finds it preselected, asks, gets the out-of-scope button, switches; a viewer sees
no admin controls; delete sends it to Trash.

## Rules the build must keep (AGENTS.md)

The engine computes every figure; the model never writes one. No contract, no channel. Row access rules
on every reader. `orgKey()` on any in-memory cache. Any pod serves any request (no per-pod state).
Additive migrations only. No new runtime dependency. Files under 500 lines (800 hard). `npm run lint`
clean. No `Co-Authored-By` trailer on any commit.
