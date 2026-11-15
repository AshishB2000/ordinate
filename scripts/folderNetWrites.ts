// Section 8 of the folder safety net (docs/team-folders/00-design.md), E6's: WRITES (D18). Over ./folderHarness's world
// with its folders planted, on throwaway sets made by boss (`W.fresh`): T_hr in HR (no grants), T_ops1 and T_ops2 in Ops
// (Ops leads: edit; Ops: view). Run last by ./folderNet: its controls change and delete things. Not a test file itself.
//
// 8. WRITES: one call (or more) per EDIT and CREATE channel, each named by its payload's label —
//    A. CLOSED: opsLead (Can edit on Ops, nothing on HR) on T_hr: every call leaves every record that names T_hr's items,
//       and their placements, byte-identical, and answers as for unknown ids or refuses `closed` (naming nothing).
//    B. VIEW: opsEditorView (Can view on Ops) on T_ops1: nothing changes, and every call that lands in C3 refuses `edit`.
//    NEGATIVE CONTROLS — C1: opsLead's same calls on T_ops1 land (the folder's editor writes); C2: with the folder
//    checks off, opsLead's calls on T_hr land (so A's payloads are writes, and only the folders stop them); C3: with
//    only E6's write checks off, opsEditorView's on T_ops2 land (so B's refusals are E6's, not a read filter's).
//    COVERAGE: every EDIT and CREATE channel lands in C2 or is in UNEXERCISED with why (the list only shrinks, both ways);
//    every one is held by the route (src/server/authz/folderWriteGate.ts) or by the store named in IN_STORES.
//    And: a create naming no folder lands in Everyone, one naming Ops lands there; a SQL dataset over Orders and a join of
//    Plain with Orders land in Ops; a whole-topic save keeps HR's members; model:export carries no HR canary (padmin's
//    does); a Trash purge drops the placement; the project's pipeline (every dataset) is opsLead's to change only with the
//    checks off; MCP's create_visual is held as visual:save is; a verified SQL question needs Edit on every dataset its SQL
//    reads, and one reading HR is opsLead's as a missing one; with no folder E6's checks add at most one statement to a write.

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { ok } from './selfcheck';
import { WRITES } from './folderReaders';
import * as H from './folderHarness';

const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const writes: typeof import('../src/server/authz/folderWrites') = require('../src/server/authz/folderWrites');
const writeGate: typeof import('../src/server/authz/folderWriteGate') = require('../src/server/authz/folderWriteGate');
const subscriptions: typeof import('../src/analysis/subscriptions') = require('../src/analysis/subscriptions');
type Person = H.Person;
type Set = H.Items & { ds2: string; folder: string; trashed: string; key: string; rel: string; sub: string; qrule: string; input: string; sql: string; sqlTrashed: string; tag: string };

/** EDIT and CREATE channels the route's gate does not hold: the store seam that does (src/server/authz/folderWrites.ts). */
export const IN_STORES: Readonly<Record<string, string>> = {
  'visual:update': 'lockedUpdate', 'metric:update': 'lockedUpdate', 'metricTree:save': 'lockedUpdate', 'term:update': 'lockedUpdate',
  'story:update': 'lockedUpdate', 'scorecard:update': 'lockedUpdate', 'scenario:update': 'lockedUpdate', 'reports:update': 'lockedUpdate',
  'reports:generated': 'lockedUpdate', 'analysis:update': 'lockedUpdate (+ added cards open)', 'analysis:rename': 'lockedUpdate',
  'analysis:view': 'lockedUpdate', 'stats:addToDashboard': 'lockedUpdate / saveAnalysis', 'metricTree:addToDashboard': 'lockedUpdate / saveAnalysis',
  'analysis:unpublish': 'analysis.patchStored',
  'visual:delete': 'trash.trashRecord', 'metric:delete': 'trash.trashRecord', 'term:delete': 'trash.trashRecord', 'verified:delete': 'trash.trashRecord',
  'reports:delete': 'trash.trashRecord', 'analysis:delete': 'trash.trashRecord', 'dataset:delete': 'trash.trashRecord', 'trash:restore': 'trash.restore',
  'story:delete': 'stories.deleteStory', 'scorecard:delete': 'scorecards.deleteScorecard', 'scenario:delete': 'scenarios.deleteScenario',
  'visual:save': 'visuals.saveVisual', 'visual:duplicate': 'visuals.duplicateVisual', 'answer:saveVisual': 'visuals.saveVisual', 'drivers:addTile': 'visuals.saveVisual',
  'analysis:starterCards': 'visuals.saveVisual', 'metric:save': 'metrics.saveMetric', 'metric:duplicate': 'metrics.duplicateMetric',
  'metric:ensureDefaults': 'ensureDefaults: proposes only on a dataset the caller edits', 'term:save': 'terms.saveTerm',
  'verified:save': 'writeVerified / lockedUpdate (recordOpen.questionDatasets)', 'story:create': 'stories.saveStory', 'story:build': 'stories.saveStory',
  'scorecard:create': 'scorecards.saveScorecard', 'scorecard:duplicate': 'scorecards.saveScorecard', 'scenario:create': 'scenarios.saveScenario',
  'scenario:duplicate': 'scenarios.saveScenario', 'reports:create': 'reportSpec.saveReport', 'reports:duplicate': 'reportSpec.saveReport',
  'scorecard:createReport': 'reportSpec.saveReport', 'alerts:save': 'alertStore.saveRule', 'alerts:patch': 'alertStore.patchRule',
  'alerts:delete': 'alertStore.deleteRule', 'relationship:save': 'relationships.saveRelationship', 'relationship:delete': 'relationships.deleteRelationship',
  'subscription:save': 'subscriptions.create/updateSubscription', 'subscription:setEnabled': 'subscriptions.updateSubscription',
  'subscription:delete': 'subscriptions.deleteSubscription', 'dataset:addStep': 'commitSteps', 'dataset:updateStep': 'commitSteps',
  'dataset:removeStep': 'commitSteps', 'dataset:reorderSteps': 'commitSteps', 'dataset:setSteps': 'commitSteps', 'text:commitStep': 'commitSteps',
  'geo:saveSpatialStep': 'commitSteps', 'segments:saveColumn': 'commitSteps', 'stats:saveFormula': 'commitSteps',
  'model:importApply': 'modelApply (catalog and base filters per dataset) + the stores', 'model:importPlan': 'writes nothing: importApply plans again',
  'plan:start': 'the stores each step writes through', 'plan:next': 'the stores each step writes through', 'plan:fix': 'the stores each step writes through',
  'plan:skip': 'the stores each step writes through', 'plan:stop': 'the stores each step writes through', 'plan:undo': 'trash.trashRecord and the stores',
  'captureDataset:draft': 'a draft names no dataset yet: dataset:composeSave lands what it becomes',
};
/** E5's (another PR): Publish and the publish channels. analysis.patchStored already holds Edit on analysis:publish. */
export const OUT_OF_SCOPE: Readonly<Record<string, string>> = { 'analysis:publish': 'E5 (D16)', 'publish:access': 'E5', 'publish:run': 'E5', 'publish:unpublish': 'E5' };
/** No effective payload here: why. Edit only to remove a line (the net reports one that lands now). */
const UNEXERCISED: Readonly<Record<string, string>> = {
  'captureDataset:delete': 'needs a screenshot capture',
  'captureDataset:draft': 'needs a screenshot upload',
  'catalog:dismissSuggestion': "needs a connection's source table suggestion",
  'connection:addSemanticDataset': 'needs a semantic-layer connection (secrets store)',
  'connection:import': 'needs a connection (secrets store): its landing is the gate\'s, as input:create\'s',
  'connection:refresh': 'needs a connection',
  'answer:keepTable': 'needs a documented table on a Live-capable connection (phase D)',
  'explore:keepTable': 'needs a documented table on a Live-capable connection (phase D)',
  'dataset:copyLive': 'needs a Live dataset',
  'dataset:refresh': 'a pasted table has no origin to refresh from',
  'dataset:setMode': 'needs a Live-capable connection',
  'dataset:setSourceTables': 'needs source table docs',
  'dataset:sourceTableChoices': 'needs source table docs',
  'dataset:syncLiveSchema': 'needs a Live dataset',
  'geo:saveSpatialStep': 'needs boundaries',
  'incremental:set': 'needs a refreshable origin',
  'input:save': 'its batches are the grid\'s',
  'live:setBaseFilters': 'needs a Live dataset',
  'live:setCalculated': 'needs a Live dataset',
  'metric:ensureDefaults': 'proposes only in a project with no metric',
  'model:importApply': 'needs a model upload',
  'model:importPlan': 'needs a model upload',
  'plan:fix': 'a run of the model\'s proposed steps', 'plan:next': 'a run of the model\'s proposed steps', 'plan:skip': 'a run of the model\'s proposed steps',
  'plan:start': 'a run of the model\'s proposed steps', 'plan:stop': 'a run of the model\'s proposed steps', 'plan:undo': 'a run of the model\'s proposed steps',
  'refreshHook:create': 'needs a refreshable origin', 'refreshHook:list': 'reads the hooks: nothing to land', 'refreshHook:revoke': 'needs a refresh URL',
  'segments:saveColumn': 'needs a fitted segmentation',
  'snapshots:restore': 'needs a kept snapshot',
  'stats:saveFormula': 'needs a regression\'s fit',
  'subscription:save': 'needs a delivery channel',
  'text:commitStep': 'needs a text step',
  'pipelines:run': 'the project\'s pipeline names no set\'s ids: checked on its own (`pipelines`)',
  'pipelines:setSchedule': 'checked on its own (`pipelines`)', 'pipelines:setPolicy': 'checked on its own (`pipelines`)',
  'pipelines:setPaused': 'checked on its own (`pipelines`)', 'pipelines:setNodeSchedule': 'checked on its own (`pipelines`)',
};

