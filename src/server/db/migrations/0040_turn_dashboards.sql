-- An Assistant answer keeps the dashboards it was asked about (`dashboardsFrom` in 0023 `assistant_turns.body`: the
-- dashboard page an ask's context named, written by src/ipc/copilot.ts `copilot:ask`, and the dashboard an alert
-- explained by src/ipc/alerts.ts is on; docs/team-folders/00-design.md, "The Assistant's history, as built"), so an
-- answer read off a dashboard in a folder a caller cannot open is hidden, with its question, though every dataset it
-- shows is open to them.
--
-- ordinate_turn_dashboards(body): its `dashboardsFrom`, so the conversation list's one query (src/ai/copilotRows.ts
--   `listPage`, the rule of src/ipc/turnsOpen.ts) counts the turns such a caller is shown beside 0039's datasets. A body
--   that is no JSON names none, as the app reads it. A turn stored before this release has none: it stays, as before.
--
-- Additive: one function. 0039's stays as it is, for a pod of the release before.

CREATE FUNCTION ordinate_turn_dashboards(body text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN ARRAY(SELECT v #>> '{}' FROM jsonb_path_query(body::jsonb, '$.dashboardsFrom[*]') AS v WHERE jsonb_typeof(v) = 'string');
EXCEPTION WHEN others THEN
  RETURN '{}'; -- not JSON: the app keeps such a turn without its other fields (copilotRows turnOf)
END $$;
