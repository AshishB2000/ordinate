# Ordinate in Slack

People ask the Assistant from Slack: `@Ordinate` in a channel you connect to an agent, or a direct message.
The answer is the app's own, on this server, as the person who asked, with the organization's AI model.
Design and rules: [`docs/slack/00-design.md`](../slack/00-design.md).

## Before you start

- **Postgres and `ORDINATE_MASTER_KEY`.** The app's keys are kept in the encrypted secrets store.
- **An AI model** chosen in Admin, as for the app. Without one, Slack answers "not set up".
- **`ORDINATE_PUBLIC_URL`** (for "Slack calls Ordinate"): the address Slack reaches this server at, and the
  address in every "Open in Ordinate" link. Without it, only Socket Mode is offered.
- Slack may reach only `slack.com`: every call goes through the SSRF guard (`SSRF_ALLOW` is not needed).

## Set it up (Admin → Slack)

1. Choose how Slack reaches Ordinate.
   - **Slack calls Ordinate** (default): Slack posts events to `/api/slack/events` and button presses to
     `/api/slack/interactions`. The server must be reachable from the internet.
   - **Ordinate calls Slack (Socket Mode)**: each pod opens a WebSocket to Slack. Nothing needs to reach in, so
     it works behind a firewall. Up to 10 connections are held across all pods.
2. Copy the manifest, then in Slack: *Create New App → From a manifest*, pick your workspace, paste, and
   *Install to Workspace*. Each company creates its own app: no vendor service sits in the path.
3. Paste the keys into Admin → Slack: the **bot token** (`xoxb-…`), the **signing secret** (Slack calls Ordinate)
   or the **app-level token** with `connections:write` (`xapp-…`, Socket Mode), and the **client ID and secret**
   ("Sign in with Slack" links a person to their account).
4. Slack verifies the request URL when the app is created, before this server has its signing secret. After
   saving the keys, open the app's *Event Subscriptions* page and press **Retry**.
5. A project admin ties channels to an agent on the agent's page (*Slack channels*, a list of the channels the bot
   is in: invite it with `/invite @Ordinate`). One agent per channel. A channel with no agent is told it is not
   connected yet; no project is guessed.

The scopes asked for are `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `channels:read`,
`groups:read` and `users:read`. Not requested: `users:read.email` (accounts are never matched by email),
`chat:write.public`, `channels:join`, `channels:history`, `files:write`.

## What people see

- **First question.** An unknown Slack user gets a private Connect button. They sign in to Ordinate, then
  "Sign in with Slack" confirms their Slack account; the link is saved and the question is answered. People from
  another Slack organization can never link.
- **Answers.** A sentence and a table (or, when the result fits Slack's chart block exactly, a chart), with
  *Open in Ordinate*, *Helpful* and *Not helpful*. The footer names the agent and the datasets.
- **Restricted data.** If an answer shows data with row rules, hidden columns or a team folder that is not open
  to everyone, or was read off a dashboard, it is posted in the channel only when every member is linked, may
  read it and sees it exactly as the asker does. Otherwise the channel gets a fixed note and the asker the
  full answer by direct message, with *Share to channel* (the check is repeated against the current members).
  A channel shared with another company never gets figures.
- **The Share policy.** A Slack post leaves the app, so the project's Share policy has a `slack` path
  (Settings → Privacy, default *Mask*). When it masks or drops anything, a fixed caption replaces the model's sentence.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Answer questions in Slack | on | Off: every question is dropped, nothing is read. |
| Count guests as channel members | off | Off: a guest in the channel makes a restricted answer private. |
| Let an asker share past a failed check | off | On: *Share to channel* works even when someone there may not see the data. Never for a channel shared with another company. |

## Operating notes

- Questions are rows in Postgres (`slack_questions`), claimed by any pod under a lease. A pod that dies mid-answer
  is retaken after about a minute, up to three attempts, and the thread still gets one answer.
- Slack retries an event until it is acknowledged; the event id makes a retry a no-op.
- Disconnecting in Admin removes the keys, every link and every channel mapping. Uninstalling the app in Slack
  switches Ordinate's side off and drops what was waiting.
- Nothing in Slack is built from a question: the Assistant answers only.
