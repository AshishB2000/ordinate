// Shared folders inside an index query's WHERE (docs/team-folders/00-design.md D13): the caller's open folders are a
// parameter, and an item's folder is read from folder_items INSIDE the query, before any ranking or LIMIT — never a
// filter after the fact. ⌘K (../searchIndex), the Assistant's search (../assistantSearchIndex, its words and meaning
// queries) and the verified lookup (../verifiedIndex) build their conditions here. Pure SQL text, no import: recordFs
// imports those modules, so they may not import the resolver (./folders); the IPC layer hands them its answer
// (./folderGate `indexFolders`).
//
// A NULL parameter is a caller nothing restricts (an admin, a project with no folder besides Everyone): an unnamed
// statement is planned with its parameters, so the condition folds away and the query is today's.

/**
 * The folder of item `kind` `id` (SQL expressions; `org`, `project` the row's), or the project (Everyone) when never moved.
 * Qualify the row's columns: inside the subquery a bare `org_id` is folder_items' own.
 */
export const folderOf = (kind: string, id: string, org: string, project: string): string =>
  `coalesce((SELECT fi.folder_id FROM folder_items fi WHERE fi.org_id = ${org} AND fi.project_id = ${project} AND fi.kind = ${kind} AND fi.item_id = lower(${id})), ${project})`;

/**
 * The row's dataset (`id`, an SQL expression) is in one of the folders `open` (a uuid[] parameter) — or `open` is NULL, or
 * the row has no dataset (a source table: project-level, not foldered).
 */
export const opensDataset = (id: string, open: string, org: string, project: string): string =>
  `(${open}::uuid[] IS NULL OR ${id} IS NULL OR ${folderOf("'dataset'", id, org, project)} = ANY(${open}::uuid[]))`;

/** Every dataset of `ids` (an SQL text[] expression) is in one of the folders `open`, or `open` is NULL: a verified SQL question's reads. */
export const opensAll = (ids: string, open: string, org: string, project: string): string =>
  `(${open}::uuid[] IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(${ids}) AS r(id) WHERE ${folderOf("'dataset'", 'r.id', org, project)} <> ALL(${open}::uuid[])))`;

/**
 * ⌘K's rows (0022; anchors 0034) the caller may see. Nothing restricts them (`open` NULL): the row's audience among
 * `audiences`, as before. Otherwise the anchor decides: a dataset's rows when it is open; a dashboard's when it is open,
 * the draft's row where they edit its folder (`edit`) and the published copy's elsewhere (D8), and what follows it (a
 * report, an alert: audience 'all') at either level; a connection's
 * (`project`) and a report without a dashboard (`many`, checked by id after ranking) by audience alone. A NULL anchor
 * (a row an older pod wrote) is never returned.
 */
export const searchRowShown = (audiences: string, open: string, edit: string, t = 'search_entries'): string => {
  const ds = folderOf("'dataset'", `${t}.anchor_id`, `${t}.org_id`, `${t}.project_id`);
  const board = folderOf("'dashboard'", `${t}.anchor_id`, `${t}.org_id`, `${t}.project_id`);
  const aud = `${t}.audience`;
  return `((${open}::uuid[] IS NULL AND ${aud} = ANY(${audiences}::text[]))
    OR (${open}::uuid[] IS NOT NULL AND (
      (${t}.anchor_kind IN ('project', 'many') AND ${aud} = ANY(${audiences}::text[]))
      OR (${t}.anchor_kind = 'dataset' AND ${aud} = ANY(${audiences}::text[]) AND ${ds} = ANY(${open}::uuid[]))
      OR (${t}.anchor_kind = 'dashboard' AND ${board} = ANY(${open}::uuid[])
          AND (${aud} = 'all' OR ${aud} = CASE WHEN ${board} = ANY(${edit}::uuid[]) THEN 'editor' ELSE 'viewer' END)))))`;
};
