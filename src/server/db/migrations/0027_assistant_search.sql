-- The Assistant's search of the Data model (docs/assistant/00-design.md, step 3; src/server/assistantSearchIndex.ts):
-- the datasets, their columns, metrics, glossary terms and documented source tables a question's words find, so an
-- ask reads its top results here instead of every list of the project. DERIVED from `records` (0007), never the
-- truth. Names, "also called" names and descriptions only: no row value is ever stored (no example, no value
-- label, no filter value), and no dataset origin (no path, URL or SQL).
--
-- KEPT CURRENT ON WRITE as 0022 and 0026 are: every save, rename or delete of a searched record rewrites that
-- record's rows in the SAME transaction (src/app/recordFs.ts), inside a SAVEPOINT, so the index can never fail a
-- save — a failure there drops the source's marker instead.
--
-- assistant_search_built: which (project, source) the index holds COMPLETELY, at which build version. No row (never
--   built, or dropped by a failed write) → the next search rebuilds that source from its records, under an exclusive
--   advisory lock every writer of that source takes shared. Sources: datasets, metrics, terms, catalog (catalog.json),
--   tables (connections/<id>.tables.json).
-- assistant_search: one row per PART of an item. An item ('dataset:<id>', 'column:<dataset>/<name>', 'metric:<id>',
--   'term:<id>', 'table:<connection>/<doc>') can draw on two records: its own (the BASE part: it exists, its name)
--   and catalog.json (its description, "also called" names, certified/retired). A query groups the parts by item.
--   `grp` is the part of a record that changes together (catalog.json: one group per dataset, one for status), and
--   `grp_hash` what it was built from: a catalog save rewrites only the groups whose hash moved.
--   The word arrays are split by the app (src/ai/modelWords.ts), never by Postgres, so the JS reference and the
--   index agree; `all_words` is their union, GIN-indexed for the `&&` prefilter. `audience`: 'editor' for source
--   tables (viewers never read a warehouse table's name), 'all' for the rest. Text compared or sorted is "C".
--
-- A WRITER THAT DOES NOT FOLLOW (a pod of an older release) writes a searched record without touching the index. The
--   triggers below drop that source's marker on any write whose transaction does not set `ordinate.assistant_search`
--   = 'on', which recordFs sets beside `ordinate.org` and `ordinate.verified_index` (0026).
--
-- Additive only: two new tables, a function and two triggers on `records`. GIN over text[] is core Postgres. org_id is
-- text, as in 0007; forced row-level security as in 0022.

CREATE TABLE assistant_search_built (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  source     text        NOT NULL,
  version    integer     NOT NULL,
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, source)
);

CREATE TABLE assistant_search (
  org_id      text     NOT NULL,
  project_id  uuid     NOT NULL,
  path        text     COLLATE "C" NOT NULL,
  grp         text     COLLATE "C" NOT NULL,
  ord         integer  NOT NULL,
  grp_hash    text     NOT NULL,
  source      text     NOT NULL,
  item        text     COLLATE "C" NOT NULL,
  kind        text     COLLATE "C" NOT NULL CHECK (kind IN ('dataset', 'metric', 'term', 'column', 'table')),
  kind_ord    smallint NOT NULL,
  base        boolean  NOT NULL,
  id          text     COLLATE "C" NOT NULL,
  dataset_id  text     COLLATE "C",
  conn_id     text     COLLATE "C",
  name        text     COLLATE "C" NOT NULL,
  updated     text     COLLATE "C" NOT NULL,
  audience    text     NOT NULL CHECK (audience IN ('all', 'editor')),
  name_words  text[]   COLLATE "C" NOT NULL,
  alias_words text[]   COLLATE "C" NOT NULL,
  text_words  text[]   COLLATE "C" NOT NULL,
  all_words   text[]   COLLATE "C" NOT NULL,
  certified   boolean  NOT NULL,
  retired     boolean  NOT NULL,
  PRIMARY KEY (org_id, path, grp, ord)
);
CREATE INDEX assistant_search_item ON assistant_search (org_id, project_id, item);
-- fastupdate off: a pending list of a whole project's rebuild is read in full by every query until a vacuum merges it
-- (3 ms for a question matching nothing at 61,000 rows, against 0.03 ms without one).
CREATE INDEX assistant_search_words ON assistant_search USING gin (all_words) WITH (fastupdate = off);

ALTER TABLE assistant_search_built ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_search_built FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_search_built_org ON assistant_search_built
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE assistant_search ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_search FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_search_org ON assistant_search
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

-- The source a record path belongs to: the same rule as sourceAt in src/server/assistantSearchIndex.ts.
CREATE FUNCTION assistant_search_stale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rel text := CASE WHEN TG_OP = 'DELETE' THEN OLD.path ELSE NEW.path END;
  org text := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  m text[];
BEGIN
  IF current_setting('ordinate.assistant_search', true) IS DISTINCT FROM 'on' THEN
    m := regexp_match(rel, '^projects/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/(?:(datasets|metrics|terms)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json|(catalog)\.json|connections/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(tables)\.json)$');
    IF m IS NOT NULL THEN
      DELETE FROM assistant_search_built WHERE org_id = org AND project_id = m[1]::uuid AND source = coalesce(m[2], m[3], m[4]);
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER records_assistant_search_written AFTER INSERT OR UPDATE ON records
  FOR EACH ROW WHEN (NEW.path LIKE 'projects/%') EXECUTE FUNCTION assistant_search_stale();
CREATE TRIGGER records_assistant_search_deleted AFTER DELETE ON records
  FOR EACH ROW WHEN (OLD.path LIKE 'projects/%') EXECUTE FUNCTION assistant_search_stale();
