-- Admin and API tokens (T3.4).
--
-- api_tokens (0003) gains the token's public prefix: the first characters of
-- the value (`ord_` + 8), shown in lists so a person can tell tokens apart.
-- The value itself is never stored — only its sha256 (token_hash), which is
-- what a request is looked up by.
ALTER TABLE api_tokens ADD COLUMN prefix text NOT NULL DEFAULT '';

-- Per-org settings an org admin changes in Admin → Settings. One row per org,
-- written on first save; no row = the defaults below.
CREATE TABLE org_settings (
  org_id        text        PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  -- Publishing a dashboard to a public link (T2.9 reads it). Off until an admin turns it on.
  public_links  boolean     NOT NULL DEFAULT false,
  -- The AI providers members may use; NULL = every provider.
  ai_providers  text[],
  -- A per-org upload cap in MB, enforced by POST /api/files UNDER the server's
  -- MAX_UPLOAD_MB ceiling; NULL = the ceiling.
  upload_cap_mb integer     CHECK (upload_cap_mb > 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The audit viewer pages newest-first by id within an org (keyset, never OFFSET).
CREATE INDEX audit_log_org_id ON audit_log (org_id, id DESC);
