-- Metric proposals (docs/metric-proposals/00-design.md): a refused answer's missing metric or business term, drafted as
-- structure, queued for an editor, approved through the normal save. src/server/proposals/ keeps these rows.
--
-- metric_proposals: one row per need. `draft` is the structure the model wrote and the app checked (a name, a formula or
--   a column and aggregation, a description, other names; a term's filters), never a figure. `state`: open → approved |
--   declined. `decided_by` / `decided_at` set on an open row are an approval under way (a claim; a stale one, older than
--   ten minutes, may be taken again), so two approvers never save two metrics. `name_key` is the lower-cased name: the
--   partial unique index makes a repeat proposal raise the count of the open one instead of making a second card.
-- metric_proposal_asks: who needed it, by question. The question's words only, never the answer or a figure.
-- metric_proposal_inbox: the bell's rows: the approvers at open ('approver'), each asker once it is decided ('asker').
--   At most 200 a member.
--
-- Additive only: three new tables. org_id is text, as in 0007; forced row-level security on `ordinate.org`, as 0020.

CREATE TABLE metric_proposals (
  org_id     text        NOT NULL,
  id         uuid        NOT NULL,
  project_id uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('metric', 'term')),
  name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  name_key   text        NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 200),
  dataset_id uuid        NOT NULL,
  draft      jsonb       NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  state      text        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'declined')),
  decided_by text,
  decided_at timestamptz,
  edited     boolean     NOT NULL DEFAULT false,
  answer     text        NOT NULL DEFAULT '' CHECK (char_length(answer) <= 2000),   -- the decline's note
  saved_id   uuid,                                                                  -- the metric or term approval saved
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX metric_proposals_one_open ON metric_proposals (org_id, project_id, kind, name_key) WHERE state = 'open';
CREATE INDEX metric_proposals_project ON metric_proposals (org_id, project_id, state, created_at DESC);

CREATE TABLE metric_proposal_asks (
  org_id      text        NOT NULL,
  proposal_id uuid        NOT NULL,
  user_email  text        NOT NULL,
  qkey        text        NOT NULL,
  question    text        NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, proposal_id, user_email, qkey),
  FOREIGN KEY (org_id, proposal_id) REFERENCES metric_proposals (org_id, id) ON DELETE CASCADE
);
CREATE INDEX metric_proposal_asks_by ON metric_proposal_asks (org_id, user_email);

CREATE TABLE metric_proposal_inbox (
  org_id      text        NOT NULL,
  user_email  text        NOT NULL,
  proposal_id uuid        NOT NULL,
  project_id  uuid        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('approver', 'asker')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz,
  PRIMARY KEY (org_id, user_email, proposal_id),
  FOREIGN KEY (org_id, proposal_id) REFERENCES metric_proposals (org_id, id) ON DELETE CASCADE
);
CREATE INDEX metric_proposal_inbox_by ON metric_proposal_inbox (org_id, user_email, created_at DESC);

ALTER TABLE metric_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_proposals_org ON metric_proposals
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE metric_proposal_asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_proposal_asks FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_proposal_asks_org ON metric_proposal_asks
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE metric_proposal_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_proposal_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_proposal_inbox_org ON metric_proposal_inbox
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
