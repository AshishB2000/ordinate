// Self-check for T6.4 (threat-model R1): a user regex can never block the
// server's event loop past a deadline.
//
//   1. DESKTOP first (no server mode): the inline fold, as it always ran, is
//      the reference — and it is checked against a verbatim copy of the
//      pre-T6.4 expressions, so the shared builders changed nothing.
//   2. SERVER: the same steps / rules through the async entry points (the
//      regex worker) give Object.is-identical cells, rows, warnings and counts.
//   3. The R1 patterns over hostile cells — replace, split, keyword rules and a
//      quality rule, all at once — come back as the translated timeout within
//      the deadline, while a 5 ms ticker keeps firing (max event-loop delay
//      measured); the killed threads are replaced and an ordinary step works.
//   4. Formula patterns run on V8's linear engine on the server: the R1 pattern
//      answers at once, ordinary ones agree with the desktop, a backreference
//      is null.
//   5. The backstop: a sync fold reaching a user regex on the server refuses.
//   6. NEGATIVE CONTROL: the same hostile step through the old inline path (a
//      child process, desktop mode) is still running at twice the deadline.
//
//   npm run build:ts && node scripts/test-regexDeadline.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { spawn }: typeof import('child_process') = require('child_process');
const { monitorEventLoopDelay }: typeof import('perf_hooks') = require('perf_hooks');

type Cell = import('../src/data/transforms').Cell;
type TableData = import('../src/data/transforms').TableData;
type TransformStep = import('../src/data/transforms').TransformStep;
type QualityRule = import('../src/analysis/qualityRules').QualityRule;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-regex-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const T: typeof import('../src/data/transforms') = require('../src/data/transforms');
const Q: typeof import('../src/analysis/qualityRules') = require('../src/analysis/qualityRules');
const off: typeof import('../src/data/regexOffThread') = require('../src/data/regexOffThread');
const pool: typeof import('../src/engine/regexPool') = require('../src/engine/regexPool');
const ctx: typeof import('../src/server/context') = require('../src/server/context');
const rs: typeof import('../src/data/regexSubset') = require('../src/data/regexSubset');
const msg: typeof import('../src/data/regexMessages') = require('../src/data/regexMessages');

const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    return ka.length === Object.keys(b as object).length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return Object.is(a, b);
};

// ── Fixture: ordinary text, empties, a number, astral and Unicode spaces ─────
const notes = ['Order #12345 - Shipped, Alpha Co', 'order #7 -  pending', '', '   ', null, 42, 'Refund requested - late',
  'shipping delayed - 😀 emoji', 'a-b-c-d', '007', 'Ünïcödé — DELIVERED', 'tab\there - x'];
const source: TableData = {
  columns: [{ name: 'id', type: 'number' }, { name: 'note', type: 'text' }],
  rows: Array.from({ length: 600 }, (_, i): Cell[] => [i, notes[i % notes.length] as Cell]),
};
const ordinary: TransformStep[] = [
  { type: 'replace_values', column: 'note', mode: 'regex', rules: [{ from: '\\d+', to: '#' }, { from: '(?:ship|SHIP)\\w*', to: '$&-x' }] },
  { type: 'replace_values', column: 'note', mode: 'regex', ignoreCase: true, rules: [{ from: 'order', to: 'O' }] },
  { type: 'split_column', column: 'note', mode: 'regex', pattern: '\\s*-\\s*', into: 'columns', count: 3 },
  { type: 'split_column', column: 'note', mode: 'regex', pattern: '[,—]', into: 'rows' },
  { type: 'keyword_rules', column: 'note', otherwise: 'Other', rules: [
    { pattern: 'ship(?:ped|ping)', category: 'Logistics', match: 'regex' },
    { pattern: 'refund', category: 'Billing', match: 'contains' },
    { pattern: 'LATE', category: 'Delay', match: 'word', caseSensitive: true },
    { pattern: '\\d{3,}', category: 'Numbered', match: 'regex', caseSensitive: true },
  ] },
] as TransformStep[];
const pipeline = [ordinary[0], ordinary[2]]; // two regex steps in one fold
const qRule = (pattern: string): QualityRule => ({ id: '11111111-1111-4111-8111-111111111111', kind: 'regex', column: 'note', args: { pattern }, severity: 'fail' });
const qPatterns = ['Order #\\d+ - .*', '[a-z ]+', '.*\\d.*'];
const formula = (expr: string): TransformStep => ({ type: 'calculated_field', name: 'f', expression: expr });
const formulas = ['regexp_match([note], "^[A-Z]")', 'regexp_extract([note], "#(\\\\d+)")', 'regexp_replace([note], "\\\\s+", "_")'];

