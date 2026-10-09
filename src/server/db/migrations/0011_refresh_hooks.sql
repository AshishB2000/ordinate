-- Refresh URLs (live data L0.5, src/server/hooks/). A dbt run or an Airflow
-- DAG POSTs to /api/hooks/refresh/<token> when new data has landed, and
-- Ordinate refreshes ONE dataset — the only thing the token can do.
--
-- Additive only: a new table, and the audit CHECK widened so every value an
-- older release ever wrote still passes.
--
-- The token is never stored: `token_hash` is its hex sha256, what a call is
-- looked up by; `prefix` (`ordh_` + 8 characters) names it in a list. The
-- value is shown once, in the reply that created it.
--
-- `created_by` is the creator's email, the key every grant check uses: a call
-- refreshes AS them, with their CURRENT role, so a hook stops working once
-- they are disabled or lose write on the project. Text, not a foreign key:
-- under AUTH_MODE=dev there is no users row, and org_id is text for the same
-- reason as in 0007_records.sql.
--
-- `last_used_at` is also the rate limit: a call claims the hook with one
-- `UPDATE … WHERE last_used_at <= now() - interval`, which serializes on the
-- row, so it holds across pods on the database's clock.

CREATE TABLE refresh_hooks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text        NOT NULL,
  project_id   uuid        NOT NULL,
  dataset_id   uuid        NOT NULL,
  token_hash   text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  prefix       text        NOT NULL,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
-- The panel lists one dataset's hooks, newest first; the UNIQUE above is the call's lookup.
CREATE INDEX refresh_hooks_dataset ON refresh_hooks (org_id, project_id, dataset_id, created_at DESC);

-- Defence in depth, forced as on records (0007): every query in
-- src/server/hooks/store.ts already names its org or its hash; these hold for
-- one that forgets to. Two ways to see a row:
--   - a member's call, with `ordinate.org` set for the transaction: the org's hooks;
--   - a refresh URL's call, which names no org: `ordinate.hook` set to the
--     token's hash shows the one row it is the hash of, and lets that call
--     stamp it. Without the token, no row.
-- A superuser or BYPASSRLS role skips RLS entirely — run the app as an ordinary role.
ALTER TABLE refresh_hooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_hooks FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_hooks_org ON refresh_hooks
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
CREATE POLICY refresh_hooks_by_token ON refresh_hooks FOR SELECT
  USING (token_hash = current_setting('ordinate.hook', true));
CREATE POLICY refresh_hooks_claim ON refresh_hooks FOR UPDATE
  USING (token_hash = current_setting('ordinate.hook', true))
  WITH CHECK (token_hash = current_setting('ordinate.hook', true));

-- Refreshes no member clicked are audited (src/server/authz/audit.ts): a
-- refresh URL's call, and a scheduled refresh.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('rpc', 'login', 'logout', 'logout_everywhere', 'password_change', 'hook_refresh', 'scheduled_refresh'));
