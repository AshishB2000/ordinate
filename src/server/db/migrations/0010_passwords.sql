-- Password sign-in (AUTH_MODE=password, src/server/auth/password.ts).
--
-- Additive only: an older release ignores both columns and the new table, and
-- the widened audit CHECK accepts every value it ever wrote.
--
-- users.password_hash is `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url), never
-- the password. NULL = no password: an SSO member, or one invited by email.
-- must_change_password: set on a password an admin chose (a new person, a
-- reset); until it is changed the server answers nothing but /api/auth/*.
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- First-run setup codes. While no enabled admin of the org has a password,
-- every pod prints a code in its log at startup and keeps only its sha256
-- here, so the code works whichever pod the browser reaches. Gone once the
-- first admin account is created, and unusable past expires_at.
CREATE TABLE setup_codes (
  code_hash  text        PRIMARY KEY,
  org_id     text        NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX setup_codes_org ON setup_codes (org_id);

-- A member changing their own password is audited like a sign-in.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('rpc', 'login', 'logout', 'logout_everywhere', 'password_change'));