/** Writes Can view on Ops allows (B): what they make lands where its maker edits, naming only what they open. */
const VIEW_ALLOWED: Readonly<Record<string, string>> = {
  'analysis:create': 'a new dashboard in Everyone with a card on an Ops chart: a card needs its dataset open, not Edit (D18)',
};

/** Section 1 (no database): every EDIT and CREATE channel is held by the route's gate or by a store, and the lists name only those. */
export function writeCoverage(): void {
  const chans = Object.entries(WRITES).filter(([, c]) => c === 'EDIT' || c === 'CREATE').map(([ch]) => ch);
  const held = (ch: string): boolean => ch in writeGate.WRITE_GATE || ch in IN_STORES || ch in OUT_OF_SCOPE;
  const loose = chans.filter((ch) => !held(ch));
  ok(`writes: each of ${chans.length} EDIT and CREATE channels is held by the route's gate or by a store (IN_STORES), or is E5's`, loose.length === 0, loose.join(', '));
  const stale = [...Object.keys(writeGate.WRITE_GATE), ...Object.keys(IN_STORES), ...Object.keys(UNEXERCISED)].filter((ch) => !chans.includes(ch));
  ok('writes: the gate, IN_STORES and UNEXERCISED name only EDIT and CREATE channels', stale.length === 0, stale.join(', '));
  ok('NEGATIVE CONTROL: a planted EDIT channel nobody holds is reported', !held('folder:plantedWrite'));
}

const enc = { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] };
const spec = (ds: string) => ({ datasetId: ds, category: 'dept', measures: [{ column: 'salary', aggregation: 'sum' }], filters: [] });
const card = (extra: object) => ({ id: randomUUID(), layout: { x: 0, y: 0, w: 6, h: 4 }, ...extra });

