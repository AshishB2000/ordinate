-- Evaluation suites (docs/eval-suites/00-design.md): thumbs on Assistant answers, saved test questions per agent, and the batch run
-- that checks them. A run is a row any pod may claim FOR UPDATE SKIP LOCKED under a lease and a heartbeat (the pattern of
-- 0043 research_runs); a late write from a pod whose lease was retaken matches no row (the owner column is the fence).
--
-- Row-level security is forced, as 0041 to 0043 do. A statement sees a row only inside a transaction that set
--   ordinate.org           the org's own rows
--   ordinate.evals_scope   'system': the worker's claim and the sweeps, across orgs (the run, suite, case and result tables only)
-- Without one, no row. A superuser or BYPASSRLS role skips RLS: run the app as an ordinary role.
--
-- What each table holds, and what it never does:
--   assistant_feedback  one row per rated answer turn. A thumbs-DOWN row keeps the QUESTION text for the editors' inbox (the owner's
--                       answer to Q1); never the answer's words or a figure. Built for the issues board to count per project and week.
--   eval_results        `reply` (the answer's words) and `why` (the judge's line) are read only by the person who ran it
--                       (src/server/evals/view.ts); no ledger, no card, no row of data.
--
-- Additive only: new tables, and a new column with a default.

-- A conversation a suite run asks in: never listed, never "the caller's latest" (src/ai/copilotRows.ts).
ALTER TABLE assistant_threads ADD COLUMN hidden boolean NOT NULL DEFAULT false;

CREATE TABLE assistant_feedback (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  turn_id    text        NOT NULL,                          -- text, as research_runs.turn_id: the contract's id is a bounded string
  thread_id  uuid        NOT NULL,
  owner      text        NOT NULL,                          -- who asked, and rated
  agent_id   uuid,                                          -- null: the Project assistant
  value      text        NOT NULL CHECK (value IN ('up', 'down')),
  reason     text        CHECK (reason IN ('wrong_number', 'wrong_data', 'didnt_answer', 'other')),
  question   text,                                          -- a thumbs-down only; null once its conversation is gone
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,                                   -- an editor added it to a suite or dismissed it
  handled_by text,
  PRIMARY KEY (org_id, turn_id)
);
CREATE INDEX assistant_feedback_week ON assistant_feedback (org_id, project_id, created_at DESC);
CREATE INDEX assistant_feedback_inbox ON assistant_feedback (org_id, project_id, created_at DESC) WHERE value = 'down' AND question IS NOT NULL AND handled_at IS NULL;

CREATE TABLE eval_suites (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  id         uuid        NOT NULL,
  name       text        NOT NULL,
  agent_id   uuid,                                          -- null: the Project assistant
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX eval_suites_project ON eval_suites (org_id, project_id, created_at);

CREATE TABLE eval_cases (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  suite_id   uuid        NOT NULL,
  id         uuid        NOT NULL,
  position   integer     NOT NULL,
  question   text        NOT NULL,
  expect     jsonb       NOT NULL,                          -- { compute?: AnswerSpec, refuse?: true, say?: string }
  source     text        NOT NULL CHECK (source IN ('verified', 'answer', 'inbox', 'typed')),
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, suite_id) REFERENCES eval_suites (org_id, id) ON DELETE CASCADE
);
CREATE INDEX eval_cases_suite ON eval_cases (org_id, suite_id, position);

CREATE TABLE eval_runs (
  org_id         text        NOT NULL,
  project_id     uuid        NOT NULL,
  id             uuid        NOT NULL,
  suite_id       uuid        NOT NULL,
  agent_id       uuid,
  started_by     text        NOT NULL,
  state          text        NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'partial', 'failed', 'stopped')),
  case_ids       jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- the suite's cases when it started, in order
  cases_total    integer     NOT NULL DEFAULT 0,
  cases_done     integer     NOT NULL DEFAULT 0,
  passed         integer     NOT NULL DEFAULT 0,
  failed         integer     NOT NULL DEFAULT 0,
  not_scored     integer     NOT NULL DEFAULT 0,
  model_calls    integer     NOT NULL DEFAULT 0,
  version        jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- what the Assistant was: hashes of its instructions and documents, its model and topic
  judge          text,                                      -- provider/model that judged (what resolved at the start), null: none judged yet
  judge_own      boolean     NOT NULL DEFAULT true,         -- the Assistant's own model judged (no Judge model was set)
  stop_requested boolean     NOT NULL DEFAULT false,
  attempts       integer     NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  deadline_at    timestamptz,
  finished_at    timestamptz,
  lease_owner    text,
  lease_until    timestamptz,
  error_code     text,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, suite_id) REFERENCES eval_suites (org_id, id) ON DELETE CASCADE
);
-- One queued or running run per project.
CREATE UNIQUE INDEX eval_runs_one_active ON eval_runs (org_id, project_id) WHERE state IN ('queued', 'running');
CREATE INDEX eval_runs_due ON eval_runs (state, lease_until) WHERE state IN ('queued', 'running');
CREATE INDEX eval_runs_suite ON eval_runs (org_id, suite_id, started_at DESC);

CREATE TABLE eval_results (
  org_id      text        NOT NULL,
  run_id      uuid        NOT NULL,
  case_id     uuid        NOT NULL,
  position    integer     NOT NULL,
  question    text        NOT NULL,                         -- a copy: the case may be edited or deleted later
  outcome     text        NOT NULL CHECK (outcome IN ('pass', 'fail', 'not_scored', 'error')),
  checks      jsonb       NOT NULL DEFAULT '[]'::jsonb,     -- [{ id, ok, code? }]
  judged      text        NOT NULL DEFAULT 'none' CHECK (judged IN ('none', 'scored', 'not_scored')),
  score       integer     CHECK (score BETWEEN 1 AND 5),
  calls       integer     NOT NULL DEFAULT 0,
  error_code  text,
  reply       text,                                         -- the answer's words: the runner's alone
  why         text,                                         -- the judge's line: the runner's alone
  dataset_ids jsonb       NOT NULL DEFAULT '[]'::jsonb,     -- what the answer read, for the closed-folder check
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, run_id, case_id),
  FOREIGN KEY (org_id, run_id) REFERENCES eval_runs (org_id, id) ON DELETE CASCADE
);

-- Admin -> AI: the judge's model; no row: the Assistant's own.
CREATE TABLE org_eval_settings (
  org_id         text        PRIMARY KEY,
  judge_provider text        NOT NULL,
  judge_model    text        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_feedback', 'org_eval_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (org_id = current_setting('ordinate.org', true))
      WITH CHECK (org_id = current_setting('ordinate.org', true))$p$, t || '_org', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['eval_suites', 'eval_cases', 'eval_runs', 'eval_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (org_id = current_setting('ordinate.org', true) OR current_setting('ordinate.evals_scope', true) = 'system')
      WITH CHECK (org_id = current_setting('ordinate.org', true) OR current_setting('ordinate.evals_scope', true) = 'system')$p$,
      t || '_scope', t);
  END LOOP;
END $$;
