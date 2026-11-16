// What a write channel needs of shared folders before its handler runs (docs/team-folders/00-design.md D18) — the
// route's half of ./folderWrites.ts. It holds the writes whose parts live in many modules (a dataset's settings, docs,
// rules, snapshots, refresh), a few by-id writes whose record names its anchor, and WHERE a new dataset or dashboard
// lands (`land`: the folder the request names, else its parents', run as the handler's landing scope). Every other
// EDIT and CREATE channel is held by its store (scripts/folderNetWrites.ts IN_STORES says which seam); the safety net's
// section 8 holds each one. A refusal here is `closed` for an item the caller cannot open (it names nothing) and
// `edit` for one they only view. INERT: nothing restricts the caller → no read, no landing.

import { isValidId } from '../../app/ids';
import { orgDb } from '../db/inOrg';
import { ctx } from '../context';
import { datasetsAt, hasFolders, landsIn, mustEdit, mustEditEveryDataset, mustOpen, withLanding, writesChecked, type Anchor } from './folderWrites';
import { levelsOf } from './folderGate';

interface Needs {
  /** Edit on each. */
  readonly edit?: readonly Anchor[];
  /** Open (view) on each. */
  readonly open?: readonly Anchor[];
  /** Records in hand, each needing Edit on what it follows (src/app/recordOpen.ts). */
  readonly records?: ReadonlyArray<readonly [string, unknown]>;
  /** Edit on every dataset of the project: what its pipeline names (a project-level graph, run as the system). */
  readonly everyDataset?: true;
  /** A create: where what it makes lands. */
  readonly land?: { readonly folderId?: unknown; readonly parents?: readonly unknown[] };
}
type In = Record<string, any>; // any: the contract's parsed input, each field read as its zod schema shaped it
type Gate = (i: In, projectId: string) => Needs | Promise<Needs>;

const ds = (...ids: unknown[]): Needs => ({ edit: datasetsAt(ids) });
const board = (id: unknown): Needs => ({ edit: typeof id === 'string' ? [{ kind: 'dashboard', id }] : [] });
const lands = (i: In): Needs => ({ land: { folderId: i.folderId } });

/** `fn`'s needs, or none (and no read) when nothing restricts the caller here: for the needs that read a record first. */
async function restrictedOnly(projectId: string, fn: () => Promise<Needs>): Promise<Needs> {
  return (await levelsOf(projectId, 'dataset')) ? fn() : {};
}

/** A catalog ref (`kind:id`): a dataset or dashboard is its own anchor; any other record is read as the caller may read it. */
async function refNeeds(ref: string, projectId: string): Promise<Needs> {
  const [kind, id] = ref.split(':');
  if (kind === 'dataset') return ds(id);
  if (kind === 'analysis') return board(id);
  const read: Record<string, () => Promise<unknown>> = { // lazy: those stores reach this module
    visual: () => (require('../../analysis/visuals') as typeof import('../../analysis/visuals')).getVisual(projectId, id),
    metric: () => (require('../../analysis/metrics') as typeof import('../../analysis/metrics')).getMetric(projectId, id),
    report: () => (require('../../analysis/reportSpec') as typeof import('../../analysis/reportSpec')).getReport(projectId, id),
    story: () => (require('../../analysis/stories') as typeof import('../../analysis/stories')).getStory(projectId, id),
  };
  return read[kind] ? restrictedOnly(projectId, async () => ({ records: [[kind, await read[kind]()]] })) : {};
}

function hookNeeds(projectId: string, id: string): Promise<Needs> {
  return restrictedOnly(projectId, async () => {
    const pool = orgDb();
    const { hookDataset } = require('../hooks/store') as typeof import('../hooks/store'); // lazy: the hooks reach the job runner
    return pool ? ds(await hookDataset(pool, ctx().org.id, projectId, id)) : {};
  });
}

function captureNeeds(projectId: string, captureId: string): Promise<Needs> {
  return restrictedOnly(projectId, async () => {
    const { loadOwn } = require('../../app/captureUpload') as typeof import('../../app/captureUpload'); // lazy: it reaches the stores
    return ds(((await loadOwn(projectId, captureId).catch(() => null)) as { datasetId?: unknown } | null)?.datasetId);
  });
}

