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
| D21 | **One operator setting, `ORDINATE_FOLDERS`, off by default** (revised at E7). Readers are inert until a folder exists; with the setting off, nothing makes, shares or moves one (D22). Nothing is ticked by default; request email is off until a person turns it on. | The setting does not make a rollback safe (Move everything to Everyone does); it stands in for the release order, so E7 can merge before a release is cut. |
| D22 | **The readers run on every pod before anyone can make a folder.** E1–E6 make every reader apply folders while nothing can create one. E7 merged without a release in between, so its channels that make, share or move a folder refuse until `ORDINATE_FOLDERS=on`, which an operator sets only once every pod runs a release with E1–E6. | The p4-01a pattern in `docs/server/upgrade.md`: a pod that cannot apply a folder must never run beside one that can make it. |

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
- `reaches(projectId, id)` (E5, in `folderGate.ts`) runs only for datasets not open: one query over
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

### The stores and the doors, as built (E2)

- **One module applies the rule**: `src/server/authz/folderGate.ts` — `levelsOf` (a list's filter, from one
  `placedIn` query of the project's moved items), `opens` / `levelOfItem` (one item), `openOnly`, `anyClosed`,
  `folderGate` (the doors) and `gateFolder` (the net). An admin, a `wholeProject` walk, a **published request**
  (`/p/` and signed embeds run as their link's audience, D17) and a project with no folder besides Everyone get
  "open" with no placement read, so every reply is today's (the safety net's section 0 proves it, checks on vs off).
- **Filtered after the read, in the store** (no list reads more than before): `datasets.listDatasets` /
  `getDatasetMeta` (null), `analysis.listAnalyses` / `getAnalysis` / `opensDashboard` (and `analysis:open`, which
  reads the tagged record), `visuals`, `metrics`, `terms` (lists, gets and the tagged reads, so a guarded save of a
  closed record refuses as for a missing one), `verifiedQuestions` (`listTagged`, `getVerified`; `readVerified`
  stays the write path's "does it exist?"), `alertStore.load` (rules by `createdFrom.analysisId`, else their
  dataset; events by their rule). Every write reads the stored file (`loadStored`), so a save never drops a closed
  rule.
- **D8**: `readsPublishedOnly(projectId, id?)`; the lists, `analysis:open`, "Also on", comments on dashboards,
  Trash and version history ask it per dashboard.
- **The doors**: `vizDataFor` (before the term expansion), `lockedViz`, `lockedMetric` and `withLockOf` (so
  `computeCard`, `pageFor`, `distinctFor`, the profile and the alert metric) call `folderGate` first. What the
  question reads besides its own dataset (`chartReads`, `metricReads`) is computed **inside `wholeProject`**: a
  relationship or a related dataset's meta read through the filtered stores would make the gate blind, and the
  answer cache (keyed by the base dataset and the question) would then hand a closed dataset's labels over. The
  figure scope came with reach, in E5 (*Reach, as built*): `folderGate` returns it.
- **`wholeProject` call sites** (an allowlist in the safety net, section 7): `figureDatasets` / `datasetsOfRoot`,
  `hiddenAnywhere`, the project-wide rules check remembered across callers, the doors' reads, `syncWatchRules` (a
  narrowed list would read another folder's watched datasets as gone and drop their rules), the push refresh of
  dependents, `folder:of`'s existence read, and the name-uniqueness checks of metrics, terms, mirrors and verified
  questions (the ceiling: a taken name says one exists).
- **`format:colors:get`** answers `{}` to a caller a folder closes any dataset to, as row rules' REDACT does: which
  values are whose is unknown.
- **Catalog parts follow their record**: `catalogIndex.getDoc` answers a blank doc (as for a record with none),
  `tagIndex` leaves out a closed record's refs and a tag used only there, and a closed dataset's column docs and
  table doc read as none (`readableColumns`, `readableTableDoc`).
- **A visual on an open dataset that reads a closed one** (a related dimension's labels) is sent without the labels
  it stores (`visualForCaller`'s `withoutLabels`), to editors too, with the tag of what was sent: a save from that
  copy refuses 409 instead of writing the labels away.
- **`folder:of`** (`src/api/folders.ts`, the first of E7's file) takes `dataset` and `dashboard`; the dataset and
  dashboard pages ask it when they load nothing (`web/src/features/live/folderClosed.ts`). Stories and reports joined
  in E3 (below).
- **The budget**: a restricted viewer's ask runs the resolver once: one transaction, three statements (BEGIN with
  `set_config`, the tree, COMMIT); `test-askBudget`'s viewer moved 114 → 117 queries, the admin cases not at all.

### What follows them, as built (E3)

- **Stories, scorecards, scenarios and reports follow what they name** (`src/analysis/followsOpen.ts`): every id under
  a visual, metric, dataset, dashboard or scorecard key must be open; a report with a dashboard follows that dashboard
  alone. Their lists skip, and their reads by id (the tagged reads too) answer `null`, so a guarded save refuses as for
  a missing one. A named visual or metric the caller's stores do not return counts as closed: a hide, never a leak (a
  story with a block on a deleted chart is hidden from a caller a folder restricts, from no one else). The first test
  in a request reads the visual and metric lists once; with no folder, none. `folder:of` takes `story` and `report`,
  and their pages ask it when they load nothing.
- **Comments follow their target**: for a caller a folder restricts, `readableComments` keeps a thread only on a target
  their stores name (every kind, not only dashboards and cards); `comment:add` on another target answers as one with
  nothing to be about, and a reply, edit, resolve, reopen or delete on a thread they cannot read answers *That comment
  is no longer here.* — as for missing ones (section 3 holds them `Object.is`-equal).
- **Mentions** (`src/server/mentions/targetReaders.ts`): who a mention on a target may name and tell is the project's
  current readers who open its anchors (the dataset; the dashboard, a card's; a visual's dataset; every dataset and
  dashboard a story shows), through `openers`. Anyone else is refused in a non-reader's words; the picker takes the
  comment's `target` (optional: without it, the project's readers, as before) and the web sends it; the notice reads
  them again at send time; `mentions:list` reads threads through `readableComments`, so a row whose target the caller
  can no longer open is gone for them (marked seen, as an edited-away one is). A body that names no one reads nothing
  more.
- **Trash and versions** (`src/app/recordOpen.ts`): `trash:list` lists an entry only when the caller opens what its
  record follows, read from its Trash copy (a dataset or dashboard keeps its placement there). A record closed to the
  caller — live in their store, else its Trash copy — has the history of a record with none (`versions:list` `[]`,
  `versions:get` `null`, `diff` and `figures` *gone*).
- **Topics**: a member in a closed folder is no member for the caller (`membersOf`) and never counts as stale;
  `topic:get` sends the record without such members, then with the tag of what was sent, so a save from that copy
  refuses (409) instead of dropping them (E2's pattern for labels). Navigation, agents and the Assistant's topic
  context read the same members.
- **Captures** follow the dataset they were saved into (`history.loadAllSummaries` for a project), so Home, Recent,
  lineage and the Captures tab leave one out with its dataset.
- **Home, Recent, lineage and "Your numbers"** are built on the filtered stores and needed no code of their own.
  `projects:overview` asks once which of the listed projects have a folder besides Everyone (`foldersRestrict`: one
  round trip, `readOnceInOrg`, none for an admin) and remembers the rest as bare for the request, so only those run the
  resolver; there it counts the dataset files the caller opens and dashboards as `listAnalyses` lists them (D8). Over
  51 bare projects that is 516 statements for an editor and 570 for a viewer, against E2's 515 and 773 (callerOn now
  seeds the rank the resolver asks for); a per-project resolver was 719 for the editor. `starred:get` keeps the caller's own keys
  — ids, no names — so a pin comes back with access; Home draws Starred from `recent:list`.
- **Pushes** (`toOpeners`, `src/server/jobs/schedules.ts`): one push per reader carrying only the items whose anchor
  they open — `alerts:fired` (each event's rule's dashboard, else its dataset), `hub:dataset-refreshed` (success and
  failure), `hub:record-saved` (Edit-level openers of a dashboard, or of a record's dataset). With no folder besides
  Everyone every reader gets today's push. E5 added the dataset's reachers to the refresh push (*Reach, as built*).
- **Recipients**: an email send's recipients, resolved at send time, keep only `openers` of the subscription's dashboard
  or the alert's anchor (`emailChannel.audience`; the alert `Delivery` carries its `anchor`). A mention's one recipient
  was narrowed by its notice. Slack and Teams are unchanged. The dialog's *2 recipients can't open this dashboard* waits
  for E7, when a folder can exist.
- **`openers`** (`folderGate.ts`) is `openerEmails` behind the net's seam, so its negative controls can turn the
  narrowing off. **MCP** needed nothing: every tool reads through the stores (section 10 calls each read-only tool).
- **The net**: sections 9–10 (`scripts/folderNetSends.ts`), the switcher's cost in sections 0 and 9
  (`scripts/folderNetCost.ts`: at most one statement over no folder code with no folder anywhere, two tree reads with
  folders on two of 51 projects; NEGATIVE CONTROL: resolved per project), and the sweep over E3's planted canaries (a comment with
  mentions, a story, scorecard, scenario and report, a trashed chart, version history, a topic member, followed
  numbers). `LATER_BY_ID` is empty (`comment:add` left it); `UNSWEPT` lost `recent:list`, `starred:get`,
  `projects:overview` and `mentions:list`; `WHOLE_PROJECT` is unchanged.
- **The budget**: no change — `test-askBudget` measures 92 / 88 / 75 / 120 / 112 / 22 queries (home, dataset, agent,
  restricted viewer, dashboard, reopen) on E2 and on E3 alike.
- **Left for later**: notebooks and metric trees following their datasets; writes on closed items beyond what a store's
  `null` refuses — `trash:restore`, `trash:purge` and `trash:empty` on a closed entry, a `topic:save` sent with no
  `base` (a closed member is refused as gone, but a whole replacement would drop it) — are E6's.

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

### Indexes, as built (E4)

- **One condition, in each query's WHERE** (`src/server/authz/folderSql.ts`, pure SQL text, as recordFs imports the
  index modules): `folderOf(kind, id)` is the item's folder read from `folder_items` inside the query (the project id,
  Everyone, when never moved; ids compared lowercased), `opensDataset(col, $open)` is "that folder is one the caller
  opens, or the row has no dataset", and `searchRowShown` is ⌘K's. `$open` (and ⌘K's `$edit`) come from the resolver
  (`folderGate.indexFolders`): its `open` set, NULL when nothing restricts the caller (an admin, a `wholeProject` walk, a
  published page, a project with no folder besides Everyone), and then the planner folds the condition away. It is a
  positive test (`folderOf(…) = ANY($open)`) rather than the table's anti-join: it is the same rows, and a caller with
  no project role opens nothing. A seam (`setIndexWhereForTest`) drops it alone, for the negative controls.
