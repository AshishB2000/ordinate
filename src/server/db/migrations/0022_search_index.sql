-- The ⌘K name search's index (src/ipc/search.ts builds it, src/server/searchIndex.ts holds the SQL):
-- one row per thing the palette finds by name, so a search is one query instead of reading every
-- record in the project. DERIVED from `records` (0007), never the truth: any row can be rebuilt,
-- and is, whenever its source's stamp moves.
--
-- search_sources: one row per (project, source) — 'datasets', 'visuals', 'analyses:editor',
--   'analyses:viewer', 'connections', 'metrics', 'reports', 'alerts' — holding the stamp of the
--   records it was built from (recordFs.stampOf: md5 over each row's path and updated_at, plus the
--   build version). A stored stamp that is not the records' current one means: rebuild that source.
-- search_entries: what a search reads. `name_lc` is JS's toLowerCase() of `name`, so a match is the
--   same substring test as the JS path (strpos — no LIKE escaping, no collation). `src_ord` and
--   `ord` keep the JS path's order exactly.
--
-- A viewer is listed published dashboards only, so dashboards are two sources and a search reads
-- its caller's. Additive only: two new tables. org_id is text, as in 0007; forced row-level
-- security as in 0020 (src/server/db/inOrg.ts sets `ordinate.org` per transaction).

CREATE TABLE search_sources (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  source     text        NOT NULL,
  stamp      text        NOT NULL,
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, source)
);

CREATE TABLE search_entries (
  org_id     text     NOT NULL,
  project_id uuid     NOT NULL,
  source     text     NOT NULL,
  ord        integer  NOT NULL,
  src_ord    smallint NOT NULL,
  kind       text     NOT NULL,
  id         text     NOT NULL,
  parent_id  text,
  name       text     NOT NULL,
  name_lc    text     COLLATE "C" NOT NULL,
  sub        text     NOT NULL,
  PRIMARY KEY (org_id, project_id, source, ord)
);

ALTER TABLE search_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY search_sources_org ON search_sources
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE search_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY search_entries_org ON search_entries
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
