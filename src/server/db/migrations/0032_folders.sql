-- Shared folders inside a project (docs/team-folders/00-design.md, D1–D5): the folder tree, the team grants
-- on its top-level folders, and where each moved dataset or dashboard sits. src/server/authz/folders.ts reads
-- them; nothing writes them yet (the folder channels are E7, after a release with the readers, D22).
--
-- EVERYONE IS VIRTUAL. Its id is the project id; it has no row, no grant and cannot be restricted. An item
-- with no folder_items row is in Everyone, which every project member opens at their project role (D2), so
-- this migration needs no backfill and changes nothing anyone sees.
--
-- folders: parent_id NULL is a top-level folder (it carries the grants); the project id is a subfolder of
--   Everyone; anything else is a subfolder of that folder. `parent_folder` is the parent when it is a real
--   folder, so a foreign key refuses a parent in another project and the deletion of a folder that still
--   has subfolders. Depth, the 1,000-folder cap and "grants on top-level folders only" are the app's.
-- folder_grants: a team's level on a folder, `view` or `edit` (D5). Gone with the team or the folder.
-- folder_items: one row per moved item; `kind` is validated by the app (dataset, dashboard), so a later
--   placed kind needs no constraint change. A folder holding an item cannot be deleted (RESTRICT).
--
-- Additive only: three new tables. org_id is text, as in 0007; forced row-level security as in 0020
-- (`ordinate.org` set per transaction, src/server/db/inOrg.ts); ids compared in "C".

CREATE TABLE folders (
  org_id        text        NOT NULL,
  project_id    uuid        NOT NULL,
  id            uuid        NOT NULL CHECK (id <> project_id),
  parent_id     uuid,
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  share_figures boolean     NOT NULL DEFAULT true,
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  parent_folder uuid        GENERATED ALWAYS AS (NULLIF(parent_id, project_id)) STORED,
  PRIMARY KEY (org_id, project_id, id),
  FOREIGN KEY (org_id, project_id, parent_folder) REFERENCES folders (org_id, project_id, id)
);
CREATE UNIQUE INDEX folders_sibling_name
  ON folders (org_id, project_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE folder_grants (
  org_id     text NOT NULL,
  project_id uuid NOT NULL,
  folder_id  uuid NOT NULL,
  team_id    uuid NOT NULL,
  level      text NOT NULL CHECK (level IN ('view', 'edit')),
  PRIMARY KEY (org_id, project_id, folder_id, team_id),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, project_id, folder_id) REFERENCES folders (org_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX folder_grants_team ON folder_grants (team_id);

CREATE TABLE folder_items (
  org_id     text        NOT NULL,
  project_id uuid        NOT NULL,
  kind       text        COLLATE "C" NOT NULL,
  item_id    text        COLLATE "C" NOT NULL CHECK (item_id = lower(item_id)),
  folder_id  uuid        NOT NULL,
  moved_by   text        NOT NULL,
  moved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, kind, item_id),
  FOREIGN KEY (org_id, project_id, folder_id) REFERENCES folders (org_id, project_id, id) ON DELETE RESTRICT
);
CREATE INDEX folder_items_folder ON folder_items (org_id, project_id, folder_id);

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders FORCE ROW LEVEL SECURITY;
CREATE POLICY folders_org ON folders
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE folder_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY folder_grants_org ON folder_grants
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE folder_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_items FORCE ROW LEVEL SECURITY;
CREATE POLICY folder_items_org ON folder_items
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
