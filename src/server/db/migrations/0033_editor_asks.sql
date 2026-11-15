-- "Ask an editor" (docs/assistant/00-design.md, phase G): a viewer whose question needs data the
-- project does not have yet, a link nobody defined, or a table that must be copied first tells the
-- project's editors and admins, through the path mentions use (0020): a row in each one's bell, a
-- notice in their open tabs, and an email for those who turned it on.
--
-- One row per person told (src/server/mentions/asks.ts), as `mentions` has: the question, the
-- reason and the note are COPIED here, because a viewer's conversation is private and the editor
-- reads what was sent, never the turn. At most 200 rows per member. org_id is text, as in
-- 0007_records.sql; forced row-level security on `ordinate.org`, as 0020.
--
-- `users.request_email` is "Email me when a viewer asks for data" (Settings → You), OFF until the
-- person turns it on (docs/team-folders/00-design.md D21); dashboard requests (phase E9) use the
-- same switch.
--
-- Additive only: one new table and one column with a constant default (no rewrite).

CREATE TABLE editor_asks (
  org_id     text        NOT NULL,
  user_email text        NOT NULL,   -- who is told: an editor or admin of the project when it was sent
  id         uuid        NOT NULL,   -- the ask: the same on every row of one send
  project_id uuid        NOT NULL,
  asker      text        NOT NULL,   -- an email, as `mentions.author`
  question   text        NOT NULL CHECK (char_length(question) BETWEEN 1 AND 1000),
  reason     text        NOT NULL CHECK (reason IN ('missing', 'link', 'copy')),
  note       text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at    timestamptz,
  PRIMARY KEY (org_id, user_email, id)
);
CREATE INDEX editor_asks_inbox ON editor_asks (org_id, user_email, created_at DESC);

ALTER TABLE users ADD COLUMN request_email boolean NOT NULL DEFAULT false;

ALTER TABLE editor_asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE editor_asks FORCE ROW LEVEL SECURITY;
CREATE POLICY editor_asks_org ON editor_asks
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
