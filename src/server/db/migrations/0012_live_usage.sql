-- What Live datasets cost the warehouse (live data L2.7, src/server/live/usageStore.ts).
-- One row per org, UTC day and connection: how many warehouse statements Live
-- sent through it, the bytes the warehouse said it billed for them, and how
-- many were refused by the org's LIVE_DAILY_QUERY_LIMIT. Admin → Live usage
-- reads it; the daily limit is checked against the org's sum of `queries`.
--
-- Additive only: a new table.
--
-- Written once per warehouse statement, by whichever pod sends it, so the
-- count is the org's, not a pod's: `queries` is counted when a statement is
-- ADMITTED, in one transaction that holds a per-(org, day) advisory lock,
-- reads the org's sum and upserts `queries + 1` (or `refused + 1` past the
-- limit) — so N pods racing at limit − 1 let exactly one through. `bytes` is
-- added when the warehouse answers; it stays NULL for a connection whose
-- warehouse reports no byte figure (Snowflake's SQL API), which the page shows
-- as "not reported", never as 0.
--
-- `project_id` is where the connection lives (connections are per project),
-- so the admin page can name it; it is not part of the key.
--
-- org_id is text, as in 0007_records.sql (dev mode's org is the literal
-- `default`). A row is kept after its day: it is the bill's history, one small
-- row per connection per day.

CREATE TABLE live_usage (
  org_id        text        NOT NULL,
  day           date        NOT NULL,
  connection_id uuid        NOT NULL,
  project_id    uuid        NOT NULL,
  queries       bigint      NOT NULL DEFAULT 0 CHECK (queries >= 0),
  bytes         bigint      CHECK (bytes >= 0),
  refused       bigint      NOT NULL DEFAULT 0 CHECK (refused >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, day, connection_id)
);

-- Defence in depth, forced as on records (0007): every statement in
-- usageStore.ts already names its org; this holds for one that forgets to.
-- The store sets `ordinate.org` per transaction; unset → NULL → no rows.
-- A superuser or BYPASSRLS role skips RLS entirely — run the app as an ordinary role.
ALTER TABLE live_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY live_usage_org ON live_usage
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
