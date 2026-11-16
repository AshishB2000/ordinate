-- Dashboard requests, the rest of E9 (docs/team-folders/00-design.md "Dashboard requests, as built"; 0037 made the
-- tables). src/server/requests/ keeps these rows.
--
-- state gains 'withdrawn': the requester took an open request back. Nothing was made; the approvers' bell rows go.
-- target_id: an existing dashboard the requester can open that the charts go onto (a new sheet of its draft), else
--   NULL: a new dashboard, as before.
-- folder_id: the folder the requester suggested for a new dashboard (one they open; the project id is Everyone), else
--   NULL. The approver sees it and may pick another; it is a suggestion, never where anything lands by itself.
-- dashboard_requests_open_by: the open requests of one person in one project, which the app caps.
--
-- Additive only: two nullable columns, an index, and a CHECK that accepts one more value. Widening the CHECK changes
-- no row; a pod of an older release never writes 'withdrawn', reads a withdrawn row as decided, and approves a row
-- with a target as a new dashboard.

ALTER TABLE dashboard_requests DROP CONSTRAINT dashboard_requests_state_check;
ALTER TABLE dashboard_requests ADD CONSTRAINT dashboard_requests_state_check CHECK (state IN ('open', 'drafted', 'approved', 'declined', 'withdrawn')) NOT VALID;
ALTER TABLE dashboard_requests ADD COLUMN target_id uuid;
ALTER TABLE dashboard_requests ADD COLUMN folder_id uuid;
CREATE INDEX dashboard_requests_open_by ON dashboard_requests (org_id, project_id, requester) WHERE state = 'open';
