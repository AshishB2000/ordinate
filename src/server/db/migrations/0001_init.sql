-- The migration ledger. src/server/db/migrate.ts reads "no such table" as
-- "nothing applied", runs this file, then records it here like any other.
-- An applied migration is never edited: its checksum is compared at startup.
CREATE TABLE schema_migrations (
  version    integer     PRIMARY KEY,
  name       text        NOT NULL,
  checksum   text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
