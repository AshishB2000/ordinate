// Every `read` contract a project viewer can call, with how COLUMN access rules cover it (semantic layer
// part 4, D15–D18) — the column twin of scripts/rowPolicyReaders.ts. A `read` contract missing here fails
// scripts/test-columnAccessSafetyNet.ts: classify it, and say how it is
// covered, in the PR that adds it. Never classify by copying the row class without checking what it returns.
//
//   GATE    a figure door (./columnDoors gateColumns): a question naming a hidden column refuses `hidden`
//   DROP    a row reader: hidden cells null in place (or the column left out of a file), named in `hidden`
//   NET     a whole-table reader: the storage net refuses a caller something is hidden from (`columns`)
//   REDACT  answers, with what names a hidden column's values left out for that caller
//   MARK    lists columns, a hidden one marked `hidden: true` (names are not secret)
//   FANOUT / EXPORT  a fan-out build (gated as its least-entitled audience) / an export (refused)
//   SKIP    a walk that skips a dataset closed to the caller
//   META    returns no value, figure or row of a dataset
//
// The classes are TREATMENT's mapped (DOOR → GATE, LOCKED → DROP or GATE, EXPLICIT → NET), with the overrides
// step 06 made each saying how it is covered. scripts/test-columnAccessSafetyNet.ts proves every class: a canary
// in every hidden cell, grepped in every reply a hidden-from viewer gets for every read contract, MCP tool, push
// and model prompt; and every GATE channel refusing a question that names a hidden column.

export type ColumnTreatment = 'GATE' | 'DROP' | 'NET' | 'REDACT' | 'MARK' | 'FANOUT' | 'EXPORT' | 'SKIP' | 'META';

