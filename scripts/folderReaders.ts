// Every `read` and `write` contract with its folder class: how shared folders cover it — the inventory of
// docs/team-folders/00-design.md ("Readers, by area") as code. A contract missing here fails section 1 of
// scripts/test-folderSafetyNet.ts: classify it, and say how it is covered when the class does not, in the
// PR that adds it. `admin` contracts are left out: only rank 3 reaches them, and rank 3 opens every folder.
// A channel whose access changes moves between READS and WRITES (the net reports one left behind).
//
//   LIST     a list: items the caller cannot open are left out
//   ITEM     names an item: null or not found when closed; bookmarks get `closed` (folder:of)
//   FIGURE   a door, or the column names and types a chart needs: the dataset open or reached (D9)
//   OPEN     dataset content beyond figures: open only (`figures_only` on a reached dataset)
//   INDEX    a search over an index, filtered in its WHERE (D13)
//   ASK      the Assistant: index-filtered facts, named items checked open
//   SEND     builds what others receive: recipients narrowed, figures by reach (D17)
//   EXPORT   a file of an item the caller opens
//   OWN      the caller's own state; item names in it filtered
//   PROJECT  project-level, no folder
//   EDIT     a write on an existing item: Edit on its folder (D18)
//   CREATE   a write that makes an item: Edit on the target folder (D18)
//   FOLDER   the folder and request channels, with their own rules (E7, E9)
//
// E1 classifies; E2–E6 make each class hold, and the safety net's later sections prove it per class.

export type FolderClass = 'LIST' | 'ITEM' | 'FIGURE' | 'OPEN' | 'INDEX' | 'ASK' | 'SEND' | 'EXPORT' | 'OWN' | 'PROJECT' | 'EDIT' | 'CREATE' | 'FOLDER';

