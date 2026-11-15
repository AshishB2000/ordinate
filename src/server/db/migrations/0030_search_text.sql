-- Meaning search's text and its failures (docs/assistant/00-design.md, "Meaning search, as built", PR 7c).
--
-- `text`: what a person reads of a part, stored when its row is written (src/ipc/assistantSearch.ts, the describer
--   that already has the raw names): a name, "also called" names, a description, cut to 1,000 characters. The
--   fingerprint job (src/server/fingerprintStore.ts) joins an item's parts and, for a column or a metric, its dataset's
--   name ("Orders · region — also called Sales region — Where the order shipped"), so identically named columns of two
--   datasets get two fingerprints. `words` stay what step 3 ranks by. On verified_keys, ord 0's `text` is the question
--   as written. Never a value: no example, value label, filter value or row (the canary tests hold it).
-- assistant_search_vector_failures: a text the provider refused on its own, by (item, model, text hash). After three
--   attempts the job skips it for a day, so one text never holds back the rest; a changed text is a new hash and gets
--   fresh attempts. No vector type: made with or without pgvector.
--
-- A WRITER THAT WRITES NO TEXT (a pod of the release before, which keeps 0027's and 0026's rows but not this column)
--   sets `ordinate.assistant_search` and `ordinate.verified_index` but not `ordinate.search_text`: the trigger below
--   drops that source's marker on its write, as 0028's does for keys, so the next search rebuilds it with its text.
--
-- Additive: two columns with a constant default (no table rewrite), one table, a function and two triggers.
-- ASSISTANT_SEARCH_VERSION 4 and VERIFIED_INDEX_VERSION 2 rebuild every source once, with its text.

ALTER TABLE assistant_search ADD COLUMN text text NOT NULL DEFAULT '';
ALTER TABLE verified_keys ADD COLUMN text text NOT NULL DEFAULT '';

CREATE TABLE assistant_search_vector_failures (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  item       text        COLLATE "C" NOT NULL,
  model      text        NOT NULL,
  text_hash  text        NOT NULL,
  attempts   integer     NOT NULL,
  code       text        NOT NULL,
  failed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, item, model, text_hash)
);
ALTER TABLE assistant_search_vector_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_search_vector_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_search_vector_failures_org ON assistant_search_vector_failures
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

-- The source a record path belongs to: 0028's rule for step 3's records, 0026's for a verified question.
CREATE FUNCTION search_text_stale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rel text := CASE WHEN TG_OP = 'DELETE' THEN OLD.path ELSE NEW.path END;
  org text := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  m text[];
BEGIN
  IF current_setting('ordinate.search_text', true) IS DISTINCT FROM 'on' THEN
    m := regexp_match(rel, '^projects/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/(?:(datasets|metrics|terms)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json|(catalog)\.json|connections/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(tables)\.json)$');
    IF m IS NOT NULL THEN
      DELETE FROM assistant_search_built WHERE org_id = org AND project_id = m[1]::uuid AND source = coalesce(m[2], m[3], m[4]);
    ELSIF rel ~ '^projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/verified/' THEN
      DELETE FROM verified_built WHERE org_id = org AND project_id = substring(rel from 10 for 36)::uuid;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER records_search_text_written AFTER INSERT OR UPDATE ON records
  FOR EACH ROW WHEN (NEW.path LIKE 'projects/%') EXECUTE FUNCTION search_text_stale();
CREATE TRIGGER records_search_text_deleted AFTER DELETE ON records
  FOR EACH ROW WHEN (OLD.path LIKE 'projects/%') EXECUTE FUNCTION search_text_stale();