export const WRITE_GATE: Readonly<Record<string, Gate>> = {
  // A dataset's own settings, columns, refresh, mode and source tables.
  'dataset:update': (i) => ds(i.datasetId),
  'dataset:refresh': (i) => ds(i.id),
  'connection:refresh': (i) => ds(i.datasetId),
  'dataset:setMode': (i) => ds(i.datasetId),
  'dataset:setSourceTables': (i) => ds(i.datasetId),
  'dataset:sourceTableChoices': (i) => ds(i.datasetId),
  'dataset:syncLiveSchema': (i) => ds(i.datasetId),
  'incremental:set': (i) => ds(i.datasetId),
  'live:setBaseFilters': (i) => ds(i.datasetId),
  'live:setCalculated': (i) => ds(i.datasetId),
  'input:save': (i) => ds(i.id),
  'input:setColumns': (i) => ds(i.id),
  'snapshots:restore': (i) => ds(i.datasetId),
  'snapshots:setKeep': (i) => ds(i.datasetId),
  // …its docs, quality rules, privacy marks and refresh URLs.
  'catalog:addAlias': (i) => ds(i.datasetId),
  'catalog:dismissSuggestion': (i) => ds(i.datasetId),
  'catalog:setColumn': (i) => ds(i.datasetId),
  'catalog:setTable': (i) => ds(i.datasetId),
  'catalog:set': (i, p) => refNeeds(String(i.ref), p),
  'quality:save': (i) => ds(i.datasetId),
  'quality:delete': (i) => ds(i.datasetId),
  'quality:run': (i) => ds(i.datasetId),
  'privacy:decide': (i) => ds(i.datasetId),
  'privacy:scan': (i) => ds(...(Array.isArray(i.datasetIds) ? i.datasetIds : [])), // none named: the handler scans those the caller edits
  'refreshHook:create': (i) => ds(i.datasetId), // a connection's: project-level, as connections are
  'refreshHook:list': (i) => ds(i.datasetId),
  'refreshHook:revoke': (i, p) => hookNeeds(p, String(i.id)),
  'insights:dismiss': (i) => ds(/^([0-9a-f-]{36}):/i.exec(String(i.id))?.[1]), // an insight is about the dataset its id starts with
  'captureDataset:delete': (i, p) => captureNeeds(p, String(i.captureId)),
  'versions:restore': (i) => (i.type === 'dataset' ? ds(i.id) : i.type === 'dashboard' ? board(i.id) : {}), // the rest: their stores' guarded updates
  // A dashboard's currency and its Discard (the rest of its writes: the store's guarded update and patchStored).
  'fx:dashboard': (i) => board(i.dashboardId),
  'analysis:discard': (i) => board(i.id),
  // The project's pipeline: it names (and runs, as the system) every dataset — editing it needs Edit on all of them.
  'pipelines:run': () => ({ everyDataset: true }),
  'pipelines:setSchedule': () => ({ everyDataset: true }),
  'pipelines:setPolicy': () => ({ everyDataset: true }),
  'pipelines:setPaused': () => ({ everyDataset: true }),
  'pipelines:setNodeSchedule': () => ({ everyDataset: true }),
  // Creates: a copy or an RFM table reads its parent and lands with it; the others where the request says (else Everyone).
  // dataset:composeSave also lands with its parents, which it alone resolves (src/ipc/datasetCompose.ts).
  'dataset:copyLive': (i) => ({ open: datasetsAt([i.datasetId]), land: { folderId: i.folderId, parents: [i.datasetId] } }),
  'segments:rfmSave': (i) => ({ open: datasetsAt([i.datasetId]), land: { parents: [i.datasetId] } }),
  'dataset:composeSave': lands,
  'connection:import': lands,
  'connection:addSemanticDataset': lands,
  'input:create': lands,
  // Keep as a dataset (phase D): a source table's Live dataset has no parent dataset, so it lands in Everyone.
  'answer:keepTable': lands,
  'explore:keepTable': lands, // the same, from Explore
  'analysis:create': lands,
  // An answer on a dashboard: Edit on the one named, its DRAFT changed; else a new one lands with the answer's dataset.
  'answer:addToDashboard': (i) => (i.analysisId ? board(i.analysisId) : { land: { parents: [i.spec?.datasetId] } }),
  'analysis:buildPlan': lands,
};

/**
 * The route's check (src/server/app.ts), before `run` (the handler): what `channel`'s input needs, refused 409 `folder`
 * when it is not met; a create runs inside its landing. Channels not in WRITE_GATE run as they are.
 */
export async function gateWrite<T>(channel: string, input: unknown, projectId: string | null, run: () => Promise<T>): Promise<T> {
  const gate = Object.prototype.hasOwnProperty.call(WRITE_GATE, channel) ? WRITE_GATE[channel] : undefined;
  if (!gate || !projectId || !isValidId(projectId) || !input || typeof input !== 'object') return run();
  const i = input as In;
  if (!writesChecked()) { // the test seam: no check — but a create still lands where it lands
    const land = (await gate(i, projectId)).land;
    return land ? withLanding(projectId, await landsIn(projectId, land.folderId, land.parents ?? []), run) : run();
  }
  // A project with no folder besides Everyone restricts no one: only a create naming a folder (none is there) is refused.
  // One statement, which also spares the resolver its tree for the rest of the request.
  if (ctx().user.role !== 'admin' && !(await hasFolders(projectId))) return i.folderId !== undefined ? withLanding(projectId, await landsIn(projectId, i.folderId), run) : run();
  const need = await gate(i, projectId);
  if (need.open) await mustOpen(projectId, need.open);
  if (need.edit) await mustEdit(projectId, need.edit);
  if (need.everyDataset) await mustEditEveryDataset(projectId);
  if (need.records) {
    const { mustEditRecord } = require('../../app/recordOpen') as typeof import('../../app/recordOpen'); // lazy: the stores reach this module
    for (const [type, rec] of need.records) await mustEditRecord(projectId, type, rec);
  }
  if (!need.land) return run();
  return withLanding(projectId, await landsIn(projectId, need.land.folderId, need.land.parents ?? []), run);
}