/** Every EDIT and CREATE call on `t`, in an order its own writes do not undo: creates and edits, then restores, then deletes. */
function callsOn(P: string, t: Set): Array<[string, string, unknown]> {
  const n = (what: string) => `${t.tag} ${what}`;
  return [
    // First: its one step is the setup's (a starter layout's fields would add more).
    ['dataset:reorderSteps', 'dataset:reorderSteps', { projectId: P, datasetId: t.ds, order: [0] }],
    ['visual:save', 'visual:save', { projectId: P, datasetId: t.ds, name: n('chart'), chartType: 'bar', encoding: enc }],
    ['visual:update', 'visual:update', { projectId: P, id: t.visual, name: n('renamed chart') }],
    ['visual:duplicate', 'visual:duplicate', { projectId: P, id: t.visual }],
    ['answer:saveVisual', 'answer:saveVisual', { projectId: P, spec: spec(t.ds) }],
    ['drivers:addTile', 'drivers:addTile', { projectId: P, request: { datasetId: t.ds, metric: { column: 'salary', aggregation: 'sum' }, compare: { mode: 'previous_period' }, dimension: 'dept' }, name: n('why') }],
    ['analysis:starterCards', 'analysis:starterCards', { projectId: P, kind: 'kpis', datasetId: t.ds }],
    ['metric:save', 'metric:save', { projectId: P, input: { name: n('metric two'), datasetId: t.ds, definition: { column: 'salary', aggregation: 'sum' } } }],
    ['metric:update', 'metric:update', { projectId: P, id: t.metric, patch: { description: n('described') } }],
    ['metric:duplicate', 'metric:duplicate', { projectId: P, id: t.metric }],
    ['metricTree:save', 'metricTree:save', { projectId: P, id: t.metric, tree: { metricId: t.metric, children: [] } }],
    ['metricTree:addToDashboard', 'metricTree:addToDashboard', { projectId: P, id: t.metric, analysisId: t.board }],
    ['term:save', 'term:save', { projectId: P, input: { name: n('term two'), aliases: [], description: 'd', datasetId: t.ds, filters: [{ type: 'filter', column: 'dept', op: '=', value: 'd2' }] } }],
    ['term:update', 'term:update', { projectId: P, id: t.term, patch: { description: n('described') } }],
    ['verified:save', 'verified:save', { projectId: P, input: { question: n('question by person'), spec: { ...spec(t.ds), category: 'person' } } }],
    ['verified:save on its id', 'verified:save', { projectId: P, id: t.verified, input: { question: n('question by day'), spec: { ...spec(t.ds), category: 'day' } } }],
    ['verified:save SQL', 'verified:save', { projectId: P, input: { question: n('sql by person'), sql: `SELECT person, sum(salary) AS total FROM "${t.tag} data" GROUP BY person` } }],
    ['alerts:save', 'alerts:save', { projectId: P, rule: { name: n('alert'), datasetId: t.ds, metric: { column: 'salary', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true } }],
    ['alerts:patch', 'alerts:patch', { projectId: P, ruleId: t.rule, patch: { enabled: false } }],
    ['analysis:create', 'analysis:create', { projectId: P, name: n('board'), sheets: [{ name: 'One', cards: [card({ type: 'visual', visualId: t.visual })] }] }],
    ['analysis:create in the folder', 'analysis:create', { projectId: P, name: n('placed board'), folderId: t.folder }],
    ['analysis:buildPlan', 'analysis:buildPlan', { projectId: P, plan: { name: n('built'), sheets: [{ name: 'One', visuals: [{ visual: t.visual }], metrics: [] }] }, folderId: t.folder }],
    ['analysis:update', 'analysis:update', { projectId: P, id: t.board, name: n('updated board') }],
    ['analysis:update adding a card', 'analysis:update', { projectId: P, id: t.board, sheets: [{ name: 'One', cards: [card({ type: 'visual', visualId: t.visual })] }] }],
    ['analysis:rename', 'analysis:rename', { projectId: P, id: t.board, name: n('renamed board') }],
    ['analysis:view', 'analysis:view', { projectId: P, id: t.board, op: { op: 'create', name: n('view'), state: {} } }],
    ['fx:dashboard', 'fx:dashboard', { projectId: P, dashboardId: t.board, code: 'EUR' }],
    ['stats:addToDashboard', 'stats:addToDashboard', { projectId: P, spec: { kind: 'distribution', datasetId: t.ds, columns: ['salary'] }, view: 'table', analysisId: t.board }],
    ['story:create', 'story:create', { projectId: P, name: n('story'), blocks: [{ kind: 'visual', visualId: t.visual }] }],
    ['story:build', 'story:build', { projectId: P, plan: { name: n('built story'), sheets: [{ name: 'One', visuals: [{ visual: t.visual }], metrics: [] }] } }],
    ['story:update', 'story:update', { projectId: P, id: t.story, name: n('updated story') }],
    ['scorecard:create', 'scorecard:create', { projectId: P, name: n('scorecard'), rows: [{ metricId: t.metric }] }],
    ['scorecard:update', 'scorecard:update', { projectId: P, id: t.scorecard, patch: { name: n('updated scorecard') } }],
    ['scorecard:duplicate', 'scorecard:duplicate', { projectId: P, id: t.scorecard }],
    ['scorecard:createReport', 'scorecard:createReport', { projectId: P, id: t.scorecard }],
    ['scenario:create', 'scenario:create', { projectId: P, input: { name: n('scenario'), baseMetricIds: [t.metric], drivers: [] } }],
    ['scenario:update', 'scenario:update', { projectId: P, id: t.scenario, patch: { name: n('updated scenario'), baseMetricIds: [t.metric], drivers: [] } }],
    ['scenario:duplicate', 'scenario:duplicate', { projectId: P, id: t.scenario }],
    ['reports:create', 'reports:create', { projectId: P, analysisId: t.board }],
    ['reports:update', 'reports:update', { projectId: P, id: t.report, patch: { name: n('updated report') } }],
    ['reports:duplicate', 'reports:duplicate', { projectId: P, id: t.report }],
    ['reports:generated', 'reports:generated', { projectId: P, id: t.report }],
    ['relationship:save', 'relationship:save', { projectId: P, relationship: { from: { datasetId: t.ds, column: 'dept' }, to: { datasetId: t.ds2, column: 'dept' }, cardinality: 'many_to_one', label: n('link') } }],
    ['subscription:setEnabled', 'subscription:setEnabled', { projectId: P, id: t.sub, enabled: false }],
    ['dataset:addStep', 'dataset:addStep', { projectId: P, datasetId: t.ds, step: { type: 'filter', column: 'dept', op: '!=', value: 'none' } }],
    ['dataset:updateStep', 'dataset:updateStep', { projectId: P, datasetId: t.ds, index: 0, step: { type: 'filter', column: 'dept', op: '!=', value: 'nobody' } }],
    ['dataset:setSteps', 'dataset:setSteps', { projectId: P, datasetId: t.ds, steps: [{ type: 'filter', column: 'dept', op: '!=', value: 'zz' }] }],
    ['dataset:removeStep', 'dataset:removeStep', { projectId: P, datasetId: t.ds, index: 0 }],
    ['dataset:update', 'dataset:update', { projectId: P, datasetId: t.ds, columns: [{ name: 'dept', type: 'text' }, { name: 'salary', type: 'number' }, { name: 'person', type: 'text' }, { name: 'day', type: 'date' }, { name: 'x_bonus_2', type: 'number' }] }],
    ['dataset:composeSave', 'dataset:composeSave', { projectId: P, name: n('composed'), base: { datasetId: t.ds }, joins: [], steps: [] }],
    ['segments:rfmSave', 'segments:rfmSave', { projectId: P, datasetId: t.ds, spec: { id: 'person', date: 'day', amount: 'salary' } }],
    ['input:create', 'input:create', { projectId: P, name: n('typed table'), columns: [{ name: 'a', type: 'text' }], folderId: t.folder }],
    ['input:setColumns', 'input:setColumns', { projectId: P, id: t.input, columns: [{ name: 'a', type: 'text' }, { name: 'b', type: 'number' }], from: [0, -1] }],
    ['catalog:set', 'catalog:set', { projectId: P, ref: `dataset:${t.ds}`, patch: { description: n('note') } }],
    ['catalog:set on its chart', 'catalog:set', { projectId: P, ref: `visual:${t.visual}`, patch: { description: n('note') } }],
    ['catalog:setColumn', 'catalog:setColumn', { projectId: P, datasetId: t.ds, column: 'salary', patch: { description: n('column note') } }],
    ['catalog:setTable', 'catalog:setTable', { projectId: P, datasetId: t.ds, patch: { guide: n('guide') } }],
    ['catalog:addAlias', 'catalog:addAlias', { projectId: P, datasetId: t.ds, column: 'salary', alias: n('pay').replace(/\s/g, '_') }],
    ['quality:save', 'quality:save', { projectId: P, datasetId: t.ds, rule: { kind: 'not_null', column: 'person', severity: 'warn' } }],
    ['quality:run', 'quality:run', { projectId: P, datasetId: t.ds }],
    ['privacy:decide', 'privacy:decide', { projectId: P, datasetId: t.ds, column: 'person', level: 'personal' }],
    ['privacy:scan', 'privacy:scan', { projectId: P, datasetIds: [t.ds] }],
    ['snapshots:setKeep', 'snapshots:setKeep', { projectId: P, datasetId: t.ds, keep: 5 }],
    ['insights:dismiss', 'insights:dismiss', { projectId: P, id: `${t.ds}:trend:day:salary`, dismissed: true }],
    ['versions:restore', 'versions:restore', { projectId: P, type: 'visual', id: t.visual, key: t.key }],
    ['analysis:discard', 'analysis:discard', { projectId: P, id: t.board }],
    ['analysis:unpublish', 'analysis:unpublish', { projectId: P, id: t.board }],
    ['trash:restore', 'trash:restore', { projectId: P, type: 'visual', id: t.trashed }],
    ['trash:restore SQL', 'trash:restore', { projectId: P, type: 'verified', id: t.sqlTrashed }],
    ['verified:delete SQL', 'verified:delete', { projectId: P, id: t.sql }],
    ['quality:delete', 'quality:delete', { projectId: P, datasetId: t.ds, ruleId: t.qrule }],
    ['subscription:delete', 'subscription:delete', { projectId: P, id: t.sub }],
    ['relationship:delete', 'relationship:delete', { projectId: P, id: t.rel }],
    ['alerts:delete', 'alerts:delete', { projectId: P, ruleId: t.rule }],
    ['reports:delete', 'reports:delete', { projectId: P, id: t.report }],
    ['scenario:delete', 'scenario:delete', { projectId: P, id: t.scenario }],
    ['scorecard:delete', 'scorecard:delete', { projectId: P, id: t.scorecard }],
    ['story:delete', 'story:delete', { projectId: P, id: t.story }],
    ['verified:delete', 'verified:delete', { projectId: P, id: t.verified }],
    ['term:delete', 'term:delete', { projectId: P, id: t.term }],
    ['metric:delete', 'metric:delete', { projectId: P, id: t.metric }],
    ['visual:delete', 'visual:delete', { projectId: P, id: t.visual }],
    ['analysis:delete', 'analysis:delete', { projectId: P, id: t.board }],
    ['dataset:delete', 'dataset:delete', { projectId: P, id: t.ds2 }],
  ];
}

/** `t`'s ids, every one a payload may name. */
const idsOf = (t: Set): string[] => [t.ds, t.ds2, t.visual, t.metric, t.term, t.verified, t.rule, t.board, t.story, t.scorecard, t.scenario, t.report, t.trashed, t.rel, t.sub, t.qrule, t.input, t.sql, t.sqlTrashed, t.folder].filter(Boolean).map((x) => x.toLowerCase());

/**
 * What a write on `t` could change: each record that names one of its ids — whole when its path does, else the parts of
 * its JSON that name one (an alert rule in alerts.json, a dataset's catalog entry, a topic's member) — and the
 * placements of its items and in its folder. Two equal states: nothing of `t`'s changed.
 */
async function stateOf(W: H.World, t: Set): Promise<Map<string, string>> {
  const ids = idsOf(t);
  const re = new RegExp(ids.join('|'), 'i');
  const out = new Map<string, string>();
  const rows = (await W.pool.query<{ path: string; body: string }>("SELECT path, body FROM records WHERE org_id = 'acme' AND (path ~* $1 OR body ~* $1)", [ids.join('|')])).rows;
  const part = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.filter((x) => re.test(JSON.stringify(x)));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k, x]) => re.test(k) || re.test(JSON.stringify(x))).map(([k, x]) => [k, re.test(k) ? x : part(x)]));
    return v;
  };
  for (const r of rows) {
    if (r.path.endsWith('.tmp')) continue;
    let body = r.body;
    if (!re.test(r.path)) {
      try {
        body = JSON.stringify(part(JSON.parse(r.body)));
      } catch {
        /* not JSON: the whole text */
      }
    }
    out.set(r.path, body);
  }
  const placed = (await W.pool.query<{ kind: string; item_id: string; folder_id: string }>(
    "SELECT kind, item_id, folder_id::text FROM folder_items WHERE org_id = 'acme' AND (item_id = ANY($1) OR folder_id = $2::uuid) ORDER BY kind, item_id", [ids, t.folder])).rows;
  out.set('folder_items', JSON.stringify(placed));
  return out;
}

