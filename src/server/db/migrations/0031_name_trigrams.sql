-- Spelling for "Did you mean" (docs/assistant/00-design.md, "Spelling", phase C): pg_trgm where the database has it,
-- and nothing anywhere else. When a model's answer names a dataset that does not exist, the names step 3's index holds
-- (0027's `assistant_search.name`, base parts) are searched by trigram similarity, so "Ordrs" finds Orders though they
-- share no word (src/server/assistantSearchIndex.ts speltPage).
--
-- OPTIONAL. pg_trgm is a contrib extension that ships with Postgres and is trusted since PG 13: a role with CREATE on
--   the database (Ordinate's owns it) may create it. This migration never fails for it: it tries CREATE EXTENSION only
--   where pg_available_extensions lists `pg_trgm`, inside a plpgsql EXCEPTION block (a subtransaction: an error there
--   rolls back that block alone), and makes the index only where the extension then exists. Without it, the same
--   query reads the few names the caller may find and src/app/trigram.ts ranks them, the reference.
-- LATER. An operator who creates the extension after this upgrade runs `SELECT ordinate_ensure_name_trigrams();` for the
--   index: the function this migration calls, so the DDL is written once, here. Without the index the answers are the
--   same, only read row by row within the project.
--
-- GIN over the stored name: pg_trgm lower-cases each word itself, so the index needs no lower(). Partial, on base parts
-- (the ones that carry an item's own name). fastupdate off, as 0027's. The operator class is qualified with the
-- extension's schema, which an operator may have put off the search_path.
--
-- Additive: one function; where pg_trgm is, the extension and one index.

CREATE FUNCTION ordinate_ensure_name_trigrams() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  nsp text;
BEGIN
  SELECT n.nspname INTO nsp FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  IF nsp IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ordinate:name_trigrams', 0));
  IF to_regclass('assistant_search_name_trgm') IS NOT NULL THEN
    RETURN true;
  END IF;
  BEGIN
    EXECUTE format('CREATE INDEX assistant_search_name_trgm ON assistant_search USING gin (name %I.gin_trgm_ops) WITH (fastupdate = off) WHERE base', nsp);
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ordinate: assistant_search_name_trgm not created (%): spelling reads the names row by row', SQLERRM;
    RETURN false;
  END;
  RETURN true;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION WHEN others THEN
      -- insufficient_privilege (no CREATE on the database), a missing library: never fail the upgrade.
      RAISE NOTICE 'ordinate: pg_trgm not created (%): spelling is ranked by the app until an operator runs CREATE EXTENSION pg_trgm', SQLERRM;
    END;
  END IF;
  PERFORM ordinate_ensure_name_trigrams();
END $$;
