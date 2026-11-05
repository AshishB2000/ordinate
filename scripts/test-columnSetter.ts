// The column access setter (semantic layer part 4, step 07; docs/semantic-layer/04-governance.md D12–D14,
// D22, D23): `dataset:columnAccess` and `dataset:setColumnAccess`, over the real RPC route, as real users
// with real grants, in a scratch Postgres. The world is scripts/columnAccessHarness.ts (Staff: dept, salary,
// ssn, employee_id, and the Prepare step `bonus = [salary] * 0.1`), with its planted rules removed first:
// here only the setter writes them.
//
// - The admin sets a rule; the server adds the carrier bonus (`from: salary`), stamps it, forgets the project's
//   15 s rules memory (an older published page), and every door enforces it (east is refused sum(salary), hr and the editor are answered: NEGATIVE CONTROLS).
// - Only a project admin reads or sets them (an editor and a viewer are 403).
// - Refused with a sentence, nothing stored: a column the dataset lacks, a member of another org, a carrier
//   typed wider than its source, more than MAX_RULED_COLUMNS once carriers are added.
// - The read says `pipeline` after a step reading salary, and suggests a marked column.
// - A data write racing the setter keeps the rules (D2b, extended to columnAccess).
// - null and [] remove them.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-columnSetter.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';
import * as H from './rowPolicyHarness';

const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const { stableStringify } = require('../src/engine/queryCache') as typeof import('../src/engine/queryCache');

type ColumnRule = import('../src/data/columnAccess').ColumnRule;