- **⌘K** (0034): `describeRecord` anchors each row — a dataset to itself; a visual and a metric to their dataset; a
  dashboard and its saved views to the dashboard; an alert rule to its dashboard when it was made from one, else its
  dataset; a report to its dashboard, else `many`; a connection to `project`. `query` and `countKinds` keep a dataset's
  rows when it is open, a dashboard's draft row where the caller edits its folder and its published row elsewhere (D8; a
  caller who reads every dashboard as published edits none), and what follows a dashboard at either level. Only a
  restricted caller's `many` rows (a report from a scorecard) are checked after ranking, by id through
  `reportSpec.getReport`, a page at a time. A `NULL` anchor never reaches a restricted caller. `unbuilt` reads in the
  same statement whether the project has a folder: without one the resolver never runs, so ⌘K makes exactly the
  statements it made before (the net's section 0: 17 and 18 for an editor and a viewer, with the folder code on and
  off; NEGATIVE CONTROL: resolving without asking reads a tree). With folders on P it reads P's tree once (20 and 21).
  `INDEX_VERSION` 3 rebuilds each source once.
- **The Assistant's search** (no migration: rows carry `dataset_id`): `opensDataset` in `rankedPage` (the prefilter of
  items, before the grouping, the order and the LIMIT), `nearestPage` (the allowed items, before any distance or LIMIT:
  meaning search), `foundItems` (the counts), `keyedItems` (the names an answer says) and `newestItems` (Home's
  datasets); `RankOptions.open`. Source tables (no dataset) as before, until E8. `hidingDatasets` is a security walk and
  sees the whole project (D14).
- **The verified lookup**: `keyHits`, `datasetHits`, `rankedIds` and `nearestIds` carry it, on the question's dataset and
  on every dataset it reads (`verified_keys.reads`, 0034, `opensAll`): a verified SQL question (#528) is indexed under the
  first dataset it reads, and is found only by a caller who opens all of them, as `listBoth` lists it.
  `verifiedSqlNamed`'s by-id read keeps the same rule (`sqlOpen`). MCP's by-id lookup
  (`indexedNamed`) also reads the question named by its id, so that read goes through `openOnly`, as `getVerified` does.
  A question on a dataset the stores read as missing does not run either, so the verified paths have two guards.
- **Spelling** (#526's "Did you mean" by pg_trgm, 0031): `speltPage`'s `findable` condition carries `opensDataset` on
  `b.dataset_id`, from `RankOptions.open`, in both its queries — the pg_trgm one, before its similarity order and LIMIT,
  and the fallback that reads the names for the reference to rank — so `answerCheck`'s candidates are the caller's.
  `test-nameSpelling` 8 holds the differential per caller on both paths (NEGATIVE CONTROL: without the WHERE the viewer is
  offered the closed dataset and the differential fails).
- **The Assistant's history** (`src/ipc/turnsOpen.ts`): for a caller a folder restricts, an answer whose chart, "Did
  you mean" option, SQL (any dataset of `sql.datasetIds`) or facts (any of `factsFrom`) is on a dataset they cannot open,
  or that was asked about a dashboard they cannot open (`dashboardsFrom`), is dropped with the question it answered — from every reply that
  carries turns (`turnsForBrowser`: `copilot:history`, `copilot:ask`, `answer:rerun`, a verified hit), from the turns
  `copilot:ask` replays to the model and the chart a follow-up continues. A title taken from such a question reads
  *Conversation*; a renamed one is the caller's own words and stays. The list counts only the turns the caller is shown,
  and says whether its first question is one, in the page's one query (`copilotRows.listPage`): the same rule in SQL —
  a turn is hidden when it is an answer on a dataset outside `$open` (0039 `ordinate_turn_shows` reads them from its
  body: 0034's `ordinate_turn_datasets` and `factsFrom`) or on a dashboard outside it (0040 `ordinate_turn_dashboards`),
  or a question whose next turn is one, and the same query's WHERE
  leaves out a conversation with turns and none shown (one made empty stays, as a new one); `copilot:history` answers
  such a conversation, by id or as the latest, as for none (no turns, no id, no title), and `copilot:ask` naming it (or
  with it the latest) starts a new conversation (`askThread`): none of its turns is replayed to the model, nor its agent
  used, nor its id returned. `copilot:renameThread` returns the count shown, from the list's own SQL (`renameThread`, the
  rename and the count one statement). With no folder the count is
  every turn and every conversation is listed, as before. Nothing is deleted: open the folder to them and the turns are back. A kept card on
  such a dataset could never be sent anyway (its record reads as missing, E2), and `answer:refresh` of it refuses at the
  door. **What the facts came from** (`factsFrom`, written by `copilot:ask` on its answer turn, server only:
  `turnsForBrowser` drops it): the datasets the ask's facts are about (`askDatasets`: the open dataset, a visual's,
  Home's 12 picks, a topic's), the linked ones (`askLinkedFacts`), the chart a follow-up continued, and what
  `buildFacts` reports as `datasetIds` where those are not its figures' — a dashboard's tiles' and Statistics tiles',
  a capture's, a Statistics panel's, a "Why did this change?" question's, and a scorecard's or scenario's metrics'
  (memo hits). **What it was asked about** (`dashboardsFrom`, server only too): the dashboard page an ask's context
  named, when the facts were that dashboard's, and the dashboard an alert explained (`explainEvent`) is on — so an
  answer read off a dashboard in a closed folder leaves though every dataset it shows is open. `openTurns` reads the
  dashboards' placements only when a turn names one. **Ceiling**: a turn stored before this release has no `factsFrom`
  (or `dashboardsFrom`), so a prose answer's words stay (net section 6 proves both ways).
- **The budget**: `test-askBudget`'s cases did not move (92 / 88 / 75 / 120 / 112 / 22; meaning on 106 / 97 / 84 / 137
  / 119). A new case asks as a viewer in team Ops with Orders in Ops and 50 datasets in a folder only admins open:
  132–138 queries (the bare viewer's 120, the datasets' placements, five records read one at a time), and the index
  statements are as many with the WHERE as without it (10 and 10). `test-askNoProjectLists` asks as that Ops viewer: no
  whole-project list, and Finance's dataset never in the facts (NEGATIVE CONTROL: without the WHERE it is).
