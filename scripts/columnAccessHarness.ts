// The world the column access suites share (semantic layer part 4, docs/semantic-layer/04-governance.md):
// scripts/rowPolicyHarness.ts's world, plus team HR with the viewer `hr`, and a dataset *Staff* (`dept`,
// `salary` number, `ssn` text holding SSN_CANARY_<i>, `employee_id`) with the Prepare step
// `bonus = [salary] * 0.1` — a carrier. *Plain* (no rules of any kind) relates to it: Plain.customer →
// Staff.employee_id, many-to-one. `salary` and `ssn` are visible to HR only, planted through `serialized`
// with `buildColumnAccess`, the builder the setter (step 07) calls.
//
// `east` is a viewer (through team East) whom Staff hides salary, ssn and bonus from; `hr` is a viewer who
// sees them; `ed` is an editor (sees every column). Not a test file itself (no `test-` prefix).

import * as H from './rowPolicyHarness';

type Cell = import('../src/data/transforms').Cell;
type Member = import('../src/data/columnAccess').Member;

const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const msg: typeof import('../src/data/rowAccessMessages') = require('../src/data/rowAccessMessages');

export const SSN_CANARY = 'SSN_CANARY';
export const STAFF_COLUMNS = [
  { name: 'dept', type: 'text' as const },
  { name: 'salary', type: 'number' as const },
  { name: 'ssn', type: 'text' as const },
  { name: 'employee_id', type: 'text' as const },
];
const DEPTS = ['Ops', 'Eng', 'Sales'];
/** 12 people; employee_id `c<i>` matches Plain's customers `c0`…`c8`. */
export const STAFF_ROWS: Cell[][] = Array.from({ length: 12 }, (_, i) => [DEPTS[i % 3], 1000 + i * 37, `${SSN_CANARY}_${i}`, `c${i}`]);
export const BONUS = { type: 'calculated_field' as const, name: 'bonus', expression: '[salary] * 0.1' };

export interface ColumnWorld extends H.World {
  staff: string;
  hrTeam: string;
  /** The column rules planted on Staff: salary and ssn for HR. */
  rules: Array<{ column: string; visibleTo: Member[] }>;
  /** Plant `rules` (default: Staff's) on `id`, built over its record as it is now. */
  plant(id: string, rules?: Array<{ column: string; visibleTo: Member[] }>): Promise<void>;
  /** Write the record's `columnAccess` as given (a corrupt one), or remove it (undefined). */
  setRaw(id: string, value: unknown): Promise<void>;
  rawOf(id: string): Promise<Record<string, unknown>>;
}

/** Null (with a skip line) without DATABASE_URL. */
export async function columnWorld(label: string): Promise<ColumnWorld | null> {
  const W = await H.world(label);
  if (!W) return null;
  const { P, call } = W;
  await call('hr', 'projects:list');
  W.uid.hr = (await W.pool.query<{ id: string }>('SELECT id::text FROM users WHERE email = $1', ['hr@acme.test'])).rows[0].id;
  const hrTeam = (await W.pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ('acme', 'HR') RETURNING id::text`)).rows[0].id;
  await W.pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [hrTeam, W.uid.hr]);
  const shared = await call('boss', 'project:share', { projectId: P, member: { teamId: hrTeam }, role: 'viewer' });
  if (shared.body?.ok !== true) throw new Error(`share failed: ${shared.text}`);
  const staff = await W.as('boss', async () => (await datasets.saveDataset(P, { name: 'Staff', sourceKind: 'csv', columns: STAFF_COLUMNS, rows: STAFF_ROWS }))!.id);
  const step = await call('boss', 'dataset:addStep', { projectId: P, datasetId: staff, step: BONUS });
  if (step.body?.ok !== true) throw new Error(`addStep failed: ${step.text.slice(0, 200)}`);
  const rel = await call('boss', 'relationship:save', { projectId: P, relationship: { from: { datasetId: W.plain, column: 'customer' }, to: { datasetId: staff, column: 'employee_id' }, cardinality: 'many_to_one' } });
  if (rel.status !== 200 || rel.body?.ok === false) throw new Error(`relationship failed: ${rel.text.slice(0, 200)}`);
  const rules = [{ column: 'salary', visibleTo: [{ teamId: hrTeam }] }, { column: 'ssn', visibleTo: [{ teamId: hrTeam }] }];
  const write = (id: string, fn: (r: Record<string, unknown>) => void) =>
    W.as('boss', () => rec.serialized(rec.datasetFilePath(P, id), (r) => { fn(r); return true; })).then((wrote) => { if (!wrote) throw new Error(`no record ${id}`); });
  const world: ColumnWorld = {
    ...W, staff, hrTeam, rules,
    plant: (id, r = rules) => write(id, (raw) => { raw.columnAccess = access.buildColumnAccess(raw, r, 'boss@acme.test', new Date().toISOString()); }),
    setRaw: (id, value) => write(id, (raw) => { if (value === undefined) delete raw.columnAccess; else raw.columnAccess = value; }),
    rawOf: (id) => W.as('boss', async () => JSON.parse(await require('../src/app/recordFs').readFile(rec.datasetFilePath(P, id), 'utf8')) as Record<string, unknown>),
  };
  await world.plant(staff);
  return world;
}

/** The sentence of a refusal reason. */
export const sentenceOf = (reason: 'hidden' | 'columns'): string => (reason === 'hidden' ? msg.rowHiddenMessage() : msg.rowColumnsMessage());

/**
 * A typed refusal for `reason`, in every wire form a channel answers one: 409 or `{ok:false, code, reason}`
 * (H.refused), or an answer channel's `{ok:false, code:'row_policy', error: <the sentence>}` (its `reason` is the sentence).
 */
export function refusedAs(r: H.Reply, reason: 'hidden' | 'columns'): boolean {
  if (H.refused(r, reason)) return true;
  const b = r.body as { ok?: unknown; code?: unknown; error?: unknown } | null;
  return r.status === 200 && !!b && b.ok === false && b.code === 'row_policy' && b.error === sentenceOf(reason);
}