const diff = (a: Map<string, string>, b: Map<string, string>): string[] =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).map((k) => (a.has(k) ? (b.has(k) ? `changed ${k}` : `gone ${k}`) : `new ${k}`));

type Ran = Map<string, { r: H.Reply; changed: string[] }>;
async function run(W: H.World, who: Person, t: Set, list: Array<[string, string, unknown]>): Promise<Ran> {
  const out: Ran = new Map();
  for (const [label, ch, payload] of list) {
    const before = await stateOf(W, t);
    const r = await W.call(who, ch, payload);
    out.set(label, { r, changed: diff(before, await stateOf(W, t)) });
  }
  return out;
}
const short = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 160)}`;
const folders: typeof import('../src/server/authz/folders') = require('../src/server/authz/folders');
/** A typed folder refusal — or one a handler caught into a field of its own, typed by the route with the catalog's sentence. */
const refusedAs = (r: H.Reply, reason: 'closed' | 'edit'): boolean =>
  H.refused(r, reason) || (r.text.includes('"code":"folder"') && r.text.includes(JSON.stringify(folders.folderRefusal(reason).error)));
/** A reply with every id masked: two answers that differ only by the ids they name (or mint) are the same answer. */
const masked = (r: H.Reply): string => H.stable(r).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'ID');
const off = async <T>(seam: (on: boolean) => void, fn: () => Promise<T>): Promise<T> => {
  seam(false);
  try {
    return await fn();
  } finally {
    seam(true);
  }
};

/** A throwaway set in `where`, with what its calls need: a step, a link, a trashed chart, a version, a subscription, a rule, a typed table. */
async function setIn(W: H.World, where: 'hr' | 'ops', tag: string): Promise<Set> {
  const { P } = W;
  const it = await W.fresh(where, tag);
  const must = <T>(what: string, v: T | null | undefined | ''): T => {
    if (!v) throw new Error(`section 8 setup: ${what}`);
    return v;
  };
  must('step', (await W.call('boss', 'dataset:addStep', { projectId: P, datasetId: it.ds, step: { type: 'filter', column: 'dept', op: '!=', value: 'q' } })).body?.ok === true);
  const rel = must('link', String((await W.call('boss', 'relationship:save', { projectId: P, relationship: { from: { datasetId: it.ds, column: 'dept' }, to: { datasetId: it.ds2, column: 'dept' }, cardinality: 'many_to_one' } })).body?.relationship?.id ?? ''));
  const gone = await W.call('boss', 'visual:save', { projectId: P, datasetId: it.ds, name: `${tag} trashed`, chartType: 'bar', encoding: enc });
  const trashed = must('trashed', String(gone.body?.visual?.id ?? gone.body?.id ?? ''));
  must('trash', (await W.call('boss', 'visual:delete', { projectId: P, id: trashed })).body?.ok === true);
  const key = must('version', String((await W.call('boss', 'versions:list', { projectId: P, type: 'visual', id: it.visual })).body?.[0]?.key ?? ''));
  const sub = must('subscription', (await W.as('boss', () => subscriptions.createSubscription(P, { name: `${tag} weekly`, analysisId: it.board, content: { mode: 'all', cardIds: [] }, schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, timezone: 'UTC', channelIds: [randomUUID()], message: { title: '', note: '', includeLink: true }, conditions: { skipUnchanged: false, onlyWhenRefreshed: false } }, 'boss@acme.test')))?.id);
  const q = await W.call('boss', 'quality:save', { projectId: P, datasetId: it.ds, rule: { kind: 'not_null', column: 'dept', severity: 'warn' } });
  const qrule = must(`quality rule ${q.text.slice(0, 200)}`, String(q.body?.rule?.id ?? q.body?.rules?.[0]?.id ?? q.body?.id ?? ''));
  const sqlOf = async (words: string): Promise<string> => {
    const r = await W.call('boss', 'verified:save', { projectId: P, input: { question: `${tag} ${words}`, sql: `SELECT dept, sum(salary) AS total FROM "${tag} data" GROUP BY dept` } });
    return must(`sql question ${r.text.slice(0, 200)}`, String(r.body?.question?.id ?? ''));
  };
  const sql = await sqlOf('sql by dept');
  const sqlTrashed = await sqlOf('sql trashed');
  must('sql trash', (await W.call('boss', 'verified:delete', { projectId: P, id: sqlTrashed })).body?.ok === true);
  const folder = W.folders[where];
  const inp = await W.call('boss', 'input:create', { projectId: P, name: `${tag} input`, columns: [{ name: 'a', type: 'text' }], folderId: folder });
  const input = must(`input ${inp.text.slice(0, 200)}`, String(inp.body?.id ?? ''));
  return { ...it, folder, trashed, key, rel, sub, qrule, input, sql, sqlTrashed, tag };
}

export async function writeSections(W: H.World): Promise<void> {
  const { P } = W;
  // ── Inert in cost first (a project with no folder), before anything is planted there ──
  await inertCost(W);

  const tHr = await setIn(W, 'hr', 'T-hr');
  const tOps1 = await setIn(W, 'ops', 'T-ops1');
  const tOps2 = await setIn(W, 'ops', 'T-ops2');
  const all = Object.entries(WRITES).filter(([ch, c]) => (c === 'EDIT' || c === 'CREATE') && !(ch in OUT_OF_SCOPE)).map(([ch]) => ch);
  const callsFor = (t: Set) => callsOn(P, t);
  const labels = callsFor(tHr).map(([label]) => label);
  const chanOf = new Map(callsFor(tHr).map(([label, ch]) => [label, ch]));

  // A. Closed: opsLead on T_hr.
  const closed = await run(W, 'opsLead', tHr, callsFor(tHr));
  const unknown = Object.fromEntries(idsOf(tHr).map((id) => [id, randomUUID()]));
  const landedClosed: string[] = [];
  const spoke: string[] = [];
  for (const [label, ch, payload] of callsFor(tHr)) {
    const { r, changed } = closed.get(label)!;
    if (changed.length) landedClosed.push(`${label}: ${changed.slice(0, 3).join('; ')} — ${short(r)}`);
    if (refusedAs(r, 'closed')) continue;
    const missing = await W.call('opsLead', ch, H.swapped(payload, unknown));
    if (masked(r) !== masked(missing)) spoke.push(`${label}: ${short(r)} | ${short(missing)}`);
  }
  ok(`writes A: none of ${labels.length} writes by opsLead on HR's items changes a record of theirs or a placement`, landedClosed.length === 0, landedClosed.join('\n'));
  ok('writes A: each answers as for unknown ids, or refuses `closed` (naming nothing)', spoke.length === 0, spoke.join('\n'));

  // B. View: opsEditorView on T_ops1.
  const viewed = await run(W, 'opsEditorView', tOps1, callsFor(tOps1));
  // C1. The folder's editor: opsLead's same calls on T_ops1.
  const c1 = await run(W, 'opsLead', tOps1, callsFor(tOps1));
  // C2. The folder checks off: opsLead's on T_hr.
  const c2 = await off(gate.setFolderChecksForTest, () => run(W, 'opsLead', tHr, callsFor(tHr)));
  // C3. Only E6's write checks off: opsEditorView's on T_ops2.
  const c3 = await off(writes.setFolderWritesForTest, () => run(W, 'opsEditorView', tOps2, callsFor(tOps2)));

  const landed = (m: Ran) => labels.filter((l) => m.get(l)!.changed.length > 0);
  const [l1, l2, l3] = [landed(c1), landed(c2), landed(c3)];
  const viewLanded = labels.filter((l) => !(l in VIEW_ALLOWED) && viewed.get(l)!.changed.length).map((l) => `${l}: ${viewed.get(l)!.changed.slice(0, 3).join('; ')} — ${short(viewed.get(l)!.r)}`);
  ok(`writes B: none of opsEditorView's (Can view on Ops) writes on Ops's items changes anything`, viewLanded.length === 0, viewLanded.join('\n'));
  const notEdit = l3.filter((l) => !(l in VIEW_ALLOWED) && !refusedAs(viewed.get(l)!.r, 'edit')).map((l) => `${l}: ${short(viewed.get(l)!.r)}`);
  ok(`writes B: each of the ${l3.length} that lands without E6's checks refuses \`edit\``, l3.length > 40 && notEdit.length === 0, notEdit.join('\n'));
  const c1Missed = l2.filter((l) => !l1.includes(l)).map((l) => `${l}: ${short(c1.get(l)!.r)}`);
  ok(`NEGATIVE CONTROL C1: opsLead's same writes on Ops's items land (${l1.length})`, c1Missed.length === 0, c1Missed.join('\n'));
  ok(`NEGATIVE CONTROL C2: with the folder checks off, opsLead's writes on HR's items land (${l2.length} of ${labels.length})`, l2.length > 40, labels.filter((l) => !l2.includes(l)).map((l) => `${l}: ${short(c2.get(l)!.r)}`).join('\n'));
  const c3Missed = l2.filter((l) => !l3.includes(l)).map((l) => `${l}: ${short(c3.get(l)!.r)}`);
  ok(`NEGATIVE CONTROL C3: with only E6's write checks off, opsEditorView's land (${l3.length})`, c3Missed.length === 0, c3Missed.join('\n'));

  // Coverage: every EDIT and CREATE channel lands in C2, or is UNEXERCISED with why — and an entry that lands now is stale.
  const exercised = new Set(l2.map((l) => chanOf.get(l)));
  const missing = all.filter((ch) => !exercised.has(ch) && !(ch in UNEXERCISED));
  ok(`writes: each of ${all.length} EDIT and CREATE channels (E5's aside) is exercised (${exercised.size}) or UNEXERCISED with why (${Object.keys(UNEXERCISED).length})`, missing.length === 0,
    missing.map((ch) => `${ch}: ${labels.filter((l) => chanOf.get(l) === ch).map((l) => short(c2.get(l)!.r)).join(' / ') || 'no payload'}`).join('\n'));
  const nowLands = Object.keys(UNEXERCISED).filter((ch) => exercised.has(ch));
  ok('writes: every UNEXERCISED channel still has no effective payload (fixed? remove it)', nowLands.length === 0, nowLands.join(', '));
  // The gate's channels refuse before their handler, whatever the payload: closed for HR, `edit` for Can view.
  // (Their anchor straight from the input: captureDataset:delete and refreshHook:revoke read it from a record there is none
  // of; the pipeline's is every dataset, checked below.)
  const gated = Object.keys(UNEXERCISED).filter((ch) => ch in writeGate.WRITE_GATE && ch !== 'captureDataset:delete' && ch !== 'refreshHook:revoke' && !ch.startsWith('pipelines:'));
  const slack: string[] = [];
  for (const ch of gated) {
    const contract = (require('../src/api/index') as typeof import('../src/api/index')).contracts[ch as keyof typeof import('../src/api/index').contracts] as never;
    const forOn = (t: Set) => H.payloadFor(contract, { ...H.valuesFor(P, t, ch), id: ch.startsWith('input') ? t.input : t.ds, folderId: t.folder });
    const [onHr, onOps] = [forOn(tHr), forOn(tOps1)];
    if (!onHr || !onOps) continue;
    const [a, b] = [await W.call('opsLead', ch, onHr), await W.call('opsEditorView', ch, onOps)];
    if (!refusedAs(a, 'closed') || !refusedAs(b, 'edit')) slack.push(`${ch}: ${short(a)} | ${short(b)}`);
  }
  ok(`writes: the gate's unexercised channels (${gated.length}) refuse opsLead on HR \`closed\` and opsEditorView on Ops \`edit\` before their handler`, slack.length === 0, slack.join('\n'));

  await landings(W);
  await kept(W);
  await pipelines(W);
  await mcpWrites(W);
  await sqlQuestions(W);
}

