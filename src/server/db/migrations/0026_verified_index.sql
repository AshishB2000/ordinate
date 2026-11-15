-- The Assistant's verified-question lookup (src/server/verifiedIndex.ts): one row per wording a verified
-- question answers to, so an ask's exact match (step 2) is one indexed probe and its examples (step 3) are
-- ranked here, not a read of every verified record of the project on every ask. DERIVED from `records`
-- (0007), never the truth: whether a question still runs, and whether the caller may see it, are worked out
-- on the few records a lookup returns (src/ipc/verifiedState.ts), never stored.
--
-- KEPT CURRENT ON WRITE as 0022 is: every save, rename or delete of projects/<p>/verified/<id>.json rewrites
-- that question's rows in the SAME transaction (src/app/recordFs.ts), inside a SAVEPOINT, so the index can
-- never fail a save — a failure drops the project's marker instead.
--
-- verified_built: the projects the index holds COMPLETELY, at which build version. No row (never built, or
--   dropped by a failed write) → the next ask rebuilds the project from its records, under an exclusive
--   advisory lock every writer of that project takes shared.
-- verified_keys: ord 0 is the question, 1.. its phrasings. `key` is ../analysis/verifiedRules `questionKey`;
--   `words` (ord 0 only) is ../ai/answerSuggest `words` of the question, duplicates kept, as the examples'
--   ranking counts them. Both are computed by the app, never by Postgres, so the JS reference and the index
--   agree. `updated` and `id` are text in "C" order: the reference compares them as JS strings.
--
-- A WRITER THAT DOES NOT FOLLOW: a pod of an older release (a rolling update, a rollback) writes a verified
--   record without touching the index. The triggers below drop that project's marker on any such write: one whose
--   transaction does not set `ordinate.verified_index` = 'on', which recordFs sets beside `ordinate.org` because
--   it rewrites the rows itself. So the next ask on a new pod rebuilds, and no question verified in the meantime is missed.
--
-- Additive only: two new tables, a function and two triggers on `records`. org_id is text, as in 0007; forced
-- row-level security as in 0022 (the trigger's delete runs under the writer's `ordinate.org`, which every
-- write to `records` must already carry).

CREATE TABLE verified_built (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  version    integer     NOT NULL,
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE verified_keys (
  org_id     text     NOT NULL,
  project_id uuid     NOT NULL,
  id         text     COLLATE "C" NOT NULL,
  ord        smallint NOT NULL,
  key        text     COLLATE "C" NOT NULL,
  dataset_id text     COLLATE "C" NOT NULL,
  updated    text     COLLATE "C" NOT NULL,
  words      text[]   COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, project_id, id, ord)
);
CREATE INDEX verified_keys_key ON verified_keys (org_id, project_id, key);

ALTER TABLE verified_built ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_built FORCE ROW LEVEL SECURITY;
CREATE POLICY verified_built_org ON verified_built
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE verified_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY verified_keys_org ON verified_keys
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

CREATE FUNCTION verified_index_stale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rel text := CASE WHEN TG_OP = 'DELETE' THEN OLD.path ELSE NEW.path END;
  org text := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
BEGIN
  IF current_setting('ordinate.verified_index', true) IS DISTINCT FROM 'on'
     AND rel ~ '^projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/verified/' THEN
    DELETE FROM verified_built WHERE org_id = org AND project_id = substring(rel from 10 for 36)::uuid;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER records_verified_written AFTER INSERT OR UPDATE ON records
  FOR EACH ROW WHEN (NEW.path LIKE 'projects/%/verified/%') EXECUTE FUNCTION verified_index_stale();
CREATE TRIGGER records_verified_deleted AFTER DELETE ON records
  FOR EACH ROW WHEN (OLD.path LIKE 'projects/%/verified/%') EXECUTE FUNCTION verified_index_stale();
