-- Connection tables per team (docs/team-folders/00-design.md D19, "Connection tables per team"): which warehouse tables
-- a team's project VIEWERS may ask the Assistant and Explore about, and which of their columns stay hidden from them.
-- Editors and admins answer from every table, as before. src/server/authz/teamTables.ts reads the rows;
-- src/ipc/teamTables.ts (`teamTables:get` / `:set`, project admins) writes them.
--
-- NOTHING IS TICKED BY DEFAULT. No row, no table: upgrade needs no backfill and changes nothing anyone sees.
--
-- team_tables: per project, team and connection, a SCHEMA row (`table_name` NULL: every table of the schema, those
--   added later included) or a TABLE row (`schema` and `table_name` exactly as listTables returns them, never
--   case-folded; '' is the schema of a source that has none), each `include` or not (an exclude). A table row wins
--   over its schema row; a person's tables are the union over their teams that hold a role on the project; a column
--   is hidden from them only if every team row that gives them the table hides it. `hidden` sits on include table rows
--   only. Gone with the team. The 2,000-rows-a-team-and-connection cap is the app's.
--
-- assistant_search.audience gains 'viewer': a documented table's row under the LABEL an editor wrote for viewers
--   (never its warehouse name), found only by a viewer whose teams were given it (its `keys` against theirs, in the
--   query's WHERE). Widening the CHECK changes no row; a pod of an older release asks for 'all' or 'editor' only, so
--   it never returns one.
--
-- Additive only: one new table, and a CHECK that accepts one more value. org_id is text, as in 0007; forced row-level
-- security as in 0032; names compared in "C".

CREATE TABLE team_tables (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  team_id    uuid        NOT NULL,
  conn_id    uuid        NOT NULL,
  schema     text        COLLATE "C" NOT NULL CHECK (char_length(schema) <= 1000),
  table_name text        COLLATE "C" CHECK (char_length(table_name) BETWEEN 1 AND 1000),
  include    boolean     NOT NULL,
  hidden     text[]      COLLATE "C" NOT NULL DEFAULT '{}',
  granted_by text        NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(hidden) = 0 OR (include AND table_name IS NOT NULL)),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX team_tables_row ON team_tables (org_id, project_id, team_id, conn_id, schema, coalesce(table_name, ''));
CREATE INDEX team_tables_team ON team_tables (team_id);

ALTER TABLE team_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY team_tables_org ON team_tables
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE assistant_search DROP CONSTRAINT assistant_search_audience_check;
ALTER TABLE assistant_search ADD CONSTRAINT assistant_search_audience_check CHECK (audience IN ('all', 'editor', 'viewer')) NOT VALID;