/** A verified SQL question follows EVERY dataset its SQL reads: writing it needs Edit on all of them; one closed hides it. */
async function sqlQuestions(W: H.World): Promise<void> {
  const { P } = W;
  const saved = async (question: string, sql: string): Promise<string> => String((await W.call('boss', 'verified:save', { projectId: P, input: { question, sql } })).body?.question?.id ?? '');
  const listed = async (id: string): Promise<boolean> => (((await W.call('padmin', 'verified:list', { projectId: P })).body?.questions as Array<{ id: string }> | undefined) ?? []).some((q) => q.id === id);
  const both = await saved('Plain and Orders by dept', 'SELECT p.dept, sum(o.salary) AS total FROM "Plain" p JOIN "Orders" o ON p.dept = o.dept GROUP BY p.dept');
  const viewOnly = await W.call('opsEditorView', 'verified:delete', { projectId: P, id: both });
  ok('SQL questions: over Plain (Everyone) and Orders (Ops), opsEditorView — who edits Plain but views Orders — may not delete it (`edit`)', !!both && refusedAs(viewOnly, 'edit') && (await listed(both)), short(viewOnly));
  const lead = await W.call('opsLead', 'verified:delete', { projectId: P, id: both });
  ok('NEGATIVE CONTROL: opsLead, who edits both, deletes it', lead.body?.ok === true && !(await listed(both)), short(lead));
  const closed = await saved('Plain and salaries by dept', 'SELECT p.dept, sum(h.salary) AS total FROM "Plain" p JOIN "HRCANARY Salaries" h ON p.dept = h.dept GROUP BY p.dept');
  const [mine, unknown] = [await W.call('opsLead', 'verified:delete', { projectId: P, id: closed }), await W.call('opsLead', 'verified:delete', { projectId: P, id: randomUUID() })];
  ok('SQL questions: one that also reads HR is, to opsLead, as a missing one — and stays', !!closed && H.stable(mine) === H.stable(unknown) && (await listed(closed)), `${short(mine)} | ${short(unknown)}`);
  const sql = await W.call('opsEditorView', 'verified:save', { projectId: P, input: { question: 'Orders by person, verified', sql: 'SELECT person, sum(salary) AS total FROM "Orders" GROUP BY person' } });
  ok('SQL questions: a new one over Orders is refused opsEditorView (`edit`)', refusedAs(sql, 'edit'), short(sql));
  ok('NEGATIVE CONTROL: padmin deletes the one that reads HR', (await W.call('padmin', 'verified:delete', { projectId: P, id: closed })).body?.ok === true && !(await listed(closed)));
}

