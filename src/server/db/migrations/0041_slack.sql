-- Ordinate in Slack (docs/slack/00-design.md): people ask the Assistant from Slack.
--
-- Every table carries org_id and every statement names it. There is no row-level security here: Slack's first
-- contact (an event, a signature check) arrives with no org, and finds it through slack_installs.team_id, so the
-- tables are read by the server's own role only. Secrets (bot token, signing secret, client secret, app token)
-- are NOT here: they are in the encrypted secrets store (src/server/secrets/store.ts, kinds slack.*).
--
-- Additive only: new tables.

-- One Slack workspace per org: the install an org admin saved (Admin -> Slack).
CREATE TABLE slack_installs (
  team_id               text        PRIMARY KEY,
  org_id                text        NOT NULL UNIQUE,
  team_name             text        NOT NULL DEFAULT '',
  enterprise_id         text,
  app_id                text        NOT NULL DEFAULT '',
  bot_user_id           text        NOT NULL,
  client_id             text        NOT NULL DEFAULT '',   -- public: the "Sign in with Slack" client id
  mode                  text        NOT NULL DEFAULT 'events' CHECK (mode IN ('events', 'socket')),
  enabled               boolean     NOT NULL DEFAULT true,
  allow_guests          boolean     NOT NULL DEFAULT false,
  allow_share_override  boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Who a Slack account is in Ordinate. Never what they may see: every question re-reads the account.
CREATE TABLE slack_links (
  org_id        text        NOT NULL,
  team_id       text        NOT NULL,
  slack_user_id text        NOT NULL,
  user_email    text        NOT NULL,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, team_id, slack_user_id)
);
CREATE INDEX slack_links_user ON slack_links (org_id, user_email);

-- One Connect button: single use, ten minutes.
CREATE TABLE slack_link_states (
  token         text        PRIMARY KEY,
  org_id        text        NOT NULL,
  team_id       text        NOT NULL,
  slack_user_id text        NOT NULL,
  user_email    text,                         -- written by /api/slack/connect (the session), never by the callback
  question_id   uuid,                         -- the question parked until the link exists
  nonce         text        NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

-- Slack retries an event until it is acknowledged: the unique key makes a retry a no-op.
CREATE TABLE slack_events (
  event_id    text        PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- The queue any pod works: claimed FOR UPDATE SKIP LOCKED under a lease (src/server/jobs/runner.ts pattern).
CREATE TABLE slack_questions (
  id             uuid        PRIMARY KEY,
  org_id         text        NOT NULL,
  team_id        text        NOT NULL,
  kind           text        NOT NULL DEFAULT 'ask' CHECK (kind IN ('ask', 'share')),
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_link', 'running', 'done', 'failed', 'dropped')),
  lease_owner    text,
  lease_until    timestamptz,
  attempts       integer     NOT NULL DEFAULT 0,
  channel_id     text        NOT NULL,
  channel_type   text        NOT NULL DEFAULT 'channel',   -- 'im' for a direct message
  thread_ts      text,                                     -- the thread the answer goes in
  event_ts       text,
  slack_user_id  text        NOT NULL,
  text           text        NOT NULL DEFAULT '',
  placeholder_ts text,
  project_id     uuid,
  agent_id       uuid,
  thread_id      uuid,                                     -- the Assistant conversation
  of_question    uuid,                                     -- a share: the answered question it posts
  outcome        text,
  answer         jsonb,                                    -- what was answered, kept so Share to channel can post it again (30 days)
  feedback       text CHECK (feedback IN ('helpful', 'not_helpful')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX slack_questions_due ON slack_questions (status, lease_until) WHERE status IN ('pending', 'running');
CREATE INDEX slack_questions_org ON slack_questions (org_id, created_at);

-- A Slack thread belongs to its first asker.
CREATE TABLE slack_threads (
  team_id       text        NOT NULL,
  channel_id    text        NOT NULL,
  thread_ts     text        NOT NULL,
  org_id        text        NOT NULL,
  project_id    uuid        NOT NULL,
  thread_id     uuid        NOT NULL,
  asker_email   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, channel_id, thread_ts)
);
CREATE INDEX slack_threads_conversation ON slack_threads (org_id, project_id, thread_id);

-- One agent per channel, set by a project admin.
CREATE TABLE slack_channel_agents (
  team_id      text        NOT NULL,
  channel_id   text        NOT NULL,
  org_id       text        NOT NULL,
  project_id   uuid        NOT NULL,
  agent_id     uuid        NOT NULL,
  channel_name text        NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, channel_id)
);
CREATE INDEX slack_channel_agents_agent ON slack_channel_agents (org_id, project_id, agent_id);

-- Socket Mode: a pod holds one of ten slots per install while it keeps a connection.
CREATE TABLE slack_socket_slots (
  team_id     text        NOT NULL,
  slot        integer     NOT NULL CHECK (slot BETWEEN 1 AND 10),
  lease_owner text        NOT NULL,
  lease_until timestamptz NOT NULL,
  PRIMARY KEY (team_id, slot)
);
