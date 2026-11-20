-- Deep research (docs/deep-research/00-design.md): a background run of the Assistant that plans, runs engine-computed
-- steps one at a time and writes a report. A run is a row any pod may claim FOR UPDATE SKIP LOCKED under a lease and a
-- heartbeat (the pattern of 0041 slack_questions and src/server/jobs/runner.ts); a late finish from a pod whose lease was
-- retaken matches no row (the owner column is the fence).
--
-- Private to its starter: every research:* channel checks `started_by`. `steps` holds each step's spec, status and reason AND
-- its facts block and number ledger; the facts and ledgers never reach a browser (src/server/research/view.ts drops them).
--
-- Row-level security is forced, as 0041 and 0042 do. A statement sees a row only inside a transaction that set
--   ordinate.org             the org's own rows
--   ordinate.research_scope  'system': the worker's claim and the sweeps, across orgs
-- Without one, no row. A superuser or BYPASSRLS role skips RLS: run the app as an ordinary role.
--
-- Additive only: new tables.

CREATE TABLE research_runs (
  org_id          text        NOT NULL,
  project_id      uuid        NOT NULL,
  id              uuid        NOT NULL,
  started_by      text        NOT NULL,
  agent_id        uuid,                                     -- null: the default Assistant
  thread_id       uuid        NOT NULL,                     -- the Assistant conversation the run's turn is in
  turn_id         text,                                     -- that turn (its factsFrom is written when the run finishes)
  question        text        NOT NULL,
  state           text        NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'writing', 'done', 'partial', 'failed', 'stopped')),
  plan            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  steps           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  report          jsonb,
  story_id        uuid,
  stop_requested  boolean     NOT NULL DEFAULT false,
  steps_used      integer     NOT NULL DEFAULT 0,
  queries_used    integer     NOT NULL DEFAULT 0,
  attempts        integer     NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  deadline_at     timestamptz,
  finished_at     timestamptz,
  lease_owner     text,
  lease_until     timestamptz,
  error_code      text,
  -- "Add to project": a short lease on the work (the charts, then the Story) done OUTSIDE any row lock, the visual saved for each step so
  -- a retry saves none twice, and story_id set once, by the holder of the token.
  add_token       text,
  add_until       timestamptz,
  add_visuals     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (org_id, id)
);
-- One queued, running or writing run per person.
CREATE UNIQUE INDEX research_runs_one_active ON research_runs (org_id, started_by) WHERE state IN ('queued', 'running', 'writing');
CREATE INDEX research_runs_due ON research_runs (state, lease_until) WHERE state IN ('queued', 'running', 'writing');
CREATE INDEX research_runs_mine ON research_runs (org_id, project_id, started_by, started_at DESC);

-- An org's limits for a run (Admin -> AI); no row: the defaults (8 steps, 12 engine queries, 10 minutes). The ceilings are in code.
CREATE TABLE org_research_limits (
  org_id     text        PRIMARY KEY,
  steps      integer     NOT NULL CHECK (steps BETWEEN 1 AND 20),
  queries    integer     NOT NULL CHECK (queries BETWEEN 1 AND 30),
  minutes    integer     NOT NULL CHECK (minutes BETWEEN 1 AND 30),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['research_runs', 'org_research_limits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (org_id = current_setting('ordinate.org', true) OR current_setting('ordinate.research_scope', true) = 'system')
      WITH CHECK (org_id = current_setting('ordinate.org', true) OR current_setting('ordinate.research_scope', true) = 'system')$p$,
      t || '_scope', t);
  END LOOP;
END $$;
