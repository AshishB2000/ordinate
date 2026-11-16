-- Dashboard requests (docs/team-folders/00-design.md D20, docs/assistant/00-design.md "Viewers request, editors
-- approve"): a viewer picks answers from their own conversation, a name and a note; the editors who can approve it
-- are told; one of them approves it (the dashboard is made then, and only then), opens it as a draft, or declines it
-- with a note; the viewer is told. src/server/requests/ keeps these rows.
--
-- dashboard_requests: one row per request. `charts` holds each answer's CHART FORM (its stored spec: dataset,
--   columns, filters, chart type, title), never a figure: the figures are computed at review, through the doors, under
--   the reviewer's access. `state`: open → approved | drafted | declined; drafted → approved at the dashboard's first
--   Publish. `decided_by` / `decided_at` set on an open row are an approval under way (a claim; a stale one, older than
--   ten minutes, may be taken again), so two approvers never make two dashboards.
-- dashboard_request_inbox: who was told, the bell's rows, as `mentions` and `editor_asks`: the approvers at send time
--   (`role` 'approver'), and the requester once it is decided ('requester'). At most 200 a member.
--
-- "Email me" is `users.request_email` (0033, off by default): the same switch Ask an editor uses.
--
-- Additive only: two new tables. org_id is text, as in 0007; forced row-level security on `ordinate.org`, as 0020.

CREATE TABLE dashboard_requests (
  org_id       text        NOT NULL,
  id           uuid        NOT NULL,
  project_id   uuid        NOT NULL,
  requester    text        NOT NULL,   -- an email, as `mentions.author`
  title        text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  note         text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  charts       jsonb       NOT NULL CHECK (jsonb_typeof(charts) = 'array' AND jsonb_array_length(charts) BETWEEN 1 AND 12),
  state        text        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'drafted', 'approved', 'declined')),
  decided_by   text,
  decided_at   timestamptz,
  answer       text        NOT NULL DEFAULT '' CHECK (char_length(answer) <= 2000),   -- the decline's note
  dashboard_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX dashboard_requests_open ON dashboard_requests (org_id, project_id, created_at DESC) WHERE state = 'open';
CREATE INDEX dashboard_requests_mine ON dashboard_requests (org_id, requester, created_at DESC);
CREATE INDEX dashboard_requests_drafted ON dashboard_requests (org_id, project_id, dashboard_id) WHERE state = 'drafted';

CREATE TABLE dashboard_request_inbox (
  org_id     text        NOT NULL,
  user_email text        NOT NULL,
  request_id uuid        NOT NULL,
  project_id uuid        NOT NULL,
  role       text        NOT NULL CHECK (role IN ('approver', 'requester')),
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at    timestamptz,
  PRIMARY KEY (org_id, user_email, request_id),
  FOREIGN KEY (org_id, request_id) REFERENCES dashboard_requests (org_id, id) ON DELETE CASCADE
);
CREATE INDEX dashboard_request_inbox_by ON dashboard_request_inbox (org_id, user_email, created_at DESC);
CREATE INDEX dashboard_request_inbox_request ON dashboard_request_inbox (org_id, request_id);

ALTER TABLE dashboard_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_requests_org ON dashboard_requests
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE dashboard_request_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_request_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_request_inbox_org ON dashboard_request_inbox
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
