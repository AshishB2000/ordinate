// Row access rules, the pure parts (docs/row-policy/00-design.md D2b, D5, D7,
// D14, D16, D18): the sanitizer, the entitlement, the cross-row allow-list over
// every prepare step type, the writers of the rule column, the upstream closure
// and the idempotent prepend. No DB, no server.
//
//   npm run build:ts && node scripts/test-rowPolicy.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const policy: typeof import('../src/data/rowPolicy') = require('../src/data/rowPolicy');
const lock: typeof import('../src/data/rowLock') = require('../src/data/rowLock');
const up: typeof import('../src/data/upstream') = require('../src/data/upstream');
const access: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';

(async () => {
  // ── The sanitizer: strict on the way in ─────────────────────────────────
  const good = policy.parseRules('region', [{ teamId: TEAM, values: ['East', ' ', 'East'] }, { userId: U2, values: ['West'] }]);
  ok('set: a valid rule list parses; blank and repeated values are dropped', good.ok && JSON.stringify(good.rules) === JSON.stringify([{ teamId: TEAM, values: ['East'] }, { userId: U2, values: ['West'] }]), JSON.stringify(good));
  const problem = (c: unknown, r: unknown) => { const p = policy.parseRules(c, r); return p.ok ? 'ok' : p.problem; };
  ok('set: no column, a blank column → column', problem('', []) === 'column' && problem('  ', []) === 'column');
  ok('set: a rule naming both a user and a team, or neither, or a bad id → member',
    problem('region', [{ userId: U1, teamId: TEAM, values: ['x'] }]) === 'member' && problem('region', [{ values: ['x'] }]) === 'member'
      && problem('region', [{ userId: '../x', values: ['x'] }]) === 'member');
  ok('set: a rule with only blank values → values (never an empty `in`)', problem('region', [{ userId: U1, values: ['', '  '] }]) === 'values');
  ok('set: a value naming a parameter → value (a lock is literal values only)', problem('region', [{ userId: U1, values: ['[[who]]'] }]) === 'value');
  ok('set: too many rules → rules', problem('region', Array.from({ length: policy.MAX_RULES + 1 }, () => ({ userId: U1, values: ['x'] }))) === 'rules');

  // ── …and closed on the way out of a record ──────────────────────────────
  ok('load: a record with no rowPolicy key has no rules', policy.policyFromRecord({ id: 'x' }) === null);
  const stored = policy.policyFromRecord({ rowPolicy: { column: 'region', rules: [{ userId: U1, values: ['East'] }], stepsHash: 'h' } });
  ok('load: a valid stored policy reads back', !!stored && stored.column === 'region' && stored.stepsHash === 'h');
  for (const [label, bad] of [['a string', 'region'], ['no rules array', { column: 'region' }], ['a rule with no values', { column: 'region', rules: [{ userId: U1, values: [] }], stepsHash: '' }], ['no stepsHash', { column: 'region', rules: [] }]] as [string, unknown][]) {
    ok(`load: a corrupt policy (${label}) is CLOSED, never "no rules"`, policy.policyFromRecord({ rowPolicy: bad }) === policy.CLOSED_POLICY);
  }
  ok('NEGATIVE CONTROL: the closed policy names no column (so every restricted reader refuses `column`)', policy.CLOSED_POLICY.column === '' && policy.CLOSED_POLICY.rules.length === 0);

  // ── The entitlement ─────────────────────────────────────────────────────
  const p = { column: 'region', stepsHash: '', rules: [{ teamId: TEAM, values: ['East', 'North'] }, { userId: U1, values: ['West', 'East'] }] };
  ok('entitlement: no policy → all', policy.entitlement(null, U1, []) === 'all');
  ok('entitlement: a user rule', JSON.stringify(policy.entitlement(p, U1, [])) === '["West","East"]');
  ok('entitlement: a team rule', JSON.stringify(policy.entitlement(p, U2, [TEAM])) === '["East","North"]');
  ok('entitlement: user and team rules UNION, de-duplicated, in rule order', JSON.stringify(policy.entitlement(p, U1, [TEAM])) === '["East","North","West"]');
  ok('entitlement: ids compare case-insensitively', JSON.stringify(policy.entitlement(p, U1.toUpperCase(), [])) === '["West","East"]');
  ok('entitlement: no matching rule → none', policy.entitlement(p, U2, []) === 'none' && policy.entitlement(p, null, []) === 'none');
  ok('entitlement: the closed policy entitles nobody', policy.entitlement(policy.CLOSED_POLICY, U1, [TEAM]) === 'none');

  // ── The cross-row allow-list covers EVERY step type ─────────────────────
  const classified = new Set([...lock.ROW_LOCAL, ...Object.keys(lock.KEYED), ...lock.CROSS_ROW_STEPS]);
  const unclassified = [...transforms.STEP_TYPES].filter((t) => !classified.has(t));
  ok('allow-list: every prepare step type is classified (a new type must be added to rowLock.ts)', unclassified.length === 0, unclassified.join(', '));
  ok('NEGATIVE CONTROL: an invented step type is cross-row', lock.storesCrossRow([{ type: 'brand_new_step' } as never], ['region']));
  const cross = (steps: unknown[], origin?: { kind: string }) => lock.storesCrossRow(steps as never, ['region'], origin);
  ok('allow-list: row-local steps pass', !cross([{ type: 'replace_values', column: 'x', mode: 'exact', rules: [] }, { type: 'calculated_field', name: 'y', expression: '[x] * 2' }, { type: 'union', datasetId: U1 }]));
  ok('allow-list: segment, text_terms, lookup_join are cross-row', cross([{ type: 'segment' }]) && cross([{ type: 'text_terms' }]) && cross([{ type: 'lookup_join' }]));
  ok('allow-list: a window / group-by / pivot / keyed dedupe pass only when keyed on the locked column',
    !cross([{ type: 'window', partitionBy: ['region'] }]) && cross([{ type: 'window' }])
      && !cross([{ type: 'group_aggregate', groupBy: ['region', 'x'] }]) && cross([{ type: 'group_aggregate', groupBy: ['x'] }])
      && !cross([{ type: 'pivot', groupBy: ['region'] }]) && cross([{ type: 'pivot', groupBy: [] }])
      && !cross([{ type: 'dedupe_key', columns: ['region', 'id'] }]) && cross([{ type: 'dedupe_key', columns: ['id'] }])
      && !cross([{ type: 'dedupe' }]) && cross([{ type: 'dedupe', columns: ['id'] }]));
  ok('allow-list: an LOD calculated field is cross-row', cross([{ type: 'calculated_field', name: 't', expression: '{FIXED : SUM([sales])}' }]));
  ok('allow-list: SQL, notebook, composed and combined origins are cross-row; a connection is not',
    cross([], { kind: 'sql' }) && cross([], { kind: 'notebook' }) && cross([], { kind: 'composed' }) && cross([], { kind: 'combined' }) && !cross([], { kind: 'connection' }));

  // ── The writers of the rule column (D18) ────────────────────────────────
  const writers = (steps: unknown[]) => policy.columnWriters(steps as never, 'region').map((s) => (s as { type: string }).type);
  ok('writers: a replace, a calculated field named for it, a rename onto it, a fill, a drop, a mask are writers',
    JSON.stringify(writers([
      { type: 'replace_values', column: 'region', mode: 'exact', rules: [] }, { type: 'calculated_field', name: 'region', expression: '"East"' },
      { type: 'rename_column', from: 'zone', to: 'region' }, { type: 'fill_empty', column: 'region', value: 'East' },
      { type: 'drop_column', column: 'region' }, { type: 'mask_hash', column: 'region' },
    ])) === '["replace_values","calculated_field","rename_column","fill_empty","drop_column","mask_hash"]');
  ok('writers: a trim of every text column and a union are writers (they never name it)', JSON.stringify(writers([{ type: 'trim' }, { type: 'union', datasetId: U1 }])) === '["trim","union"]');
  ok('writers: a filter or a dedupe on it is NOT a writer; neither is a step on another column',
    writers([{ type: 'filter', column: 'region', op: '=', value: 'East' }, { type: 'dedupe_key', columns: ['region'] }, { type: 'replace_values', column: 'city', mode: 'exact', rules: [] }]).length === 0);
  const before = policy.writersHash([{ type: 'filter', column: 'sales', op: '>', value: 1 } as never], 'region');
  ok('writers hash: a step that does not write the column leaves the hash alone', before === policy.writersHash([], 'region'));
  ok('NEGATIVE CONTROL: adding a replace on the column moves the hash', before !== policy.writersHash([{ type: 'replace_values', column: 'region', mode: 'exact', rules: [{ from: 'West', to: 'East' }] } as never], 'region'));

  // ── The upstream closure (D14) ──────────────────────────────────────────
  const graph: Record<string, string[]> = { d: ['c'], c: ['b', 'a'], b: ['a'], a: [], loop1: ['loop2'], loop2: ['loop1'] };
  const parents = async (id: string) => graph[id] ?? [];
  const closure = await up.upstreamIds('d', parents);
  ok('closure: every ancestor, transitively, not the dataset itself', closure.complete && [...closure.ids].sort().join(',') === 'a,b,c');
  const loop = await up.upstreamIds('loop1', parents);
  ok('closure: a cycle terminates', loop.complete && [...loop.ids].join(',') === 'loop2');
  const deep: Record<string, string[]> = {};
  for (let i = 0; i < 40; i++) deep[`n${i}`] = [`n${i + 1}`];
  const long = await up.upstreamIds('n0', async (id) => deep[id] ?? [], 16);
  ok('closure: a chain past the depth is INCOMPLETE (the caller fails closed)', !long.complete);
  ok('parents: a record\'s origin deps and its union/lookup steps',
    JSON.stringify(up.parentsOfRecord({ origin: { kind: 'sql', sql: 'select 1', deps: [U1] }, steps: [{ type: 'union', datasetId: U2 }, { type: 'lookup_join', datasetId: U1 }] })) === JSON.stringify([U2, U1]));

  // ── One closure: the lineage graph (figureDatasets, pipelines) agrees with the rules' walk (round 2, PART 2b) ──
  const lineage: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
  const originMod: typeof import('../src/data/datasetOrigin') = require('../src/data/datasetOrigin');
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [A, B, C, D, E, F, G, H2] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
  const brokenJoin = { kind: 'composed', baseId: A, joins: [{ datasetId: B, mode: 'sideways' }] };
  const recs: Record<string, Record<string, unknown>> = {
    [A]: { id: A, name: 'A', steps: [] },
    [B]: { id: B, name: 'B', steps: [] },
    [C]: { id: C, name: 'Composed', steps: [], origin: { kind: 'composed', baseId: A, joins: [{ datasetId: B, mode: 'left' }] } },
    [D]: { id: D, name: 'Sql', steps: [], origin: { kind: 'sql', sql: 'select 1', deps: [A] } },
    [E]: { id: E, name: 'Union', steps: [{ type: 'union', datasetId: B }] },
    [F]: { id: F, name: 'Lookup', steps: [{ type: 'lookup_join', datasetId: A, leftKey: 'k', rightKey: 'k', columns: ['x'] }] },
    [G]: { id: G, name: 'Chain', steps: [], origin: { kind: 'sql', sql: 'select 1', deps: [C, E] } },
    [H2]: { id: H2, name: 'Broken', steps: [], origin: brokenJoin },
  };
  const g = lineage.buildGraph({ datasets: Object.values(recs), visuals: [], dashboards: [], metrics: [], reports: [], alerts: [] });
  const ups = new Map<string, string[]>();
  for (const e of g.edges) if (e.from.startsWith('dataset:') && e.to.startsWith('dataset:')) ups.set(e.to.slice(8), [...(ups.get(e.to.slice(8)) ?? []), e.from.slice(8)]);
  const viaGraph = async (x: string) => (await up.upstreamIds(x, async (p) => ups.get(p) ?? [])).ids;
  const viaRules = async (x: string) => (await up.upstreamIds(x, async (p) => up.parentsOfRecord(recs[p]))).ids;
  const show = (ids: Set<string>) => [...ids].sort().join(',');
  for (const [label, x, want] of [['composed', C, [A, B]], ['sql', D, [A]], ['union', E, [B]], ['lookup_join', F, [A]], ['sql over composed + union', G, [A, B, C, E]], ['an origin that does not sanitize', H2, [A, B]]] as const) {
    const [a, b] = [await viaGraph(x), await viaRules(x)];
    ok(`one closure: ${label} — the lineage graph and the rules' walk agree, exactly`, show(a) === show(b) && show(b) === [...want].sort().join(','), `${show(a)} | ${show(b)}`);
  }
  ok('NEGATIVE CONTROL: that last origin is one sanitizeOrigin drops — a strict reading would have named no parent', originMod.sanitizeOrigin(brokenJoin) === undefined);

  // ── The prepend is idempotent, and only keeps filter steps (D7, S4) ─────
  const l = lock.makeLock({ region: ['East', 'North'] })!;
  const user = [{ type: 'filter', column: 'sales', op: '>', value: 1 }] as never[];
  const once = access.withLockSteps(l, user);
  ok('prepend: the lock first, then the caller\'s filters', once.length === 2 && once[0] === l.steps[0]);
  ok('prepend: again on a list that already starts with the lock → unchanged', access.withLockSteps(l, once).length === 2);
  ok('prepend: a list that has the lock but NOT first gets it prepended (never skipped)', access.withLockSteps(l, [...user, ...l.steps] as never[]).length === 3);
  ok('prepend: a non-filter step from a caller is dropped (a rename cannot run before the lock)',
    access.withLockSteps(l, [{ type: 'rename_column', from: 'region', to: 'r' }, ...user] as never[]).every((s) => s.type === 'filter'));
  ok('lock: one value is `=`, several are `in`, both context', lock.lockStep('region', ['East']).op === '=' && lock.lockStep('region', ['a', 'b']).op === 'in' && l.steps[0].context === true);

  // ── A lock that cannot be honoured refuses in every engine (round 2, #2) ──
  const rf: typeof import('../src/engine/residentFilter') = require('../src/engine/residentFilter');
  const live: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
  const missing = { ...lock.lockStep('zone', ['East']) };
  const plainMissing = { type: 'filter', column: 'zone', op: '=', value: 'East' } as never;
  const table = { columns: [{ name: 'region', type: 'text' as const }], rows: [['East'], ['West']] };
  const reason = (fn: () => unknown): string => { try { fn(); return 'answered'; } catch (err) { return access.isRowPolicyError(err) ? err.reason : String(err); } };
  ok('JS fold: a lock on a column the table lacks refuses (column), never "Filter skipped"', reason(() => transforms.applyPipeline(table, [missing])) === 'column');
  ok('NEGATIVE CONTROL: the same filter without the lock mark is skipped, every row kept', transforms.applyPipeline(table, [plainMissing]).rows.length === 2);
  ok('resident filter: a lock on a missing column refuses', reason(() => rf.filterPredicate(table.columns, missing, [])) === 'column');
  ok('NEGATIVE CONTROL: …without the mark it applies nothing (null), as before', rf.filterPredicate(table.columns, plainMissing, []) === null);
  ok('Live spec: a lock on a missing column refuses', reason(() => live.adaptFilter(missing, [{ name: 'region', type: 'text' }], {}, [])) === 'column');
  ok('NEGATIVE CONTROL: …without the mark it is skipped with the warning, as before', live.adaptFilter(plainMissing, [{ name: 'region', type: 'text' }], {}, []) === null);

  // ── Steps whose output name defaults from their input write that name (round 2, #15) ──
  ok('writers: a sentiment step writes <column>_sentiment, a keyword-rules step <column>_category, unnamed',
    policy.columnWriters([{ type: 'text_sentiment', column: 'notes' } as never], 'notes_sentiment').length === 1
      && policy.columnWriters([{ type: 'keyword_rules', column: 'notes', rules: [] } as never], 'notes_category').length === 1);
  ok('NEGATIVE CONTROL: …and not another column', policy.columnWriters([{ type: 'text_sentiment', column: 'notes' } as never], 'region').length === 0);

  // ── The refusal's sentence is how a caught one is typed again ───────────
  const reply = [{ ok: false, error: new access.RowPolicyError('none').message }, { ok: false, error: 'something else' }];
  access.tagRowPolicyRefusals(reply);
  ok('tagging: a caught refusal gets code and reason; another failure does not',
    (reply[0] as Record<string, unknown>).code === 'row_policy' && (reply[0] as Record<string, unknown>).reason === 'none' && !('code' in reply[1]));

  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