(async () => {
  // ── 1. Desktop: the reference ───────────────────────────────────────────────
  const ref = {
    steps: ordinary.map((s) => T.applyPipeline(source, [s])),
    pipeline: T.applyPipeline(source, pipeline),
    rules: qPatterns.map((p) => Q.evaluateRuleJs(qRule(p), source.columns, source.rows)),
    formulas: formulas.map((f) => T.applyPipeline(source, [formula(f)])),
  };
  ok('desktop: the async fold IS the sync fold (no worker off the server)',
    same(await off.applyPipelineAsync(source, pipeline), ref.pipeline) && pool.killedCount() === 0);

  // The pre-T6.4 expressions, verbatim: a chain of text.replace(re, () => to), and text.split(re).
  const oldReplace = (s: Extract<TransformStep, { type: 'replace_values' }>) => (text: string) => {
    let out = text;
    s.rules.forEach((r) => { const c = rs.checkRegex(r.from); if (c.ok) out = out.replace(rs.jsRegex(c.js, !!s.ignoreCase), () => r.to); });
    return out;
  };
  const texts = notes.filter((n): n is string | number => n !== null).map(String);
  const r0 = ordinary[0] as Extract<TransformStep, { type: 'replace_values' }>;
  ok('regexReplacer = the pre-T6.4 replace chain, text for text',
    texts.every((x) => rs.regexReplacer(r0.rules, false)(x) === oldReplace(r0)(x)));
  const sp = ordinary[2] as Extract<TransformStep, { type: 'split_column' }>;
  const spRe = (() => { const c = rs.checkRegex(sp.pattern); return c.ok ? rs.jsRegex(c.js, false) : null; })();
  ok('regexSplitter = the pre-T6.4 split, text for text',
    texts.every((x) => same(rs.regexSplitter(sp.pattern as string, false)(x), x.split(spRe as RegExp))));

  const hostile = ['(\\w+)+!', '(a|a)+!', '\\w+\\w+\\w+\\w+\\w+\\w+\\w+\\w+\\w+\\w+\\w+\\w+!'];
  const t0 = performance.now();
  const checks = hostile.map((p) => rs.checkRegex(p).ok);
  ok('validation is no hazard: checkRegex accepts the R1 patterns in < 50 ms (it only tests "")',
    checks.every(Boolean) && performance.now() - t0 < 50, `${(performance.now() - t0).toFixed(1)} ms`);

  // ── 2. Server: byte-identical through the worker ───────────────────────────
  ctx.enterServerMode(tmp);
  for (let i = 0; i < ordinary.length; i++) {
    const got = await off.applyPipelineAsync(source, [ordinary[i]]);
    ok(`server = desktop, Object.is on every cell: ${ordinary[i].type} #${i}`, same(got, ref.steps[i]) && got.warnings.length === 0);
  }
  ok('server = desktop for a two-regex-step fold (rows, warnings, stepCounts)', same(await off.applyPipelineAsync(source, pipeline), ref.pipeline));
  for (let i = 0; i < qPatterns.length; i++) {
    ok(`server = desktop for quality pattern ${qPatterns[i]} (failing, sample)`,
      same(await off.evaluateRuleAsync(qRule(qPatterns[i]), source.columns, source.rows), ref.rules[i]));
  }
  const p0 = await off.failingPredicateAsync(qRule(qPatterns[0]), source.columns, source.rows);
  const p1 = Q.failingPredicateJs(qRule(qPatterns[0]), source.columns, source.rows, undefined, new Map(source.rows.map((r) => [String(r[1]), /^(?:Order #\d+ - .*)$/su.test(String(r[1]))])));
  ok('server: the failing-row predicate agrees row for row', 'test' in p0 && 'test' in p1 && source.rows.every((r) => p0.test(r) === p1.test(r)));

  // ── 3. Hostile patterns: timeout within the deadline, loop keeps serving ───
  const evil = 'a'.repeat(40);
  const hostileTable: TableData = { columns: source.columns, rows: [[1, 'fine - text'], [2, evil], [3, 'also fine']] };
  const deadline = pool.deadline();
  const timeoutText = msg.regexTimeoutWarning('2');
  const runs: Array<{ label: string; run: () => Promise<boolean> }> = [
    ...hostile.map((p) => ({
      label: `replace ${p}`,
      run: async () => { const r = await off.applyPipelineAsync(hostileTable, [{ type: 'replace_values', column: 'note', mode: 'regex', rules: [{ from: p, to: 'x' }] } as TransformStep]); return same(r.warnings, [timeoutText]) && same(r.rows, hostileTable.rows); },
    })),
    { label: 'split (\\w+)+!', run: async () => (await off.applyPipelineAsync(hostileTable, [{ type: 'split_column', column: 'note', mode: 'regex', pattern: '(\\w+)+!', into: 'rows' } as TransformStep])).warnings[0] === timeoutText },
    { label: 'keyword (\\w+)+!', run: async () => (await off.applyPipelineAsync(hostileTable, [{ type: 'keyword_rules', column: 'note', rules: [{ pattern: '(\\w+)+!', category: 'X', match: 'regex' }] } as TransformStep])).warnings[0] === timeoutText },
    { label: 'quality (\\w+)+!', run: async () => (await off.evaluateRuleAsync(qRule('(\\w+)+!'), hostileTable.columns, hostileTable.rows)).error === msg.regexTimeoutRuleError('2') },
  ];
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 5);
  const started = performance.now();
  const results = await Promise.all(runs.map(async (r) => { const s = performance.now(); const good = await r.run(); return { ...r, good, ms: performance.now() - s }; }));
  const wall = performance.now() - started;
  clearInterval(ticker);
  h.disable();
  const maxDelay = h.max / 1e6;
  for (const r of results) {
    ok(`hostile ${r.label}: the translated timeout, rows untouched, in ${r.ms.toFixed(0)} ms (deadline ${deadline} ms)`, r.good && r.ms < deadline * 3, r.ms.toFixed(0));
  }
  console.log(`  measured: ${runs.length} hostile calls at once, wall ${wall.toFixed(0)} ms, ${ticks} ticks of 5 ms, max event-loop delay ${maxDelay.toFixed(1)} ms, threads killed ${pool.killedCount()}`);
  ok('the event loop kept serving: max delay < 250 ms and the ticker fired throughout', maxDelay < 250 && ticks > wall / 5 / 4, `${maxDelay.toFixed(1)} ms, ${ticks} ticks`);
  ok('every hostile call killed its thread', pool.killedCount() === runs.length, pool.killedCount());
  ok('a killed thread is replaced: an ordinary step works afterwards',
    same(await off.applyPipelineAsync(source, [ordinary[0]]), ref.steps[0]));

  // ── 4. Formula patterns: the linear engine on the server ───────────────────
  const fs0 = performance.now();
  const fr = T.applyPipeline(hostileTable, [formula('regexp_match([note], "(\\\\w+)+!")')]);
  const fms = performance.now() - fs0;
  ok(`formula: regexp_match with (\\w+)+! over the hostile cell answers "false" in ${fms.toFixed(1)} ms (linear engine)`,
    fr.rows[1][2] === 'false' && fms < 200, fms.toFixed(1));
  formulas.forEach((f, i) => ok(`formula: ${f} on the server = the desktop`, same(T.applyPipeline(source, [formula(f)]), ref.formulas[i])));
  ok('formula: a backreference is null on the server (the linear engine refuses it)',
    T.applyPipeline(hostileTable, [formula('regexp_match([note], "(a)\\\\1")')]).rows[1][2] === null);

  // ── 5. The backstop ────────────────────────────────────────────────────────
  const bs = T.applyPipeline(hostileTable, [{ type: 'replace_values', column: 'note', mode: 'regex', rules: [{ from: '(\\w+)+!', to: 'x' }] } as TransformStep]);
  ok('backstop: the sync fold on the server refuses a regex step instead of running it', same(bs.warnings, [msg.regexRefusedWarning()]));
  const bq = Q.evaluateRuleJs(qRule('(\\w+)+!'), hostileTable.columns, hostileTable.rows);
  ok('backstop: a quality regex rule without the worker errors instead of running', bq.error === msg.regexRefusedWarning());
  ok('backstop: zero rows still validate on the server (nothing to match)', T.applyPipeline({ columns: source.columns, rows: [] }, [ordinary[0]]).warnings.length === 0);

  // ── 6. Negative control: the old inline path hangs past the deadline ───────
  const child = spawn(process.execPath, ['-e', `
    const T = require(${JSON.stringify(path.join(__dirname, '../src/data/transforms.js'))});
    process.send && 0; console.log('start');
    T.applyPipeline({ columns: [{ name: 'note', type: 'text' }], rows: [[${JSON.stringify(evil)}]] },
      [{ type: 'replace_values', column: 'note', mode: 'regex', rules: [{ from: '(\\\\w+)+!', to: 'x' }] }]);
    console.log('done');`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += String(d); });
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, deadline * 2);
    child.on('exit', () => { clearTimeout(timer); resolve(true); });
  });
  ok(`negative control: without the worker the same step is still running at ${deadline * 2} ms`, !exited && out.includes('start') && !out.includes('done'), out);

  // ── 7. Story text (T2.13): a fixed pattern that was quadratic on user text ──
  const story: typeof import('../src/analysis/storyText') = require('../src/analysis/storyText');
  const ws = ' \t         　﻿\n\v\f\r';
  ok('story: trimEnd strips exactly what /\\s+$/ did', ws.split('').every((c) => ('a' + c + c).trimEnd() === ('a' + c + c).replace(/\s+$/, '')) && 'a​'.trimEnd() === 'a​'.replace(/\s+$/, ''));
  const s0 = performance.now();
  story.mdParse(' '.repeat(100_000) + 'x\n# Title' + ' '.repeat(100_000) + 'y');
  const sms = performance.now() - s0;
  ok(`story: a 100k-space line parses in ${sms.toFixed(0)} ms (was 28 s with /\\s+$/)`, sms < 500, sms.toFixed(0));

  await pool.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
