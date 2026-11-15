-- Exact lookups in the Assistant's search of the Data model (0027; src/server/assistantSearchIndex.ts `keyedItems`): an
-- ask resolves the names a chart spec says, and reads a dataset's metrics and terms, through the index instead of
-- every list of the project (docs/assistant/00-design.md, "Scale rules").
--
-- `keys`, on an item's BASE part only: a hash of its name as the answer validator compares it (trimmed and lowercased,
-- and squashed), the same of a term's other names, and `d:<dataset id>` for a metric or a term. Made by the app
-- (src/ipc/assistantSearch.ts nameKeys), so Postgres never lowercases a name: a key match is a candidate, and the app
-- applies the validator's own rule to the records it reads. Never a value.
--
-- A WRITER THAT WRITES NO KEYS (a pod of the release before, which keeps 0027's rows but not this column) sets
--   `ordinate.assistant_search` and not `ordinate.assistant_search_keys`: the trigger below drops that source's marker
--   on its write, as 0027's does for a writer that keeps no index at all, so the next search rebuilds it with keys.
--
-- Additive: one column with a constant default (no table rewrite), two indexes, a function and two triggers.
-- ASSISTANT_SEARCH_VERSION 2 marks every source stale, so each is rebuilt once with its keys on the next search.

ALTER TABLE assistant_search ADD COLUMN keys text[] COLLATE "C" NOT NULL DEFAULT '{}';
CREATE INDEX assistant_search_keys ON assistant_search USING gin (keys) WITH (fastupdate = off);
-- The newest items of a kind (Home's datasets when the question names too few): an index scan, not the project's rows.
CREATE INDEX assistant_search_newest ON assistant_search (org_id, project_id, kind, updated DESC, item) WHERE base;

-- The source a record path belongs to: the same rule as 0027's assistant_search_stale, for a writer that writes no keys.
CREATE FUNCTION assistant_search_keys_stale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rel text := CASE WHEN TG_OP = 'DELETE' THEN OLD.path ELSE NEW.path END;
  org text := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  m text[];
BEGIN
  IF current_setting('ordinate.assistant_search_keys', true) IS DISTINCT FROM 'on' THEN
    m := regexp_match(rel, '^projects/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/(?:(datasets|metrics|terms)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json|(catalog)\.json|connections/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(tables)\.json)$');
    IF m IS NOT NULL THEN
      DELETE FROM assistant_search_built WHERE org_id = org AND project_id = m[1]::uuid AND source = coalesce(m[2], m[3], m[4]);
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER records_assistant_search_keys_written AFTER INSERT OR UPDATE ON records
  FOR EACH ROW WHEN (NEW.path LIKE 'projects/%') EXECUTE FUNCTION assistant_search_keys_stale();
CREATE TRIGGER records_assistant_search_keys_deleted AFTER DELETE ON records
  FOR EACH ROW WHEN (OLD.path LIKE 'projects/%') EXECUTE FUNCTION assistant_search_keys_stale();
