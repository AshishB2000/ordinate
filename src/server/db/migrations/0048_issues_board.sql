-- The data issues board (docs/issues-board/00-design.md): a weekly read of STORED Assistant answers finds where it struggled, groups the
-- same problem into one issue with a title and a suggested fix, and lets an editor propose a definition, send a ticket to Linear or Jira
-- Cloud, or resolve or ignore it. src/server/issues/ keeps these rows.
--
--   issue_settings       per project: the check is OFF until a project admin turns it on; when it last ran.
--   issues               one per cause. `key` is the cause (a missing name, a dataset, or the commonest question words); `tokens` the words of
--                        a words group, to join a later group to it. A resolved issue that gets a newer signal reopens. Hidden from the board
--                        until it holds three questions (the board's query, not a column).
--   issue_signals        one per (answer, kind of trouble). `question` is the asker's own words and `owner` who asked: the board shows the
--                        words (to an editor who may open the dataset) and counts the owners; a reply never names one. Never an answer's
--                        words, a figure or a row. The primary key makes a rerun, or an overlapping window, add nothing twice.
--   issue_tickets        the ticket an editor sent: one per issue and tracker.
--   tracker_integrations the org's Linear / Jira settings that are not secret. The TOKEN is in the secrets store (kind tracker.token), never here.
--
-- Additive only: new tables. org_id is text, as in 0007; forced row-level security on `ordinate.org`, as 0020. The weekly job runs inside the
-- org's own context, so no system scope is needed.

CREATE TABLE issue_settings (
  org_id      text        NOT NULL,
  project_id  uuid        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT false,
  enabled_by  text,
  last_run_at timestamptz,
  last_error  text,
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE issues (
  org_id     text        NOT NULL,
  id         uuid        NOT NULL,
  project_id uuid        NOT NULL,
  key        text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 400),
  tokens     text[]      NOT NULL DEFAULT '{}',
  kind       text        NOT NULL,
  title      text        NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  fix        text        NOT NULL DEFAULT '' CHECK (char_length(fix) <= 600),
  named      boolean     NOT NULL DEFAULT false,
  status     text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  status_by  text,
  status_at  timestamptz,
  reopened   integer     NOT NULL DEFAULT 0,
  proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX issues_key ON issues (org_id, project_id, key);
CREATE INDEX issues_project ON issues (org_id, project_id, status, updated_at DESC);

CREATE TABLE issue_signals (
  org_id        text        NOT NULL,
  project_id    uuid        NOT NULL,
  turn_id       text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('needs_link', 'needs_copy', 'undefined_name', 'refused', 'outside', 'untraced', 'thumbs_down', 'asked_again')),
  issue_id      uuid        NOT NULL,
  reason        text,
  label         text,
  question      text        NOT NULL CHECK (char_length(question) BETWEEN 1 AND 4000),
  owner         text        NOT NULL,
  dataset_ids   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  dashboard_ids jsonb       NOT NULL DEFAULT '[]'::jsonb,
  at            timestamptz NOT NULL,
  PRIMARY KEY (org_id, project_id, turn_id, kind),
  FOREIGN KEY (org_id, issue_id) REFERENCES issues (org_id, id) ON DELETE CASCADE
);
CREATE INDEX issue_signals_issue ON issue_signals (org_id, issue_id, at DESC);

CREATE TABLE issue_tickets (
  org_id   text        NOT NULL,
  issue_id uuid        NOT NULL,
  provider text        NOT NULL CHECK (provider IN ('linear', 'jira')),
  ref      text        NOT NULL,
  url      text        NOT NULL,
  sent_by  text        NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, issue_id, provider),
  FOREIGN KEY (org_id, issue_id) REFERENCES issues (org_id, id) ON DELETE CASCADE
);

CREATE TABLE tracker_integrations (
  org_id       text        NOT NULL,
  provider     text        NOT NULL CHECK (provider IN ('linear', 'jira')),
  settings     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  connected_by text        NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['issue_settings', 'issues', 'issue_signals', 'issue_tickets', 'tracker_integrations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (org_id = current_setting('ordinate.org', true))
      WITH CHECK (org_id = current_setting('ordinate.org', true))$p$, t || '_org', t);
  END LOOP;
END $$;
