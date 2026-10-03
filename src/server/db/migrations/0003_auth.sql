-- Identity (T3.2): orgs, their users, teams, browser sessions, API tokens.
-- Multi-org from day one; a single-org deployment has one row in `orgs`
-- (ORDINATE_ORG, default `default`), created at startup.
--
-- No secret is stored in the clear: a session id and an API token are kept
-- only as the hex sha256 of the value the client holds.

CREATE TABLE orgs (
  -- Becomes a directory name (DATA_DIR/orgs/<id>), same rule as src/app/paths.ts.
  id         text        PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A user row IS the org membership: the same person in two orgs is two rows,
-- each with its own role.
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text        NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email         text        NOT NULL CHECK (email = lower(email)),
  name          text,
  role          text        NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (org_id, email)
);

CREATE TABLE teams (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     text        NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

-- Idle expiry is last_seen_at + SESSION_IDLE_MINUTES, checked at lookup;
-- absolute expiry is fixed at creation in expires_at.
CREATE TABLE sessions (
  id_hash      text        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Personal API tokens (T3.4 issues them; shown once, stored hashed).
CREATE TABLE api_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text        NOT NULL,
  token_hash   text        NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);