/** MCP's write tools write through the same stores, so they are held alike — no tool-specific code. */
async function mcpWrites(W: H.World): Promise<void> {
  const { P, ops } = W;
  const tokenOf = async (who: Person): Promise<string> => String((await W.call(who, 'tokens:create', { name: 'net writes', expiresInDays: 1 })).body?.token ?? '');
  const tool = (token: string, name: string, args: object): Promise<string> => W.mcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: P, ...args } } });
  const charts = async () => ((await W.call('padmin', 'visual:list', { projectId: P })).body as Array<{ datasetId: string }>).filter((v) => v.datasetId === ops.ds).length;
  const chart = { dataset: ops.ds, name: 'MCP chart', chartType: 'bar', encoding: enc };
  const before = await charts();
  const viewOnly = await tool(await tokenOf('opsEditorView'), 'create_visual', chart);
  ok('MCP: create_visual by opsEditorView\'s token (Can view on Ops) on Orders is refused, and makes nothing', viewOnly.includes(folders.folderRefusal('edit').error) && (await charts()) === before, viewOnly.slice(0, 300));
  const lead = await tool(await tokenOf('opsLead'), 'create_visual', chart);
  ok('NEGATIVE CONTROL: opsLead\'s token makes it', (await charts()) === before + 1, lead.slice(0, 300));
}

