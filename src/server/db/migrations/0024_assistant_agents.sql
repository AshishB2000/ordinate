-- The Assistant agent each conversation belongs to (docs/assistant-agents/00-design.md, rule 11): an agent record's id
-- (projects/<id>/agents/<agent>.json). NULL is the Project assistant, which every conversation made before this was.
--
-- Additive only: one nullable column, no default and nothing backfilled. No foreign key: an agent is a record, not a
-- row, and a deleted one's conversations keep its id (they stay readable; a new question in one goes to the Project
-- assistant, and restoring the agent from the Trash brings it back).

ALTER TABLE assistant_threads ADD COLUMN agent_id uuid;