export const READS: Readonly<Record<string, FolderClass>> = {
  'agent:list': 'LIST', // agents are project-level; their topics' members filtered to what the caller opens
  'ai:setMine': 'OWN',
  'ai:status': 'PROJECT',
  'alerts:list': 'LIST',
  'alerts:markSeen': 'OWN',
  'alerts:test': 'SEND',
  'analysis:draft': 'OPEN', // the Assistant's plan over a dataset's columns and values
  'analysis:gallery': 'LIST',
  'analysis:open': 'ITEM',
  'analysis:previewPlan': 'OPEN', // a template mapping's previews: authoring, not a dashboard's reach
  'analysis:tiles': 'FIGURE',
  'answer:alsoOn': 'LIST', // the dashboards showing an open dataset: dashboards in closed folders left out
  'answer:card': 'OPEN', // a source table is no folder's: a viewer's only when their team was given it (E8, src/ipc/sourceAnswers.ts sourceView)
  'answer:explain': 'FIGURE',
  'answer:refresh': 'ASK',
  'answer:rerun': 'ASK',
  'asset:read': 'PROJECT',
  'boundary:get': 'PROJECT',
  'boundary:list': 'PROJECT',
  'branding:logo': 'PROJECT',
  'calendar:today': 'PROJECT',
  'captureDataset:get': 'ITEM',
  'captureDataset:image': 'ITEM',
  'captureDataset:list': 'LIST',
  'captureDataset:status': 'PROJECT',
  'catalog:columns': 'OPEN',
  'catalog:get': 'ITEM',
  'catalog:getTable': 'OPEN',
  'catalog:instructions': 'PROJECT',
  'catalog:list': 'LIST',
  'catalog:tags': 'LIST',
  'channel:list': 'PROJECT',
  'comment:add': 'ITEM', // comments follow the record they are on
  'comment:delete': 'ITEM',
  'comment:deleteReply': 'ITEM',
  'comment:edit': 'ITEM',
  'comment:list': 'LIST',
  'comment:mentionable': 'ITEM', // readers who can open the target
  'comment:reopen': 'ITEM',
  'comment:reply': 'ITEM',
  'comment:resolve': 'ITEM',
  'connections:list': 'PROJECT', // p2-01 still decides what a viewer reads of a connection
  'connectors:catalog': 'PROJECT',
  'connectors:logos': 'PROJECT',
  'copilot:ask': 'ASK', // E4: the indexes' folder WHERE; the turns it replays leave closed answers out (src/ipc/turnsOpen.ts). E8: a viewer's source tables, by the given-tables WHERE
  'copilot:deleteThread': 'OWN',
  'copilot:history': 'ASK', // E4: an answer on a closed dataset and its question are not sent (src/ipc/turnsOpen.ts)
  'copilot:newThread': 'OWN',
  'copilot:renameThread': 'OWN',
  'copilot:threads': 'OWN', // E4: a title taken from such a question reads untitled
  'dashboard:asOfStamps': 'FIGURE',
  'dashboard:exportHtml': 'EXPORT',
  'dashboard:metric': 'FIGURE',
  'dataSearch:query': 'INDEX',
  'dataset:columns': 'FIGURE',
  'dataset:composePreview': 'OPEN',
  'dataset:distinct': 'FIGURE',
  'dataset:list': 'LIST',
  'dataset:liveSchema': 'OPEN',
  'dataset:page': 'OPEN',
  'dataset:profile': 'OPEN',
  'dataset:source': 'OPEN',
  'dataset:stats': 'OPEN',
  'dataset:suggestCalcField': 'OPEN',
  'dataset:suggestSteps': 'OPEN',
  'drivers:explain': 'OPEN',
  'drivers:explainAlert': 'OPEN',
  'drivers:explainPoint': 'OPEN',
  'editors:ask': 'PROJECT', // a viewer's ask goes to the project's editors and admins; E3 narrows them to who can open what it names
  'embed:columns': 'ITEM', // a dashboard's filterable columns for a signed embed
  'embed:status': 'PROJECT',
  'events:list': 'PROJECT',
  'explore:suggest': 'OPEN',
  'folder:of': 'FOLDER', // a bookmark's check: `closed` for an item that exists in a folder the caller cannot open, names nothing
  'folder:tree': 'FOLDER', // the folders the caller opens and where items in them sit; teams' names on those only (test-folderChannels)
  'format:colors:get': 'PROJECT', // the project's colour map: values any chart dealt, so a closed folder's values are E2's to withhold (as row rules' REDACT)
  'formula:check': 'OPEN',
  'formula:functions': 'PROJECT',
  'fx:get': 'PROJECT',
  'geo:boundarySources': 'PROJECT',
  'geo:resolvePlace': 'PROJECT',
  'geo:spatialPreview': 'OPEN',
  'home:overview': 'LIST',
  'incremental:get': 'OPEN',
  'input:load': 'OPEN',
  'input:lookups': 'LIST', // every other dataset with its columns
  'insights:list': 'LIST',
  'jobs:cancel': 'OWN',
  'jobs:clear': 'OWN',
  'jobs:list': 'OWN',
  'key:status': 'PROJECT',
  'lineage:column': 'ITEM',
  'lineage:fields': 'ITEM',
  'lineage:get': 'ITEM',
  'mentions:list': 'OWN',
  'mentions:prefs': 'OWN',
  'mentions:seen': 'OWN',
  'mentions:setPrefs': 'OWN',
  'metric:check': 'FIGURE',
  'metric:get': 'ITEM',
  'metric:list': 'LIST',
  'metric:preview': 'FIGURE',
  'metric:table': 'FIGURE',
  'metric:values': 'FIGURE',
  'metricTree:compute': 'FIGURE',
  'metricTree:suggest': 'LIST',
  'model:navigation': 'LIST',
  'model:overview': 'LIST',
  'numbers:follow': 'OWN',
  'numbers:get': 'OWN', // the caller's followed metrics: names and figures filtered to what they open
  'onboarding:set': 'OWN',
  'onboarding:status': 'OWN',
  'onboarding:visit': 'OWN',
  'period:picker': 'PROJECT',
  'pipelines:get': 'PROJECT', // a step naming a dataset the caller can't open reads "a dataset you can't open"
  'pipelines:preview': 'PROJECT',
  'plan:check': 'ASK',
  'prefs:get': 'OWN',
  'prepare:get': 'OPEN',
  'prepare:similarValues': 'OPEN',
  'prepare:stepPreview': 'OPEN',
  'privacy:overview': 'LIST',
  'privacy:review': 'OPEN',
  'privacy:summary': 'LIST',
  'project:access': 'PROJECT',
  'projects:list': 'PROJECT',
  'projects:open': 'PROJECT',
  'projects:overview': 'LIST', // its counts are of what the caller opens
  'projects:roles': 'OWN',
  'publish:plan': 'SEND',
  'publish:sites': 'LIST',
  'publish:targets': 'LIST',
  'quality:failingRows': 'OPEN',
  'quality:list': 'OPEN',
  'quality:preview': 'OPEN',
  'rebuild:match': 'OPEN',
  'rebuild:read': 'PROJECT', // a screenshot's structure: no dataset
  'recent:list': 'LIST',
  'relationship:list': 'LIST',
  'relationship:related': 'LIST', // the related datasets' columns: closed ones left out
  'relationship:suggest': 'OPEN',
  'report:build': 'EXPORT',
  'report:preview': 'EXPORT',
  'reports:get': 'ITEM',
  'reports:list': 'LIST',
  'reports:open': 'ITEM',
  'request:create': 'FOLDER', // the caller's own answer turns on datasets they open (`closed` otherwise); an existing dashboard they open (else as none) or a folder they open (`closed` otherwise); tells those with Edit on every one (E9)
  'request:folders': 'FOLDER', // the folders the caller opens, by name: Everyone and the rest of their access (E9)
  'request:withdraw': 'FOLDER', // the caller's own open request only; someone else's answers as none (E9)
  'scenario:compare': 'OPEN', // scenarios have no reach: every dataset they read must be open
  'scenario:compute': 'OPEN',
  'scenario:get': 'ITEM',
  'scenario:list': 'LIST',
  'scenario:metrics': 'LIST',
  'scenario:targets': 'LIST',
  'scorecard:compute': 'FIGURE',
  'scorecard:detail': 'FIGURE',
  'scorecard:get': 'ITEM',
  'scorecard:list': 'LIST',
  'search:query': 'INDEX', // E4: each row's anchor in the WHERE (0034, src/server/authz/folderSql.ts)
  'segments:features': 'OPEN',
  'segments:fit': 'OPEN',
  'segments:rfm': 'OPEN',
  'snapshots:diff': 'OPEN',
  'snapshots:list': 'OPEN',
  'snapshots:stamps': 'OPEN',
  'sql:datasetQuery': 'OPEN',
  'sql:explain': 'OPEN',
  'sql:run': 'OPEN',
  'sql:schema': 'OPEN',
  'starred:get': 'LIST',
  'starred:set': 'OWN',
  'stats:dashboards': 'LIST',
  'stats:pair': 'OPEN',
  'stats:run': 'OPEN',
  'story:draft': 'OPEN',
  'story:export': 'EXPORT',
  'story:figures': 'FIGURE',
  'story:get': 'ITEM',
  'story:list': 'LIST',
  'subscription:get': 'ITEM',
  'subscription:history': 'ITEM',
  'subscription:list': 'LIST',
  'subscription:preview': 'SEND',
  'summary:compute': 'FIGURE',
  'summary:rewrite': 'FIGURE', // narrates the figures summary:compute computed
  'template:list': 'OPEN',
  'template:plan': 'OPEN',
  'teamTables:mine': 'FOLDER', // a viewer's given source tables by label (E8): a table is in no folder, its teams' ticks decide
  'term:get': 'ITEM',
  'term:list': 'LIST',
  'term:usage': 'ITEM', // names of the records that use a term: filtered
  'text:preview': 'OPEN',
  'text:profile': 'OPEN',
  'themes:list': 'PROJECT',
  'slack:myLink': 'OWN', // the caller's own Slack link
  'slack:openQuestion': 'OWN', // the caller's own Slack question (a channel question's words for anyone who may ask in its project)
  'slack:unlink': 'OWN',
  'research:card': 'FIGURE', // a door per step kind (answer:card, the SQL gate, driversVizData): the dataset open or reached
  'research:get': 'ITEM', // the starter's own run; not found once a dataset a computed step read is closed to them (src/server/research/rpc.ts, the rule of src/ipc/turnsOpen.ts)
  'research:list': 'OWN', // the caller's own runs
  'tokens:create': 'OWN',
  'tokens:list': 'OWN',
  'tokens:revoke': 'OWN',
  'topic:get': 'ITEM', // members filtered
  'trash:list': 'LIST',
  'verified:checkResult': 'LIST', // a result on a closed dataset left out
  'verified:list': 'LIST',
  'versions:diff': 'ITEM',
  'versions:figures': 'FIGURE',
  'versions:get': 'ITEM',
  'versions:list': 'LIST',
  'visual:data': 'FIGURE',
  'visual:dataBatch': 'FIGURE',
  'visual:drillDown': 'FIGURE',
  'visual:get': 'ITEM',
  'visual:list': 'LIST',
  'visual:preview': 'FIGURE',
  'visual:rows': 'FIGURE', // figures flag: the rows behind a mark (pageFor)
  'visual:rowsDownload': 'FIGURE',
  'visual:suggest': 'OPEN',
  'visual:thumbs': 'FIGURE',
};

