-- Signed embedding (docs/embed/00-design.md).
--
-- Additive only: two columns an older release neither reads nor writes, and
-- the audit CHECK widened so every value an earlier release wrote still passes.
--
-- org_settings gains the org's embedding switch (off until an admin turns it
-- on) and the exact origins allowed to frame /embed/* (CSP frame-ancestors).
-- The signing secret is NOT here: it is a row of `secrets` (kind
-- 'embed.signing'), encrypted under the org's data key.
ALTER TABLE org_settings ADD COLUMN embed_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE org_settings ADD COLUMN embed_origins text[] NOT NULL DEFAULT '{}';

-- One row per embed view whose signature held: actor 'embed', the link and dashboard ids, the outcome.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('rpc', 'login', 'logout', 'logout_everywhere', 'password_change', 'hook_refresh', 'scheduled_refresh', 'embed_view'));
