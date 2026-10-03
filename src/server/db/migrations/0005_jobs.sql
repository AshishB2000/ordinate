-- Scheduled jobs and cross-pod events (T5.4). src/server/jobs/.
--
-- `jobs`: one row per (org, kind, target) schedule. A pod CLAIMS a due row
-- (next_run_at <= now() and no live lease) with FOR UPDATE SKIP LOCKED, stamps
-- a lease (lease_owner + lease_until), heartbeats it while running, and on
-- finish moves next_run_at forward and clears the lease — only if it still
-- owns it. A pod that dies mid-run leaves next_run_at in the past; once
-- lease_until passes, another pod's claim retakes the row.
--
-- org_id is text, not a foreign key: `orgs` arrives with T3.2, and dev mode's
-- org is the literal `default`. target '' is "the whole org".

CREATE TABLE jobs (
  org_id           text        NOT NULL,
  kind             text        NOT NULL,            -- 'tick' (refresh/alerts/anomaly watch/pipelines/trash), later 's3:gc', …
  target           text        NOT NULL DEFAULT '',
  next_run_at      timestamptz NOT NULL,
  lease_owner      text,                            -- '<pod>/<claim uuid>' while running, else NULL
  lease_until      timestamptz,
  runs             bigint      NOT NULL DEFAULT 0,  -- finished runs (success or failure)
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_error       text,                            -- truncated message of the last failed run, NULL after a success
  PRIMARY KEY (org_id, kind, target)
);
CREATE INDEX jobs_due ON jobs (next_run_at);

-- Event bodies too big for a NOTIFY payload (Postgres caps it at 8000 bytes):
-- the publisher inserts the body here and NOTIFYs its id in the same statement;
-- receivers read it by id. Rows older than 5 minutes are deleted by the next
-- large publish. UNLOGGED: transient by design — a crash may truncate it, and
-- an event lost that way is the same as one sent while a tab was disconnected.
CREATE UNLOGGED TABLE event_payloads (
  id         uuid        PRIMARY KEY,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_payloads_created ON event_payloads (created_at);
