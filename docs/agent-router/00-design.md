# Agent router ("Auto")

Feature 9 of the 10 Lightdash-parity AI features. The owner's plan page is
https://claude.ai/artifact/Ay1xKM2SbndrhsTQ52XExn. Builds on agents (#1), Slack (#2) and knowledge documents (#3), all merged.

## What it is and why

A project can have up to 50 agents, and today's pick (`preselect` in `src/ai/agentAccess.ts`) never reads the question: it
is the last conversation's agent, else the first agent shared with the person's team. **Auto** reads the question. For a
person who may use two or more agents and has not picked one, it scores each agent they may use against the question and
picks the one that fits. When two are close it asks one small model call; when that cannot say either, it asks the person
with two or three agent buttons. Every answer records which agent answered and why.

The router never decides a figure. It decides who answers; the answering path is unchanged (the chosen agent's scope, row
locks, hidden columns, instructions and documents all apply as before).

## Decided by the owner

1. **Q1: search scores first, a small model call only when two agents are close.** No model call for a clear winner.
2. **Q2: when unsure, ask with two or three agent buttons.** The click is remembered for the conversation (it is an ordinary
   ask with that agent, in a conversation with that agent).
3. **Q3: Auto is the default for people who may use 2 or more agents.** Picking an agent turns Auto off for that
   conversation. A person with one agent (or none) sees no change.

## Calls made in the plan (settled unless the owner objects)

- Agents a person may not use (`mayUse`) are never scored, suggested or named.
- Follow-ups keep the conversation's agent until the person changes it.
- The reason is one line from the matches found, never a model's guess.
- A Slack channel's linked agent always answers there. Slack **direct messages** get the router.

## The one decision point

Every ask resolves its agent in two places, both already single:

- the web: `copilot:ask` (`src/ipc/copilot.ts`): `askScope(projectId, into ? into.agentId : agentId)`;
- Slack DMs: `directTarget` (`src/server/slack/ask.ts`), which picks the agent a DM's new conversation starts with.

The router is `src/ipc/agentRoute.ts` (`routeAsk`), pure scoring in `src/ai/agentRoute.ts`. `preselect`/`agentForAsk` stay
the fallback and the access check (`agentForAsk` still runs inside `askScope` on whatever agent the router returns, so an
agent that stops being usable falls back with its line as before).

## The scorer (phase 1)

For each agent in `usable` (`agentsFor`: `mayUse`, the only filter), points from:

| Source | Points | Read from |
|---|---|---|
| Data: datasets, columns, metrics, terms found by the question's words | the search score (4 per word in a name, 2 per also-called, 1 per description word); a hit by meaning alone (fingerprints, score 0) counts 1 | ONE `searchModel` call for the project (`assistant_search`, fingerprints when set up), kept to the datasets of the agent's topic (a column only when the topic keeps that field; a metric or term also when the topic names it) |
| Verified questions | 2 per question word | `listBoth` (caller-aware: folders), questions whose every dataset is in the agent's topic |
| Documents | 2 per question word in a title | one query for all agents' titles (`titlesByAgent`) |
| Description | 1 per question word | the agent record |

An agent with **no topic** answers from all data, so it gets no data or verified points (they would make it win every
question); it scores by description and documents only. The agents' topics are read as the caller may read them
(`topicsForReaders`), the search applies the caller's folders, hidden columns and audience, and the verified list is the
caller's, so a name the caller cannot see is never a match and never in a reason.

**Decision** (`decide`): best score under 2 is "nothing to go on" (one stray word is not evidence); the best at least
1.5x the second is a clear winner; otherwise a close call with every agent within that band, at most three.

**Model call when close** (`agentRoutePrompt.ts`): the question plus the top two agents' names and descriptions, nothing else
(no data, instructions, documents or history), reply `1`, `2` or `0`. It runs only when `execConfig` says a model is ready and
`underBudget` (the per-person cap `slack/ask.ts` keeps) allows it; it counts against that cap. Any failure, `0`, or an
unparseable reply is "cannot say".

**Cannot say:** the web gets `choose` (buttons); a Slack DM has nobody to click, so it takes the agent with more matches.

**Nothing to go on:** the usual pick stands (`preselect`; a blank conversation keeps the agent it has), with no route note.

**One query per ask:** a single search for the whole project however many agents, one verified listing, one titles query.
Topics are one record read each (at most 50), as the agent list already does.

## Wiring (phase 2)

