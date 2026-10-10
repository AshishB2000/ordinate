-- An org's settings document (src/app/config.ts, through src/server/orgConfig.ts):
-- number and date formats, branding, language, the fiscal calendar, each
-- member's starred items, first-run guidance, notification switches.
--
-- It used to be `config.json` under DATA_DIR. With S3 storage DATA_DIR is a
-- pod's own scratch disk (the Helm chart's emptyDir), so each pod had its own
-- copy and a restarted pod started from the defaults. Here every pod reads the
-- same row.
--
-- Additive only: a new table. One row per org, written on the first change (or
-- at the first start, from a `config.json` an earlier version left on disk).
-- `version` goes up by one on every write; a pod asks for it about once a
-- second and re-reads the body when it has moved.
--
-- Never a secret: connection passwords and AI keys are in the encrypted
-- secrets store (0002). The writer blanks those fields before every write, and
-- test-orgConfig-db plants a canary to prove it.
--
-- org_id is text, as in 0007_records.sql (dev mode's org is the literal `default`).

CREATE TABLE org_config (
  org_id     text        PRIMARY KEY,
  body       text        NOT NULL,
  version    bigint      NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Defence in depth, forced as on records (0007): every statement in
-- orgConfig.ts already names its org; this holds for one that forgets to.
-- The store sets `ordinate.org` per transaction; unset → NULL → no rows.
-- A superuser or BYPASSRLS role skips RLS entirely — run the app as an ordinary role.
ALTER TABLE org_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_config FORCE ROW LEVEL SECURITY;
CREATE POLICY org_config_org ON org_config
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
