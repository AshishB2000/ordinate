-- Records in Postgres (T5.1). One row per record file the desktop keeps as
-- JSON under userData — project.json, datasets/<id>.json (the metadata; the
-- Parquet stays on disk), visuals, analyses, metrics, reports, alerts.json,
-- versions, trash, comments, … — keyed by the org and the path relative to the
-- org's userData. src/app/recordFs.ts is the only reader and writer.
--
-- `body` is the file's exact text, not jsonb: jsonb would reorder keys and
-- refuse the unparseable copy a store keeps aside as `.corrupt`, and every
-- store already parses and sanitizes what it reads.
--
-- `path` is COLLATE "C" so a directory listing is one index range scan
-- (`path >= 'dir/' AND path < 'dir0'`).
--
-- org_id is text, not a foreign key: `orgs` arrives with T3.2, and dev mode's
-- org is the literal `default` (as in 0002_secrets.sql).

CREATE TABLE records (
  org_id      text        NOT NULL,
  path        text        COLLATE "C" NOT NULL,
  body        text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, path)
);

-- Defence in depth: every query in recordFs.ts already filters org_id = $1;
-- this also holds for any query that forgets to. recordFs sets the org per
-- transaction (`set_config('ordinate.org', …, true)`); unset → NULL → no rows.
-- FORCE makes it apply to the table's owner too. A superuser or BYPASSRLS
-- role skips RLS entirely — run the app as an ordinary role.
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE records FORCE ROW LEVEL SECURITY;
CREATE POLICY records_org ON records
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
