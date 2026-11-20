-- Ordinate in Slack (docs/slack/00-design.md): people ask the Assistant from Slack.
--
-- Every table that holds org data carries org_id, every statement names its org, and the tables are under forced
-- row-level security as well (the pattern of 0011 refresh_hooks: a table first looked up WITHOUT an org). A statement
-- sees a row only inside a transaction that set one of:
--   ordinate.org          the org's own (a member's call, an admin's)
--   ordinate.slack_team   one Slack workspace's rows (an event, an interaction or a socket envelope: the first thing
--                         known is the team id, which finds the org through slack_installs)
--   ordinate.slack_state  one Connect button's row, by the sha256 of its token (the callback names no org)
--   ordinate.slack_scope  'system': the worker's claim and the sweeps, across orgs
-- Without one, no row. src/server/slack/db.ts sets them. A superuser or BYPASSRLS role skips RLS: run the app as an
-- ordinary role. Secrets (bot token, signing secret, client secret, app token)
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
  token_hash    text        PRIMARY KEY,                 -- sha256 hex of the token in the Connect URL: the URL holds the credential, the table never does
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
  answer         jsonb,                                    -- ids and names of what was answered (no card, no figure): where the stored turn is, and its view
  delivered_at   timestamptz,                              -- the answer was posted (or its private note was): a retaken question only finishes
  dm_at          timestamptz,                              -- the private answer was sent: never sent twice
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

-- Row-level security (see the head of this file).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['slack_installs', 'slack_links', 'slack_link_states', 'slack_questions', 'slack_threads', 'slack_channel_agents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (org_id = current_setting('ordinate.org', true)
          OR %s
          OR current_setting('ordinate.slack_scope', true) = 'system')
      WITH CHECK (org_id = current_setting('ordinate.org', true)
          OR %s
          OR current_setting('ordinate.slack_scope', true) = 'system')$p$,
      t || '_scope', t,
      CASE t WHEN 'slack_link_states' THEN $q$token_hash = current_setting('ordinate.slack_state', true) OR team_id = current_setting('ordinate.slack_team', true)$q$
             ELSE $q$team_id = current_setting('ordinate.slack_team', true)$q$ END,
      CASE t WHEN 'slack_link_states' THEN $q$token_hash = current_setting('ordinate.slack_state', true) OR team_id = current_setting('ordinate.slack_team', true)$q$
             ELSE $q$team_id = current_setting('ordinate.slack_team', true)$q$ END);
  END LOOP;
END $$;
