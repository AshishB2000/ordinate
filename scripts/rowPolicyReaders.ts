// Every `read` contract a project viewer can call, with how row access rules
// cover it — the inventory of docs/row-policy/00-design.md as code. A `read`
// contract missing here fails scripts/test-rowPolicySafetyNet.ts: classify it
// (and say how it is covered) before it ships.

export type Treatment = 'DOOR' | 'DOOR+' | 'LOCKED' | 'NET' | 'EXPLICIT' | 'SKIP' | 'REDACT' | 'FANOUT' | 'EXPORT' | 'META';

export const TREATMENT: Readonly<Record<string, Treatment>> = {
  'agent:list': 'META', // Assistant agents: names, topics by name and dataset id, teams by name, instructions (editor prose, as catalog:instructions)
  'ai:setMine': 'META',
  'ai:status': 'META',
  'alerts:list': 'REDACT',
  'alerts:markSeen': 'META', // writes the caller's own seen state; returns no row or figure
  'alerts:test': 'FANOUT',
  'analysis:draft': 'NET',
  'analysis:gallery': 'REDACT',
  'analysis:open': 'REDACT',
  'analysis:previewPlan': 'NET',
  'analysis:tiles': 'DOOR',
  'answer:alsoOn': 'META', // dashboard ids and names the caller may open (a viewer the published copies), found by dataset; no row, no figure
  'answer:card': 'DOOR', // a source table given to a viewer's team (E8) has no rules: the tick dialog says every row is theirs
  'answer:explain': 'DOOR',
  'answer:refresh': 'DOOR', // the caller's own answer turn's spec, through computeCard; its kept card replaced. An SQL answer's turn (src/ipc/answerSql.ts): its SQL through sql:run's gate, where the storage net refuses a restricted caller (NET); over Live datasets (F3, src/engine/live/liveSql.ts) printed under each table's lock (withLockOf per table); test-answerSql, test-liveSqlAnswers
  'answer:rerun': 'DOOR',
  'asset:read': 'META',
  'boundary:get': 'META',
  'boundary:list': 'META',
  'branding:logo': 'META',
  'calendar:today': 'META',
  'captureDataset:get': 'EXPLICIT',
  'captureDataset:image': 'EXPLICIT',
  'captureDataset:list': 'REDACT',
  'captureDataset:status': 'META',
  'catalog:columns': 'REDACT', // value labels name stored values: withheld from a caller closed to the dataset (src/app/columnLabelAccess.ts)
  'catalog:get': 'META',
  'catalog:getTable': 'REDACT', // keyCheck counts every row: withheld from a caller closed to the dataset
  'catalog:instructions': 'META', // editor prose (D5)
  'catalog:list': 'META',
  'catalog:tags': 'META',
  'channel:list': 'META',
  'comment:add': 'META',
  'comment:delete': 'META',
  'comment:deleteReply': 'META',
  'comment:edit': 'META',
  'comment:list': 'META',
  'comment:mentionable': 'META', // names of the project's current readers; no row, no figure
  'comment:reopen': 'META',
  'comment:reply': 'META',
  'comment:resolve': 'META',
  'connections:list': 'REDACT', // a caller who may not see source names gets id, name, connector, status and dataset count only (N2, p2-01)
  'connectors:catalog': 'META',
  'connectors:logos': 'META',
  'copilot:ask': 'EXPLICIT', // an SQL answer (src/ipc/answerSql.ts) and a verified SQL question's rerun go through sql:run's gate: a restricted caller is refused by the storage net, before any SQL is written (NET); over Live datasets (F3) the statement is printed under each table's lock (withLockOf per table, src/engine/live/liveSql.ts), test-liveSqlAnswers; test-answerSql
  'copilot:deleteThread': 'META',
  'copilot:history': 'EXPLICIT', // a kept answer card is sent only while the caller's row lock and hidden columns on its dataset match the ones it was computed under (src/ipc/answerSnapshots.ts); test-answerSnapshots
  'copilot:newThread': 'META',
  'copilot:renameThread': 'META',
  'copilot:threads': 'META',
  'dashboard:asOfStamps': 'META',
  'dashboard:exportHtml': 'EXPORT',
  'dashboard:metric': 'DOOR',
  'dataSearch:query': 'SKIP',
  'dataset:columns': 'META',
  'dataset:composePreview': 'NET',
  'dataset:distinct': 'LOCKED', // A source table target (`table`, Explore phase D): editors only, read inside its in-memory Live view; a viewer's is refused before any read (test-exploreSourceTables)
  'dataset:list': 'REDACT',
  'dataset:liveSchema': 'REDACT',
  'dataset:page': 'LOCKED',
  'dataset:profile': 'LOCKED',
  'dataset:source': 'META',
  'dataset:stats': 'NET',
  'dataset:suggestCalcField': 'NET',
  'dataset:suggestSteps': 'NET',
  'drivers:explain': 'NET',
  'drivers:explainAlert': 'NET',
  'drivers:explainPoint': 'NET',
  'editors:ask': 'META', // the caller's question, reason and note to the project's editors (src/server/mentions/asks.ts); returns no row or figure
  'embed:columns': 'META',
  'embed:status': 'META',
  'events:list': 'META',
  'explore:suggest': 'META', // A source table target (`table`, Explore phase D): editors only, read inside its in-memory Live view; a viewer's is refused before any read (test-exploreSourceTables)
  'folder:of': 'META', // whether a dataset or dashboard id is in a folder the caller cannot open: no row, no figure, no name
  'folder:tree': 'META', // folder names, levels, teams' names and which item ids sit where: no row, no figure
  'format:colors:get': 'REDACT',
  'formula:check': 'EXPLICIT',
  'formula:functions': 'META',
  'fx:get': 'META',
  'geo:boundarySources': 'META',
  'geo:resolvePlace': 'META',
  'geo:spatialPreview': 'NET',
  'home:overview': 'DOOR+', // standsOut's cards through the doors; its datasets redacted as dataset:list's (summariesFor)
  'incremental:get': 'REDACT',
  'input:load': 'NET',
  'input:lookups': 'META',
  'insights:list': 'EXPLICIT',
  'jobs:cancel': 'META',
  'jobs:clear': 'META',
  'jobs:list': 'META',
  'key:status': 'META',
  'lineage:get': 'META',
  'lineage:column': 'META', // names and counts of the records around one column, never a value (part 8)
  'lineage:fields': 'META',
  'mentions:list': 'META', // the caller's own mention rows; snippets of comments, never a row or figure
  'mentions:prefs': 'META',
  'mentions:seen': 'META',
  'mentions:setPrefs': 'META',
  'metric:check': 'DOOR',
  'metric:get': 'META',
  'metric:list': 'META',
  'metric:preview': 'DOOR',
  'metric:table': 'DOOR+',
  'metric:values': 'DOOR',
  'metricTree:compute': 'DOOR+',
  'metricTree:suggest': 'META',
  'model:overview': 'REDACT', // key counts and the values a filter step or formula quotes: withheld from a caller closed to the dataset
  'model:navigation': 'META', // hierarchy and column NAMES and the calendar's ladder: never a value, the same reply for every caller
  'numbers:follow': 'META', // the caller's own follow list; checks the metric or scorecard exists, returns no figure
  'numbers:get': 'DOOR+', // metric:series / metric:value / scorecard:compute handlers, as metric:table asks them
  'onboarding:set': 'META', // the caller's own fold and hide; returns no row or figure
  'onboarding:status': 'META',
  'onboarding:visit': 'META', // ticks the caller's own tour stop; returns no row or figure
  'period:picker': 'META',
  'pipelines:get': 'REDACT',
  'pipelines:preview': 'META',
  'plan:check': 'META',
  'prefs:get': 'META',
  'prepare:get': 'EXPLICIT',
  'prepare:similarValues': 'NET',
  'prepare:stepPreview': 'NET',
  'privacy:overview': 'META',
  'privacy:review': 'META',
  'privacy:summary': 'META',
  'project:access': 'META',
  'projects:list': 'REDACT',
  'projects:open': 'REDACT',
  'projects:overview': 'META',
  'projects:roles': 'META',
  'publish:plan': 'FANOUT',
  'publish:sites': 'META',
  'publish:targets': 'META',
  'quality:failingRows': 'EXPLICIT',
  'quality:list': 'REDACT',
  'quality:preview': 'NET',
  'rebuild:match': 'NET',
  'rebuild:read': 'META',
  'recent:list': 'META',
  'relationship:list': 'REDACT', // a warning's `repeats` counts every row of the TO dataset: withheld from a caller closed to it
  'relationship:related': 'META',
  'relationship:suggest': 'NET',
  'report:build': 'EXPORT',
  'report:preview': 'EXPORT',
  'reports:get': 'META',
  'reports:list': 'META',
  'reports:open': 'META',
  'request:create': 'META', // stores the caller's own answers' chart forms for the editors (src/server/requests); returns an id, never a row or figure
  'request:folders': 'META', // folder ids and names the caller opens; no row, no figure
  'request:withdraw': 'META', // the caller's own request's state; returns no row or figure
  'scenario:compare': 'NET',
  'scenario:compute': 'NET',
  'scenario:get': 'META',
  'scenario:list': 'META',
  'scenario:metrics': 'META',
  'scenario:targets': 'META',
  'scorecard:compute': 'DOOR+',
  'scorecard:detail': 'DOOR+',
  'scorecard:get': 'META',
  'scorecard:list': 'META',
  'search:query': 'META',
  'segments:features': 'NET',
  'segments:fit': 'NET',
  'segments:rfm': 'NET',
  'snapshots:diff': 'EXPLICIT',
  'snapshots:list': 'META',
  'snapshots:stamps': 'META',
  'sql:datasetQuery': 'META',
  'sql:explain': 'NET',
  'sql:run': 'NET',
  'sql:schema': 'META',
  'starred:get': 'META',
  'starred:set': 'META',
  'stats:dashboards': 'META',
  'stats:pair': 'NET',
  'stats:run': 'NET',
  'story:draft': 'NET',
  'story:export': 'EXPORT',
  'story:figures': 'DOOR',
  'story:get': 'META',
  'story:list': 'META',
  'subscription:get': 'META',
  'subscription:history': 'META',
  'subscription:list': 'META',
  'subscription:preview': 'FANOUT',
  'summary:compute': 'EXPLICIT',
  'summary:rewrite': 'EXPLICIT',
  'template:list': 'NET',
  'template:plan': 'NET',
  'teamTables:mine': 'META', // a viewer's given source tables by label (team folders E8): no row, no figure; test-exploreSourceTables
  'term:get': 'REDACT', // a restricted caller gets no filter value (ipc/terms termForCaller)
  'term:list': 'REDACT', // …and a definition without one
  'term:usage': 'META', // record names a viewer's own lists show (caller-aware stores); no value, row or figure
  'text:preview': 'NET',
  'text:profile': 'NET',
  'themes:list': 'META',
  'tokens:create': 'META',
  'slack:myLink': 'META', // the caller's own Slack link: ids and a workspace name
  'slack:openQuestion': 'META', // where a Slack question lives (ids) and, for another member, the question's own words
  'slack:unlink': 'META', // removes the caller's own link; returns a count
  'research:card': 'DOOR', // a step's chart, drawn now for its starter through answer:card's handler, the SQL gate (storage net) or driversVizData: each takes the caller's row lock
  'research:get': 'EXPLICIT', // the starter's own run: specs, statuses, reasons and the report words written under THEIR access; hidden once a step's dataset is closed to them (shows()'s rule); never a step's facts
  'research:list': 'META', // the caller's own runs: ids, state, the question they typed
  'tokens:list': 'META',
  'tokens:revoke': 'META',
  'topic:get': 'META', // ids and names of a project's datasets, fields, metrics and terms: never a value, the same reply for every caller
  'trash:list': 'META',
  'verified:list': 'REDACT', // D5: no spec with a value filter on a dataset closed to the caller (ipc/verified rowOf); an SQL question is its words and datasets only, never its SQL (ipc/verifiedSql sqlRow)
  'verified:checkResult': 'REDACT', // reasons can quote a value: none on a dataset closed to the caller (ipc/assistantCheck checkFor)
  'versions:diff': 'EXPLICIT',
  'versions:figures': 'DOOR',
  'versions:get': 'EXPLICIT',
  'versions:list': 'META',
  'visual:data': 'DOOR', // A source table target (`table`, Explore phase D): editors only, read inside its in-memory Live view; a viewer's is refused before any read (test-exploreSourceTables)
  'visual:drillDown': 'DOOR', // the steps behind a mark; its grain is the chart's own answer, read through vizDataFor. A source table target (`table`, Explore phase D): editors only, read inside its in-memory Live view; a viewer's is refused before any read (test-exploreSourceTables)
  'visual:dataBatch': 'DOOR', // A source table target (`table` per item, Explore phase D): editors only, read inside its in-memory Live view; a viewer's is refused before any read (test-exploreSourceTables)
  'visual:get': 'REDACT',
  'visual:list': 'META',
  'visual:preview': 'DOOR',
  'visual:rows': 'LOCKED',
  'visual:rowsDownload': 'LOCKED',
  'visual:suggest': 'NET',
  'visual:thumbs': 'DOOR',
};
