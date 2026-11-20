-- Knowledge documents for the Assistant (docs/knowledge-docs/00-design.md): reference text an editor attaches to a
-- project or to one Assistant agent, split into passages, of which an ask reads the few that match its question.
--
-- Numbered 0042 on purpose: Ordinate in Slack (0041_slack.sql) merges first, and the runner refuses a new file
-- numbered below one already applied. A database that has applied 0040 reaches 0042 with no 0041 in between.
--
-- knowledge_docs: one row per document. org_id is text, as in 0007; ids repeat across orgs after an import, so the key
--   is (org_id, id). agent_id is null for a project document. `text` is what the Assistant reads and the editor sees
--   (the original file is not kept); text_hash is its sha256, with updated_at the edit-conflict tag's inputs.
-- knowledge_passages: the document cut into passages (src/knowledge/split.ts), rewritten in the SAME transaction as the
--   document row, so a passage never outlives or lags its document (ON DELETE CASCADE does the rest). The three word
--   lists are src/ai/modelWords.ts `searchWords` of the document's title, the passage's heading path and its text;
--   `words` is their union, so a passage found by its title alone is still a candidate (`words && $1`, GIN).
--   Computed by the app, never by Postgres, so the pure ranking (src/knowledge/rank.ts) and the index agree.
--
-- Forced row-level security, as 0026 and 0041: a statement sees a row only inside a transaction that set
-- `ordinate.org` to its org (src/server/db/inOrg.ts). A superuser or BYPASSRLS role skips RLS: run the app as an
-- ordinary role.
--
-- Additive only: two new tables.

CREATE TABLE knowledge_docs (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  id         uuid        NOT NULL,
  agent_id   uuid,
  title      text        NOT NULL,
  source     text        NOT NULL CHECK (source IN ('typed', 'markdown', 'text', 'pdf', 'docx')),
  file_name  text,
  chars      integer     NOT NULL,
  text       text        NOT NULL,
  text_hash  text        NOT NULL,
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The sweep (src/knowledge/lifecycle.ts): since when the project or agent this belongs to was DEFINITELY not found; null
  -- while it is found or unknown (a read that failed). A document is deleted only a day after that, any pod's sweep.
  missing_since timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX knowledge_docs_project ON knowledge_docs (org_id, project_id, agent_id);

CREATE TABLE knowledge_passages (
  org_id        text    NOT NULL,
  project_id    uuid    NOT NULL,
  doc_id        uuid    NOT NULL,
  agent_id      uuid,
  ord           integer NOT NULL,
  title_words   text[]  NOT NULL,
  heading_words text[]  NOT NULL,
  text_words    text[]  NOT NULL,
  heading       text    NOT NULL,
  text          text    NOT NULL,
  words         text[]  NOT NULL,
  PRIMARY KEY (org_id, doc_id, ord),
  FOREIGN KEY (org_id, doc_id) REFERENCES knowledge_docs (org_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_passages_words ON knowledge_passages USING GIN (words);
CREATE INDEX knowledge_passages_project ON knowledge_passages (org_id, project_id, agent_id);

ALTER TABLE knowledge_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_docs FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_docs_org ON knowledge_docs
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE knowledge_passages ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_passages FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_passages_org ON knowledge_passages
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
