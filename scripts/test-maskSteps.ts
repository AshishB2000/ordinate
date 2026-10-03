// Self-check for the three MASK steps (src/data/maskSteps.ts, dispatched from
// transforms.applyPipeline) and the one way they could silently fail: the
// resident pipeline storing a derived table UNmasked.
//
//   1. Each kind — hash, redact, generalise (bucket / month / domain) — on
//      real cells, including null and '' (which stay empty), and the TYPE of
//      the output column (a bucketed number stays a number, a month is a date,
//      a token is text).
//   2. Hash WITHOUT a salt is skipped with a warning, never hashed unsalted.
//   3. Reversible: removing the step gives back the source exactly.
//   4. sqlGen bails on every mask step (it would otherwise warn and CONTINUE),
//      so runResidentPipeline returns null — and datasets.updateSteps on a
//      resident (Parquet) dataset stores the MASKED table, end to end.
//
//   npm run build:ts && node scripts/test-maskSteps.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-mask-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_name: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the modules under test.
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const mask: typeof import('../src/data/maskSteps') = require('../src/data/maskSteps');
const sqlGen: typeof import('../src/engine/sqlGen') = require('../src/engine/sqlGen');
const pipelineDuck: typeof import('../src/engine/pipelineDuck') = require('../src/engine/pipelineDuck');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const privacyStore: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');

type Step = import('../src/data/transforms').TransformStep;
const SALT = 'a'.repeat(64);
const columns = [
  { name: 'email', type: 'text' as const },
  { name: 'card', type: 'text' as const },
  { name: 'amount', type: 'number' as const },
  { name: 'joined', type: 'date' as const },
];
const rows: (string | number | null)[][] = [
  ['jane@example.com', '4111111111111111', 57, '2024-03-17'],
  ['JOE@Example.org', '5555555555554444', 1234.5, '2023-12-01'],
  ['jane@example.com', '12', -3, '03/09/2024'],
  [null, null, null, null],
  ['', '', null, ''],
  ['not an email', '378282246310005', 99.99, 'Jan 5, 2023'],
];
const src = () => ({ columns: columns.map((c) => ({ ...c })), rows: rows.map((r) => r.slice()) });
const run = (steps: Step[], salt?: string) => transforms.applyPipeline(src(), steps, { salt });
const col = (out: { columns: { name: string }[]; rows: unknown[][] }, name: string) => {
  const i = out.columns.findIndex((c) => c.name === name);
  return out.rows.map((r) => r[i]);
};
const typeOf = (out: { columns: { name: string; type: string }[] }, name: string) => (out.columns.find((c) => c.name === name) || { type: '?' }).type;

