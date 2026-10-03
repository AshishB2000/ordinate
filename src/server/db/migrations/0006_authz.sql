-- Authorization and audit (T3.3). src/server/authz/ reads and writes these.
--
-- A project lives on disk (or, after T5.1, in Postgres) under its org; who may
-- touch it lives here. A grant names ONE grantee — a user or a team of the
-- same org — and a role. The owner team is a grant with `owner` set (always
-- admin, at most one per project; T3.4 transfers it). Org admins are admin on
-- every project of their org without a row; nobody else sees a project
-- without one (src/server/authz/index.ts documents the rule).

-- Composite keys so a grant's user or team is provably in the grant's org:
-- a row naming org A's project and org B's team cannot be written.
ALTER TABLE users ADD CONSTRAINT users_id_org UNIQUE (id, org_id);
ALTER TABLE teams ADD CONSTRAINT teams_id_org UNIQUE (id, org_id);

CREATE TABLE project_grants (
  org_id     text        NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  project_id uuid        NOT NULL,
  user_id    uuid,
  team_id    uuid,
  role       text        NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  owner      boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(user_id, team_id) = 1),
  CHECK (NOT owner OR (team_id IS NOT NULL AND role = 'admin')),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  -- NULLs are distinct, so a user row and a team row never collide.
  UNIQUE (org_id, project_id, user_id),
  UNIQUE (org_id, project_id, team_id)
);
CREATE UNIQUE INDEX project_grants_owner ON project_grants (org_id, project_id) WHERE owner;
CREATE INDEX project_grants_user ON project_grants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX project_grants_team ON project_grants (team_id) WHERE team_id IS NOT NULL;

-- Who did what, never with what: channel, ids, actor, outcome. No input
-- field values (they may hold data or secrets) — only UUID-shaped ids.
-- org_id is text without a foreign key so the trail outlives a deleted org.
CREATE TABLE audit_log (
  id         bigserial   PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  org_id     text        NOT NULL,
  actor      text,                       -- the member's email; null when unknown (a refused sign-in without one)
  action     text        NOT NULL CHECK (action IN ('rpc', 'login', 'logout', 'logout_everywhere')),
  channel    text,                       -- the RPC channel for action = 'rpc'
  project_id uuid,                       -- the project the call was authorized against
  target_ids uuid[]      NOT NULL DEFAULT '{}',
  outcome    text        NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
  request_id text
);
CREATE INDEX audit_log_org_at ON audit_log (org_id, at DESC);
