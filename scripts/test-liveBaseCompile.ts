// A Live dataset's base filters in every compiled statement (semantic layer part 1, PR 08, D13) — PURE:
// builds SQL, runs nothing. scripts/test-liveBaseFilters.ts runs the same statements on the fake warehouse.
//
// 1. Every builder of a statement over the rows (the compiler's six, the profile) binds the base
//    filter's values, in every dialect, for a table and a defining query; with no base (or `[]`) each
//    statement is byte-identical to today's, SQL and parameters. NEGATIVE CONTROL: the canary check
//    sees a statement without the base.
// 2. The profile names a base column even past PROFILE_MAX_COLUMNS, and refuses one it does not declare.
// 3. The inventory, by source scan (the test-liveUsage pattern): every file under src/ that makes a
//    ParamSink builds statements, and every builder function in one ends its statement through
//    `whereOf` (the compiler) or `sampledFrom` (the profile) — the two places the base is AND-ed in —
//    or is on the exempt list (it reads no rows, or the base reached it another way). A new builder fails here until
//    it carries the base.
//    NEGATIVE CONTROL: a planted builder without either is found.
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
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

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
  ['compileKeyCheck', (env) => compile.compileKeyCheck('region', env)],
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

// ── 3. The inventory ─────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
/** Repo-relative path → text, for every .ts under src/ (no declarations). */
function srcFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    }
  };
  walk('src');
  return out;
}
/**
 * Statements that need no base of their own: they read the catalog, not rows (plan's inventory #8); or (by file) a
 * semantic layer's statement, whose question already holds the base filters ahead of its own (semanticPlan's whereOf
 * puts `env.base` first, part 7 c1), so the encoder binds them as it binds any filter.
 */
const EXEMPT = new Set(['compileSamplingKeyProbe', 'src/engine/live/semantic/snowflake.ts:encode']);
/** Per builder file (one that makes a ParamSink): its `.finish(` count, and the builder functions that reach neither door. */
function builders(files: Map<string, string>): { finishers: [string, number][]; unbased: string[] } {
  const finishers: [string, number][] = [];
  const unbased: string[] = [];
  for (const [file, text] of [...files].sort()) {
    if (file === 'src/engine/live/sqlParams.ts' || !/new ParamSink\(/.test(text)) continue;
    finishers.push([file, (text.match(/\.finish\(/g) ?? []).length]);
    for (const chunk of text.split(/\n(?=(?:export )?function )/)) {
      const name = /^(?:export )?function (\w+)/.exec(chunk)?.[1];
      if (name && /\.finish\(/.test(chunk) && !/\b(whereOf|sampledFrom)\(/.test(chunk) && !EXEMPT.has(name) && !EXEMPT.has(`${file}:${name}`)) unbased.push(`${file}:${name}`);
    }
  }
  return { finishers, unbased };
}
const found = builders(srcFiles());
// compile.ts ×7: PR 01's compileKeyCheck is the seventh. formulaSql.ts (release A, p8-03) makes a ParamSink to check a
// formula at save and finishes no statement: counted, with 0, so a statement it starts to finish fails here. The
// Snowflake semantic encoder (c1) finishes one SEMANTIC_VIEW statement.
ok('inventory: the builders are exactly compile.ts ×7, formulaSql.ts ×0, profileSql.ts ×2 and semantic/snowflake.ts ×1',
  show(found.finishers) === show([['src/engine/live/compile.ts', 7], ['src/engine/live/formulaSql.ts', 0], ['src/engine/live/profileSql.ts', 2], ['src/engine/live/semantic/snowflake.ts', 1]]), show(found.finishers));
ok('inventory: every builder function ends its statement through whereOf or sampledFrom', found.unbased.length === 0, show(found.unbased));
const planted = new Map([...srcFiles(), ['src/engine/live/keyCheckSql.ts', "const b = new ParamSink();\nexport function compileKeyCheck(): unknown {\n  return b.finish('SELECT 1', d, []);\n}\n"]]);
const caught = builders(planted);
ok('inventory NEGATIVE CONTROL: a planted builder is counted, and named as carrying no base',
  caught.finishers.some(([f]) => f === 'src/engine/live/keyCheckSql.ts') && show(caught.unbased) === show(['src/engine/live/keyCheckSql.ts:compileKeyCheck']), show(caught));

finish();
