-- Embedded Assistant (docs/embedded-assistant/00-design.md): an outside customer, with no account, asks an Assistant agent
-- through a token the host's backend signs (src/server/embed/askToken.ts).
--
--   embed_agents             which agents may be embedded, in which project, and per embeddable dataset the column every
--                            token must lock: datasets = [{ "id": "<dataset uuid>", "column": "<text column>" }].
--                            A marking is a claim: every ask checks the dataset's current record again.
--   embed_assistant_limits   Q4: questions per day for the org and per minute per customer. No row: the defaults in code.
--   embed_asks               one audit row per question whose token signature held: the customer's id (the token's `sub`),
--                            the agent and the outcome. Never the question, the answer or a filter value. Its own table:
--                            audit_log's action CHECK is not widened here.
--
-- Row-level security is forced on ordinate.org, as 0041 to 0043: a statement sees a row only inside a transaction that set
-- it (src/server/db/orgTx.ts inOrg). Without one, no row. A superuser or BYPASSRLS role skips RLS: run the app as an ordinary role.
--
-- Additive only: new tables.

CREATE TABLE embed_agents (
  org_id      text        NOT NULL,
  agent_id    uuid        NOT NULL,
  project_id  uuid        NOT NULL,
  datasets    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  enabled     boolean     NOT NULL DEFAULT true,
  updated_by  text        NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, agent_id)
);

CREATE TABLE embed_assistant_limits (
  org_id         text        PRIMARY KEY,
  daily_cap      integer     NOT NULL CHECK (daily_cap BETWEEN 1 AND 1000000),
  per_minute_cap integer     NOT NULL CHECK (per_minute_cap BETWEEN 1 AND 600),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE embed_asks (
  org_id    text        NOT NULL,
  id        uuid        NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  agent_id  uuid,
  customer  text        NOT NULL DEFAULT '',
  outcome   text        NOT NULL CHECK (outcome IN ('ok', 'denied', 'limited', 'refused', 'error')),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX embed_asks_recent ON embed_asks (org_id, at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['embed_agents', 'embed_assistant_limits', 'embed_asks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
      USING (org_id = current_setting('ordinate.org', true))
      WITH CHECK (org_id = current_setting('ordinate.org', true))$p$,
      t || '_scope', t);
  END LOOP;
END $$;
