-- Reach (docs/team-folders/00-design.md D9, D16): which datasets each dashboard's PUBLISHED copy reads, so a
-- dataset in a folder the caller cannot open still shows its figures on a dashboard they can open. DERIVED from
-- `records` (0007), never the truth: the truth is the copy's own `published.reads`, frozen at Publish
-- (src/analysis/publishedReads.ts). src/server/dashboardReads.ts keeps it; src/server/authz/folderGate.ts reads it.
--
-- KEPT CURRENT ON WRITE as 0026 is: every write of projects/<p>/analyses/<id>.json rewrites that dashboard's rows in
-- the SAME transaction (src/app/recordFs.ts), inside a SAVEPOINT, so it can never fail a save — a failure drops the
-- project's marker instead.
--
-- dashboard_reads_built: the projects the table holds COMPLETELY, at which build version. No row → the next reach
--   question rebuilds the project from its records (a copy published before `reads` is worked out then, never
--   written back), under an exclusive advisory lock every writer of that project takes shared.
-- dashboard_reads: one row per (dashboard, dataset its copy reads). Ids lowercase text in "C".
--
-- A WRITER THAT DOES NOT FOLLOW: a pod of an older release writes a dashboard without touching these rows. The
--   triggers below, on any such write (a transaction that does not set `ordinate.folders` = 'on', which recordFs
--   sets beside `ordinate.org`), delete that dashboard's rows and the project's marker: an older pod can only NARROW
--   reach until the next rebuild, never widen it.
--
-- Additive only: two new tables, a function and two triggers on `records`. Forced row-level security as in 0026.

CREATE TABLE dashboard_reads_built (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  version    integer     NOT NULL,
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE dashboard_reads (
  org_id      text NOT NULL,
  project_id  uuid NOT NULL,
  analysis_id text COLLATE "C" NOT NULL CHECK (analysis_id = lower(analysis_id)),
  dataset_id  text COLLATE "C" NOT NULL CHECK (dataset_id = lower(dataset_id)),
  PRIMARY KEY (org_id, project_id, analysis_id, dataset_id)
);
CREATE INDEX dashboard_reads_dataset ON dashboard_reads (org_id, project_id, dataset_id);

ALTER TABLE dashboard_reads_built ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_reads_built FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_reads_built_org ON dashboard_reads_built
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE dashboard_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_reads_org ON dashboard_reads
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

CREATE FUNCTION dashboard_reads_stale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rel text := CASE WHEN TG_OP = 'DELETE' THEN OLD.path ELSE NEW.path END;
  org text := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  m text[];
BEGIN
  IF current_setting('ordinate.folders', true) IS DISTINCT FROM 'on' THEN
    m := regexp_match(rel, '^projects/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/analyses/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.json$');
    IF m IS NOT NULL THEN
      DELETE FROM dashboard_reads WHERE org_id = org AND project_id = m[1]::uuid AND analysis_id = lower(m[2]);
      DELETE FROM dashboard_reads_built WHERE org_id = org AND project_id = m[1]::uuid;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER records_dashboard_reads_written AFTER INSERT OR UPDATE ON records
  FOR EACH ROW WHEN (NEW.path LIKE 'projects/%/analyses/%') EXECUTE FUNCTION dashboard_reads_stale();
CREATE TRIGGER records_dashboard_reads_deleted AFTER DELETE ON records
  FOR EACH ROW WHEN (OLD.path LIKE 'projects/%/analyses/%') EXECUTE FUNCTION dashboard_reads_stale();
