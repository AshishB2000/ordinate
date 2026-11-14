-- The Assistant's conversations as rows (docs/assistant-threads/00-design.md): one per
-- conversation, one per turn. Before this, every member's conversations in a project were ONE
-- record, projects/<id>/copilot.json (0007), read and rewritten whole on every turn.
--
-- No data moves here. Under forced RLS this migration, run as the app's ordinary role with no
-- `ordinate.org`, sees no `records` row at all. src/ai/copilotRows.ts moves a project's
-- copilot.json into these rows the first time a pod of this release touches that project's
-- conversations, under the record's lock, then deletes the record.
--
-- Additive only: two new tables and a sequence. org_id is text, as in 0007; forced row-level
-- security as in 0020 (`ordinate.org` set per transaction).
--
-- Ids are the app's randomUUID(). A conversation id is unique within its project only (every
-- desktop v1 file migrated into the same fixed id), so project_id is in every key.
-- `touched` is the order a member's conversations were last created or appended to, as the
-- file's array order was: it breaks an updated_at tie (two writes in one millisecond) and picks
-- what the 50-per-member cap drops. `owner` is NULL for a desktop import's conversation, which
-- belongs to nobody on a server. A turn's `body` is the JSON of its other fields (provenance,
-- answer, suggest, learn, savedVisualId, guidance), sanitized again on every read. Text, not
-- jsonb: jsonb refuses \u0000 inside a string.

CREATE SEQUENCE assistant_threads_touched;

CREATE TABLE assistant_threads (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  id         uuid        NOT NULL,
  owner      text,
  title      text        NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  touched    bigint      NOT NULL DEFAULT nextval('assistant_threads_touched'),
  PRIMARY KEY (org_id, project_id, id)
);
ALTER SEQUENCE assistant_threads_touched OWNED BY assistant_threads.touched;
-- A member's conversations in a project, newest first.
CREATE INDEX assistant_threads_mine ON assistant_threads (org_id, project_id, owner, updated_at DESC, touched DESC);

CREATE TABLE assistant_turns (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  thread_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  seq        integer     NOT NULL,
  role       text        NOT NULL CHECK (role IN ('user', 'assistant')),
  text       text        NOT NULL,
  created_at timestamptz NOT NULL,
  body       text        NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, project_id, thread_id, id),
  FOREIGN KEY (org_id, project_id, thread_id) REFERENCES assistant_threads (org_id, project_id, id) ON DELETE CASCADE
);
-- A turn's place in its conversation: one number each, given out as the conversation's highest + 1
-- under its row lock. Unique here as well, so a writer that skipped the lock fails rather than
-- numbering two turns alike; and a conversation's turns, and the 200-turn cap, read in this order.
CREATE UNIQUE INDEX assistant_turns_seq ON assistant_turns (org_id, project_id, thread_id, seq);

ALTER TABLE assistant_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_threads_org ON assistant_threads
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE assistant_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_turns_org ON assistant_turns
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