async function main(): Promise<void> {
  // ── 1. mask_hash ──────────────────────────────────────────────────────────
  const h = run([{ type: 'mask_hash', column: 'email' }], SALT);
  const hv = col(h, 'email');
  ok('hash: every value becomes a # + 12-hex token', [0, 1, 2, 5].every((i) => /^#[0-9a-f]{12}$/.test(String(hv[i]))), JSON.stringify(hv));
  ok('hash: the same value is the same token (joins and counts still work)', hv[0] === hv[2] && hv[0] !== hv[1]);
  ok('hash: equals maskToken(salt, value) — the one token the share policy also writes', hv[0] === mask.maskToken(SALT, 'jane@example.com'));
  // Empty stays EMPTY. The output column is retyped like every derived column,
  // and that shared rule (parse.coerceValue) stores an empty text cell as null.
  ok('hash: null and "" stay empty — never a token of nothing', hv[3] === null && hv[4] === null);
  ok('hash: the output column is text', typeOf(h, 'email') === 'text');
  ok('hash: no warning', h.warnings.length === 0, JSON.stringify(h.warnings));
  const other = run([{ type: 'mask_hash', column: 'email' }], 'b'.repeat(64));
  ok('hash: a different project salt gives different tokens', col(other, 'email')[0] !== hv[0]);
  const numHash = run([{ type: 'mask_hash', column: 'amount' }], SALT);
  ok('hash: a number column hashes String(n) and becomes text', typeOf(numHash, 'amount') === 'text' && col(numHash, 'amount')[0] === mask.maskToken(SALT, '57'));

  // ── 2. No salt → skipped, never hashed unsalted ───────────────────────────
  for (const salt of [undefined, '', 'short']) {
    const r = run([{ type: 'mask_hash', column: 'email' }], salt);
    ok(`hash with salt ${JSON.stringify(salt)} is SKIPPED with a warning`,
      col(r, 'email')[0] === 'jane@example.com' && r.warnings.length === 1 && /masking key is not available/.test(r.warnings[0]), JSON.stringify(r.warnings));
  }

  // ── mask_redact ───────────────────────────────────────────────────────────
  const rd = run([{ type: 'mask_redact', column: 'card' }]);
  ok('redact: keeps the last 4 → •••1111', col(rd, 'card')[0] === '•••1111' && col(rd, 'card')[1] === '•••4444', JSON.stringify(col(rd, 'card')));
  ok('redact: a value no longer than what is kept is hidden whole', col(rd, 'card')[2] === '•••');
  ok('redact: empties stay empty; column is text', col(rd, 'card')[3] === null && col(rd, 'card')[4] === null && typeOf(rd, 'card') === 'text');
  ok('redact: keep 0 hides everything', col(run([{ type: 'mask_redact', column: 'card', keep: 0 }]), 'card')[0] === '•••');
  ok('redact: keep is clamped to 8', (mask.sanitizeMaskStep({ type: 'mask_redact', column: 'c', keep: 40 }) as { keep: number }).keep === 8);
  const rdNum = run([{ type: 'mask_redact', column: 'amount', keep: 2 }]);
  ok('redact: a number column becomes text', typeOf(rdNum, 'amount') === 'text' && col(rdNum, 'amount')[1] === '•••.5');

  // ── mask_generalize: bucket ───────────────────────────────────────────────
  const b = run([{ type: 'mask_generalize', column: 'amount', mode: 'bucket', size: 10 }]);
  ok('bucket: numbers round DOWN to the bucket floor', JSON.stringify(col(b, 'amount')) === JSON.stringify([50, 1230, -10, null, null, 90]), JSON.stringify(col(b, 'amount')));
  ok('bucket: the column STAYS a number column', typeOf(b, 'amount') === 'number' && col(b, 'amount').every((v) => v === null || typeof v === 'number'));
  ok('bucket: 0.1-wide buckets do not print float noise', mask.bucketFloor(0.35, 0.1) === 0.3 && mask.bucketFloor(0.7, 0.1) === 0.7);
  const bText = run([{ type: 'mask_generalize', column: 'email', mode: 'bucket', size: 10 }]);
  ok('bucket on a text column is skipped with a warning', col(bText, 'email')[0] === 'jane@example.com' && /not a number column/.test(bText.warnings[0] || ''));

  // ── mask_generalize: month ────────────────────────────────────────────────
  const m = run([{ type: 'mask_generalize', column: 'joined', mode: 'month' }]);
  ok('month: ISO, US and long-form dates truncate to YYYY-MM', JSON.stringify(col(m, 'joined')) === JSON.stringify(['2024-03', '2023-12', '2024-03', null, null, '2023-01']), JSON.stringify(col(m, 'joined')));
  ok('month: the column is still a date column', typeOf(m, 'joined') === 'date');
  const mBad = run([{ type: 'mask_generalize', column: 'email', mode: 'month' }]);
  ok('month: a value that is not a date is CLEARED (not leaked) and counted', col(mBad, 'email')[0] === null && /cleared 4 values/.test(mBad.warnings[0] || ''), JSON.stringify(mBad.warnings));

  // ── mask_generalize: domain ───────────────────────────────────────────────
  const d = run([{ type: 'mask_generalize', column: 'email', mode: 'domain' }]);
  ok('domain: keeps @domain, lowercased', JSON.stringify(col(d, 'email')) === JSON.stringify(['@example.com', '@example.org', '@example.com', null, null, null]), JSON.stringify(col(d, 'email')));
  ok('domain: a non-email is cleared with a warning; column is text', /cleared 1 value in "email" that was not an email address/.test(d.warnings[0] || '') && typeOf(d, 'email') === 'text', JSON.stringify(d.warnings));

  // ── Unknown column, sanitising, reversibility ─────────────────────────────
  const unk = run([{ type: 'mask_redact', column: 'nope' }]);
  ok('an unknown column is skipped with a warning', unk.rowCount === rows.length && /unknown column "nope"/.test(unk.warnings[0] || ''));
  const clean = transforms.sanitizeSteps([
    { type: 'mask_hash', column: 'email', salt: 'SMUGGLED' },
    { type: 'mask_generalize', column: 'x', mode: 'nonsense' },
    { type: 'mask_generalize', column: 'x', mode: 'bucket', size: -4 },
    { type: 'mask_redact' },
  ]);
  ok('sanitize: keeps only whitelisted fields (no smuggled salt), drops a bad mode or a missing column',
    JSON.stringify(clean) === JSON.stringify([{ type: 'mask_hash', column: 'email' }, { type: 'mask_generalize', column: 'x', mode: 'bucket', size: 10 }]), JSON.stringify(clean));
  const source = src();
  transforms.applyPipeline(source, [{ type: 'mask_hash', column: 'email' }], { salt: SALT });
  ok('the source is never mutated', source.rows[0][0] === 'jane@example.com');
  const back = run([]);
  ok('removing the step gives back the source exactly', JSON.stringify(back.rows) === JSON.stringify(rows));
  ok('maskedColumns follows a later rename and drop',
    JSON.stringify([...mask.maskedColumns([{ type: 'mask_hash', column: 'a' }, { type: 'rename_column', from: 'a', to: 'b' }, { type: 'mask_redact', column: 'c' }, { type: 'drop_column', column: 'c' }])]) === JSON.stringify(['b']));

  // ── 4. sqlGen bails; the resident path cannot store an unmasked table ─────
  const schema = columns.map((c, i) => ({ physical: `c${i}`, name: c.name, type: c.type }));
  for (const step of [
    { type: 'mask_hash', column: 'email' },
    { type: 'mask_redact', column: 'card' },
    { type: 'mask_generalize', column: 'amount', mode: 'bucket', size: 10 },
  ] as Step[]) {
    const gen = sqlGen.generateSql('t', schema, [{ type: 'trim' }, step]);
    ok(`sqlGen BAILS on ${step.type} (it would otherwise warn and continue)`, gen.sql === null, gen.sql || '');
  }
  const pq = path.join(tmpUserData, 'direct.source.parquet');
  pqSync.writeTable(pq, columns, rows);
  ok('runResidentPipeline returns null for a mask step (the fold must run)',
    await pipelineDuck.runResidentPipeline(pq, columns, [{ type: 'mask_redact', column: 'card' }]) === null);

  // End to end through the store, on a RESIDENT dataset: the second step edit
  // has a source Parquet, which is exactly when runResidentPipeline is tried.
  await projects.init();
  const proj = await projects.createProject('Mask project');
  const saved = await datasets.saveDataset(proj.id, { name: 'People', sourceKind: 'csv', columns, rows });
  ok('fixture dataset saved', !!saved);
  await datasets.updateSteps(proj.id, saved!.id, [{ type: 'trim' }]); // snapshots the source Parquet
  const meta = await datasets.getDatasetMeta(proj.id, saved!.id);
  ok('the dataset is resident (Parquet on disk) before the mask step', !!meta && meta.resident === true);
  trace.reset();
  const res = await datasets.updateSteps(proj.id, saved!.id, [{ type: 'trim' }, { type: 'mask_hash', column: 'email' }, { type: 'mask_redact', column: 'card' }]);
  ok('the resident pipeline was tried and SKIPPED', (trace.snapshot().preparePipeline || { skipped: 0 }).skipped === 1, JSON.stringify(trace.snapshot().preparePipeline));
  const salt = await privacyStore.getSalt(proj.id);
  const stored = await datasets.getDataset(proj.id, saved!.id);
  const e = col(stored!, 'email');
  ok('the STORED derived table is masked (hash) — read back from disk',
    !!res && e[0] === mask.maskToken(salt as string, 'jane@example.com') && !e.includes('jane@example.com'), JSON.stringify(e));
  ok('…and redacted', col(stored!, 'card')[0] === '•••1111');
  ok('…while the source keeps the raw values (the step is reversible)', stored!.source!.rows[0][0] === 'jane@example.com');
  const recordJson = fs.readFileSync(path.join(tmpUserData, 'projects', proj.id, 'datasets', saved!.id + '.json'), 'utf8');
  ok('the dataset record never carries the salt', !recordJson.includes(salt as string));
  await datasets.updateSteps(proj.id, saved!.id, [{ type: 'trim' }]);
  const reverted = await datasets.getDataset(proj.id, saved!.id);
  ok('removing the mask steps restores the raw values', col(reverted!, 'email')[0] === 'jane@example.com' && col(reverted!, 'card')[0] === '4111111111111111');
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' mask check(s) FAILED'); process.exit(1); }
    console.log('\nAll mask-step checks passed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
