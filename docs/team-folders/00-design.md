# Team folders, connection tables and dashboard requests — design (phase E)

Phase E of the [Assistant design](../assistant/00-design.md#build-order). Today a project is the
smallest thing Ordinate shares: everyone with a project role sees every dataset and dashboard in it.
This note adds **shared folders** inside a project, shared with **teams** at *Can view* or *Can
edit*; **connection tables** an admin ticks for a team, so its viewers can ask about warehouse
tables without a dataset; and **dashboard requests**, so a viewer asks, an editor approves and the
viewer is told. Every list, search and reader checks the item's folder, and a safety-net test holds
them to it, as row access rules have.

It builds on [row access rules](../row-policy/00-design.md) (the storage net and the reader
inventory), [column access](../semantic-layer/04-governance.md) (the canary sweep), the
[drafts model](../analysis/00-model.md)
(viewers read the published copy), [IdP groups](../sso-lifecycle/00-design.md) (teams come from the
IdP) and [notifications](../notifications/00-design.md) (mentions' push, Home row and email).
Measured on nothing yet: every number below is a count from the code at `aa86c9e4`.

## What you will see

- **A project admin** opens **Share → Folders** (or an org admin **Admin → Teams → Finance →
  Folders**), makes a top-level folder *Finance*, and gives team *Finance* **Can view** and team
  *Finance leads* **Can edit**. Nothing else changes: every existing dataset and dashboard is still
  in **Everyone in the project**, which every project member opens at their project role.
- **Data** and **Dashboards** get a folder rail on the left when the project has a folder besides
  Everyone: *Everyone in the project*, then the folders you can open, nested. An item's page shows a
  chip, *In Finance · Finance can view, Finance leads can edit*, which answers "why can I see this?".
- **Moving** an item (**Move to…**, or drag onto the rail) shows what changes before it happens:
  *Moving to Finance: Ops analysts (14 people) will lose access. It has a published link: everyone
  in the org can still open that page. 2 dashboards in other folders show its charts: their viewers
  keep seeing those charts.* **Move** / **Cancel**.
- **A viewer in Ops analysts** sees Everyone and Ops. Finance's datasets, dashboards, charts,
  metrics, terms, verified questions, comments and alerts do not exist for them: not in a list, not
  in ⌘K, not in the Assistant, not by guessing an id. A Finance dashboard they were linked to says
  *This is in a folder you can't open.*
- **A dashboard in Ops whose chart reads a Finance dataset** shows that chart to Ops viewers (row
  rules still apply). They can't open the dataset, see it in Data or ask the Assistant about it.
  Finance's admin can turn that off: **Finance → Settings → Dashboards in other folders may show
  this folder's data** (on by default).
- **An editor with only Can view on Finance** reads Finance's dashboards as a viewer does (the
  published copy) and cannot change, move or add anything there.
- **An admin** opens **Admin → Teams → Ops analysts → Tables**, ticks `ANALYTICS` on *Snowflake
  (prod)* (new tables included), unticks `ANALYTICS.PAYROLL`, ticks `SALES.CUSTOMERS` with
  *hide: email, phone*. Ops viewers can now ask the Assistant and Explore about those tables.
- **A viewer** whose answer they want to keep clicks **Request a dashboard**, picks answers from the
  conversation, a name and a note. Editors who can act on it get *Priya asked for a dashboard:
  Returns Q4 (2 charts)* on Home, in their open tabs, and by email if they turned it on. The review
  page shows the charts with today's figures and exactly what approving creates. **Approve and
  publish**, **Approve as a draft** or **Decline with a note**. Priya is told either way.

## How others do it, and what we took

| Tool | Model | Taken | Not taken |
|---|---|---|---|
| Metabase collections ([docs](https://www.metabase.com/docs/latest/permissions/collections)) | Groups get View, Curate or No access per collection; most permissive group wins; a root collection everyone starts in; data permissions kept apart from collections | Group-only grants, additive levels, a root folder, content apart from data (our connection tables) | Personal collections; sub-collections that keep their own grants after the parent changes |
| Lightdash spaces ([docs](https://docs.lightdash.com/references/workspace/spaces)) | Spaces *inherit* from the project or are *restricted* to invited groups and people; project admins see every space; nested spaces inherit | Everyone = an inheriting space; a restricted top-level folder; admins see all; nesting by inheritance | Per-space Full Access for non-admins; restricted nested spaces |
| Looker folders ([docs](https://docs.cloud.google.com/looker/docs/organizing-spaces)) | View or Manage Access, Edit per folder; subfolders inherit by default; a Shared root | Two levels; inherit by default | Delegated "manage access" (open question 2) |
| Superset `DASHBOARD_RBAC` ([docs](https://superset.apache.org/docs/security/)) | A role given a dashboard can read the charts and datasets on it without dataset permissions | **Reach**: a dashboard you can open shows its datasets' figures | Dashboards without roles falling back to dataset access |

Metabase and Lightdash refuse a dashboard card whose question or chart is in a space you can't open.
The Assistant design already chose the Superset behaviour ("a dashboard shows its numbers to anyone
who can open it"), so a dashboard never shows a hole where a chart used to be. The per-folder switch
above is how a folder like HR gets Metabase's stricter behaviour.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Folders are Postgres rows, not records**: `folders`, `folder_grants`, `folder_items` (0032). Placement is a row keyed by item, not a field on the record. | Indexes filter by joining `folder_items` inside their query, so a move is one row and no index is rewritten. A record field would need every index rewritten on a move and every list to read every record. |
| D2 | **No `folder_items` row means Everyone in the project.** Everyone is virtual: its id is the project id, its access is always the caller's project role, and it cannot be restricted or deleted. | Upgrade needs no backfill and changes nothing. An older pod's new item lands in Everyone, which is today's behaviour. |
| D3 | **Placed kinds: datasets and dashboards.** Everything else follows a parent (table under *What lives where*). Reports, stories, scorecards, scenarios and notebooks follow **every** dataset they read: you see one only if you can open all of them. | One answer to "why can I see this?", as the Assistant design agreed. No folder picker on five more screens. Following *all* fails closed. |
| D4 | **Top-level folders carry the grants; subfolders inherit and have none.** Depth at most 5 below Everyone or a top-level folder; at most 1,000 folders per project; names 1–120 characters, unique among siblings regardless of case. Everyone may have subfolders (they inherit the project role). | Lightdash's restricted nested spaces and Metabase's sub-collections that keep their own grants are where "why can't I see this?" gets hard. A team needing a narrower set gets its own top-level folder. |
| D5 | **Grants are to teams, never to one person.** Levels: `view`, `edit`. A person's level on a top-level folder is the highest level of any team they are in, **capped by their project role** (viewer → view, editor → edit). No project role, no folder access. | The Assistant design: "an admin gives a team, never one person". Teams come from the IdP (0019), so a new hire just joins a group. A team of one is fine. |
| D6 | **Project admins and org admins open every folder** and are the only ones who create top-level folders, change grants, set the reach switch, or delete a top-level folder. There is no per-folder Manage level (open question 2). | Lightdash and Looker do the same for admins. "Who decides who sees Finance" stays one role. |
| D7 | **Folders restrict editors too.** A project editor sees Everyone (at edit) and the folders their teams were given. | Two teams of analysts in one project is the reason for folders. Unlike row rules (D4 there), an editor cannot route around a folder: every path that reads another dataset (SQL, Prepare joins and unions, compose, relationships, copies) goes through the storage net (D11). |
| D8 | **View level reads the published copy.** `readsPublishedOnly` becomes per dashboard: a caller below `edit` on the dashboard's folder reads the copy, whatever their project role. Edit level reads the draft. | One rule for "Can view": you see what was published, as a viewer does today. A project without folders behaves exactly as now. |
| D9 | **Reach.** A dataset is *reached* by a caller when a dashboard they can open read it at its last Publish (`published.reads`, frozen at Publish, D16), and the dataset's top-level folder allows it (`share_figures`, default true). A reached dataset gives **its name, columns and figures, and the rows behind a chart mark**, through the figure doors only. It is never listed, searched, opened on the Data page, explored or asked about. | The agreed behaviour, with a switch for folders that must stay closed. Freezing the set at Publish makes it a fact of what viewers were shown, not of whatever the doors read later. |
| D10 | **Reach is per dataset, not per request.** The doors cannot tell a dashboard's request from a crafted one (they take a `datasetId`, not a dashboard), so a reached dataset answers any figure question at the doors, under row rules. | The alternative, a dashboard id on every door contract, touches about 15 contracts and the web's runtime for no gain: a dashboard viewer already filters, drills and reads the rows behind marks. Putting a chart on a dashboard shares its dataset's figures with the dashboard's audience, and the Publish dialog says so (D16). |
| D11 | **A storage net behind the stores**, the row-policy D8 pattern. `getDataset` and `residentSource` throw `FolderError` for a dataset the caller cannot open, unless the current async scope is a figure scope that a door opened for exactly that reached dataset. `getDatasetMeta` returns `null` for a dataset neither open nor reached. | A reader the inventory missed refuses (a bug report) instead of leaking (a breach). |
| D12 | **Stores return `null` for an item the caller cannot open, as for a missing id.** Lists leave it out. The pages people bookmark (dashboard, dataset, story, report) ask `folder:of` when they find nothing, and say *This is in a folder you can't open* instead of "not found" when the item exists. | The drafts design already proved every reader handles a viewer's `null` dashboard (`test-dashboardDraftsViewer`). One channel says it, so no other reply differs from a missing id. It says that something exists, never what (a ceiling). |
| D13 | **Indexes filter inside the query.** ⌘K's `search_entries` gains an anchor per row; `assistant_search` and `verified_keys` already carry `dataset_id`. A caller's open folders are a query parameter, and an anti-join on `folder_items` drops rows anchored in a closed folder. A row with no anchor is never returned to a restricted caller. | The Scale rules: "Access is filtered inside the query." No list on the ask path. |
| D14 | **Security walks see the whole project.** `figureDatasets`, `upstreamIds`, `hiddenAnywhere`, `policyClosed`, the lineage graph behind a refusal, and the reach computation run inside `folders.wholeProject(fn)`, which turns off folder filtering for reads (never for replies). Its call sites are an allowlist in the safety net. | A folder-filtered walk would miss a row-policy dataset the caller cannot see and fail open. |
| D15 | **One refusal code, `folder`**, HTTP 409, with a machine `reason` and a catalog sentence (table under *Refusals*). The route maps `FolderError` as it maps `RowPolicyError`; a catch that turns an error into `[]` or `null` rethrows it; the web's `refusalOf` draws it in the same refusal state. | The row-policy shape, which the web already renders. |
| D16 | **Publish records what the copy reads** (`published.reads`: dataset ids) and **refuses to start sharing a dataset the publisher cannot open**: a dataset in the new `reads` that the publisher cannot open and the previous copy did not read is refused (`folder`, reason `publish`). The dialog lists the folders whose data the dashboard will show outside them. | Publishing is the moment a dataset's figures leave its folder. Nobody grants what they cannot see. |
| D17 | **Recipients and pushes narrow to who can open the anchor**: subscription and email recipients, alert pushes, refresh pushes, mention pickers and notices, request notices. Published `/p/` pages and signed embeds are unchanged: their audience is the link's. | A `/p/` page is a snapshot whose audience was chosen at Publish (resolves the Assistant design's open question; the move warning names the link). |
| D18 | **Writes check the item's folder at Edit**; creating needs Edit on the target folder. Saved visuals, metrics, terms and verified questions are written with Edit on their dataset's folder; adding a card to a dashboard needs its dataset open (view). New items land in the folder the request names, else their first parent dataset's folder (a copy, a SQL or composed dataset, a duplicate), else Everyone. | "Can edit: also add, change and move items in it." A derived dataset never leaks a restricted parent into Everyone. |
| D19 | **Connection tables are per team, per project, apart from folders** (`team_tables`, 0036). Nothing is ticked by default. They decide what a project **viewer** may ask about; editors and admins answer from every table, as in phase D. | Metabase keeps data access apart from collections. Tables are where data comes from; folders hold what people made. |
| D20 | **Dashboard requests are Postgres rows** (`dashboard_requests`, 0037) holding the answers' chart forms, never a figure. Nothing is created until an editor approves. | A request is a per-person item listed across projects by state, like a mention. "Nothing else is created yet" stays literally true, and no dashboard reader learns a card that points at a table with no dataset. |
| D21 | **No setting.** Readers are inert until a folder exists; the channels that make folders merge only after a release with the readers is tagged (D22). Nothing is ticked by default; request email is off until a person turns it on. | A flag would not make a rollback safe; release order does. |
| D22 | **The readers ship a release before the writers.** E1–E6 make every reader apply folders while nothing can create one; E7 (the folder channels and screens) merges after a release with E1–E6 is tagged. | The p4-01a pattern in `docs/server/upgrade.md`: a pod that cannot apply a folder must never run beside one that can make it. |

## The model

### Who can open what (the rule, in full)

```
level(caller, folder F) =
  manage                       org admin, or project admin (rank 3)
  min(cap, max over the caller's teams of their grant on root(F))
                               where cap = view for a project viewer, edit for a project editor
  cap                          when root(F) is Everyone (F = the project id, or under it)
  none                         otherwise (no grant, or no project role)

root(F)   = the nearest ancestor (or F) whose parent is NULL (a top-level folder) or the project id
level(caller, item)  = level(caller, folder of the item's anchor)
opens(item)          = level ≥ view
reaches(dataset D)   = not opens(D) and share_figures(root(folder(D)))
                       and some dashboard B with opens(B) has D in B.published.reads
```

Without Postgres there are no teams and no folders: everything is in Everyone, and the folder
channels answer *Folders need DATABASE_URL*, as sharing does. Desktop and self-check mode, the jobs'
system identity and org admins are never restricted (`ctx().user.role === 'admin'`, no query).

### What lives where

| Kind | Its access comes from | Notes |
|---|---|---|
| Dataset (extract, Live, input table, capture-made) | its own placement | a derived dataset defaults to its first parent's folder |
| Dashboard (`analysis` record) | its own placement | saved views, subscriptions, comments on it follow it |
| Visual, metric, glossary term, verified question | its dataset | a formula metric also needs every metric it names open |
| Catalog doc of a dataset or column, quality rule, snapshot, incremental state, Live profile | its dataset | |
| Alert rule | its dashboard when `createdFrom.analysisId` names one, else its dataset | as the Assistant design agreed |
| Report | its dashboard (`analysisId`), else every dataset it reads | |
| Story, scorecard, scenario, notebook, metric tree, capture thread | every dataset (or metric) it reads | a story block that is a dashboard counts as that dashboard |
| Relationship | both datasets open | |
| Version history, Trash entry, comment | the record it belongs to | a trashed item keeps its placement row until purged |
| Topic, agent | project-level records; their members are filtered to what the caller opens | topics stay not access control (D15, `src/api/topics.ts`) |
| Connection, source table doc, pipeline, boundary, theme, asset, instructions, settings | project-level, not foldered | p2-01 still decides what a viewer reads of a connection; a pipeline step naming a dataset the caller can't open reads *a dataset you can't open*, and editing such a pipeline is refused |

### Folders, items and moves

- **Create**: a top-level folder by a project admin; a subfolder by anyone with Edit on its parent.
  **Rename**: a top-level folder by a project admin; a subfolder with Edit on it. **Delete**: only an
  empty folder, Trash included (a foreign key refuses otherwise); the dialog offers *Move its 3 items
  to…* first. Deleting never moves items to a parent on its own: that could widen access.
- **Move** needs Edit on the item's current folder and on the destination (a project admin may move
  anything). Moving a dataset moves what follows it; moving a dashboard moves its views,
  subscriptions, alerts and comments. One transaction writes the `folder_items` rows; no index row
  changes (D1).
- **The move warning** is `folder:moveImpact`: the teams (and head count) who lose access, whether
  Everyone loses it, published links and embeds, subscription recipients who will stop receiving it,
  and dashboards elsewhere that reach a moved dataset (and whether `share_figures` keeps them). It
  returns a hash of that answer; `folder:move` takes the hash and refuses `move_changed` if access
  changed since (the edit-conflicts pattern), so the warning is what the person agreed to.
- **Bundles and backups** carry no folders. An import or a restore makes a new project whose only
  grant is its creator's, so everything in Everyone widens nothing. A project's deletion drops its
  folders, grants, placements, reach rows, team tables and requests, as `dropGrants` drops grants.

### What an admin sees

Project and org admins see every folder. In the rail, a folder none of their teams was given shows
a small lock and *Admin access*: they see it because they are an admin, and its members do not see
them there. **Share → Folders** lists each top-level folder with its grants, the people that adds up
to, and the reach switch. **Admin → Teams → <team>** shows, per project, the team's project role, its
folders and its tables; changes there go through the same project channels (an org admin is admin on
every project). There is no "view as" in phase E.

## Enforcement

### The resolver (`src/server/authz/folders.ts`)

`folderAccessOn(projectId)` → `{ all: true }` or `{ open, edit, viewOnly, shareFigures, noFolders }`
(folder id arrays, the project id standing for Everyone; `noFolders`: nothing can be placed, so no
placement query). The rule itself is the pure `accessFrom(projectId, rank, rows)`; `levelIn(access,
folderId)` and `levelOn(projectId, kind, id)` answer one folder or item. A folder deeper than 5, a broken
parent chain or an id that is no folder of the project resolves to `none` (admins still open it): a hide,
never a leak. Memoised per request in a `WeakMap` keyed by the request context (inner keys by `orgKey`
and caller), like `callerOn`; a database error throws (the request is refused), never falls back.

- Rank 3 (org or project admin, from the rank `authorize` seeded): `{ all: true }`, no query.
- Otherwise **one query** inside `inOrg`: every folder of the project with its parent, its reach
  switch and the caller's best team grant on it (a `LEFT JOIN folder_grants` on the caller's
  `team_members`). The tree is walked in the app. A project with no folders returns no rows, and
  every later check is answered from that without another query.
- `placementOf(projectId, kind, ids)` reads `folder_items` by id in one query, memoised per id.
  Lists read the project's placements in one query (at most the number of moved items).
- `reachOn(projectId, datasetIds)` (E5) runs only for datasets not open: one query over
  `dashboard_reads` joined to the dashboards' placements, memoised per id (needs the project's
  `dashboard_reads_built` marker, else rebuilds it first, as `assistant_search` does).
- `openerEmails(pool, org, projectId, anchor, min)` (`anchor` an item, `{ kind, id }`; it needs no
  request context, as a job asks) is `readerEmails`/`writerEmails` narrowed to the anchor's root folder,
  in one transaction (the placement, the tree when placed, then the emails): for Everyone exactly those
  two; for a top-level folder org admins, project admins, and members whose project role and some team's
  grant on that root both reach `min`; for an unresolvable folder admins only. `test-folderAccess` holds
  it `Object.is`-equal to the resolver for every anchor and level.

The per-request cost for a viewer or editor is one query, two when an item was moved, three when a
dashboard reaches a dataset. `test-askBudget`'s ceilings rise by at most one query for its restricted
viewer; its admin cases do not move.

### The stores (lists and reads by id)

Each store's list and by-id read becomes caller-aware, as `listAnalyses` and `getAnalysis` already
are for drafts, so every handler, the MCP tools and the jobs a request starts inherit it:
`datasets.listDatasets/getDatasetMeta`, `analysis.listAnalyses/getAnalysis` (per-dashboard audience,
D8), `visuals`, `metrics`, `terms`, `verifiedQuestions`, `reportSpec`, `stories`, `scorecards`,
`scenarios`, `captureRecord`, `alertStore` (rules and events), `comments`, `trashStore`,
`versions`, `catalog` (per-dataset parts), `relationships`, `topics.membersOf`, `recent`,
`starred`, `numbers` (followed metrics). Each filters records it has already read, with the
placements from one query, so no list reads more than it does today. The raw record reads stores use
for writes (`getStoredAnalysis`, `datasetRecord`) stay unfiltered and are reached only from write
paths that checked Edit first (D18).

### The doors and the storage net

- **The doors** (`vizDataFor`, `computeCardMetric`, `computeCard`, `pageFor`, `distinctFor`, the
  profile reader) call `folderGate(projectId, datasetId)` first, before the row lock, the Live split
  and every cache key: open → go on; reached → go on inside `withFigureScope(datasetId)`; neither →
  `FolderError('closed')`. The scope nests like the row lock's: a door for D inside a door for E may
  read only D. `pageFor` takes a flag from its caller: `visual:rows` and `visual:rowsDownload` pass
  `figures`, `dataset:page` passes `open`, so the grid on the Data page needs the dataset open.
- **The net**: `getDataset` and `residentSource` call `gateFolder` beside `gateRows` (above the
  as-of hooks and the publish memo). `getDatasetMeta` returns `null` for neither-open-nor-reached.
  Every other path that names another dataset (SQL `compile()`, Prepare `union` and `lookup_join`,
  compose, copy, relationships' match rates, fx rates) reads through these, so it refuses.
- **The Assistant and Explore** need the dataset open. Step 3's index drops reach-only datasets (they
  are in folders the caller cannot open), the answer validator never resolves a name to one, "Did
  you mean" never offers one, and a dashboard context leaves out its reach-only metrics. The answer
  snapshot check (`answerSnapshots`) adds openness to its fingerprint: a kept card on a dataset since
  moved away is recomputed under today's access, which refuses.

### Indexes: inside the query

| Index | Anchor | WHERE for a restricted caller |
|---|---|---|
| ⌘K `search_entries` (0022) | new `anchor_kind`, `anchor_id` (0034): a dataset or dashboard id; `project` for connections; `many` for reports, stories and alerts without a dashboard | `NOT EXISTS (placement of lower(anchor) in a folder <> ALL($open))`; a dashboard row's audience by level: `editor` rows where the folder is in `$edit`, `viewer` rows where it is in `$viewOnly`; `many` rows checked by id after ranking, a page at a time; `NULL` anchors (an older pod's row) never returned. `INDEX_VERSION` 3 rebuilds each source once. |
| Assistant `assistant_search` (0027) | `dataset_id` (a dataset's own id on its rows) | the same anti-join on `dataset_id`, in `rankedPage`, `foundItems` and `keyedItems`; table rows as today (`audience`) until E8 |
| Verified `verified_keys` (0026) | `dataset_id` | the same anti-join in the lookup and the examples' ranking |
| `countKinds`, `countModel` | as above | the counts are of what the caller can open (Home, `projects:overview`) |

The read-everything reference paths filter through the same caller-aware stores, so the
differential tests (`test-searchIndex`, `test-assistantSearch`, `test-verifiedIndex`) keep holding the
index to the reference, now per caller.

### Pushes, mentions and recipients (D17)

- `toReaders` gains an anchor: `alerts:fired` and quality pushes go to `openerEmails(anchor)`;
  `hub:dataset-refreshed` to those who open or reach the dataset; edit-conflict pushes to Edit-level
  openers.
- `comment:mentionable` lists current readers who can open the target; a mention of someone who
  cannot is refused like a non-reader; `mentions:list` drops rows whose target the caller can no
  longer open, read now, as it already re-reads the comment.
- Email and channel recipients are resolved at send time and intersected with `openerEmails` of the
  subscription's dashboard or the alert's anchor. The subscription dialog says *2 recipients can't
  open this dashboard and won't get it*. Slack and Teams channels are outside Ordinate's directory
  and unchanged.

### Publish, `/p/`, embeds and exports

`/p/` and embeds keep their audiences (D17). Publish records `reads` and refuses per D16. The
Publish and embed dialogs say *Everyone in the org with the link can open this page, including people
who can't open Finance* when the dashboard is outside Everyone. Exports (`dashboard:exportHtml`,
`story:export`, `report:*`) need the item open; their figures follow the dashboard's reach.

### MCP, API tokens and jobs

Agents and tokens act as their person (Assistant design). MCP tools call the same stores and doors,
so they are filtered and gated with no tool-specific code; the safety net calls every tool. A job
keeps the request context it was started in, so its folder access is its submitter's at submit time.

### Refusals

| `reason` | When | Sentence (catalog, `src/server/folderMessages.ts`: the i18n extractor's import fixes a sentence file at `src/<area>/`) |
|---|---|---|
| `closed` | an item, or a figure on a dataset, in a folder the caller cannot open | This is in a folder you can't open. |
| `figures_only` | a reader beyond the doors (grid, profile, stats, catalog, Explore, Assistant) on a reached dataset | You can see this dataset's charts on a dashboard, but the data itself is in a folder you can't open. |
| `edit` | a write in a folder the caller opens at view | You can view this folder but not change it. Ask someone who can edit it, or a project admin. |
| `publish` | D16 | This dashboard now shows data from a folder you can't open, so someone who can open it needs to publish it. |
| `move_changed` | the move hash no longer matches | Who can open these changed since you checked. Check again before moving. |
| `not_empty` | deleting a folder that holds items, Trash included | Move this folder's items out before deleting it. |

No sentence names a folder, team or item the caller cannot open.

## Readers, by area

The inventory of record is code: `scripts/folderReaders.ts` classifies **every `read` and `write`
contract** (208 and 170 at `aa86c9e4`) exactly once, in a table per access. `admin` contracts (66) are left out because
their callers open every folder, and the test asserts that rule. The classes:

| Class | Meaning | Examples |
|---|---|---|
| `LIST` | a list: items the caller cannot open are left out | `dataset:list`, `analysis:gallery`, `visual:list`, `metric:list`, `term:list`, `verified:list`, `story:list`, `scorecard:list`, `alerts:list`, `comment:list`, `trash:list`, `versions:list`, `recent:list`, `starred:get`, `catalog:list`, `relationship:list`, `home:overview`, `projects:overview` |
| `ITEM` | names an item: `null` or not found when closed; bookmarks get `closed` | `analysis:open`, `visual:get`, `metric:get`, `term:get`, `story:get`, `scorecard:get`, `catalog:get`, `lineage:get`, `topic:get` (members filtered) |
| `FIGURE` | a door, or the column names and types a chart needs: open or reached | `dataset:columns`, `visual:data`, `visual:dataBatch`, `visual:thumbs`, `visual:rows`, `visual:rowsDownload`, `visual:drillDown`, `analysis:tiles`, `dashboard:metric`, `metric:values`, `metric:table`, `dataset:distinct`, `scorecard:compute`, `metricTree:compute`, `summary:compute`, `answer:explain` |
| `OPEN` | dataset content beyond figures: open only | `dataset:page`, `dataset:profile`, `dataset:stats`, `catalog:columns`, `quality:*`, `snapshots:*`, `prepare:get`, `stats:*`, `drivers:*`, `segments:*`, `sql:*`, `explore:suggest`, `answer:card` |
| `INDEX` | a search over an index, filtered in its WHERE | `search:query`, `dataSearch:query` (skips closed datasets) |
| `ASK` | the Assistant: index-filtered facts, named items checked open | `copilot:ask`, `copilot:history`, `answer:rerun`, `answer:refresh` |
| `SEND` | builds what others receive: recipients narrowed, figures by reach | `subscription:preview`, `alerts:test`, `publish:plan` |
| `EXPORT` | a file of an item the caller opens | `dashboard:exportHtml`, `story:export`, `report:build`, `report:preview` |
| `OWN` | the caller's own state; item names in it filtered | `mentions:list`, `prefs:get`, `onboarding:*`, `tokens:*`, `jobs:list` |
| `PROJECT` | project-level, no folder | `connections:list` (p2-01 still applies), `themes:list`, `ai:status`, `boundary:*`, `calendar:today`, `catalog:instructions` |
| `EDIT` | a write on an existing item: Edit on its folder | `analysis:update`, `analysis:publish`, `visual:update`, `metric:update`, `dataset:update`, `dataset:refresh`, `dataset:delete`, `trash:restore` |
| `CREATE` | a write that makes an item: Edit on the target folder (D18) | `analysis:create`, `visual:save`, `metric:save`, `dataset:composeSave`, `dataset:parsePaste`, `connection:import`, `answer:saveVisual`, `model:importApply` |
| `FOLDER` | the folder and request channels, with their own rules | `folder:*`, `teamTables:*`, `request:*` |

A new contract is classified in the PR that adds it, with a comment saying how it is covered, as
`rowPolicyReaders.ts` asks. The rows above are the design-time intent; where they and the code
disagree, the code wins.

## The folder safety net (`scripts/test-folderSafetyNet.ts`)

Over the real RPC route, as real users with real grants, in a scratch Postgres, like
`test-rowPolicySafetyNet` and `test-columnAccessSafetyNet`. The world (`scripts/folderHarness.ts`):

- Project P with folders **Ops** (team Ops: view; team Ops leads: edit), **Finance** (team Finance:
  view; `share_figures` on), **HR** (no grants; `share_figures` off), and a subfolder **Ops/Returns**.
- In HR, canaries in every field a reply could carry: dataset `HRCANARY Salaries` with a column
  `hrcanary_salary` and a catalog note, a visual, a metric, a term, a verified question, a quality
  rule, a comment with a mention, an alert rule, a story, a scorecard, a dashboard `HRCANARY board`
  with a saved view and a subscription, a Trash entry and version history; the folder name itself.
- A Finance board reading Ops's `orders` (reach), an Everyone board reading HR's dataset (reach that
  `share_figures` off refuses), and plain Everyone items as controls.
- People: `boss` (org admin), `padmin` (project admin, no teams), `opsViewer`, `opsLead` (project
  editor in Ops leads), `opsEditorView` (project editor in team Ops: view only), `finViewer`, `ed`
  (project editor, no teams: Everyone only), `nobody` (no project role).

Sections, each with its negative control:

1. **Coverage** (no database): every `read` and `write` contract is classified; the table names no
   channel that is gone or changed access; every `admin` contract is reachable only at rank 3.
   NEGATIVE CONTROL: a planted contract is reported.
2. **The sweep**: every `read` contract with one payload each (naming HR's ids where it takes an
   id), called as `opsViewer`, `opsLead`, `finViewer` and `ed`: no reply carries an HR canary.
   NEGATIVE CONTROL: `padmin`'s replies do.
3. **By id**: every `ITEM` channel on an HR id answers exactly what it answers for a random unknown
   id (bodies compared with `Object.is` after the ids are swapped); only `folder:of` answers
   `closed`, and names nothing. NEGATIVE CONTROL: `padmin` gets the item.
4. **Figures and reach**: every `FIGURE` channel on HR's dataset refuses `closed` for `opsViewer`.
   On `orders`, `finViewer`'s reply through the Finance board's reach is `Object.is`-equal to
   `padmin`'s. Every `OPEN` channel on `orders` refuses `figures_only` for `finViewer`, and
   `dataset:list`, ⌘K and the Assistant never name it. The Everyone board's HR chart refuses for
   `ed` (switch off). NEGATIVE CONTROLS: a Finance board whose `reads` lacks `orders` (planted)
   refuses `finViewer`; turning HR's switch on answers `ed`.
5. **The net**: a planted reader calling `getDataset(HR)` in `opsViewer`'s request refuses
   `FolderError`; one reading HR inside a figure scope opened for `orders` refuses too. NEGATIVE
   CONTROL: the same reader as `padmin` reads.
6. **Indexes**: for each person, ⌘K, `searchModel`, `countModel` and the verified lookup from the
   index are `Object.is`-equal to the reference paths; HR's words find nothing outside HR.
   NEGATIVE CONTROLS: an index row with a `NULL` anchor (planted) is not returned to `opsViewer` but
   is to `padmin`; an anchor in another case is still filtered.
7. **Security walks**: `figureDatasets`, `upstreamIds`, `hiddenAnywhere` and `policyClosed` return
   the same sets for `opsViewer` as for `padmin`; every `wholeProject()` call site is on the
   allowlist. NEGATIVE CONTROL: the walk run without `wholeProject()` differs.
8. **Writes**: every `EDIT` channel on a throwaway HR item, as `opsLead`, refuses and leaves the
   record byte-identical; as `opsEditorView` on an Ops item, refuses `edit`; every `CREATE` naming
   HR refuses; a create with no folder lands in Everyone; a SQL dataset over an Ops dataset lands in
   Ops. NEGATIVE CONTROL: `opsLead`'s same calls on Ops items succeed.
9. **Pushes and sends**: events about HR items (an alert firing, a refresh, a mention, a
   subscription run, a request notice) reach only HR openers' streams and inboxes, and HR's
   subscription email resolves to no Ops address. NEGATIVE CONTROL: `padmin`'s stream gets them.
10. **MCP and model prompts**: every MCP tool as `opsViewer`, and every prompt the stubbed model is
    sent for `opsViewer`'s asks: no canary. NEGATIVE CONTROL: as `padmin`.
11. **Moves**: moving `orders` to HR closes it for `opsViewer` on the next request with no cache to
    clear; the impact lists Ops analysts and Ops leads; a move with a stale hash refuses
    `move_changed`. NEGATIVE CONTROL: moving back reopens it.

Next to it: `test-folderAccess` (the resolver: every row of the rule above, caps, inheritance,
Everyone, admins, without a database; with one, the note's people through forced RLS, `openerEmails`
against the resolver, no folders against `authorize`'s rank, the memo and the constraints), `test-dashboardReads` (D16, below), and `test-dashboardDraftsViewer`
extended with `opsEditorView` (an editor at view level reads only published copies).

## Reach, as built (D9, D16)

- `publishedReads(projectId, copy)` is a narrowing of `datasetsOfRoot`: every id under a
  `…datasetId(s)` key of the copy (whose visual cards are frozen inline), the datasets of every
  metric a card names (formula operands followed to depth 16), and each frozen definition's join
  plan reads (`joinPlan.planReads`). No lineage climb (a refresh reads parents as the system) and no
  relationship walk beyond the plan. `analysis:publish`, the scheduled re-publish and the Ready
  migration store it as `published.reads`; `sanitizePublished` keeps it.
- `dashboard_reads` (0035) is derived from that field by a pure describer in the record's write
  transaction, the 0022 pattern. A write by a pod that does not set `ordinate.folders = 'on'` fires
  a trigger that deletes that dashboard's rows and the project's marker, so an older pod can only
  narrow reach. A copy without `reads` (published before this) is computed when the marker is
  rebuilt; the rebuild never writes the record.
- `folder:move` of a dataset out of Everyone waits for the project's marker (it builds it first), so
  no dashboard loses a chart because its reach was not indexed yet.
- **`test-dashboardReads`**: for a corpus of dashboards (visual, metric, formula metric, KPI, related
  column, control, stats card, scorecard and metric-tree cards), every dataset the doors touch while
  rendering the published copy, recorded by the fan-out scope's recorder, is in `reads`, and `reads`
  holds nothing the copy does not name (`Object.is` on the sorted lists). NEGATIVE CONTROL: dropping
  one id from `reads` refuses that tile for `finViewer`.

## Connection tables per team

### The model

`team_tables` rows (0036), per project, team and connection: a **schema** row (all its tables,
those added later included) or a **table** row (the schema and name exactly as `listTables` returns
them), each **include** or **exclude**, and on an include table row the **hidden columns**. A table
is given to a team when it has an include table row, or an include schema row and no exclude table
row; a table row always wins over its schema row. A person's tables are the union over their teams.
A column is hidden from them only if every team row that gives them the table hides it (most
permissive wins, as Metabase's groups add up). Nothing is ticked by default; a team with no project
role gets nothing from its ticks.

### Who it affects

| | Editors and admins | Viewers |
|---|---|---|
| Step 3 search of source tables | every table (phase D) | only given tables: their index rows gain keys `t:<conn>/<table>` and `s:<conn>/<schema>` (0028's `keys`, `ASSISTANT_SEARCH_VERSION` bump), matched with `keys && $given` |
| Answers and Explore from a table (phase D's in-memory Live target) | every table on a live-capable connection | given tables only, hidden columns removed by the column gate (`gateColumns`, as a synthetic column rule), Live cost limits as for anyone |
| SQL on source tables (phase F) | every table | `FROM` limited to given tables; hidden columns not selectable (F's design applies them in the warehouse) |
| Names | as today | a given table only under the **label an editor wrote** for viewers on its source table doc; until it has one, it is not offered to viewers at all. Never its name or any part of it, schema, database, host, connection address or SQL (decided: open question 1); unticked tables not even by name (p2-01) |

Row rules do not exist on a table: the tick dialog says *Everyone in this team sees every row of
these tables. To limit rows, make a dataset and give it row access rules.*

### Channels and screen

`teamTables:get` and `teamTables:set` (`admin`, project-scoped; at most 2,000 rows a team and
connection), the tree from `connection:listTables`. **Admin → Teams → <team> → Tables** and **Share
→ Folders → Tables** show the same tree: connections, schemas with a tick that includes new tables,
tables with a tick and a *Hide columns* picker (from `connection:describe`). In phase E before D has
merged, E8 ships the rows, the screen and the index filter; the viewer answer path lands with D.

## Dashboard requests

### The flow

1. **Request** (`request:create`, `read`, audited, as `comment:add` lets viewers write): the caller
   picks 1–12 answers from their own conversations (turn ids, checked against `assistant_threads.owner`),
   a name, an optional note (≤ 2,000 characters) and a target: a new dashboard, or an existing one
   they can open. Allowed to anyone who cannot keep the answer themselves: a viewer, or an editor at
   view level on the dataset's folder (the *Request a dashboard* button replaces *Add to
   dashboard*). At most 20 open requests per person per project.
2. **Stored, nothing built**: one `dashboard_requests` row with each answer's chart form as the turn
   kept it (a source table target, a SQL statement marked Not checked), never a figure.
3. **Told**: the approvers are editors and admins with Edit on the request's folder (where it was
   asked from, else Everyone) and on the folder of every existing dataset its charts use. They get a
   push (`requests:changed`), a Home row and, if they turned it on (**Settings → You → Email me
   about dashboard requests**, off by default), an email through `deliver` with the budget kind
   `request` (per author and per recipient per hour, as mentions).
4. **Review** (`request:preview`, `write`): the charts computed through the doors as the editor,
   and the list of what approving creates: each Live dataset (from which table), each link, each
   chart written as SQL (Not checked), the dashboard, the folder. *Priya sees fewer rows: row
   access rules apply to her* when they do.
5. **Decide**: **Approve and publish** or **Approve as a draft** (`request:approve`: `folderId`
   among those where the approver has Edit and the requester can open) creates exactly the preview's
   list (the same function builds both), places it, and publishes or not. On an existing dashboard
   the charts go onto a new sheet *Requested by Priya*; if its draft has unpublished edits, it is
   never published by the approval, and the editor is told why. **Decline**
   (`request:decline`) needs a note. The requester may **Withdraw** (`request:withdraw`) while open.
6. **The requester is told**: *Your dashboard Returns Q4 is ready* with the link, or the note; a
   draft approval tells them when it is first published.

### States

`open` → `approved` | `drafted` | `declined` | `withdrawn`; `drafted` → `approved` on the
dashboard's first Publish. An open request whose requester lost access to the project, or whose
answers' datasets left their reach, shows as *No longer available* and can only be declined.

### Channels

| Channel | Access | Who |
|---|---|---|
| `request:create`, `request:withdraw` | read | the requester |
| `request:list` | read, org | the caller's own requests and those they can approve, across projects they read (`visible`) |
| `request:get` | read | the requester or an approver |
| `request:preview`, `request:approve`, `request:decline` | write | an approver (step 3) |

`test-dashboardRequests`: the states and who is told; the preview's list `Object.is`-equal to what
approval created; a declined or withdrawn request creates nothing; the limits; a viewer cannot name
someone else's turn. E2E `requests.e2e.ts`: a viewer requests, an editor approves, the viewer opens
the dashboard from Home.

## Migrations

Numbers are the next free ones when each PR lands: 0029 was the last on `develop` and 0030–0031 went to
other open PRs, so E1 took 0032 and the rows after it are provisional. All additive, forced
row-level security on `ordinate.org` like 0020 and later, org ids `text`, ids compared in "C".

| Migration | What |
|---|---|
| 0032 `folders` (E1, as built) | `folders (org_id, project_id, id, parent_id NULL, name, share_figures bool default true, created_by, created_at)`, `id <> project_id`, names 1–120 characters, and a generated `parent_folder` (= `NULLIF(parent_id, project_id)`) with a foreign key to the parent, so a parent in another project and deleting a folder that has subfolders are refused (a whole subtree goes in one statement); a unique index on `(org_id, project_id, coalesce(parent_id, <the zero uuid>), lower(name))`; `folder_grants (org_id, project_id, folder_id, team_id, level CHECK IN ('view','edit'))`, PK `(org_id, project_id, folder_id, team_id)`, an index by team, with `(team_id, org_id)` → `teams` ON DELETE CASCADE and → `folders` ON DELETE CASCADE; `folder_items (org_id, project_id, kind, item_id text, folder_id, moved_by, moved_at)`, PK `(org_id, project_id, kind, item_id)`, `item_id` lowercase-checked, → `folders` ON DELETE RESTRICT; an index on `(org_id, project_id, folder_id)` |
| 0033 `editor_asks` (Ask an editor, as built) | `editor_asks (org_id, user_email, id, project_id, asker, question, reason, note, created_at, seen_at)`, forced RLS; `users.request_email boolean NOT NULL DEFAULT false` ("Email me when a viewer asks for data"; dashboard requests reuse it) |
| 0034 `search_anchors` | `search_entries.anchor_kind`, `anchor_id` (nullable, no default rewrite) |
| 0035 `dashboard_reads` | `dashboard_reads (org_id, project_id, analysis_id, dataset_id)`, an index by dataset; `dashboard_reads_built (org_id, project_id, version)`; the trigger on `records` for writers without `ordinate.folders` |
| 0036 `team_tables` | `team_tables (org_id, project_id, team_id, conn_id, schema, table_name NULL, include bool, hidden text[], granted_by, granted_at)`, unique on `(org_id, project_id, team_id, conn_id, schema, coalesce(table_name, ''))`, team → `teams` ON DELETE CASCADE |
| 0037 `dashboard_requests` | the table above with indexes for an approver's open list and a requester's own (`users.request_email`, off by default, is already there: Ask an editor's 0033 made it, and requests use the same switch) |

`kind` in `folder_items` has no CHECK: the app validates it (`dataset`, `dashboard`), so a later
placed kind needs no constraint change.

## Upgrade and rollback

- **Upgrade changes nothing anyone sees.** No placement rows means everything is in Everyone at the
  project role; the per-dashboard audience rule gives every project member today's audience; ⌘K
  rebuilds each source once (`INDEX_VERSION` 3); `dashboard_reads` builds per project on first need.
- **The release that lets anyone make a folder needs the readers' release first (D22).** The owner
  tags a release containing E1–E6 before E7 merges, and `docs/server/upgrade.md` gets a section in
  its usual shape: go through that release, or stop every pod and start the new ones. A pod older
  than it shows every folder's items to every project member.
- **Never roll back below that release once a project has a folder besides Everyone.** An older pod
  ignores the tables and shows everything. If a rollback is unavoidable, a project admin first moves
  every item back to Everyone (**Share → Folders → Move everything to Everyone**, part of E7), which
  makes the rollback widen nothing. Rolling back between releases that both carry the readers is
  safe: the tables stay, and an older pod's dashboard writes only narrow reach (the 0035 trigger).

## The PR plan

Each PR is one review, with its tests in the same PR, and classifies the contracts it touches in
`scripts/folderReaders.ts`.

| PR | What | Tests |
|---|---|---|
| E1 | 0032; `src/server/authz/folders.ts` (resolver, placements, `openerEmails`, `wholeProject`); `FolderError`, the route's 409, the web's `refusalOf`, the catalog sentences; `scripts/folderReaders.ts` with every read and write contract | `test-folderAccess`; safety net section 1 |
| E2 | The stores and the doors for datasets, dashboards and what follows them: caller-aware lists and reads by id, per-dashboard audience (D8), `folderGate` in the doors, the storage net, `folder:of` and the bookmark sentences | safety net 2–5 and 7 with planted rows; `test-dashboardDraftsViewer` + `opsEditorView`; the row-policy and column-access nets unchanged |
| E3 | Everything around them: comments, mentions, Trash, versions, lineage, topics, recent, starred, numbers, Home, `projects:overview`, pushes, recipients, MCP | safety net 9–10; `test-mentions` with a mention of someone who cannot open the target |
| E4 | Indexes: 0034 and ⌘K anchors, the WHERE on `assistant_search` and `verified_keys`, counts | safety net 6; `test-searchIndex`, `test-assistantSearch`, `test-verifiedIndex` per caller; `test-askBudget` ceilings (+1 at most); `test-askNoProjectLists` with an Ops viewer |
| E5 | Reach: `publishedReads`, `published.reads`, 0035 and its trigger and rebuild, the publish refusal, `share_figures` | `test-dashboardReads`; safety net 4 |
| E6 | Writes: every `EDIT` and `CREATE` contract, `folderId` on create inputs, derived defaults, model import and export, pipelines, relationships | safety net 8 |
| — | **Release tag** with E1–E6 (D22), and the upgrade.md section | |
| E7 | `src/api/folders.ts`: `folder:tree`, `folder:create`, `folder:rename`, `folder:delete`, `folder:setShareFigures`, `folder:access`, `folder:grant`, `folder:moveImpact`, `folder:move`; the rail, chips, Move dialog, Share → Folders, Admin → Teams → Folders, empty states; *Move everything to Everyone* | `test-folderChannels` (depth, names, delete-empty, admin-only top level, the move hash); safety net 11; `folders.e2e.ts` in both themes |
| E8 | Connection tables: 0036, `teamTables:*`, the Tables screen, index keys for tables, the viewer answer and Explore path (with or after phase D) | `test-teamTables` (include, exclude, schema, union, hidden columns); safety net: an unticked table's name in no viewer reply or prompt |
| E9 | Dashboard requests: 0037, `src/api/requests.ts`, Home rows, the review page, pushes and email | `test-dashboardRequests`; `requests.e2e.ts` |

E2 to E6 can land in any order after E1, but each must be in before the release tag. E8 and E9 do
not depend on E7 and may merge after the tag in either order.

## Ceilings

- **An id says that something exists.** A bookmark sentence, a 409 on a known id and a refused
  dashboard tile say that an item exists in a folder the caller cannot open, never its name, folder
  or contents.
- **A metric's name is unique in the project.** An editor saving *Revenue* where Finance has one is
  told the name is taken, which says that a metric with that name exists.
- **Reach answers any figure question on a reached dataset** (D10), not only the dashboard's own.
- **Stories, reports without a dashboard, scorecards and scenarios have no reach**: a block or row on
  a dataset the reader cannot open refuses.
- **A folder's switch is per top-level folder**, not per dataset.

## Open questions

1. **A given table's name for viewers. Decided:** an editor-written label
   on the source table doc, never a name derived from the table's own (a title-cased last segment still
   tells a viewer the warehouse table's name, against p2-01). A table without a label is not offered to
   viewers; the Tables screen asks editors to name it. A pod of an older release that drops the label on
   save makes the table unoffered again: a hide, never a leak, so no "kept" release is needed first.
2. **A per-folder Manage level** (Looker's Manage Access, Lightdash's Full Access), so a Finance
   lead can change Finance's grants without being project admin. Default: no; project admins only.
   It can be added later as a third `level` value.
3. **Placing stories, reports and scorecards in folders** instead of following their datasets.
   Default: they follow (D3). If people ask for a Finance stories shelf, `folder_items.kind` takes
   new kinds without a constraint change.
4. **Old open requests.** Default: an open request stays open until decided or withdrawn; after 30
   days Home lists it under *Older*. The alternative is closing it as lapsed, with the requester
   told.
