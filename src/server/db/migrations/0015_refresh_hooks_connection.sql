-- A refresh URL for a whole CONNECTION (src/server/hooks/): one call refreshes
-- every dataset that came from it — one `curl` after a dbt run that built
-- twenty models, instead of twenty URLs.
--
-- A hook now names ONE target: a dataset (as before) or a connection. Additive
-- for an older release: every row it wrote passes the CHECK, its inserts still
-- do, and a connection's row reads there as a hook whose dataset is missing —
-- the same 404 as a deleted dataset's.
ALTER TABLE refresh_hooks ALTER COLUMN dataset_id DROP NOT NULL;
ALTER TABLE refresh_hooks ADD COLUMN connection_id uuid;
ALTER TABLE refresh_hooks ADD CONSTRAINT refresh_hooks_one_target CHECK ((dataset_id IS NULL) <> (connection_id IS NULL));
-- The rail lists one connection's hooks, newest first (as refresh_hooks_dataset does a dataset's).
CREATE INDEX refresh_hooks_connection ON refresh_hooks (org_id, project_id, connection_id, created_at DESC) WHERE connection_id IS NOT NULL;
