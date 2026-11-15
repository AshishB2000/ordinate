-- ⌘K's rows gain the item a shared folder decides them by (docs/team-folders/00-design.md D13; src/server/searchIndex.ts):
-- a search for a caller a folder restricts keeps, in its own WHERE, only the rows whose anchor sits in a folder they open
-- (src/server/authz/folderSql.ts `searchRowShown`), before the ranking and the LIMIT.
--
-- `anchor_kind`, `anchor_id`: a dataset's rows, a visual's and a metric's anchor to the dataset ('dataset', its id); a
--   dashboard's and its saved views' to the dashboard ('dashboard'); an alert rule to its dashboard when it was made from
--   one, else its dataset; a report to its dashboard, else 'many' (it follows everything it names: checked by id after
--   ranking); a connection to the project ('project', not foldered). Made by the app (src/ipc/search.ts describeRecord).
--   NULL: a row a pod of an older release wrote, never returned to a restricted caller (a hide, never a leak).
--
-- verified_keys.reads: every dataset a verified question reads — a chart question's one, an SQL question's all (its
--   `dataset_id` is only the first) — so the verified lookups keep, in their WHERE, only questions the caller opens every
--   dataset of (src/server/authz/folderSql.ts `opensAll`). Made by the app (src/ipc/verifiedLookup.ts describeVerified).
--
-- A WRITER THAT WRITES NO ANCHORS (a pod of the release before, which keeps 0022's and 0026's rows but not these columns)
--   sets `ordinate.org` and not `ordinate.search_anchors`: the trigger below drops that ⌘K source's marker, or the
--   project's verified marker, on its write, as 0030's does for a writer with no text, so the next search rebuilds it. A
--   delete by such a pod removes its rows as this release would: no trigger on DELETE.
--
-- ordinate_turn_datasets(body): the datasets an Assistant turn's stored body (0023 `assistant_turns.body`) shows — its
--   chart's (`answer.datasetId`), its "Did you mean" options' and every one its SQL answer read (`sql.datasetIds`) — so the conversation list counts, in its one query, only
--   the turns a caller a folder restricts is shown (src/ai/copilotRows.ts `listPage`, the rule of src/ipc/turnsOpen.ts).
--   A body that is no JSON shows none, as the app reads it.
--
-- Additive: two nullable columns and one with a constant default (no table rewrite), two functions and a trigger.
-- INDEX_VERSION 3 and VERIFIED_INDEX_VERSION 4 rebuild every source once, with their anchors and reads. Folder ids are read from folder_items (0032) inside the query: a move rewrites no row here.

ALTER TABLE search_entries ADD COLUMN anchor_kind text COLLATE "C";
ALTER TABLE search_entries ADD COLUMN anchor_id text COLLATE "C";
ALTER TABLE verified_keys ADD COLUMN reads text[] COLLATE "C" NOT NULL DEFAULT '{}';

-- The source a record path belongs to: the same rule as sourceOf in src/app/searchSources.ts; else 0026's verified question.
CREATE FUNCTION search_anchors_stale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m text[];
BEGIN
  IF current_setting('ordinate.search_anchors', true) IS DISTINCT FROM 'on' THEN
    m := regexp_match(NEW.path, '^projects/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/(?:(datasets|visuals|analyses|connections|metrics|reports)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json|(alerts)\.json)$');
    IF m IS NOT NULL THEN
      DELETE FROM search_sources WHERE org_id = NEW.org_id AND project_id = m[1]::uuid AND source = coalesce(m[2], m[3]);
    ELSIF NEW.path ~ '^projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/verified/' THEN
      DELETE FROM verified_built WHERE org_id = NEW.org_id AND project_id = substring(NEW.path from 10 for 36)::uuid;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER records_search_anchors_written AFTER INSERT OR UPDATE ON records
  FOR EACH ROW WHEN (NEW.path LIKE 'projects/%') EXECUTE FUNCTION search_anchors_stale();

CREATE FUNCTION ordinate_turn_datasets(body text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN ARRAY(
    SELECT v #>> '{}' FROM jsonb_path_query(body::jsonb, '$.answer.datasetId') AS v WHERE jsonb_typeof(v) = 'string'
    UNION ALL
    SELECT v #>> '{}' FROM jsonb_path_query(body::jsonb, '$.suggest.options[*].spec.datasetId') AS v WHERE jsonb_typeof(v) = 'string'
    UNION ALL
    SELECT v #>> '{}' FROM jsonb_path_query(body::jsonb, '$.sql.datasetIds[*]') AS v WHERE jsonb_typeof(v) = 'string');
EXCEPTION WHEN others THEN
  RETURN '{}'; -- not JSON: the app keeps such a turn without its other fields (copilotRows turnOf)
END $$;
