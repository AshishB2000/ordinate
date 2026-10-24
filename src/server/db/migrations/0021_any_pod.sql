-- Any pod can serve any request (docs/any-pod/00-design.md). Three things that were one pod's
-- memory become rows every pod reads:
--
--   file_tokens      upload and download tokens (src/server/fileTokens.ts)
--   import_stages    parsed-but-unsaved imports (src/data/stageStore.ts)
--   shared_counters  the abuse limits' windows (src/server/counters.ts)
--
-- Their bytes live in the org's staging area (src/server/staging.ts):
-- DATA_DIR/orgs/<org>/temp/<storage_key> on a shared volume, or
-- s3://<bucket>/<prefix>/orgs/<org>/staging/<storage_key>. A storage_key is a server-made file name
-- (no separator), and the org part of every path is the caller's, never read from a row.
-- The `shared:sweep` job deletes what has expired.
--
-- file_tokens holds the sha256 of a token, never the token. A take is one conditional UPDATE that
-- names the org, the user and the kind, so a wrong caller matches nothing and burns nothing.
--
-- Additive only: three new tables. org_id is text, as in 0007_records.sql (dev mode's org is the
-- literal `default`).

CREATE TABLE file_tokens (
  token_hash   bytea       PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  org_id       text        NOT NULL,
  user_email   text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('upload', 'download')),
  storage_key  text        COLLATE "C" NOT NULL,
  name         text        NOT NULL,
  size         bigint      NOT NULL CHECK (size >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX file_tokens_expiry ON file_tokens (org_id, expires_at);

-- `meta` is JSON text, not jsonb: a column name may hold U+0000, which jsonb refuses.
-- `ready_at` is NULL while the Parquet is still being written: such a row is never read and never
-- evicted (an eviction mid-write left a file no row named). Eviction keeps the newest ready ones.
CREATE TABLE import_stages (
  id           uuid        PRIMARY KEY,
  org_id       text        NOT NULL,
  user_email   text        NOT NULL,
  storage_key  text        COLLATE "C" NOT NULL,
  meta         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at     timestamptz,
  expires_at   timestamptz NOT NULL
);
CREATE INDEX import_stages_owner ON import_stages (org_id, user_email, created_at);
CREATE INDEX import_stages_expiry ON import_stages (org_id, expires_at);

-- A window opens at a key's first hit and lasts its limit's window; at its end the count starts
-- over. window_end is cut to milliseconds, so a refund names its window exactly.
CREATE TABLE shared_counters (
  org_id      text        NOT NULL,
  key         text        COLLATE "C" NOT NULL,
  n           bigint      NOT NULL CHECK (n >= 0),
  window_end  timestamptz NOT NULL,
  PRIMARY KEY (org_id, key)
);

-- Defence in depth, forced as on records (0007): every statement already names its org and runs
-- in a transaction that sets `ordinate.org`; unset → NULL → no rows. A superuser or BYPASSRLS role
-- skips RLS entirely, so run the app as an ordinary role.
ALTER TABLE file_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY file_tokens_org ON file_tokens
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE import_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY import_stages_org ON import_stages
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE shared_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY shared_counters_org ON shared_counters
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