- **The net**: section 6 (`scripts/folderNetIndexes.ts`) on Finance's canaries, made in Everyone, talked about there by
  opsViewer and finViewer, then placed in Finance: for five people every index answer is the reference's, and opsViewer,
  opsLead and ed find nothing of Finance or HR by ⌘K, words, spelling (a typo sharing no word, and its "Did you mean"),
  meaning (a fake embedder), the counts, the verified lookup or their history, whose counts are of the turns they are
  shown — a prose answer on Finance's dataset leaves with its question (the one on Plain before it stays), and a
  conversation of only such turns is not listed and reads as none by id; so is an alert's explanation on Finance's
  dataset, and an answer asked on a dashboard placed in Finance that shows no dataset; a rename is told the 2 turns
  shown, not 4; an ask into a conversation of only hidden turns lands in a new one and replays the model none of them;
  NEGATIVE CONTROLS: finViewer and padmin do (finViewer's ask lands in the one named, replaying its two turns; their
  rename is told 4); the dashboard turn with its `dashboardsFrom` removed is listed and shown; the rename counted
  without the folders says 4; without the WHERE, opsViewer's ⌘K, words, spelling and meaning carry
  Finance's, and their list would count the hidden turns and carry that conversation; the same turn with its `factsFrom` removed (an older release's) keeps its words; an anchor-less row is not returned to opsViewer but is to padmin; an anchor in another case is still
  filtered. `LATER` is empty: the sweep holds `search:query`, `copilot:history` and `copilot:threads` (NEGATIVE CONTROL:
  padmin's carry HR's canaries).
- **Left for later**: reach (E5) needs nothing here — the indexes keep only folders the caller opens, so a reached
  dataset is never searched (D9). E6's writes remain. An `answer:rerun` naming a conversation of only hidden turns
  still appends to it (it replays nothing to the model, and the hidden turns stay hidden).

### Writes, as built (E6)

