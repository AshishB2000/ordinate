-- Parquet on S3 (T5.2). One row per table object a write created, registered
-- BEFORE the object is written, so garbage collection knows every key even
-- when a write dies halfway. src/engine/storage.ts is the only reader/writer.
--
-- `key` is relative to the org's prefix: <project>/<id>.<version>[.source].parquet.
-- `unreferenced_since` is stamped by the GC pass that first finds no record
-- naming `version`, cleared if one does again; the object is deleted once it
-- is older than the grace period (STORAGE_GC_GRACE_MINUTES).

CREATE TABLE storage_objects (
  org_id              text        NOT NULL,
  key                 text        COLLATE "C" NOT NULL,
  version             uuid        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  unreferenced_since  timestamptz,
  PRIMARY KEY (org_id, key)
);

-- Same defence in depth as records (0007): storage.ts filters org_id and sets
-- the org per transaction; RLS holds for a query that forgets to.
ALTER TABLE storage_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY storage_objects_org ON storage_objects
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