/** The project's pipeline names every dataset: opsLead (HR's closed to them) may not change it; padmin may. */
async function pipelines(W: H.World): Promise<void> {
  const { P } = W;
  const policy = (retries: number) => ({ projectId: P, policy: { retries, backoffMs: 5_000 } });
  const stored = async () => JSON.stringify((await W.call('padmin', 'pipelines:get', { projectId: P })).body?.policy ?? null);
  const before = await stored();
  const refusedLead = await W.call('opsLead', 'pipelines:setPolicy', policy(2));
  const refusedView = await W.call('opsEditorView', 'pipelines:run', { projectId: P });
  ok('pipelines: opsLead may not change the project\'s pipeline, which names HR\'s datasets (`closed`), and nothing changed', refusedAs(refusedLead, 'closed') && (await stored()) === before, short(refusedLead));
  ok('pipelines: nor run it', refusedAs(refusedView, 'closed'), short(refusedView));
  const unchecked = await off(writes.setFolderWritesForTest, () => W.call('opsLead', 'pipelines:setPolicy', policy(2)));
  ok('NEGATIVE CONTROL: with E6\'s checks off, opsLead\'s change lands', unchecked.body?.ok === true && (await stored()) !== before, short(unchecked));
  ok('NEGATIVE CONTROL: padmin changes it', (await W.call('padmin', 'pipelines:setPolicy', policy(1))).body?.ok === true);
}

/** Where creates land (D18), and what a whole save keeps, a purge drops and an export carries. */
async function landings(W: H.World): Promise<void> {
  const { P } = W;
  const placeOf = async (id: string) => (await W.pool.query<{ f: string }>("SELECT folder_id::text AS f FROM folder_items WHERE org_id = 'acme' AND item_id = $1", [String(id).toLowerCase()])).rows[0]?.f ?? null;
  const made = await W.call('opsLead', 'analysis:create', { projectId: P, name: 'No folder named' });
  ok('landing: a dashboard created naming no folder lands in Everyone (no placement)', !!made.body?.id && (await placeOf(made.body.id)) === null, short(made));
  const typed = await W.call('opsLead', 'input:create', { projectId: P, name: 'Into Ops', columns: [{ name: 'a', type: 'text' }], folderId: W.folders.ops });
  ok('landing: a typed table created naming Ops lands in Ops', (await placeOf(String(typed.body?.id ?? ''))) === W.folders.ops, short(typed));
  const intoHr = await W.call('opsLead', 'input:create', { projectId: P, name: 'Into HR', columns: [{ name: 'a', type: 'text' }], folderId: W.folders.hr });
  const intoNowhere = await W.call('opsLead', 'input:create', { projectId: P, name: 'Into nowhere', columns: [{ name: 'a', type: 'text' }], folderId: randomUUID() });
  ok('landing: naming HR, or a folder that is not there, refuses `closed` alike', H.refused(intoHr) && H.refused(intoNowhere) && H.stable(intoHr) === H.stable(intoNowhere), `${short(intoHr)} | ${short(intoNowhere)}`);
  const sql = 'SELECT dept, salary FROM "Orders"';
  const staged = await W.call('opsLead', 'sql:prepareSave', { projectId: P, sql });
  const fromSql = await W.call('opsLead', 'dataset:composeSave', { projectId: P, name: 'From SQL', base: { inline: { name: 'From SQL', stagedId: staged.body?.stagedId } }, joins: [], steps: [], sourceKind: 'sql', origin: { kind: 'sql', sql, deps: [] } });
  ok('landing: a SQL dataset over Orders (Ops) lands in Ops', (await placeOf(String(fromSql.body?.dataset?.id ?? ''))) === W.folders.ops, `${short(staged)} | ${short(fromSql)}`);
  const joined = await W.call('opsLead', 'dataset:composeSave', { projectId: P, name: 'Plain with Orders', base: { datasetId: W.plain }, joins: [{ datasetId: W.ops.ds, mode: 'left', on: { left: 'dept', right: 'dept' } }], steps: [] });
  ok('landing: Plain (Everyone) joined with Orders (Ops) lands in Ops, never in Everyone', (await placeOf(String(joined.body?.dataset?.id ?? ''))) === W.folders.ops, short(joined));
  const asAdmin = await W.call('padmin', 'dataset:composeSave', { projectId: P, name: 'Orders copy', base: { datasetId: W.ops.ds }, joins: [], steps: [] });
  ok('landing: an admin\'s copy of Orders lands in Ops too', (await placeOf(String(asAdmin.body?.dataset?.id ?? ''))) === W.folders.ops, short(asAdmin));
  ok('NEGATIVE CONTROL: Plain copied lands in Everyone', (await placeOf(String((await W.call('opsLead', 'dataset:composeSave', { projectId: P, name: 'Plain copy', base: { datasetId: W.plain }, joins: [], steps: [] })).body?.dataset?.id ?? 'x'))) === null);
}