- `copilot:ask` gets `auto?: boolean`. With it, on a conversation with no turns yet (or none at all), and never for a
  personal API token or a share path: `autoRoute` returns the agent and its reason, or `choose`.
  - `choose`: the reply is `{ ok: true, choose: [{ id, name, description? }] }`. Nothing is asked, stored or created.
  - An agent: if the blank conversation is with a different agent, a new one with the routed agent replaces it once the answer is
    stored (`pin`), and the old blank one is deleted. The reply's `threadId` names the new one.
  - A conversation with turns ignores `auto`: follow-ups keep the agent.
- Stored with the turn (no migration): assistant turns get `route?: { why }` (`src/ai/routeTurn.ts`, sanitized as
  `research` is). It is set on the answer to the routed question, including a verified-question hit and an out-of-scope reply.
  `turnsForBrowser` passes it through. The reason is built by the app (`agentRouteMessages.ts`, in the catalog): "Matched the
  Payroll dataset and the payroll cost metric." or, when the model settled a close call, "Two agents fit about equally, so it
  compared their descriptions." It has no model words.
- Slack DMs: `directTarget(pool, who, question)` calls `routeAsk(..., 'best')`; the reason rides to the handler as a
  server-only `context.routed` (the contract has no such field, as `noSources`) and is stored on the turn. Channels are
  unchanged: a channel's linked agent answers.

## The picker (phase 3)

- The agent picker gets **Auto** (first option) when the person may use 2 or more agents. Auto is the default for a new or
  blank conversation (Assistant page, dock and Home). Picking an agent (or the Project assistant) turns it off for that
  conversation; picking Auto again turns it back on.
- Each routed answer shows "Answered by Finance agent · Change" and the reason line. **Change** opens the usable agents; a
  pick starts a new conversation with that agent and asks the same question there (as "Ask the Project assistant" does).
- A `choose` reply shows two or three agent buttons above the composer with the question kept; a click asks it with that
  agent (an ordinary explicit ask, which also starts the conversation with it).
- Home's ask bar: Auto is its default too; it starts a blank conversation marked Auto and hands the question over.

## Files

New: `src/ai/agentRoute.ts` (scorer), `agentRoutePrompt.ts`, `agentRouteMessages.ts`, `routeTurn.ts`;
`src/ipc/agentRoute.ts`; web `AutoChoice`/Auto parts; tests below; this doc.
Touched: `src/ipc/copilot.ts`, `src/ai/copilot.ts` (turn field), `src/ipc/answers.ts`, `verifiedAsk.ts`, `verifiedSql.ts`
(route on the turn), `src/api/assistant.ts` (`auto`), `src/knowledge/store.ts` (`titlesByAgent`), `src/server/slack/ask.ts`,
`answer.ts`, `scripts/i18n-extract.ts` (MAIN_FILES), the i18n catalogs, web assistant/home files.

## Storage and contracts

No migration. No new contract: `copilot:ask` gains an optional `auto` (the same `read` access, project scope), so the
rowPolicy / folder / column-access readers and the folder-write net are unchanged. The router reads only through the
existing doors (search, verified list, topics), each under the caller.

## Tests

- `scripts/test-agentRoute.ts`: scorer, decision, reasons, the model call's text, `routeAsk` (one search for any number of
  agents; an agent not in `usable` never wins, is never offered or named; a clear winner makes no model call).
- `scripts/test-agentRouteAsk.ts`: the real `copilot:ask` with `auto`: route stored on the turn, follow-up keeps the agent, a
  blank conversation replaced, a close call asks the model once and then `choose` with nothing stored, a verified hit.
- `scripts/test-agentRouteAccess.ts` (Postgres): over the real index and access, with a viewer outside an agent's team, an
  editor, and an admin; a Slack DM through `directTarget`.
- Vitest for the picker and the answer line; one Playwright e2e with two agents.

## Open points

1. **No match at all.** The plan says "when it is unsure, ask". With no agent matching a single word (a "hello"), asking would
   interrupt every vague question, so the usual pick stands silently and no route is recorded. A close call between agents
   that do match is what asks.
2. **An agent with no topic** scores by description and documents only (see the scorer). An all-data agent with a thin
   description will rarely be picked; the plan's risk note already says thin agents score poorly.
3. **"Each answer shows Answered by"**: the line is on the routed answer. A follow-up in that conversation keeps the agent,
   which the conversation header already names; the line is not repeated on every follow-up.
4. **Verified questions are one listing per ask** (`listBoth`), not an indexed query. Fine at the sizes agents run at; the
   code carries a `shortcut:` comment to move to a word-ranked index query.
5. **Home**: its ask bar creates the conversation before the Assistant page opens. A small in-memory mark (`autoThreads`)
   tells the page that blank conversation is Auto. A reload of a blank conversation in a new tab is not Auto (it has an
   explicit nothing); harmless, since the person just picks.
