-- The ⌘K name search's index (src/server/searchIndex.ts): one row per thing the palette finds
-- by name, so a search is one query, not a read of every record in the project. DERIVED from
-- `records` (0007), never the truth.
--
-- KEPT CURRENT ON WRITE: every save, rename or delete of a searched record (src/app/searchSources.ts)
-- rewrites that record's rows in the SAME transaction (src/app/recordFs.ts), inside a SAVEPOINT, so the
-- index can never fail a save — a failure there drops the source's marker instead.
--
-- search_sources: which (project, source) the index holds COMPLETELY, at which build version. No row
--   (never built, or dropped by a failed write) → the next search rebuilds that source from the
--   records, under an exclusive advisory lock every writer of that source takes shared.
-- search_entries: what a search reads. `words` is built from words split by the app
--   (src/app/searchMatch.ts wordsOf → array_to_tsvector), never by Postgres's parser, so the JS
--   reference and the index agree; `name_lc`, `updated`, `src_ord`, `rec`, `ord` are the ORDER BY.
--   `audience`: 'all', or for dashboards 'editor' (the draft) and 'viewer' (the published copy).
--
-- GIN over a tsvector is core Postgres: no extension. Additive only: two new tables. org_id is
-- text, as in 0007; forced row-level security as in 0020 (`ordinate.org` set per transaction).

CREATE TABLE search_sources (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  source     text        NOT NULL,
  version    integer     NOT NULL,
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, source)
);

CREATE TABLE search_entries (
  org_id     text     NOT NULL,
  project_id uuid     NOT NULL,
  path       text     COLLATE "C" NOT NULL,
  audience   text     NOT NULL CHECK (audience IN ('all', 'editor', 'viewer')),
  ord        integer  NOT NULL,
  src_ord    smallint NOT NULL,
  rec        text     COLLATE "C" NOT NULL,
  kind       text     NOT NULL,
  id         text     NOT NULL,
  parent_id  text,
  name       text     NOT NULL,
  name_lc    text     COLLATE "C" NOT NULL,
  words      tsvector NOT NULL,
  updated    text     COLLATE "C" NOT NULL,
  sub        text     NOT NULL,
  PRIMARY KEY (org_id, path, audience, ord)
);
CREATE INDEX search_entries_project ON search_entries (org_id, project_id, src_ord);
CREATE INDEX search_entries_words ON search_entries USING gin (words);

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