export const COLUMN_TREATMENT: Readonly<Record<string, ColumnTreatment>> = {
  'ai:setMine': 'META',
  'ai:status': 'META',
  'alerts:list': 'REDACT',
  'alerts:markSeen': 'META',
  'alerts:test': 'FANOUT', // so is alerts:save on a dataset with column rules; test-columnAccessSafetyNet
  'analysis:draft': 'NET',
  'analysis:gallery': 'REDACT',
  'analysis:open': 'REDACT',
  'analysis:previewPlan': 'NET',
  'analysis:tiles': 'GATE',
  'answer:card': 'GATE',
  'answer:explain': 'GATE',
  'answer:rerun': 'GATE',
  'asset:read': 'META',
  'boundary:get': 'META',
  'boundary:list': 'META',
  'branding:logo': 'META',
  'calendar:today': 'META',
  'captureDataset:get': 'NET',
  'captureDataset:image': 'NET',
  'captureDataset:list': 'REDACT',
  'captureDataset:status': 'META',
  'catalog:columns': 'REDACT', // a hidden column's example and value labels left out (app/columnLabelAccess); test-columnRedact
  'catalog:get': 'META',
  'catalog:getTable': 'REDACT',
  'catalog:instructions': 'META', // editor prose about the project (part 3, D5): no cell, label or figure of a dataset
  'catalog:list': 'META',
  'catalog:tags': 'META',
  'channel:list': 'META',
  'comment:add': 'META',
  'comment:delete': 'META',
  'comment:deleteReply': 'META',
  'comment:edit': 'META',
  'comment:list': 'META',
  'comment:mentionable': 'META',
  'comment:reopen': 'META',
  'comment:reply': 'META',
  'comment:resolve': 'META',
  'connections:list': 'REDACT',
  'connectors:catalog': 'META',
  'connectors:logos': 'META',
  'copilot:ask': 'REDACT', // the facts leave a hidden column out entirely (ai/hiddenFacts), its metrics and terms too; test-columnFacts
  'copilot:deleteThread': 'META',
  'copilot:history': 'META',
  'copilot:newThread': 'META',
  'copilot:renameThread': 'META',
  'copilot:threads': 'META',
  'dashboard:asOfStamps': 'META',
  'dashboard:exportHtml': 'EXPORT',
  'dashboard:metric': 'GATE',
  'dataSearch:query': 'SKIP',
  'dataset:columns': 'MARK', // a hidden column marked hidden: true (columnAccess.markHidden); test-columnRedact
  'dataset:composePreview': 'NET',
  'dataset:distinct': 'GATE', // distinctFor: the column and the parent picks are the question
  'dataset:list': 'REDACT',
  'dataset:liveSchema': 'REDACT', // closedToCaller: no sample values; test-columnRedact
  'dataset:page': 'DROP', // pageFor: hidden cells null in place, named in `hidden`; a search, sort or filter on one refuses
  'dataset:profile': 'GATE', // withLockOf: the column is the question (a Live sample too)
  'dataset:source': 'META',
  'dataset:stats': 'NET',
  'dataset:suggestCalcField': 'NET',
  'dataset:suggestSteps': 'NET',
  'drivers:explain': 'NET',
  'drivers:explainAlert': 'NET',
  'drivers:explainPoint': 'NET',
  'embed:columns': 'META',
  'embed:status': 'META',
  'events:list': 'META',
  'explore:suggest': 'META',
  'format:colors:get': 'REDACT', // no colours of a column hidden on any dataset (rowAccess.hiddenAnywhere); test-columnRedact
  'formula:check': 'NET',
  'formula:functions': 'META',
  'fx:get': 'META',
  'geo:boundarySources': 'META',
  'geo:resolvePlace': 'META',
  'geo:spatialPreview': 'NET',
  'home:overview': 'GATE',
  'incremental:get': 'REDACT',
  'input:load': 'NET',
  'input:lookups': 'META',
  'insights:list': 'NET',
  'jobs:cancel': 'META',
  'jobs:clear': 'META',
  'jobs:list': 'META',
  'key:status': 'META',
  'lineage:column': 'META', // the records around one column, by name (part 8): no value, figure or row; a column's name is not secret
  'lineage:fields': 'META', // what uses each field, counted from records (part 8), never from rows
  'lineage:get': 'META',
  'mentions:list': 'META',
  'mentions:prefs': 'META',
  'mentions:seen': 'META',
  'mentions:setPrefs': 'META',
  'metric:check': 'GATE',
  'metric:get': 'META',
  'metric:list': 'REDACT', // a metric that reads a hidden column marked hidden: true (analysis/columnHidden); test-columnRedact
  'metric:preview': 'GATE',
  'metric:table': 'GATE',
  'metric:values': 'GATE',
  'metricTree:compute': 'GATE',
  'metricTree:suggest': 'META',
  'model:navigation': 'META', // hierarchies (their names and column names), the date ladder and the topics: no value, figure or row (part 6)
  'model:overview': 'REDACT',
  'numbers:follow': 'META',
  'numbers:get': 'GATE',
  'onboarding:set': 'META',
  'onboarding:status': 'META',
  'onboarding:visit': 'META',
  'period:picker': 'META',
  'pipelines:get': 'REDACT',
  'pipelines:preview': 'META',
  'plan:check': 'META',
  'prefs:get': 'META',
  'prepare:get': 'NET',
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
  'publish:plan': 'FANOUT', // gated as its least-entitled audience: one reading a hidden column refuses; test-columnAccessSafetyNet
  'publish:sites': 'META',
  'publish:targets': 'META',
  'quality:failingRows': 'NET',
  'quality:list': 'REDACT', // closedToCaller: the rules without args, no run; test-columnRedact
  'quality:preview': 'NET',
  'rebuild:match': 'NET',
  'rebuild:read': 'META',
  'recent:list': 'META',
  'relationship:list': 'REDACT',
  'relationship:related': 'META',
  'relationship:suggest': 'NET',
  'report:build': 'EXPORT',
  'report:preview': 'EXPORT',
  'reports:get': 'META',
  'reports:list': 'META',
  'reports:open': 'META',
  'scenario:compare': 'NET',
  'scenario:compute': 'NET',
  'scenario:get': 'META',
  'scenario:list': 'META',
  'scenario:metrics': 'META',
  'scenario:targets': 'META',
  'scorecard:compute': 'GATE',
  'scorecard:detail': 'GATE',
  'scorecard:get': 'META',
  'scorecard:list': 'META',
  'search:query': 'META',
  'segments:features': 'NET',
  'segments:fit': 'NET',
  'segments:rfm': 'NET',
  'snapshots:diff': 'NET',
  'snapshots:list': 'META',
  'snapshots:stamps': 'META',
  'sql:datasetQuery': 'META',
  'sql:explain': 'NET',
  'sql:run': 'NET',
  'sql:schema': 'MARK', // a hidden column marked hidden: true; test-columnRedact
  'starred:get': 'META',
  'starred:set': 'META',
  'stats:dashboards': 'META',
  'stats:pair': 'NET',
  'stats:run': 'NET',
  'story:draft': 'NET',
  'story:export': 'EXPORT',
  'story:figures': 'GATE',
  'story:get': 'META',
  'story:list': 'META',
  'subscription:get': 'META',
  'subscription:history': 'META',
  'subscription:list': 'META',
  'subscription:preview': 'FANOUT', // its figures built in a fan-out scope (subscriptions/run buildMessage); test-columnAccessSafetyNet
  'summary:compute': 'NET',
  'summary:rewrite': 'NET',
  'template:list': 'NET',
  'template:plan': 'NET',
  'term:get': 'REDACT',
  'term:list': 'REDACT', // values hidden from a restricted caller; one on a hidden column marked hidden: true; test-columnRedact
  'term:usage': 'META',
  'text:preview': 'NET',
  'text:profile': 'NET',
  'themes:list': 'META',
  'tokens:create': 'META',
  'tokens:list': 'META',
  'tokens:revoke': 'META',
  'topic:get': 'META', // a topic's name, description and member ids and field names (part 6): no value, figure or row
  'trash:list': 'META',
  'verified:checkResult': 'REDACT', // a reason (it can quote the model) dropped on a dataset closed to the caller (test-columnRedact); a question the caller's list leaves out is no row and no count (test-columnAccessSafetyNet)
  'verified:list': 'DROP', // a question whose spec names a hidden column is left out (ipc/verifiedState); test-columnRedact
  'versions:diff': 'NET',
  'versions:figures': 'GATE',
  'versions:get': 'NET',
  'versions:list': 'META',
  'visual:data': 'GATE',
  'visual:dataBatch': 'GATE',
  'visual:drillDown': 'GATE', // the steps behind a mark: a drill naming a hidden column is refused (ipc/drillDown); its grain lookup is visual:data's
  'visual:get': 'REDACT', // visualForCaller: one naming a hidden column loses its labels and those filter values; test-columnRedact
  'visual:list': 'META',
  'visual:preview': 'GATE',
  'visual:rows': 'DROP', // pageFor: as dataset:page; the mark's filter passes the gate
  'visual:rowsDownload': 'DROP', // pageFor, then the hidden columns leave the CSV (columnDoors.shownColumns)
  'visual:suggest': 'NET',
  'visual:thumbs': 'GATE',
};
