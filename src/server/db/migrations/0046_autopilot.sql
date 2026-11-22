-- Autopilot phases 2 to 4 (docs/autopilot/00-design.md): the per-project settings, the weekly runs and the report's rows.
-- Phase 1 (0044) only watched; this acts. Nothing here holds a figure or a person's rows: names are chart names.
--
-- autopilot_settings: one row per project. `enabled` is off by default. `run_as` is the org admin who switched it on: every run
--   acts as them, checked again at the start of the run (src/server/autopilot/run.ts). `paused_reason` is set when they lost it.
-- autopilot_runs: one row per run. A SCHEDULED run has `week` (the UTC Monday) and the partial unique index below makes
--   "two servers never run the same week twice" a fact of the table: the claim is an INSERT ... ON CONFLICT DO NOTHING.
--   A manual "Run now" has no week. A claim left `running` is retaken after 30 minutes (a crashed pod).
-- autopilot_items: the rows of a run's report, with what Undo needs.
--
-- Additive only: three new tables, forced row-level security as in 0012, 0035 and 0044.

CREATE TABLE autopilot_settings (
  org_id         text        NOT NULL,
  project_id     uuid        NOT NULL,
  enabled        boolean     NOT NULL DEFAULT false,
  window_days    integer     NOT NULL DEFAULT 90 CHECK (window_days BETWEEN 30 AND 365),
  slow_ms        integer     NOT NULL DEFAULT 5000 CHECK (slow_ms BETWEEN 500 AND 600000),
  trash_unused   boolean     NOT NULL DEFAULT true,
  repair_renames boolean     NOT NULL DEFAULT true,
  run_as         text,
  paused_reason  text        CHECK (paused_reason IN ('lost_admin')),
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE autopilot_runs (
  org_id       text        NOT NULL,
  project_id   uuid        NOT NULL,
  id           uuid        NOT NULL,
  week         date,
  manual       boolean     NOT NULL DEFAULT false,
  state        text        NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'paused', 'failed')),
  ran_as       text,
  window_days  integer     NOT NULL,
  covered_from date,
  counts       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  PRIMARY KEY (org_id, id),
  CHECK ((manual AND week IS NULL) OR (NOT manual AND week IS NOT NULL))
);
CREATE UNIQUE INDEX autopilot_runs_week ON autopilot_runs (org_id, project_id, week) WHERE week IS NOT NULL;
CREATE INDEX autopilot_runs_project ON autopilot_runs (org_id, project_id, started_at DESC);

CREATE TABLE autopilot_items (
  org_id     text        NOT NULL,
  run_id     uuid        NOT NULL,
  seq        integer     NOT NULL,
  project_id uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('trashed', 'repaired', 'broken', 'slow')),
  visual_id  uuid        NOT NULL,
  name       text        NOT NULL,
  state      text        NOT NULL CHECK (state IN ('applied', 'listed', 'undone', 'failed')),
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  undo       jsonb,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, run_id, seq)
);
CREATE INDEX autopilot_items_visual ON autopilot_items (org_id, project_id, visual_id, kind);

ALTER TABLE autopilot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY autopilot_settings_org ON autopilot_settings
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE autopilot_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY autopilot_runs_org ON autopilot_runs
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE autopilot_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_items FORCE ROW LEVEL SECURITY;
CREATE POLICY autopilot_items_org ON autopilot_items
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
