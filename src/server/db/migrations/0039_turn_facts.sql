-- An Assistant answer keeps the datasets its facts were built from (`factsFrom` in 0023 `assistant_turns.body`, written by
-- src/ipc/copilot.ts `copilot:ask`; docs/team-folders/00-design.md, "The Assistant's history, as built"), so a prose
-- answer with no chart is hidden, with its question, from a caller a shared folder closes one of them to.
--
-- ordinate_turn_shows(body): 0034's `ordinate_turn_datasets` — its chart's, its "Did you mean" options' and its SQL
--   answer's datasets — and its `factsFrom`, so the conversation list counts, in its one query, only the turns such a
--   caller is shown, and leaves out a conversation none of whose turns is (src/ai/copilotRows.ts `listPage`, the rule of
--   src/ipc/turnsOpen.ts). A body that is no JSON shows none, as the app reads it. A turn stored before this release
--   has no `factsFrom`: its words stay, as before.
--
-- Additive: one function. 0034's stays, for a pod of the release before, which reads no `factsFrom` (it shows those
-- turns, as it did).

CREATE FUNCTION ordinate_turn_shows(body text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN ARRAY(
    SELECT v #>> '{}' FROM jsonb_path_query(body::jsonb, '$.answer.datasetId') AS v WHERE jsonb_typeof(v) = 'string'
    UNION ALL
    SELECT v #>> '{}' FROM jsonb_path_query(body::jsonb, '$.suggest.options[*].spec.datasetId') AS v WHERE jsonb_typeof(v) = 'string'
    UNION ALL
    SELECT v #>> '{}' FROM jsonb_path_query(body::jsonb, '$.sql.datasetIds[*]') AS v WHERE jsonb_typeof(v) = 'string'
    UNION ALL
    SELECT v #>> '{}' FROM jsonb_path_query(body::jsonb, '$.factsFrom[*]') AS v WHERE jsonb_typeof(v) = 'string');
EXCEPTION WHEN others THEN
  RETURN '{}'; -- not JSON: the app keeps such a turn without its other fields (copilotRows turnOf)
END $$;
