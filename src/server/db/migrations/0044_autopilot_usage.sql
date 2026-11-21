-- Autopilot phase 1 (docs/autopilot/00-design.md): what Autopilot needs to WATCH before it may act. Nothing here is read
-- by a screen yet; the weekly job (later phases) reads it.
--
-- item_usage_daily: one row per chart (kind 'visual') or dashboard (kind 'dashboard') per UTC day. `opened`: it was
--   opened that day (a person in the app, an API-token or MCP read, an embed, a published page). `computes`, `total_ms` and
--   `max_ms`: how many times the server computed it that day and how long it took, so "typical" is total_ms / computes and
--   "slowest" is max_ms (both merge across pods and flushes exactly). PER ITEM ONLY: there is no user column, by design.
--   Written by every pod in batches (src/server/autopilot/usage.ts), never inside a request. An item that no longer exists
--   is never inserted (the flush checks `records`), so a client-sent id cannot fill the table.
--
-- column_renames: every column rename the app made through the column editor (src/data/columnEdit.ts), with the old and the
--   new name, so a later repair is exact. `kind`: 'source' (the source column itself was renamed) or 'step' (a
--   rename_column step was appended to the prepare steps, because a step reads the column). `edit_id` groups the rows of one
--   edit; `seq` orders all rows of the org, so a swap (a to b and b to a in one edit) or a chain (a to b, later b to c)
--   replays exactly. A rename made before this migration is not here: it is flagged, never repaired.
--
-- Additive only: two new tables. Forced row-level security as in 0012 and 0035: a statement sees a row only inside a
-- transaction that set ordinate.org. A superuser or BYPASSRLS role skips RLS: run the app as an ordinary role.

CREATE TABLE item_usage_daily (
  org_id     text    NOT NULL,
  project_id uuid    NOT NULL,
  kind       text    NOT NULL CHECK (kind IN ('visual', 'dashboard')),
  item_id    uuid    NOT NULL,
  day        date    NOT NULL,
  opened     boolean NOT NULL DEFAULT false,
  computes   integer NOT NULL DEFAULT 0 CHECK (computes >= 0),
  total_ms   bigint  NOT NULL DEFAULT 0 CHECK (total_ms >= 0),
  max_ms     integer NOT NULL DEFAULT 0 CHECK (max_ms >= 0),
  PRIMARY KEY (org_id, project_id, kind, item_id, day)
);
CREATE INDEX item_usage_daily_day ON item_usage_daily (org_id, project_id, day);

CREATE TABLE column_renames (
  org_id     text        NOT NULL,
  seq        bigint      GENERATED ALWAYS AS IDENTITY,
  project_id uuid        NOT NULL,
  dataset_id uuid        NOT NULL,
  edit_id    uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('source', 'step')),
  old_name   text        NOT NULL,
  new_name   text        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, seq)
);
CREATE INDEX column_renames_dataset ON column_renames (org_id, project_id, dataset_id, seq);

ALTER TABLE item_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY item_usage_daily_org ON item_usage_daily
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE column_renames ENABLE ROW LEVEL SECURITY;
ALTER TABLE column_renames FORCE ROW LEVEL SECURITY;
CREATE POLICY column_renames_org ON column_renames
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
