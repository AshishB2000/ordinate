// A Live dataset's base filters in every compiled statement (semantic layer part 1, PR 08, D13) — PURE:
// builds SQL, runs nothing. scripts/test-liveBaseFilters.ts runs the same statements on the fake warehouse.
//
// 1. Every builder of a statement over the rows (the compiler's six, the profile) binds the base
//    filter's values, in every dialect, for a table and a defining query; with no base (or `[]`) each
//    statement is byte-identical to today's, SQL and parameters. NEGATIVE CONTROL: the canary check
//    sees a statement without the base.
// 2. The profile names a base column even past PROFILE_MAX_COLUMNS, and refuses one it does not declare.
//
//   npm run build:ts && node scripts/test-liveBaseCompile.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { CompileEnv, CompiledQuery, Compiled, LiveSource } from '../src/engine/live/compile';
import type { LiveFilter, LiveIR } from '../src/engine/live/liveSpec';

const compile: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const profile: typeof import('../src/engine/live/profileSql') = require('../src/engine/live/profileSql');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');

const show = (v: unknown): string => JSON.stringify(v);
const CANARY = 'zz-base-7c41';
const BASE: LiveFilter[] = [{ kind: 'in', column: 'region', values: ['North', CANARY], negate: true }];
const bound = (q: CompiledQuery): boolean => q.params.some((p) => p.value === CANARY);
const query = (c: Compiled | { ok: true; query: CompiledQuery } | { ok: false }): CompiledQuery | null => (c.ok ? (c as { query: CompiledQuery }).query : null);

const M = { column: 'amt', aggregation: 'sum' as const };
const chart = (category: LiveIR['category'], filters: LiveFilter[] = []): LiveIR => ({ kind: 'chart', category, measures: [M], filters, order: 'natural', weekCal: null });
const metricIr: LiveIR = { kind: 'metric', measures: [M], filters: [], order: 'natural', weekCal: null };
const latestIr = chart({ column: 'region', kind: 'text' }, [{ kind: 'latest', column: 'd', period: 'last_quarter', yearsBack: 0 }]);
const textIr = chart({ column: 'region', kind: 'text' }, [{ kind: 'compare', column: 'cat', op: '!=', value: 'x' }]);

const BUILDERS: [string, (env: CompileEnv) => Compiled | { ok: true; query: CompiledQuery } | { ok: false }][] = [
  ['compileMetric', (env) => compile.compileMetric(metricIr, env)],
  ['compileLatestDates', (env) => compile.compileLatestDates(latestIr, env)],
  ['compileBinRange', (env) => compile.compileBinRange(chart({ column: 'qty', kind: 'bins' }), env)],
  ['compileGrainProbe', (env) => compile.compileGrainProbe(chart({ column: 'd', kind: 'date' }), env)],
  ['compileChart', (env) => compile.compileChart(textIr, { kind: 'text' }, env)],
  ['compileCaseMatches', (env) => compile.compileCaseMatches('region', ['south'], env)],
  ['compileProfile', (env) => profile.compileProfile(env, { rows: 1000, percent: 5, samplingKey: true })],
  ['compileProfile (LIMIT only)', (env) => profile.compileProfile(env, { rows: 1000, limitOnly: true })],
];

const SOURCES: LiveSource[] = [{ kind: 'table', parts: ['t'] }, { kind: 'sql', sql: 'SELECT * FROM t' }];

for (const d of dialects.DIALECT_IDS) {
  for (const source of SOURCES) {
    const env = fx.env(source, fx.COLUMNS, d);
    for (const [name, build] of BUILDERS) {
      const label = `${name} (${d}, ${source.kind})`;
      const withBase = query(build({ ...env, base: BASE }));
      ok(`${label}: carries the base filter`, !!withBase && bound(withBase), show(withBase));
      const plain = build(env);
      ok(`${label}: byte-identical without one`, plain.ok === true && show(build({ ...env, base: [] })) === show(plain));
    }
  }
}

const env = fx.env({ kind: 'table', parts: ['t'] });
ok('NEGATIVE CONTROL: the canary check sees a statement without the base', !bound(query(compile.compileMetric(metricIr, env))!));
ok('the latest-date anchor is narrowed by the base, as a lock narrows it', bound(query(compile.compileLatestDates(latestIr, { ...env, base: BASE }))!));
ok('a base filter on an undeclared column refuses the question (unknownColumn)',
  show(compile.compileMetric(metricIr, { ...env, base: [{ kind: 'empty', column: 'gone', negate: true }] })) === show(compile.compileMetric({ ...metricIr, filters: [{ kind: 'empty', column: 'gone', negate: true }] }, env)));
ok('profile: a base column outside env.columns refuses (unknownColumn)',
  (() => { const r = profile.compileProfile({ ...env, columns: env.columns.slice(0, 1), base: BASE }, { rows: 1000 }); return !r.ok && r.code === 'unknownColumn'; })());
ok('profile: the sample is filtered, then capped — the base sits between the sample clause and the LIMIT',
  /USING SAMPLE 1000 ROWS\) AS lv_src WHERE .* LIMIT 1000\) AS lv_src/.test(query(profile.compileProfile({ ...env, base: BASE }, { rows: 1000 }))!.sql));

const wide = Array.from({ length: 501 }, (_, i) => ({ name: `c${i}`, type: 'text' as const }));
const kept = profile.profiledColumns(wide, [{ kind: 'empty', column: 'c500', negate: true }]);
ok('profiledColumns keeps a base column past the 500 cap, first, within the cap', kept.length === 500 && kept[0].name === 'c500' && kept.filter((c) => c.name === 'c500').length === 1);
ok('profiledColumns without a base is today\'s first 500', show(profile.profiledColumns(wide, [])) === show(wide.slice(0, 500)) && show(profile.profiledColumns(wide, undefined)) === show(wide.slice(0, 500)));
ok('profiledColumns keeps schema order for the rest', show(profile.profiledColumns(fx.COLUMNS, BASE).map((c) => c.name)) === show(['region', ...fx.COLUMNS.map((c) => c.name).filter((n) => n !== 'region')]));

finish();