async function kept(W: H.World): Promise<void> {
  const { P, hr, ops } = W;
  const topicBody = async () => (await W.pool.query<{ body: string }>("SELECT body FROM records WHERE org_id = 'acme' AND path ~ $1", [`topics/${W.topic}`])).rows[0]?.body ?? '';
  const saved = await W.call('opsLead', 'topic:save', { projectId: P, id: W.topic, topic: { name: 'Mixed topic', datasets: [{ id: ops.ds }, { id: W.plain }], metricIds: [ops.metric], termIds: [] } });
  const body = await topicBody();
  ok('topics: a whole save with no base by opsLead keeps HR\'s members, and lands Ops\'s change', saved.body?.ok === true && body.includes(hr.ds) && body.includes(hr.metric) && body.includes(hr.term) && body.includes(W.plain), short(saved));
  const dropped = await off(writes.setFolderWritesForTest, async () => off(gate.setFolderChecksForTest, async () => {
    await W.call('opsLead', 'topic:save', { projectId: P, id: W.topic, topic: { name: 'Mixed topic', datasets: [{ id: ops.ds }], metricIds: [ops.metric], termIds: [] } });
    return topicBody();
  }));
  ok('NEGATIVE CONTROL: with the folder checks off, the same save drops them', !dropped.includes(hr.ds));
  const modelExport: typeof import('../src/app/modelExport') = require('../src/app/modelExport');
  const files = (who: Person) => W.as(who, async () => JSON.stringify([...(await modelExport.exportModel(P)).files]));
  const hrIds = new RegExp([hr.ds, W.hrDim, hr.metric, hr.term].join('|'), 'i');
  const [exp, theirs] = [await files('opsLead'), await files('padmin')];
  ok('model:export: the files opsLead\'s export carries name nothing of HR (no canary, no id)', exp.length > 50 && !H.CANARY.test(exp) && !hrIds.test(exp), exp.slice(0, 200));
  ok('NEGATIVE CONTROL: padmin\'s carry HR\'s, its link to Orders included', H.CANARY.test(theirs) && theirs.includes(W.hrDim));
  const exportReply = await W.call('opsLead', 'model:export', { projectId: P });
  ok('model:export over the route answers opsLead a file', exportReply.body?.ok === true, short(exportReply));
  const purgeable = (await W.pool.query<{ item_id: string }>("SELECT item_id FROM folder_items WHERE org_id = 'acme' AND folder_id = $1::uuid AND kind = 'dataset'", [W.folders.hr])).rows.map((r) => r.item_id);
  const trashed = (await W.call('padmin', 'trash:list', { projectId: P })).body as Array<{ type: string; id: string }>;
  const inTrash = trashed.find((e) => e.type === 'dataset' && purgeable.includes(e.id.toLowerCase()));
  const purged = inTrash ? await W.call('padmin', 'trash:purge', { projectId: P, type: 'dataset', id: inTrash.id }) : null;
  const still = inTrash ? (await W.pool.query("SELECT 1 FROM folder_items WHERE org_id = 'acme' AND item_id = $1", [inTrash.id.toLowerCase()])).rowCount : -1;
  ok('trash: purging a dataset placed in HR drops its placement (the folder can then be deleted, E7)', !!inTrash && purged?.body?.ok === true && still === 0, inTrash ? short(purged!) : 'no HR dataset in the Trash');
}

/** With no folder in the project, E6's checks add at most one statement to a write (`hasFolders`), as section 0's lists. */
async function inertCost(W: H.World): Promise<void> {
  const proj = String((await W.call('boss', 'projects:create', { name: 'Bare writes' })).body?.id ?? '');
  await W.call('boss', 'project:share', { projectId: proj, member: { userId: W.uid.opsLead }, role: 'editor' });
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const ds = String((await W.as('boss', () => datasets.saveDataset(proj, { name: 'Bare', sourceKind: 'csv', columns: [{ name: 'dept', type: 'text' }, { name: 'salary', type: 'number' }], rows: [['a', 1], ['b', 2]] })))?.id ?? '');
  const saved = (await W.call('boss', 'visual:save', { projectId: proj, datasetId: ds, name: 'Bare chart', chartType: 'bar', encoding: enc })).body;
  const v = String(saved?.visual?.id ?? saved?.id ?? '');
  const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const count = async (fn: () => Promise<unknown>): Promise<number> => {
    const query = proto.query;
    let n = 0;
    proto.query = function (this: unknown, ...a: unknown[]) {
      n++;
      return query.apply(this, a);
    };
    try {
      await fn();
    } finally {
      proto.query = query;
    }
    return n;
  };
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['visual:update', () => W.call('opsLead', 'visual:update', { projectId: proj, id: v, name: `Bare ${randomUUID().slice(0, 4)}` })],
    ['catalog:setColumn', () => W.call('opsLead', 'catalog:setColumn', { projectId: proj, datasetId: ds, column: 'salary', patch: { description: randomUUID() } })],
    ['analysis:create', () => W.call('opsLead', 'analysis:create', { projectId: proj, name: 'Bare board' })],
    ['dataset:composeSave', () => W.call('opsLead', 'dataset:composeSave', { projectId: proj, name: 'Bare copy', base: { datasetId: ds }, joins: [], steps: [] })],
  ];
  const over: string[] = [];
  for (const [label, fn] of cases) {
    let [on, without] = [Infinity, Infinity];
    for (let i = 0; i < 3; i++) {
      on = Math.min(on, await count(fn));
      without = Math.min(without, await off(writes.setFolderWritesForTest, () => count(fn)));
    }
    if (on > without + 1) over.push(`${label}: ${on} > ${without} + 1`);
    console.log(`     inert write cost, ${label}: ${on} statements (${without} without E6's checks)`);
  }
  ok('inert in cost: with no folder, E6\'s checks add at most one statement to a write (whether the project has a folder)', over.length === 0, over.join('; '));
}
