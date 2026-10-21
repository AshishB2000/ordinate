-- Notifications that reach the right person (docs/notifications/00-design.md):
-- each member's own alert inbox state, a once-only ledger for alert posts, the
-- mentions that name a member, and their "Email me when someone mentions me".
--
-- Additive only: three new tables and one column with a constant default (no
-- backfill; Postgres 11+ adds it without rewriting the table). org_id is text,
-- as in 0007_records.sql (dev mode's org is the literal `default`). Every new
-- table is per org with row-level security forced, like 0013's user_ai_model:
-- src/server/db/inOrg.ts sets `ordinate.org` per transaction; unset → NULL →
-- no rows.

-- What one member has seen of one project's alert inbox (src/server/alertInbox.ts).
-- An event is seen when its `at` is at or before seen_through ("Mark all seen"),
-- or its id is in seen_ids (marked one by one; pruned on every write to the
-- events still stored, so never more than the 200 a project keeps). No row: the
-- shared `seen` flag the events carried before this migration decides, so no
-- badge lights up on upgrade.
CREATE TABLE alert_inbox (
  org_id       text        NOT NULL,
  user_email   text        NOT NULL,
  project_id   uuid        NOT NULL,
  seen_through timestamptz,
  seen_ids     uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(seen_ids) <= 200),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_email, project_id)
);

-- Each fired alert event goes to its rule's channels at most once, whichever
-- path delivered it (the tick, a refresh, a refresh URL, MCP, a pipeline step)
-- and on whichever pod (src/server/subscriptions/alertPosts.ts). The INSERT is
-- the claim, made right before that event's own post; rows older than 30 days
-- are deleted by the next claim in the org.
CREATE TABLE alert_posts (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  event_id   uuid        NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, event_id)
);
CREATE INDEX alert_posts_age ON alert_posts (org_id, claimed_at);

-- A member named in a comment or a reply: Home's "Mentioned you". No text is
-- copied here: Home reads the comment as it is now, so an edit or a delete is
-- never shown stale, and a member who lost access to the project sees nothing
-- of it. The INSERT … ON CONFLICT DO NOTHING is also the gate: a push and an
-- email go out only when it inserted, so removing and re-adding a mention never
-- notifies twice. At most 200 rows per member (src/server/mentions/store.ts).
CREATE TABLE mentions (
  org_id     text        NOT NULL,
  user_email text        NOT NULL,   -- who was mentioned
  piece_id   uuid        NOT NULL,   -- the comment (its own body) or the reply that names them
  project_id uuid        NOT NULL,
  comment_id uuid        NOT NULL,   -- the thread
  author     text        NOT NULL,   -- who wrote it: an email, as comments.json keeps authors
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at    timestamptz,
  PRIMARY KEY (org_id, user_email, project_id, piece_id)   -- ids repeat across projects after a bundle import
);
CREATE INDEX mentions_inbox ON mentions (org_id, user_email, created_at DESC);

-- "Email me when someone mentions me" (Settings → You), on the membership row.
ALTER TABLE users ADD COLUMN mention_email boolean NOT NULL DEFAULT true;

ALTER TABLE alert_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY alert_inbox_org ON alert_inbox
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE alert_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_posts FORCE ROW LEVEL SECURITY;
CREATE POLICY alert_posts_org ON alert_posts
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentions FORCE ROW LEVEL SECURITY;
CREATE POLICY mentions_org ON mentions
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