void (async () => {
  const W = await C.columnWorld('column setter');
  if (!W) return finish();
  try {
    const { P, staff, hrTeam: HR } = W;
    await W.setRaw(staff, undefined); // the harness planted rules; here the setter writes them
    const Q = { projectId: P, datasetId: staff };
    const set = (who: string, columns: unknown, datasetId = staff) => W.call(who, 'dataset:setColumnAccess', { projectId: P, datasetId, columns });
    const read = (who = 'boss') => W.call(who, 'dataset:columnAccess', Q);
    const stored = async () => (await W.rawOf(staff)).columnAccess as import('../src/data/columnAccess').ColumnAccess | undefined;
    const SUM_SALARY = { projectId: P, datasetId: staff, encoding: { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] }, filters: [] };
    const answered = (r: H.Reply): boolean => r.status === 200 && !H.refused(r) && r.body?.ok !== false;
    const EAST = { teamId: W.team };
    const must = (what: string, r: H.Reply): H.Reply => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`${what}: ${r.text.slice(0, 200)}`); return r; };
    must('mark ssn', await W.call('boss', 'catalog:setColumn', { projectId: P, datasetId: staff, column: 'ssn', patch: { sensitivity: 'personal' } }));

    ok('NEGATIVE CONTROL: with no rules, east is answered sum(salary)', answered(await W.call('east', 'visual:data', SUM_SALARY)));
    const none = await read();
    ok('the read with no rules: none, no rules, ssn suggested', none.body?.ok === true && none.body.state === 'none' && none.body.rules.length === 0 && none.body.suggest.includes('ssn'), none.text.slice(0, 300));

    // ── Set ────────────────────────────────────────────────────────────────
    const before = Date.now();
    const since = new Date(before).toISOString();
    ok('setup: the project\'s 15 s memory says no column rules since now (and remembers it)', !(await W.as('boss', () => rowAccess.anyColumnRulesSince(P, since))));
    const r = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }]);
    ok('the save forgets that memory: an older published page stops at once on this pod', await W.as('boss', () => rowAccess.anyColumnRulesSince(P, since)));
    ok('the admin sets it; the carrier is added, read-only, from salary', r.body?.ok === true && r.body.rules.some((x: ColumnRule) => x.column === 'bonus' && x.from === 'salary'), r.text.slice(0, 300));
    ok('…the carrier is visible to whom salary is', stableStringify(r.body?.rules?.find((x: ColumnRule) => x.column === 'bonus')?.visibleTo) === stableStringify([{ teamId: HR }]));
    const s1 = await stored();
    ok('stored and stamped by the server: updatedBy, updatedAt, readersHash', !!s1 && s1.updatedBy === 'boss@acme.test' && Date.parse(s1.updatedAt) >= before - 1000 && Date.parse(s1.updatedAt) <= Date.now() && typeof s1.readersHash === 'string' && s1.readersHash.length > 0, JSON.stringify(s1));
    ok('…what is stored sanitizes and still holds', !!s1 && access.columnAccessFromRecord(await W.rawOf(staff)) !== 'closed' && access.accessState(await W.rawOf(staff), s1) === 'ok');
    const audited = await W.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE channel = 'dataset:setColumnAccess' AND outcome = 'ok' AND $1 = ANY(target_ids)`, [staff]);
    ok('the save is audited by the route', (audited.rows[0]?.n ?? 0) >= 1);
    ok('east is now refused sum(salary); hr is answered', H.refused(await W.call('east', 'visual:data', SUM_SALARY), 'hidden') && answered(await W.call('hr', 'visual:data', SUM_SALARY)));
    ok('NEGATIVE CONTROL: the editor sees every column', answered(await W.call('ed', 'visual:data', SUM_SALARY)));
    const marked = await W.call('east', 'dataset:columns', { projectId: P, id: staff });
    ok('east\'s header marks salary and bonus hidden, not ssn (not ruled)', ((cols: Array<{ name: string; hidden?: true }>) => cols.filter((c) => c.hidden).map((c) => c.name).sort().join() === 'bonus,salary')(marked.body?.columns ?? []), marked.text.slice(0, 300));
    const got = await read();
    ok('the read returns the rules, carriers with from, state ok, and ssn still suggested', got.body?.ok === true && got.body.state === 'ok' && got.body.rules.length === 2 && got.body.rules.find((x: ColumnRule) => x.column === 'salary')?.from === undefined && got.body.suggest.includes('ssn') && Array.isArray(got.body.builtFrom), got.text.slice(0, 300));

    // ── Who ────────────────────────────────────────────────────────────────
    ok('an editor and a viewer are 403 on both channels', [await set('ed', []), await set('east', []), await read('ed'), await read('east')].every((x) => x.status === 403));
    ok('NEGATIVE CONTROL: …and that refused nothing for the admin: the rules are still stored', stableStringify(await stored()) === stableStringify(s1));

    // ── Refused, nothing stored ─────────────────────────────────────────────
    const lacks = await set('boss', [{ column: 'nope', visibleTo: [] }]);
    ok('a column the dataset lacks is refused with a sentence; nothing stored', lacks.body?.ok === false && typeof lacks.body.error === 'string' && lacks.body.error.includes('nope') && (await stored())?.columns.length === 2, lacks.text.slice(0, 200));
    await W.pool.query(`INSERT INTO orgs (id, name) VALUES ('globex', 'globex') ON CONFLICT DO NOTHING`);
    const FOREIGN_TEAM = (await W.pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ('globex', 'HR') RETURNING id::text`)).rows[0].id;
    const foreign = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: FOREIGN_TEAM }] }]);
    ok('a member of another org is refused; nothing stored', foreign.body?.ok === false && typeof foreign.body.error === 'string' && stableStringify(await stored()) === stableStringify(s1), foreign.text.slice(0, 200));
    const unknownUser = await set('boss', [{ column: 'salary', visibleTo: [{ userId: crypto.randomUUID() }] }]);
    ok('…a user who does not exist too', unknownUser.body?.ok === false && stableStringify(await stored()) === stableStringify(s1));
    const wider = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }, { column: 'bonus', visibleTo: [{ teamId: HR }, EAST] }]);
    ok('a carrier typed with a wider list than its source is refused, naming both; nothing stored', wider.body?.ok === false && /bonus/.test(wider.body.error) && /salary/.test(wider.body.error) && stableStringify(await stored()) === stableStringify(s1), wider.text.slice(0, 200));
    const narrower = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }, EAST] }, { column: 'bonus', visibleTo: [{ teamId: HR }] }]);
    ok('NEGATIVE CONTROL: …a carrier typed narrower than its source is kept, as typed', narrower.body?.ok === true && stableStringify(narrower.body.rules.find((x: ColumnRule) => x.column === 'bonus')) === stableStringify({ column: 'bonus', visibleTo: [{ teamId: HR }] }), narrower.text.slice(0, 300));
    const alone = await set('boss', [{ column: 'bonus', visibleTo: [EAST] }]);
    ok('NEGATIVE CONTROL: …and bonus alone (salary not ruled) is an ordinary rule', alone.body?.ok === true && alone.body.rules.length === 1 && alone.body.rules[0].from === undefined, alone.text.slice(0, 200));
    must('restore', await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }]));
    const s2 = await stored();
    const dup = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }, { column: 'salary', visibleTo: [] }]);
    ok('a column named twice is refused; nothing stored', dup.body?.ok === false && stableStringify(await stored()) === stableStringify(s2), dup.text.slice(0, 200));
    ok('a typed `from` is refused by the contract (a carrier is never typed)', (await set('boss', [{ column: 'bonus', visibleTo: [], from: 'salary' }])).status === 400);

    // More than MAX_RULED_COLUMNS once the carriers are added: a dataset of 257 columns, c0 carried into `more`.
    const WIDE = await W.as('boss', async () => (await datasets.saveDataset(P, { name: 'Wide', sourceKind: 'csv', columns: Array.from({ length: 257 }, (_, i) => ({ name: `c${i}`, type: 'number' as const })), rows: [Array.from({ length: 257 }, (_, i) => i)] }))!.id);
    must('wide step', await W.call('boss', 'dataset:addStep', { projectId: P, datasetId: WIDE, step: { type: 'calculated_field', name: 'more', expression: '[c0] + 1' } }));
    const rulesOf = (n: number) => Array.from({ length: n }, (_, i) => ({ column: `c${i}`, visibleTo: [{ teamId: HR }] }));
    const tooMany = await set('boss', rulesOf(256), WIDE);
    const wideRaw = async () => (await W.as('boss', async () => JSON.parse(await require('../src/app/recordFs').readFile(rec.datasetFilePath(P, WIDE), 'utf8')))) as Record<string, unknown>;
    ok('more than MAX_RULED_COLUMNS once carriers are added is refused; nothing stored', tooMany.body?.ok === false && !('columnAccess' in (await wideRaw())), tooMany.text.slice(0, 200));
    const fits = await set('boss', rulesOf(255), WIDE);
    ok('NEGATIVE CONTROL: …255 and the carrier (256) is stored', fits.body?.ok === true && fits.body.rules.length === 256, fits.text.slice(0, 200));

    // ── State and suggestions ───────────────────────────────────────────────
    const afterStep = async <T>(step: object, check: () => Promise<T>): Promise<T> => {
      must('addStep', await W.call('boss', 'dataset:addStep', { projectId: P, datasetId: staff, step }));
      try { return await check(); } finally {
        const steps = (await W.rawOf(staff)).steps as unknown[];
        must('setSteps', await W.call('boss', 'dataset:setSteps', { projectId: P, datasetId: staff, steps: steps.slice(0, -1) }));
      }
    };
    const CALC_SALARY2 = { type: 'calculated_field', name: 'salary2', expression: '[salary] * 2' };
    ok('the read says pipeline after a new step reads salary, and suggests the marked column ssn', ((x) => x?.state === 'pipeline' && x.suggest.includes('ssn'))((await afterStep(CALC_SALARY2, () => read())).body), '');
    const again = await afterStep(CALC_SALARY2, async () => {
      const saved = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }]);
      return { saved, state: (await read()).body?.state, salary2: saved.body?.rules?.find((x: ColumnRule) => x.column === 'salary2') };
    });
    ok('…saving again holds: state ok, and salary2 is a carrier', again.saved.body?.ok === true && again.state === 'ok' && again.salary2?.from === 'salary', JSON.stringify(again).slice(0, 300));
    must('restore', await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }]));
    const ruledSsn = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }, { column: 'ssn', visibleTo: [{ teamId: HR }] }]);
    ok('NEGATIVE CONTROL: a hidden marked column is no longer suggested', ruledSsn.body?.ok === true && !(await read()).body?.suggest.includes('ssn'));
    must('restore', await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }]));

    // ── A data write racing the setter keeps the rules (D2b) ────────────────
    /**
     * Holds a re-import of Staff (what a refresh writes) between its fetch and its record write — the record write
     * awaits a gate — sets the rules meanwhile, releases it, and compares what is stored with what the setter wrote.
     */
    const raceRefreshWithSetter = async (): Promise<boolean> => {
      must('clear', await set('boss', null));
      const file = await W.as('boss', async () => rec.datasetFilePath(P, staff));
      const real = rec.writeRecordKeepingPolicy;
      let reached!: () => void;
      const atWrite = new Promise<void>((res) => { reached = res; });
      let open!: () => void;
      const gate = new Promise<void>((res) => { open = res; });
      (rec as { writeRecordKeepingPolicy: typeof real }).writeRecordKeepingPolicy = async (f, obj) => {
        if (f === file) { reached(); await gate; }
        return real(f, obj);
      };
      try {
        const refresh = W.as('boss', () => datasets.updateDatasetData(P, staff, { columns: C.STAFF_COLUMNS, rows: C.STAFF_ROWS }));
        await atWrite;
        const setter = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }]);
        const written = await stored();
        open();
        await refresh;
        const after = await stored();
        return setter.body?.ok === true && !!written && stableStringify(after) === stableStringify(written);
      } finally {
        (rec as { writeRecordKeepingPolicy: typeof real }).writeRecordKeepingPolicy = real;
      }
    };
    ok('a refresh racing the setter keeps the rules', await raceRefreshWithSetter());

    // ── Remove ─────────────────────────────────────────────────────────────
    const removed = await set('boss', null);
    ok('null removes them, and east is answered again', removed.body?.ok === true && (await stored()) === undefined && answered(await W.call('east', 'visual:data', SUM_SALARY)), removed.text.slice(0, 200));
    must('again', await set('boss', [{ column: 'salary', visibleTo: [] }]));
    ok('an empty visibleTo hides it from every viewer, hr too', H.refused(await W.call('hr', 'visual:data', SUM_SALARY), 'hidden'));
    ok('[] removes them too', (await set('boss', [])).body?.ok === true && (await stored()) === undefined && answered(await W.call('hr', 'visual:data', SUM_SALARY)));

  } catch (err) {
    ok('the suite ran', false, err instanceof Error ? err.stack : String(err));
  } finally {
    await W.close();
    finish();
  }
})();