- **One rule, three seams** (`src/server/authz/folderWrites.ts`): a write needs Edit on what it changes, a create Edit on
  where it lands; below Edit refuses `edit`, an item the caller cannot open answers as for a missing one where the
  store's write path reads it, else `closed` (names nothing: the Ceilings' "a 409 on a known id"). What a record follows
  is `recordOpen.levelOfRecord` — a dataset or dashboard its own folder, an alert its dashboard else its dataset, a report
  its dashboard, a verified question `questionDatasets` (the ONE place a question's datasets are read: a chart
  question's spec's dataset, an SQL question's every `sql.datasetIds` entry — writing one needs Edit on ALL of them, and
  one closed to the caller hides it, as `listBoth` lists it), anything else the lowest level over everything it names
  (a chart's own dataset hides it; a label dataset it also reads refuses).
  1. **The stores**, so the route, MCP's write tools, the Assistant's plans and model imports are held alike:
     `editConflict.lockedUpdate` (every guarded update: closed → gone; below Edit before `apply` and after it — a refusal
     after rolls the write back in the lock's transaction; a dashboard's added cards need their datasets open),
     `trash.trashRecord` and `restore` (the live record, else its Trash copy), the story, scorecard and scenario deletes
     (closed: "gone is success", as a missing one), each follower's create and duplicate (visual, metric, term, verified,
     story, scorecard, scenario, report), `alertStore` save, patch, delete and `restoreRule` (E2's open item), relationships
     (both ends open, Edit on one; never over an edge the caller could not change), subscriptions (their dashboard),
     `analysis.patchStored` (Unpublish, and Publish's Edit beside E5's D16 refusal), `commitSteps` (every pipeline edit: a
     channel, a plan step, text, geo, segments, stats), a plan's calculated fields, and model import's catalog docs and
     base filters (a refused object fails with the catalog's sentence; the rest still land).
  2. **The route** (`folderWriteGate.ts` `WRITE_GATE`): the dataset-scoped writes whose parts live in many modules
     (settings, columns, refresh, mode, source tables, docs, quality rules, privacy marks, snapshots, refresh URLs, an
     insight's dataset, a capture's), a catalog ref's record, Discard and a dashboard's currency, `versions:restore` of a
     dataset or dashboard, and the project's **pipeline** (`pipelines:*`, now `EDIT`): it names and runs every dataset as
     the system, so changing it needs Edit on all of them — from the placements, no listing.
  3. **Where creates land**: `folderId` (optional) on `analysis:create`, `analysis:buildPlan`, `dataset:composeSave`,
     `dataset:copyLive`, `connection:import`, `connection:addSemanticDataset` and `input:create`; else the folder of the
     first parent **outside Everyone** (a copy, an RFM table, a composed or SQL dataset: its base, joins and the datasets its
     SQL reads) — a refinement of "first parent", so that a join with a restricted dataset never lands in Everyone; else
     Everyone. The request runs in a landing scope and the placement row is written **before** the record
     (`placeFirst`, from a dataset's first record write, a Live record's and `saveAnalysis`): a derived dataset is never,
     for a moment, in Everyone. A folder named that is not there is `closed`, as a closed one. The web sends no `folderId`
     until E7 makes folders.
- **Reclassified** (the code wins): `dataset:parsePaste` and `dataset:pickAndParse` are `OWN` (they stage a table for the
  caller; `composeSave` lands it), `sql:prepareSave` is `OPEN` (it stages; the `sql` origin lands it with its reads),
  `segments:rfmSave` is `CREATE`, `pipelines:*` are `EDIT`.
- **Left by E2 and E3**: `alerts:patch` and `restoreRule` on a closed rule answer as missing; `metric:ensureDefaults` asks
  "none yet?" of the project (`wholeProject`, an allowlisted site) and proposes only on a dataset the caller edits (none,
  quietly, otherwise); `trash:purge`, `trash:empty` and the 30-day purge drop the placements of what they purge, so an
  emptied folder can be deleted (E7); a base-less `topic:save` keeps the members the caller was never sent;
  `verified:save` on an id asks the caller's read whether it exists; `model:export` leaves out a relationship to or from a
  dataset the caller cannot open (its columns name it); `privacy:scan` with no ids scans only what the caller edits.
- **The cost**: with no folder besides Everyone a non-admin's route-held write asks once whether the project has a folder
  (`hasFolders`: `foldersRestrict`'s one statement, which also spares the resolver its tree for the rest of the request);
  the store checks read nothing the resolver had not (memoised). Measured against the checks off: `visual:update` 32 / 32
  statements, `catalog:setColumn` 17 / 17, `analysis:create` 23 / 22, `dataset:composeSave` 60 / 59. An org admin reads
  nothing, but a derived create's parent placement (one statement).
- **The net's section 8** (`scripts/folderNetWrites.ts`, on throwaway sets): 84 calls over every EDIT and CREATE channel
  with a payload that writes — opsLead on HR's leaves every record naming them and their placements byte-identical and
  answers as for unknown ids or `closed`; opsEditorView (Can view on Ops) changes nothing and is refused `edit` by each
  call that lands without E6's checks; NEGATIVE CONTROLS: opsLead's same calls on Ops land, and so do opsLead's on HR's
  with the folder checks off and opsEditorView's with E6's checks off. Coverage: 77 channels exercised, 34 in
  `UNEXERCISED` with why (a Live dataset, a connection, an upload, a model's plan run …; it only shrinks), the 17 of those
  the route holds refused before their handler whatever the payload; every channel held by the gate or a store (section 1,
  no database). Then: landings (no folder → Everyone, Ops → Ops, HR and an unknown folder alike `closed`, a SQL dataset over
  Orders and Plain joined with Orders → Ops, an admin's copy → Ops), the topic's kept members, the model export, the purge,
  the pipeline, MCP's `create_visual` and verified SQL questions (over Plain and Orders: opsEditorView, who edits Plain
  and views Orders, may not delete or make one; one that also reads HR is opsLead's as a missing one), each with its
  control; and the cost above. E5's D16 case now has padmin make its draft: ed may not add a card on HR (D18).
- **Left for E7** (done there, below): the folder channels (`folder:move` writes `folder_items` as `placeFirst` does),
  `folderId` in the web's create dialogs, and placing a duplicate dashboard when one exists.

### The folder channels and screens, as built (E7)

- **Channels** (`src/api/folders.ts`, handlers `src/ipc/folders.ts`; every one project-scoped by `projectId`):

  | Channel | Access | Rule (beyond the route's role) |
  |---|---|---|
  | `folder:tree` | read | the folders the caller opens (an admin: all, `adminOnly` when no team of theirs was given its root), each with their level, a top-level folder's teams and switch, items placed (the Trash included); `placed`: where each item in an open folder sits. Empty, `available: false`, without Postgres |
  | `folder:create` | write | `parentId` null: a top-level folder, rank 3 only; the project id or a folder: Edit on it. Depth ≤ 5 below its root, ≤ 1,000 a project, names unique among siblings whatever the case (0032's index answers a race, as `name taken`) |
  | `folder:rename`, `folder:delete` | write | a top-level folder rank 3, a subfolder Edit on it; delete takes the folder and its empty subfolders in one statement, `not_empty` when any holds an item (Trash included; 0032's RESTRICT backs it) |
  | `folder:setShareFigures`, `folder:grant` | admin | top-level folders only; a team of the org |
  | `folder:access` | admin | Share → Folders: each top-level folder, its grants with head counts (members with a project role), the people they add up to, the org's teams |
  | `folder:moveImpact`, `folder:move` | write | Edit where each item is and where it goes (`closed` / `edit`); `from` moves everything placed in a folder and under it (a delete's "Move its items to…"), and `from` = the project id is *Move everything to Everyone* (rank 3, to Everyone only) |

  Folder writes run under a per-project advisory lock (the cap and depth are counted under it). Non-refusal answers are
  `{ok:false, error}` in the catalog's words (`src/server/folderMessages.ts`, translated). A deleted project's folders,
  grants and placements go with it (`dropFolders`, beside `dropGrants`).
- **The move warning and its hash** (`src/server/authz/folderMove.ts`): one transaction reads the tree, the grants and
  every member folders restrict (`folderPeople.membersOn`: not an org or project admin, a project role), and runs the
  resolver's rule per person (`folderPeople.levelAt`, held `Object.is`-equal to `accessFrom` over every rank, grant and
  membership). Per item: who loses it (grouped by the source root's teams, or Everyone), who gains it, who drops to
  view or rises to edit; moved dashboards on a published site; subscription email recipients (a channel's users and
  teams) who lose it; dashboards in other folders whose published copy reads a moved dataset (0035, built first when
  unbuilt — so a dataset leaving Everyone has its reach known) and whether the destination's root shares figures. The
  reply carries counts and team names, never an address. The hash is sha256 over the answer **and** the people behind
  it by email (a member swapped in a team changes it though no count moves) and the caller. `folder:move` computes it
  again, refuses `move_changed` unless equal, then writes the rows in one statement (to Everyone: deletes them), as
  `placeFirst` does. No index row changes (D1); `dashboard_reads` needs nothing (it joins placements at query time).
- **Screens** (`web/src/features/folders/`, one lazy chunk with Data and Dashboards; Share → Folders its own):
  - **The rail** (`FolderRail`, `FolderView`): beside Data's datasets and the Dashboards grid when the project has a
    folder besides Everyone — *All datasets / dashboards* (an addition: the default view keeps every item the caller
    opens, each row tagged with its folder), Everyone and its subfolders, then the top-level folders, nested, with
    counts, a lock and *Admin access* for an admin's. `?folder=` filters; the heading says who it is shared with; an
    empty folder has its own state (*Import into this folder* / Create). At phone width it is a row of pills.
    New subfolder, Rename and Delete sit on each row's ⋯ where the caller may.
  - **Move to…** (`MoveDialog`): from a dataset row, a dashboard card's ⋯, the item's chip, or a drag onto the rail
    (the dialog opens with the destination picked). The warning loads for the destination picked; Move is off until it
    has; a `move_changed` refusal shows the server's sentence and the new warning.
  - **The chip** (`FolderChip`) on the dataset page and the dashboard view: *In Finance · Finance can view, Finance leads
    can edit*; a button to Move for whoever edits where it is.
  - **Share → Folders** (`SharedFolders`, a tab of the project admin's Share dialog): each top-level folder as a card
    with its teams at *Can view* / *Can edit*, *Give it to a team*, the reach switch, Rename and Delete; New folder;
    *Move everything to Everyone* (with the warning) while anything is placed. **Admin → Teams → ⋯ → Folders…**
    (`TeamFolders`): per project, the team's level on each top-level folder, through `folder:grant`.
  - **Where creates land** (D18): the rail's folder, when the caller edits it, goes as `folderId` on `analysis:create`
    (New dashboard), `analysis:buildPlan` (Draft with AI), `dataset:composeSave` (import, paste, combine) and
    `input:create`; a duplicated dashboard is created in its original's folder.
- **The setting (D21, D22)**: `ORDINATE_FOLDERS` (`on`/`off`, default `off`), parsed once at startup in
  `src/server/env.ts` (a typo stops it) and handed to `folderTree.useFolders` by `buildApp`. Off, `folder:create`,
  `folder:grant`, `folder:setShareFigures`, `folder:moveImpact` and `folder:move` answer `{ok:false, error}` with the
  catalog's *Folders are off on this server: an operator turns them on once every server runs this version.* (the
  handlers' `gated`, `src/ipc/folders.ts`); `folder:tree`, `folder:rename`, `folder:delete` and `folder:access` work,
  since a folder exists only if it was made while on. `folder:tree` and `folder:access` carry `enabled`, so the web hides
  the rail's New folder and New subfolder, Move to… (rows, cards, the chip, drags), Share → Folders' New folder, team,
  level and reach controls and *Move everything to Everyone*, and Admin → Teams → Folders' levels, each with one line
  instead — no extra call. Operators: `docs/server/configuration.md#shared-folders`.
- **Who can't open a page** (`src/server/authz/folderOutside.ts`, D16, D17): `outsideCount(project, items)` — the
  project members folders restrict (`membersOn`) for whom `levelAt` is `none` on the root of at least one item's folder;
  one query when every item is in Everyone, else one transaction (`folderMove.worldOf`). `publish:plan` adds `outside`
  over the picked dashboards and every dataset the fan-out build read; `embed:columns` over the embedded dashboard and
  its tiles' datasets. The Publish and Embed dialogs say *Shows data from folders N people can't open* (nothing at 0).
  `subscription:preview` adds `closedRecipients`: of every email list picked, the recipients `audience` would leave out
  (`emailChannel.closedRecipients`: `recipients` minus `openers` of the dashboard); the web now sends every email list
  in the preview's draft (Slack and Teams stay out of its key), and the Where step says *N recipients can't open this
  dashboard and won't get it.* Counts only; no new contract, so no reader table changed.
- **Cost**: each page with the rail, the chip or Share → Folders asks `folder:tree` once (one transaction, three
  statements); a project without folders shows nothing new. `publish:plan` and `embed:columns` add one query (a
  transaction of five with an item placed), `subscription:preview` one per email list and one for the openers.
  Initial JS 206 KB gzip.
- **Tests**: `test-folderChannels` (both modes): `ORDINATE_FOLDERS` off by default, `on` turns it on, a typo refuses;
  off, each of the five changes answers the off sentence and nothing is written, while the tree, Share → Folders'
  list, rename and delete work (CONTROL: turned on, the same create lands, and every section below runs on); who can't
  open a page, `Object.is`-equal to the resolver run as each member, through `publish:plan` and `embed:columns`, and
  `closedRecipients` equal to what `audience` leaves out (NEGATIVE CONTROLS: Everyone's items, 0); the per-person rule against the resolver; admin-only top level,
  subfolders by Edit, depth 5 under a root and under Everyone, names, delete-empty with the Trash, grants and the
  switch, the tree naming nothing closed, the hash refusing a stale warning and a made-up one, Edit on both ends,
  *Move everything to Everyone*, a deleted project leaving nothing — each with its NEGATIVE CONTROL. **Safety net 11**
  (`scripts/folderNetMoves.ts`): no top-level folder by an editor, no grant by a viewer or an editor; Orders → HR warns
  that Ops and Ops leads lose it and the Finance board stops showing it; after a grant changed, the warning's hash
  refuses and nothing moves; the move's change, per person over `folder:of` on the next request, is exactly the
  warning's people, and finViewer's reach goes as warned; NEGATIVE CONTROL: moving back reopens it to the same people.
  Vitest `folders.test.tsx` (with the off line in the rail, Share → Folders and Admin → Teams → Folders), the Publish,
  Embed and Subscribe dialogs' lines and their absence; e2e `folders.e2e.ts` (Postgres, `ORDINATE_FOLDERS=on`, both
  themes, phone width).
- **Left for later**: naming the folders in the Publish and Embed line (it counts people, it names none); folder search
  in the rail; moving folders themselves (only items move).

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

## Reach, as built (E5: D9, D16, D17)

- **What a copy reads**: `publishedReads(projectId, copy)` (`src/analysis/publishedReads.ts`) is a narrowing of
  `datasetsOfRoot`, run inside `wholeProject`: every id under a `…datasetId(s)` key of the copy (its visual cards are
  frozen inline; a Ready copy's unfrozen cards read their chart as stored), the datasets of every metric a card names —
  a formula's operands by name, a period's base, a tree's parts and a target's metric, to depth 16 — and each chart's
  and KPI's join plan reads (`chartReads` / `metricReads`, what the doors gate). No lineage climb and no relationship
  walk beyond the plan. `analysis:publish` (and MCP's publish) and the Ready migration store it as `published.reads`,
  lowercase and sorted; `sanitizePublished` keeps it (UUIDs only, at most 1,000).
- **The publish refusal (D16)**: Publish computes `reads` inside the record's lock and refuses `folder` / `publish`
  (409, the route's) when one of them is a dataset the publisher cannot open that the previous copy did not read
  (a copy without `reads` is worked out first). Without folders every dataset opens and nothing more is read.
- **`dashboard_reads` (0035)** holds `(dashboard, dataset)` rows, kept by `src/server/dashboardReads.ts` in the record's
  own write transaction (recordFs's hooks, the 0026 pattern: a SAVEPOINT under a shared advisory lock, a failure drops
  the marker). The describer is pure (`publishedCopy.copyReadsOf`): the copy's `reads`, `[]` with no copy, null for a
  copy published before `reads` — then the write drops the project's marker. A project with no marker at
  `DASHBOARD_READS_VERSION` is rebuilt on the next reach question, once under an exclusive lock: copies without `reads`
  are worked out first, outside the lock (`bodyReads`, which reads other records), and never written back; one that
  changed meanwhile leaves the marker unset (a narrower reach, asked again next time). A write by a pod that does not
  set `ordinate.folders = 'on'` (recordFs sets it beside `ordinate.org`) fires the trigger, which deletes that
  dashboard's rows and the marker: an older pod can only narrow reach.
- **Reach in the doors** (`src/server/authz/folderGate.ts`): `reaches(projectId, id)` is asked only of a dataset a folder
  closes to the caller — its folder's root shares figures (`access.shareFigures`) and the published copy of a dashboard
  they open reads it: ONE statement per dataset per request (`readersIn`, the marker read with it). `folderGate` now
  returns a **figure scope**: open datasets go on, reached ones run the door's body inside a scope holding exactly the
  reached ids it may read (a door inside another reads only its own), neither refuses `closed`; `mode: 'open'` (the grid,
  a profile, drivers, an answer card: `withLockOf`'s default, `pageFor('open')`) refuses a reached one `figures_only`.
  Inside the scope `opens()` answers true for those ids, so the stores (a metric by id, a term) and the storage net hand
  them through; **outside it a reached dataset is closed** — not listed, `getDatasetMeta` null, the net refusing
  `figures_only` — so a reader nobody opted in answers as for a missing id or refuses, never leaks (section 4 holds
  every `OPEN` channel to that). The doors: `vizDataFor`, `lockedViz`, `lockedMetric`, `withLockOf` (`figures`: the rows
  behind a mark through `pageFor(…, 'figures')`, `distinctFor`, an alert's periods). FIGURE handlers that read around
  their door open the scope first (`inReach`): `visual:data` / `:dataBatch`, `visual:rows`, `visual:rowsDownload`,
  `visual:drillDown`, `dataset:columns`, `dataset:distinct`, `dashboard:metric`, `stats:tile`; `metric:value` runs in
  the scope of its metric's datasets (`inMetricReach`: its own and those of the metrics it names), so a dashboard's
  saved-metric KPI answers too. D10 holds as decided: a reached dataset answers any figure question at those doors.
- **User SQL is OPEN-class**: `compile()` (`src/engine/sqlDatasets.ts`) asks `folderGate(…, 'open')` of every dataset a
  statement names, so the Query tab, a SQL dataset, a notebook cell, the Assistant's SQL answer and a verified SQL
  question (#528, the same `runAnswerSql`) refuse a reached dataset `figures_only` — even inside a door's figure scope,
  where the storage net would hand it through.
- **`/p/` and embeds (D17)** are unchanged: a published request opens every folder (E2), and a site build or a
  scheduled run reaches as its publisher does.
- **Pushes**: `hub:dataset-refreshed` (success and failure) carries `reach` on its anchor, and `openerEmails` adds the
  openers of every dashboard whose copy reads the dataset when its root shares figures (one more statement, only for a
  dataset in a folder; the rows rebuilt first when unbuilt). A reading dashboard in Everyone sends it to every reader.
- **Cost**: with no folder anywhere, a dashboard's figure calls read nothing of reach (section 0: 0 statements on
  `dashboard_reads`, 120 statements against 114 with no folder code for three calls — E2's tree read). With folders,
  finViewer's three tiles on Orders read `dashboard_reads` once. A dashboard write pays the index's four statements
  (as 0022 and 0026 do), with or without folders.
- **The net, section 4** (`scripts/folderNetReach.ts`): finViewer's figure calls on Orders through the Finance board
  (tiles, chart, rows behind a mark, a control's values, columns, KPI, a page of charts, a drill) are `Object.is`-equal
  to padmin's (NEGATIVE CONTROL: reach off, the tiles refuse `closed`); each of 53 `OPEN` channels on Orders refuses
  finViewer `figures_only` or `closed`, or answers as for an unknown id, and `dataset:list` never names it; the Everyone
  board's HR KPI refuses ed (HR shares nothing; NEGATIVE CONTROL: switch on, it answers — and ed's grid on HR still
  refuses `figures_only` with no canary row, which `figures_only` off hands over); an older pod's write of the Finance
  board without Orders in `reads` refuses finViewer its KPI on the next request, and a republish restores it; D16 refuses
  ed's publish of a board newly reading HR (NEGATIVE CONTROLS: padmin's publish; ed's republish of a copy that already
  read HR); an Orders refresh reaches finViewer (NEGATIVE CONTROL: reach off); SQL over Orders — `sql:run`, and the
  Assistant's SQL answer run inside Orders' figure scope — refuses finViewer `figures_only` (NEGATIVE CONTROL: with
  `figures_only` off, `sql:run` hands Orders' rows). The harness adds the Finance board and
  the Everyone board, so the counts of section 9 moved by one dashboard each.
- **`test-dashboardReads`** (both modes): over nine shapes (chart, KPI, saved metric, formula with an operand on another
  dataset, related dimension, control, statistics card, metric tree over two datasets, text) the copy's `reads` are
  `Object.is`-equal to what a fan-out build's recorder saw the doors touch rendering it (NEGATIVE CONTROL: the copy's own
  dataset keys alone miss the formula's operand); a copy without `reads` is null to the describer and `bodyReads`
  equals what Publish recorded; with Postgres the rows are the describer's from the writes alone, three questions at once
  rebuild once, an older pod's writes drop rows and marker and the rebuild restores them without writing the record
  (NEGATIVE CONTROL: the same write with `ordinate.folders` keeps the marker), unpublish and republish follow, and a
  deleted project leaves nothing.
- **Left for E6 and later**: `folder:move` building the marker before a dataset leaves Everyone (E7); a metric tree,
  scorecard or `metric:series` on a reached dataset (they answer as for a closed one — a hole, never a leak); a `/p/`
  build by a publisher who only reaches a saved metric's dataset (the KPI falls back to its column); the Publish
  dialog's "shows data from folders …" list and the subscription dialog's line wait for E7, when a folder can exist.

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

### Connection tables, as built (E8)

- **The rows** (0036, `team_tables`): as the migrations table says, plus a CHECK that `hidden` sits on include table
  rows only. `schema` is `''` for a source with no schemas (the fake warehouse, MySQL without a database). A documented
  table is named as `listTables` qualifies it (`schema.name`); its schema is what comes before its **last** dot, so a
  table name with a dot of its own reads as a schema nobody ticked (a hide).
- **The rule** (`src/server/authz/teamTables.ts`, pure): `givenFrom` folds the rows team by team (a table row wins over
  its schema row; two table rows naming one table, an exclude wins), `tableAccess` unites the teams (given by any; hidden
  only what every giving team hides, compared case-insensitively, a schema tick hiding nothing). Only a team that holds a
  role on the project counts. `givenOn(projectId)` reads the caller's teams' rows in **one** statement (`inOrg`), memoised
  per request, only for a caller who does not see source names (a project viewer) and is in a team (`callerOn`'s team
  ids): an editor, an admin and a viewer in no team read nothing. A database error refuses the request.
- **The channels** (`src/api/teamTables.ts`, `src/ipc/teamTables.ts`): `teamTables:get` `{projectId, teamId}` → the team's
  rows and its role on the project (`null`: its ticks give nothing, and the screen says so); `teamTables:set`
  `{projectId, teamId, connId, rows}` (≤ 2,000) replaces that team's rows on that connection in one transaction, tidied
  (one row per schema and table, the last wins; `hidden` kept only on an include table row). Both `admin`,
  project-scoped (a project admin or an org admin), audited; without `DATABASE_URL` they answer *Tables for teams need a
  database*. Being `admin`, they are in none of `folderReaders.ts`, `rowPolicyReaders.ts` and `columnAccessReaders.ts`
  (those list `read` and `write` contracts; rank 3 opens everything). A deleted project's rows go with its grants
  (`dropGrants`); a team's with the team (cascade).
- **The label** (open question 1, as decided): `label` (≤ 120) on the source table doc, written through
  `sourceTable:save`'s patch (a doc is created for a table that has none), kept by every re-save and by a facts read
  (`updateSourceDoc`), and on the doc's index entry (`connections/<id>.tables.json`), which step 3's index reads.
  `sourceTable:list` rows and `sourceTable:get` carry it. A table with no label is offered to no viewer, ticked or not.
- **The screen**: **Admin → Teams → ⋯ → Tables…** (`?tab=teams&team=<id>`, `web/src/features/admin/TeamTables.tsx`,
  `TeamTablesTree.tsx`): a project picker, the rows notice (*Everyone in this team sees every row …*), a warning when the
  team has no role there, then one card per connection. **Show tables** asks `connection:listTables` on that click only;
  schemas carry a tick (*Whole schema, tables added later included*), tables a tick, and a ticked table its **Name for
  viewers** field (saved on blur), **Hide columns** (a dialog over `connection:describe`) and what viewers see (*Viewers
  see it as “Returns”*, *Name it for viewers: until then they are not offered it*, *Read its columns on the Source
  tables page first*). Every change saves at once. Share → Folders → Tables is E7's, over the same component.
- **Step 3's index** (no migration beyond the CHECK): each documented table with a label gets a second item,
  `label:<connection>/<doc>` — kind `table`, audience **`viewer`** (0036 widens the CHECK), its name, words and
  fingerprint text the **label alone** — with `keys` `tableKey(conn, table)` and `schemaKey(conn, schema)` (hashes, 0028's
  column). An editor's audiences are `all` + `editor`, so they never meet it; a viewer's are `all` + `viewer` only when
  `givenKeys` gives them something, with `$keys` (the tables a table row gives, the schemas a schema row gives) and
  `$denied` (every table some team names that they are not given) in the same WHERE as the folders' (`givenSql`:
  `rankedPage`, `nearestPage`, `speltPage`, `foundItems`), before any ranking or LIMIT. The reference applies the same
  rule (`givenPart`). `ASSISTANT_SEARCH_VERSION` 5 rebuilds each source once. A separate item, not a part of the
  editor's: the item's words, its vector and its name would otherwise carry the warehouse name.
- **The viewer's answer**: `sourceView` — the one door of every table reader: `inSourceTable` (the card, a refresh, a
  conversation's reopen, the access print, a follow-up's PREVIOUS ANSWER), `sourceVocabulary`, `answer:keepTable`, and
  phase D's Explore (`onSourceTable` behind its five inputs, and `explore:keepTable`) — asks who reads. An editor, as in phase D. A viewer given nothing is refused before any doc, connection or warehouse
  read (*This dataset no longer exists.*); one given something reads the doc, and the table is theirs only when it is
  given and labelled, else the same sentence. Their view is named by the label, carries no connection name, and declares
  the table's columns **less the hidden ones** — so they are in no SOURCE TABLES line, no vocabulary, no "Did you mean",
  and every compiled statement refuses them (a name the view does not declare) — but for a required partition column,
  kept so the required date range still applies. The view's origin keeps the warehouse name, read by the compiler only;
  `answeredFrom` sends a viewer the id alone, as before. The Live budget, cache and concurrency are a Live dataset's, for
  anyone. Home's SOURCE TABLES block lists a viewer's tables as `- Shop orders: region (text), amount (number)`.
- **Kept cards**: `accessPrint` of a table's view adds the columns it declares, so a card kept before a column was
  hidden is never sent again (`answer:refresh` then refuses it). Editors' kept table cards are computed once more, once.
- **The budget**: `test-askBudget` did not move — 92 / 88 / 75 / 120 / 112 / 22 / 151 queries (home, dataset, agent,
  restricted viewer, dashboard, reopen, SQL), and the Ops viewer of case 8, who is in a team, 132 (E4 measured 132–138):
  a viewer in no team, an editor and an admin read nothing of `team_tables`; one in a team, one statement a request.
- **Tests**: `test-teamTables` (13 checks without a database, 36 with): the rule's include, exclude, schema, union and
  hidden columns, each with its NEGATIVE CONTROL, and `givenKeys` equal to the rule over 8 tables × 8 team sets
  (NEGATIVE CONTROL: without `denied` it is not); the channels (an editor 403, a team with no role `null`); the resolver
  per viewer (NEGATIVE CONTROL: Ghost once it has a role); the index per viewer equal to the reference and the rule,
  counts included, never by a warehouse name (NEGATIVE CONTROLS: without the WHERE; the editor by name); the prompt, the
  answer Object.is the editor's through one warehouse statement, a hidden column, an excluded, an unticked and an
  unlabelled table refused (NEGATIVE CONTROL: the editor's), the kept card after a column is hidden; the safety net: no
  viewer reply, prompt, ⌘K search, history or MCP tool answer carries a warehouse name, schema, the connection or an
  ungiven label (NEGATIVE CONTROL: the editor's prompt). Vitest `web/src/features/admin/teamTables.test.tsx`; e2e
  `web/e2e/team-tables.e2e.ts` (both themes and the phone).
- **Explore for a viewer**: the picker's tables come from `teamTables:mine` (`read`; classified `FOLDER` in
  `folderReaders.ts`, `META` in the row and column inventories): the caller's given tables whose doc has a label and read
  columns — the indexes of the connections their teams named in one read, each such connection once — as
  `{connId, docId, name, live}`, `name` the label; empty for an editor, whose picker stays `sourceTable:list`. The page
  names the table by that label, says *Warehouse table* with no connection, offers no Keep (an editor's; still 403), and
  a table to copy first tells a viewer an editor has to copy it. `test-exploreSourceTables` 7 (Postgres): the picker's
  one table by its label; its fields less the hidden column, its chart and batch Object.is the editor's, a drill, filter
  values typed; a chart on the hidden column answered as one on a made-up name; a table labelled but given to no team is
  no dataset; keep 403; no reply carries the warehouse name, the connection, the hidden column or the ungiven table
  (NEGATIVE CONTROL: the editor's list and fields). Vitest `web/src/features/explore/sourceTable.test.tsx`.
- **Left**: Share → Folders → Tables (E7). **Phase F (a viewer's SQL on given tables)** builds on `givenOn` / `tableAccess` and the view: a viewer's
  statement names tables by their **labels** (the only names they have), which the gate resolves to warehouse names
  server side, refusing any name that is not a given, labelled table as unknown (never echoing it); the columns it may
  name are the view's declared ones (hidden columns refused, `*` expanded to those alone), the required date range as
  the view's; and the SQL text, which carries warehouse names once resolved, never goes back to the viewer. Built as F6
  (docs/live-data/01-live-sql.md, "F6 as built").

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

### Dashboard requests, as built (E9)

- **The rows** (0037): `dashboard_requests` — the requester, a title (1–120), a note (≤ 2,000), `charts` (1–12 chart
  forms: each answer turn's stored spec, sanitized; never its words or its kept card, which carry figures), `state`
  (`open` → `approved` | `drafted` | `declined`; `drafted` → `approved` at the first Publish), `decided_by` /
  `decided_at`, `answer` (a decline's note) and `dashboard_id`; and `dashboard_request_inbox` — the bell's rows, as
  `mentions` and `editor_asks`: one per approver told (`role` 'approver') and the requester's once it is decided
  ('requester'), each with its `seen_at`, at most 200 a member. Forced RLS on both. 0038 adds the state `withdrawn`,
  `target_id` (an existing dashboard the charts go onto) and `folder_id` (the requester's suggested folder for a new
  one), and an index of the open ones by requester. The requester's own row is written at send, already seen, so their
  bell lists the waiting request (with **Withdraw**) and no badge; a decision makes it new.
- **Contracts** (`src/api/requests.ts`): `request:create` (`read`, audited, as `editors:ask`; an existing
  `dashboardId` or a suggested `folderId`, not both), `request:withdraw` (`read`, audited: the requester's own, someone
  else's answers as a missing one) and `request:folders` (`read`: the folders the caller opens, by path, for the
  dialog); `request:preview`, `request:approve` (`publish`: true is Approve and publish, false is **Edit**; `folderId`,
  one of the preview's choices) and `request:decline` (a note required), all `write`. There is no `request:list` or `request:get`: the bell's rows ride on `mentions:list` (`requests`), as
  viewers' asks do, and the review page is `request:preview`. Classified `FOLDER` in `scripts/folderReaders.ts`;
  `request:create`, `request:withdraw` and `request:folders` are `META` in `rowPolicyReaders` and `columnAccessReaders`
  (an id, a state, folder names).
- **Create** (`src/server/requests/requests.ts`): the turns are read through `copilot.findTurn`, the caller's own
  threads only, so someone else's turn answers as a missing one; an SQL answer (*An answer written as SQL can't go on a
  dashboard*) and a source table's (*An editor must keep this table first*) are refused, each with its own sentence; a
  chart on a Live dataset goes as one on an extract. Every dataset must be open to the requester (`mustOpen`: `closed`)
  and still exist. A `dashboardId` must be one the requester reads (`getAnalysis` as them: a draft they cannot read, a
  closed or a missing one answer alike, *not one you can open*), and its name becomes the request's; a `folderId` must
  be one they open (`closed` otherwise, naming nothing). Anyone who reads the project may send one; the web offers
  **Request a dashboard** to viewers only.
- **Approvers**: `openers(…, 'edit')` per dataset the charts read, and on the named dashboard, intersected, never the
  requester — org admins, project admins, and editors whose team has Edit on every one's folder; with no folder, the
  project's writers. With nobody left, the send says so and nothing is written.
- **Not twice, not a flood** (shared counters, as asks): the same charts (`stableStringify` of the forms, hashed) from
  the same person in the same project within a day are *already sent*; at most `REQUESTS_PER_DAY` (10) a person a day,
  across projects; and at most `OPEN_PER_PROJECT` (20) open per person in a project, counted inside the insert's
  transaction under an advisory lock on them and the project (two sends at once cannot both pass), refused typed
  (`code: 'too_many_open'`). A refused or failed send is given back. A withdrawal clears its *already sent* key, so the
  same charts asked again are a new request.
- **Withdraw** (`withdrawRequest`): the requester's open request, unless an approval holds it (*someone is approving
  it*), becomes `withdrawn` (`decided_by` the requester) in one statement, and the approvers' bell rows are deleted in
  the same transaction; a `requests:changed` push (state `withdrawn`, no toast) refreshes their bells. Nothing is made;
  approving after it is *already decided*; the review page says *Priya withdrew it*.
- **Review and approve share one function** (`planOf`): every chart through `computeCard` (THE answer door: folders,
  row access rules, hidden columns) as the reviewer, and where it lands — `landsIn(projectId, undefined, datasets)`:
  the first dataset's folder outside Everyone, else Everyone, refused unless the reviewer edits it — or the requester's
  suggested folder, or the one the reviewer picks, when among the **choices** (`./where.ts` `folderChoices`): the
  folders the reviewer edits that the requester opens (their access resolved in a context of their own, as they are
  now), so *ready* never names a dashboard its requester cannot open. A pick outside them is refused (*Pick a folder you
  edit and Priya can open*), even to an org admin, before the claim. The preview carries the choices and the
  suggestion's name (only when the reviewer opens it). Approving runs it
  again and makes exactly that: each chart through `saveCardAsVisual` (Save as visual's path, a version each), one
  dashboard of them (`arrangeSheet` and `sanitizeCards`, the plan builder's arrangement and whitelist; a version)
  inside `withLanding`, so it is placed before its record is written, then Publish itself (`drafts.publish`, with
  D16). Every action needs `mustEdit` on every dataset the charts read and on the named dashboard: an editor who cannot
  open one is `closed`, one who only views its folder `edit`; a viewer never reaches it (`write`). A chart that cannot
  be drawn now makes nothing and says which.
- **An existing dashboard**: the charts are saved as visuals and added to its DRAFT as one new sheet, *Requested by
  Priya* (`updateAnalysis` under its lock, a version), never a new dashboard. Approve and publish then publishes it —
  unless its draft already had edits nobody published (`statusOf` `edited`, read under the lock): then nothing is
  published, the request is `drafted`, the reply says why (*Its draft already had edits nobody published …*), and its
  next Publish approves the request and tells the requester. The preview says which (`creates.onto.publishes`).
- **Exactly one**: an approval first *claims* the open row (`decided_by` / `decided_at` set, state still open; a claim
  older than ten minutes may be taken again), so two approvers at once make one dashboard; a failure before anything
  is made gives the claim back; a dashboard made but refused at Publish (D16 on a related dataset) is recorded as
  `drafted`, never made twice. Decline takes an unclaimed row in one statement.
- **Told** (the mention path, never in the reply's way): on create, a bell row and a `requests:changed` push (ids,
  names and the state, never the title, a chart or the note) to each approver, and an email (title, the charts' titles,
  the note, the review link) to those with `users.request_email` on — the same switch as Ask an editor, now labelled
  **Email me about data asks and dashboard requests** — under the mention email budget. On approval or decline, the
  requester's row (new again), push (with the dashboard id when approved) and email (*Your dashboard … is ready* with
  its link, or *… was declined* with the note); the approvers' rows are marked seen. **Edit** tells nobody: Publish's
  hook (`dashboardPublished`, one UPDATE, in `publishDashboard.publish`, so MCP's publish counts too) marks the
  request approved and tells the requester then. The badge (`unseenCount`, on `/api/auth/me`) and `mentions:seen`
  count and mark the request rows too.
- **The web**: *Request a dashboard* on a viewer's answer card (`RequestDashboard.tsx`: the conversation's chart
  answers to tick — its SQL and source-table answers listed but never ticked, each with its sentence — **Put the charts
  on** a new dashboard (a name, and a **Folder (optional)** among those they open, when there is more than Everyone) or
  **a dashboard already there** (one they open), a note); the bell's **Dashboard requests** (`RequestsForYou.tsx`: an
  approver's row opens the review page; the requester's waiting row has **Withdraw**, their ready row opens the
  dashboard, a declined one shows the note) and its toasts; the review page `/requests/:projectId/:requestId`
  (`RequestReviewPage.tsx`: the charts, the note, *Approving makes* — a sheet on the named dashboard, or a new one with
  *Priya suggested Shared* and a **Folder** picker among the choices — **Approve and publish**, **Edit**,
  **Decline…**, and a decided or withdrawn request's outcome with a link). Editors' own *Add to dashboard* on an
  answer does not exist yet; only the viewer's request was built.
- **Tested**: `scripts/test-dashboardRequests.ts` (10 checks without a database, 103 with; the rest of E9 in
  `scripts/dashboardRequestsMore.ts`, run on its bench) — the contracts; no db; who
  is told (NEGATIVE CONTROLS: an Everyone-only editor, an editor viewing Ops, another viewer and the requester are not;
  on Plain both editors are); someone else's turn; 403 without a grant; the canary (no figure of the charts in either
  table; NEGATIVE CONTROL: the viewer's kept turns hold them); the email; the preview's figures `Object.is` the door's
  as the reviewer (NEGATIVE CONTROL: the requester's own, under a row rule, differ) and its list equal to what
  approval made; refusals (`closed`, `edit`, 403) making nothing (control: the Ops lead may); one dashboard, in Ops,
  published, the requester told and reading its copy; a second approval and two at once make no second; Edit tells no
  one until Publish; decline; dedupe; the limit (control: another person, whose Plain request lands in Everyone); seen
  and the badge; RLS. Then withdraw (NEGATIVE CONTROLS: another viewer, an approver, a held claim; another request's
  rows stand), an existing dashboard (NEGATIVE CONTROL: Everyone-only editors neither told nor allowed; a draft with
  edits not published), the folders (NEGATIVE CONTROL: the reviewer's Finance is no choice, even for the admin), SQL
  and source-table answers (control: a chart goes), a Live chart (NEGATIVE CONTROL: the warehouse down makes nothing),
  the cap (control: another person sends), a project's deletion (control: another project's rows stay). Vitest
  `web/src/features/dashboards/requests/requests.test.tsx` (17); e2e `web/e2e/requests.e2e.ts` (Postgres): Priya
  requests from the Assistant, Sam reviews from the toast and approves, Priya opens it from the bell, then asks for a
  chart on that dashboard and withdraws it — screens `requests-dialog`, `-dialog-onto`, `-review`, `-review-phone`,
  `-bell`, `-bell-phone`, `-dashboard`, `-withdraw`, `-withdraw-phone`, both themes.
- **Project deletion** drops its requests (`dropGrants`, beside its team tables), and their bell rows with them
  (ON DELETE CASCADE).
- **Left**: *No longer available*; a source table's answer made into a Live dataset at approval and an SQL answer kept
  as SQL (the Live dataset and *Not checked* lines of the preview) — both refused for now, with their sentences; *Priya
  sees fewer rows*; *Older* after 30 days.

## Migrations

Numbers are the next free ones when each PR lands: 0029 was the last on `develop` and 0030–0031 went to
other open PRs, so E1 took 0032. 0033 went to an open PR (#525, `editor_asks`) and 0031 to the spelling PR (#526), so E4
took 0034 and every row after it moved on by one; they stay provisional. All additive, forced
row-level security on `ordinate.org` like 0020 and later, org ids `text`, ids compared in "C".

| Migration | What |
|---|---|
| 0032 `folders` (E1, as built) | `folders (org_id, project_id, id, parent_id NULL, name, share_figures bool default true, created_by, created_at)`, `id <> project_id`, names 1–120 characters, and a generated `parent_folder` (= `NULLIF(parent_id, project_id)`) with a foreign key to the parent, so a parent in another project and deleting a folder that has subfolders are refused (a whole subtree goes in one statement); a unique index on `(org_id, project_id, coalesce(parent_id, <the zero uuid>), lower(name))`; `folder_grants (org_id, project_id, folder_id, team_id, level CHECK IN ('view','edit'))`, PK `(org_id, project_id, folder_id, team_id)`, an index by team, with `(team_id, org_id)` → `teams` ON DELETE CASCADE and → `folders` ON DELETE CASCADE; `folder_items (org_id, project_id, kind, item_id text, folder_id, moved_by, moved_at)`, PK `(org_id, project_id, kind, item_id)`, `item_id` lowercase-checked, → `folders` ON DELETE RESTRICT; an index on `(org_id, project_id, folder_id)` |
| 0033 `editor_asks` (Ask an editor, as built) | `editor_asks (org_id, user_email, id, project_id, asker, question, reason, note, created_at, seen_at)`, forced RLS; `users.request_email boolean NOT NULL DEFAULT false` ("Email me when a viewer asks for data"; dashboard requests reuse it) |
| 0034 `search_anchors` (E4, as built) | `ordinate_turn_datasets(body)` (an Assistant turn's chart, "Did you mean" and SQL answer datasets, `{}` for a body that is no JSON: the conversation list's count of shown turns); `search_entries.anchor_kind`, `anchor_id` (nullable, no table rewrite, `COLLATE "C"`); `verified_keys.reads` (every dataset a verified question reads: an SQL question's all); `search_anchors_stale()` and the trigger `records_search_anchors_written` (INSERT or UPDATE on `records`): a write whose transaction does not set `ordinate.search_anchors` = 'on' drops that ⌘K source's marker, or the project's verified one, 0030's pattern. No DELETE trigger: an older pod's delete removes its rows as this release would |
| 0035 `dashboard_reads` (E5, as built) | `dashboard_reads (org_id, project_id, analysis_id, dataset_id)`, lowercase-checked, PK on all four, an index by dataset; `dashboard_reads_built (org_id, project_id, version)`; two triggers on `records` (`projects/%/analyses/%`) for writers without `ordinate.folders`: that dashboard's rows and the project's marker go |
| 0036 `team_tables` (E8, as built) | `team_tables (org_id, project_id, team_id, conn_id, schema, table_name NULL, include bool, hidden text[], granted_by, granted_at)`, unique on `(org_id, project_id, team_id, conn_id, schema, coalesce(table_name, ''))`, `hidden` on include table rows only, team → `teams` ON DELETE CASCADE, forced RLS; `assistant_search.audience` CHECK widened to `viewer` (a documented table's labelled row) |
| 0037 `dashboard_requests` (E9, as built) | `dashboard_requests (org_id, id, project_id, requester, title, note, charts jsonb, state, decided_by, decided_at, answer, dashboard_id, created_at)` with partial indexes for the open ones and the drafted ones by dashboard, and one by requester; `dashboard_request_inbox (org_id, user_email, request_id, project_id, role, created_at, seen_at)` → `dashboard_requests` ON DELETE CASCADE; forced RLS on both (`users.request_email` is 0033's, reused) |
| 0038 `dashboard_requests_more` (E9, as built) | `dashboard_requests.state` CHECK widened to `withdrawn` (`NOT VALID`, no row changes); `target_id uuid` and `folder_id uuid`, nullable; `dashboard_requests_open_by (org_id, project_id, requester) WHERE state = 'open'` |
| 0039 `turn_facts` (history, as built) | `ordinate_turn_shows(body)`: 0034's `ordinate_turn_datasets` and an answer's `factsFrom` (the datasets its facts were built from), for the conversation list's count of shown turns and its WHERE; 0034's function stays for an older pod |
| 0040 `turn_dashboards` (history, as built) | `ordinate_turn_dashboards(body)`: an answer's `dashboardsFrom` (the dashboard it was asked about), for the conversation list's count and WHERE and the rename's count beside 0039's; 0039's stays for an older pod |

`kind` in `folder_items` has no CHECK: the app validates it (`dataset`, `dashboard`), so a later
placed kind needs no constraint change.

## Upgrade and rollback

- **Upgrade changes nothing anyone sees.** No placement rows means everything is in Everyone at the
  project role; the per-dashboard audience rule gives every project member today's audience; ⌘K
  rebuilds each source once (`INDEX_VERSION` 3); `dashboard_reads` builds per project on first need.
- **Nobody can make a folder until every pod has the readers (D22).** E7 merged without a release
  after E1–E6, so `ORDINATE_FOLDERS` is off by default and an operator turns it on once every pod
  runs a release with the readers; `docs/server/upgrade.md` says so. A pod older than the readers
  shows every folder's items to every project member.
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
| — | ~~**Release tag** with E1–E6 (D22)~~: replaced at E7 by `ORDINATE_FOLDERS`, off by default, and the upgrade.md section | |
| E7 | `src/api/folders.ts`: `folder:tree`, `folder:create`, `folder:rename`, `folder:delete`, `folder:setShareFigures`, `folder:access`, `folder:grant`, `folder:moveImpact`, `folder:move`; the rail, chips, Move dialog, Share → Folders, Admin → Teams → Folders, empty states; *Move everything to Everyone* | `test-folderChannels` (depth, names, delete-empty, admin-only top level, the move hash); safety net 11; `folders.e2e.ts` in both themes |
| E8 | Connection tables: 0036, `teamTables:*`, the Tables screen, index keys for tables, the viewer answer and Explore path (with or after phase D) | `test-teamTables` (include, exclude, schema, union, hidden columns); safety net: an unticked table's name in no viewer reply or prompt |
| E9 | Dashboard requests: 0037 and 0038, `src/api/requests.ts`, Home rows, the review page, pushes and email | `test-dashboardRequests`; `requests.e2e.ts` |

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
