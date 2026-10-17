-- Images the org stores: the workspace and dashboard logos
-- (branding/logo.png|svg, branding/dash-<id>.png|svg) and Image-card pictures
-- (projects/<id>/assets/<id>.png|jpg|svg), keyed by the org and the path
-- relative to the org's userData. src/app/blobStore.ts is the only reader and
-- writer, and it refuses any other path.
--
-- They used to be files under DATA_DIR. With S3 storage DATA_DIR is a pod's own
-- scratch disk (the Helm chart's emptyDir), so only the pod that took the
-- upload had the picture: the org's settings said a logo existed and every
-- other pod dropped it. Here every pod reads the same row. A file an earlier
-- version left on a pod's disk becomes the row the first time it is read.
--
-- Additive only: a new table. The CHECK is the largest kind's cap (an asset,
-- 5 MiB); blobStore holds each kind to its own (a logo, 512 KiB). Capture
-- screenshots are not here: they are already in the thread record (records).
--
-- org_id is text, as in 0007_records.sql (dev mode's org is the literal
-- `default`). `path` is COLLATE "C" so a project's pictures go in one index
-- range delete (`path >= 'projects/<id>/' AND path < 'projects/<id>0'`).

CREATE TABLE blobs (
  org_id      text        NOT NULL,
  path        text        COLLATE "C" NOT NULL,
  bytes       bytea       NOT NULL CHECK (octet_length(bytes) <= 5242880),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, path)
);

-- Defence in depth, forced as on records (0007): every statement in
-- blobStore.ts already filters org_id = $1; this holds for one that forgets to.
-- The store sets `ordinate.org` per transaction; unset → NULL → no rows.
-- A superuser or BYPASSRLS role skips RLS entirely — run the app as an ordinary role.
ALTER TABLE blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE blobs FORCE ROW LEVEL SECURITY;
CREATE POLICY blobs_org ON blobs
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