export const WRITES: Readonly<Record<string, FolderClass>> = {
  'agent:instructions': 'PROJECT',
  'research:addToProject': 'CREATE', // saves each cited chart as a visual and makes a Story: Edit on the target folder (answer:saveVisual's and story:create's rules)
  'research:resume': 'OWN', // the caller's own run, queued again
  'research:start': 'OWN', // the caller's own run and conversation turn; its steps run through the doors, as the starter
  'research:stop': 'OWN', // the caller's own run
  'alerts:delete': 'EDIT',
  'alerts:fromAnswer': 'FIGURE', // the alert dialog's figure, through the alert's own door (testRule)
  'alerts:patch': 'EDIT',
  'alerts:save': 'CREATE', // a rule follows its dashboard, else its dataset
  'alerts:setDigest': 'OWN',
  'analysis:buildPlan': 'CREATE', // creates the plan's fields, visuals and dashboard
  'analysis:create': 'CREATE',
  'analysis:delete': 'EDIT',
  'analysis:discard': 'EDIT',
  'analysis:publish': 'EDIT', // and D16: refuses to start sharing a dataset the publisher cannot open (E5)
  'analysis:rename': 'EDIT',
  'analysis:starterCards': 'CREATE', // builds visual records on a dataset
  'analysis:unpublish': 'EDIT',
  'analysis:update': 'EDIT',
  'analysis:view': 'EDIT', // saved views follow their dashboard
  'answer:addToDashboard': 'CREATE', // a visual, and a tile on a dashboard's draft (Edit on its folder) or a new one landed with its dataset
  'answer:keepTable': 'CREATE', // makes the Live dataset of a source table an editor's answer read (phase D)
  'answer:saveVisual': 'CREATE',
  'asset:importImage': 'PROJECT',
  'boundary:import': 'PROJECT',
  'captureDataset:delete': 'EDIT',
  'captureDataset:draft': 'CREATE',
  'catalog:addAlias': 'EDIT',
  'catalog:checkKey': 'OPEN', // counts the dataset's rows
  'catalog:dismissSuggestion': 'EDIT',
  'catalog:set': 'EDIT',
  'catalog:setColumn': 'EDIT',
  'catalog:setInstructions': 'PROJECT',
  'catalog:setTable': 'EDIT',
  'catalog:suggestions': 'LIST', // a dataset's (or the project's) suggested meanings
  'connection:addSemanticDataset': 'CREATE',
  'connection:delete': 'PROJECT',
  'connection:deleteQuery': 'PROJECT',
  'connection:describe': 'PROJECT',
  'connection:estimate': 'PROJECT',
  'connection:explain': 'PROJECT',
  'connection:import': 'CREATE',
  'connection:listTables': 'PROJECT',
  'connection:refresh': 'EDIT', // refreshes one dataset
  'connection:replaceSecret': 'PROJECT',
  'connection:run': 'PROJECT',
  'connection:sample': 'PROJECT',
  'connection:saveQuery': 'PROJECT',
  'connection:semanticModels': 'PROJECT',
  'connection:setLiveOptIn': 'PROJECT',
  'connection:testAndSave': 'PROJECT',
  'dataset:addStep': 'EDIT',
  'dataset:composeSave': 'CREATE',
  'dataset:copyLive': 'CREATE',
  'dataset:delete': 'EDIT',
  'dataset:parsePaste': 'OWN', // stages a parsed table for the caller (no project): dataset:composeSave lands it (E6)
  'dataset:pickAndParse': 'OWN', // stages a parsed upload for the caller: dataset:composeSave lands it (E6)
  'dataset:refresh': 'EDIT',
  'dataset:removeStep': 'EDIT',
  'dataset:reorderSteps': 'EDIT',
  'dataset:setMode': 'EDIT',
  'dataset:setSourceTables': 'EDIT',
  'dataset:setSteps': 'EDIT',
  'dataset:sourceTableChoices': 'EDIT', // dataset:setSourceTables' picker
  'dataset:syncLiveSchema': 'EDIT',
  'dataset:update': 'EDIT',
  'dataset:updateStep': 'EDIT',
  'drivers:addTile': 'EDIT', // adds a tile to a dashboard
  'embed:preview': 'SEND', // what an embed's audience is shown (D17: the link's audience)
  'events:delete': 'PROJECT',
  'events:importCsv': 'PROJECT',
  'events:save': 'PROJECT',
  'events:setCalendars': 'PROJECT',
  'explore:keepTable': 'CREATE', // Explore's Keep as a dataset: the Live dataset of a source table (phase D), as answer:keepTable
  'folder:create': 'FOLDER', // a top-level folder by a project admin, a subfolder with Edit on its parent (test-folderChannels)
  'folder:delete': 'FOLDER', // an empty folder only: `not_empty`; a top-level one by a project admin
  'folder:move': 'FOLDER', // Edit where each item is and where it goes; the hash refuses a stale warning (safety net 11)
  'folder:moveImpact': 'FOLDER', // who loses and gains access, as head counts by team: Edit on both ends, as the move
  'folder:rename': 'FOLDER',
  'format:colors:assign': 'PROJECT',
  'format:colors:palette': 'PROJECT',
  'format:colors:reset': 'PROJECT',
  'format:colors:set': 'PROJECT',
  'fx:dashboard': 'EDIT',
  'geo:saveSpatialStep': 'EDIT',
  'incremental:set': 'EDIT',
  'input:create': 'CREATE',
  'input:save': 'EDIT',
  'input:setColumns': 'EDIT',
  'insights:dismiss': 'EDIT',
  'live:checkCalc': 'OPEN',
  'live:setBaseFilters': 'EDIT',
  'live:setCalculated': 'EDIT',
  'metric:delete': 'EDIT',
  'metric:duplicate': 'CREATE',
  'metric:ensureDefaults': 'CREATE',
  'metric:save': 'CREATE',
  'metric:update': 'EDIT',
  'metricTree:addToDashboard': 'EDIT',
  'metricTree:save': 'CREATE', // a metric tree follows every metric it reads
  'model:export': 'EXPORT',
  'model:exportOssie': 'EXPORT',
  'model:importApply': 'CREATE',
  'model:importPlan': 'CREATE', // what model:importApply would write
  'pipelines:run': 'EDIT', // the project's pipeline, run as the system: Edit on every dataset it names (E6)
  'pipelines:setNodeSchedule': 'EDIT', // the project's pipeline: Edit on every dataset it names (E6)
  'pipelines:setPaused': 'EDIT', // the project's pipeline: Edit on every dataset it names (E6)
  'pipelines:setPolicy': 'EDIT', // the project's pipeline: Edit on every dataset it names (E6)
  'pipelines:setSchedule': 'EDIT', // the project's pipeline: Edit on every dataset it names (E6)
  'plan:fix': 'CREATE', // a plan's steps make items: Edit on the target folder
  'plan:next': 'CREATE',
  'plan:skip': 'CREATE',
  'plan:start': 'CREATE',
  'plan:stop': 'CREATE',
  'plan:undo': 'CREATE',
  'privacy:decide': 'EDIT',
  'privacy:scan': 'EDIT',
  'projects:create': 'PROJECT',
  'projects:import': 'PROJECT', // a new project whose only grant is its creator's: everything in Everyone
  'projects:rename': 'PROJECT',
  'publish:access': 'EDIT',
  'publish:run': 'EDIT',
  'publish:unpublish': 'EDIT',
  'quality:delete': 'EDIT',
  'quality:run': 'EDIT',
  'quality:save': 'CREATE',
  'refreshHook:create': 'EDIT',
  'refreshHook:list': 'EDIT',
  'refreshHook:revoke': 'EDIT',
  'relationship:delete': 'EDIT',
  'relationship:save': 'CREATE', // both datasets open, Edit on one
  'reports:create': 'CREATE',
  'reports:delete': 'EDIT',
  'reports:duplicate': 'CREATE',
  'reports:generated': 'EDIT',
  'reports:update': 'EDIT',
  'request:approve': 'FOLDER', // Edit on every dataset the charts read and on the dashboard it names; a new one lands as E6's landsIn says or in a picked folder the caller edits and the requester opens, and is published through Publish (E9)
  'request:decline': 'FOLDER', // Edit on every dataset the charts read (E9)
  'request:preview': 'FOLDER', // Edit on every dataset the charts read and on the dashboard it names; each chart through THE answer door as the reviewer; folder names only of those the reviewer edits and the requester opens (E9)
  'sample:seed': 'PROJECT',
  'scenario:create': 'CREATE',
  'scenario:delete': 'EDIT',
  'scenario:duplicate': 'CREATE',
  'scenario:update': 'EDIT',
  'scorecard:create': 'CREATE',
  'scorecard:createReport': 'CREATE',
  'scorecard:delete': 'EDIT',
  'scorecard:duplicate': 'CREATE',
  'scorecard:update': 'EDIT',
  'segments:rfmSave': 'CREATE', // a new RFM dataset: lands with the one it reads (D18)
  'segments:saveColumn': 'EDIT',
  'snapshots:restore': 'EDIT',
  'snapshots:setKeep': 'EDIT',
  'sourceTable:delete': 'PROJECT',
  'sourceTable:forDataset': 'ITEM',
  'sourceTable:get': 'PROJECT',
  'sourceTable:lineage': 'LIST', // the records that read a source table
  'sourceTable:list': 'PROJECT',
  'sourceTable:read': 'PROJECT',
  'sourceTable:save': 'PROJECT',
  'sql:prepareSave': 'OPEN', // runs the SQL (the net refuses a closed dataset) and stages the result: composeSave's `sql` origin lands it with the datasets it reads (E6)
  'stats:addToDashboard': 'EDIT',
  'stats:saveFormula': 'EDIT',
  'story:build': 'CREATE',
  'story:create': 'CREATE',
  'story:delete': 'EDIT',
  'story:update': 'EDIT',
  'subscription:delete': 'EDIT',
  'subscription:save': 'CREATE', // a subscription follows its dashboard
  'subscription:sendNow': 'SEND',
  'subscription:setEnabled': 'EDIT',
  'term:delete': 'EDIT',
  'term:save': 'CREATE',
  'term:update': 'EDIT',
  'text:commitStep': 'EDIT',
  'topic:delete': 'PROJECT',
  'topic:save': 'PROJECT',
  'trash:restore': 'EDIT',
  'verified:check': 'ASK', // checks the Assistant against every verified question
  'verified:delete': 'EDIT',
  'verified:save': 'CREATE',
  'versions:restore': 'EDIT',
  'visual:delete': 'EDIT',
  'visual:duplicate': 'CREATE',
  'visual:save': 'CREATE',
  'visual:update': 'EDIT',
};
