-- IdP groups → org role and teams (docs/sso-lifecycle/00-design.md).
--
-- Additive only: a new table and three new nullable columns. An older release
-- ignores all four: it never reads groups, and keeps roles and teams as stored.
--
-- One row per (org, group): the group maps to an org role, a team, or both.
-- The name is stored as sign-in compares it (Unicode NFC, trimmed) and is
-- matched exactly, case-sensitive. A team named here is LINKED: its members
-- come from the IdP only. The composite key proves the team is the row's
-- org's (teams_id_org, 0006). No RLS, like the other identity tables
-- (users, teams, sessions, api_tokens): it is read at sign-in, before any
-- request context sets ordinate.org, and every statement names its org.
CREATE TABLE idp_groups (
  org_id     text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 256),
  role       text CHECK (role IN ('admin', 'editor', 'viewer')),
  team_id    uuid,
  PRIMARY KEY (org_id, group_name),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  CHECK (role IS NOT NULL OR team_id IS NOT NULL)
);

-- A member's last EXPLICIT group list as sign-in read it (canonical, sorted),
-- so a mapping change re-applies every synced member at once. NULL = none seen.
-- idp_groups_at: when that list was read. A mapping change takes privileges
-- away from every list, but GRANTS only from one read within a session
-- lifetime (SESSION_ABSOLUTE_HOURS); an older one waits for the next sign-in.
ALTER TABLE users ADD COLUMN idp_groups text[];
ALTER TABLE users ADD COLUMN idp_groups_at timestamptz;

-- What header mode compares per request (writes only on change): the hex
-- sha256 of [break-glass flag, ...idp_groups], or 'kept:<sha>' when the last
-- admin was kept (cleared whenever the org gains an admin). NULL = re-apply
-- at the next request.
ALTER TABLE users ADD COLUMN idp_groups_digest text;
