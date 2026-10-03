-- Secrets at rest (T5.3). Envelope encryption, src/server/secrets/store.ts:
-- every secret is AES-256-GCM under its org's data key; every data key is
-- AES-256-GCM under ORDINATE_MASTER_KEY, which never touches the database.
-- Rotation (src/server/secrets/rotate.ts) re-wraps the data-key rows only.
--
-- org_id is text, not a foreign key: `orgs` arrives with T3.2, and dev mode's
-- org is the literal `default`.

CREATE TABLE secret_data_keys (
  id          uuid        PRIMARY KEY,
  org_id      text        NOT NULL UNIQUE,     -- one data key per org
  master_kid  text        NOT NULL,            -- fingerprint of the master key that wraps it
  wrapped     bytea       NOT NULL,            -- the 32-byte data key, encrypted
  iv          bytea       NOT NULL,
  tag         bytea       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz                      -- last re-wrap under a new master key
);

CREATE TABLE secrets (
  org_id      text        NOT NULL,
  kind        text        NOT NULL,            -- 'connection.password' | 'connection.token' | 'ai.apiKey'
  ref         text        NOT NULL,            -- connection UUID, provider name, …
  key_id      uuid        NOT NULL REFERENCES secret_data_keys (id),
  ciphertext  bytea       NOT NULL,            -- AAD binds it to (org_id, kind, ref)
  iv          bytea       NOT NULL,
  tag         bytea       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, ref)
);
