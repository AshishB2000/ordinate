-- Meaning search's fingerprints (docs/assistant/00-design.md, phase C; PR 7a): pgvector where the database has it, and
-- nothing anywhere else. A fingerprint is one row of `assistant_search_vectors`: an item of the Assistant's search
-- (0027's `item`: 'dataset:<id>', 'column:<dataset>/<name>', 'metric:<id>', 'term:<id>', 'table:<connection>/<doc>'),
-- the model that made it, the hash of the text it was made from, and the vector. DERIVED, as 0027's rows are: made
-- from names and descriptions only, never a row value.
--
-- OPTIONAL. pgvector is an extension a plain Postgres does not offer, and it is not a trusted one: creating it takes a
--   superuser (rds_superuser on RDS, cloudsqlsuperuser on Cloud SQL, an allow-listed azure.extensions on Azure). This
--   migration never fails for it: it tries CREATE EXTENSION only where pg_available_extensions lists `vector`, inside a
--   plpgsql EXCEPTION block (a subtransaction: an error there rolls back that block alone, not the migration), and the
--   table is made only where the extension then exists. Without it, search stays on words.
-- LATER. An operator who creates the extension after this upgrade gets the table from the app: src/server/vectorStore.ts
--   calls ordinate_ensure_vector_store(), the function this migration calls, so the DDL is written once, here. The app
--   never creates the extension.
--
-- 768 dimensions for every model (text-embedding-3-* with `dimensions: 768`, Gemini's 768 output; a gateway model must
-- return 768). HNSW over cosine distance (pgvector 0.5 or later). Forced row-level security as 0027. The type and
-- operator class are qualified with the extension's own schema, which an operator may have put off the search_path.
--
-- Additive: one function; where pgvector is, the extension, one table and its index.

CREATE FUNCTION ordinate_ensure_vector_store() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  nsp text;
BEGIN
  SELECT n.nspname INTO nsp FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector';
  IF nsp IS NULL THEN
    RETURN false;
  END IF;
  -- Pods that call at once: one creates, the others wait here and then find the table.
  PERFORM pg_advisory_xact_lock(hashtextextended('ordinate:vector_store', 0));
  IF to_regclass('assistant_search_vectors') IS NOT NULL THEN
    RETURN true;
  END IF;
  BEGIN
    EXECUTE format($ddl$
      CREATE TABLE assistant_search_vectors (
        org_id     text        NOT NULL,
        project_id uuid        NOT NULL,
        item       text        COLLATE "C" NOT NULL,
        model      text        NOT NULL,
        text_hash  text        NOT NULL,
        embedding  %1$I.vector(768) NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, project_id, item, model)
      )$ddl$, nsp);
    EXECUTE format('CREATE INDEX assistant_search_vectors_embedding ON assistant_search_vectors USING hnsw (embedding %I.vector_cosine_ops)', nsp);
    EXECUTE 'ALTER TABLE assistant_search_vectors ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE assistant_search_vectors FORCE ROW LEVEL SECURITY';
    EXECUTE $p$CREATE POLICY assistant_search_vectors_org ON assistant_search_vectors
      USING (org_id = current_setting('ordinate.org', true))
      WITH CHECK (org_id = current_setting('ordinate.org', true))$p$;
  EXCEPTION WHEN others THEN
    -- A pgvector without HNSW (before 0.5), no CREATE on the schema: no table, and search stays on words.
    RAISE NOTICE 'ordinate: assistant_search_vectors not created (%): meaning search stays on words', SQLERRM;
    RETURN false;
  END;
  RETURN true;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN others THEN
      -- insufficient_privilege (the role may not create it), feature_not_supported, a missing library: never fail the upgrade.
      RAISE NOTICE 'ordinate: pgvector not created (%): meaning search stays on words until an operator runs CREATE EXTENSION vector', SQLERRM;
    END;
  END IF;
  PERFORM ordinate_ensure_vector_store();
END $$;
