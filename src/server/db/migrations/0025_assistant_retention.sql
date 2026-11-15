-- Assistant conversations are kept until an admin says otherwise (docs/assistant-threads/00-design.md §8).
-- 0023 kept 50 per member per project and deleted the least recently touched beyond that; that
-- cap is gone with a database, and the list is paged instead (assistant_threads_mine).
--
-- Additive only: one nullable column and one index.
--
-- `assistant_retention_days`: Admin → Settings, "Delete Assistant conversations unused for N days".
-- NULL, the default, keeps every conversation. The shared sweep (src/server/sharedState.ts) deletes
-- an org's conversations whose last turn is older, a few at a time.
ALTER TABLE org_settings ADD COLUMN assistant_retention_days integer CHECK (assistant_retention_days BETWEEN 1 AND 3650);

-- The sweep's "this org's conversations unused since …", read every five minutes once it is set.
CREATE INDEX assistant_threads_unused ON assistant_threads (org_id, updated_at);
