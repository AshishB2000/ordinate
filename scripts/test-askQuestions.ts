// Self-check for the ASK QUESTION SET (scripts/fixtures/ask-questions.json) —
// no model, no handlers.
//
// The fixture is what a later model evaluation runs against: questions about
// the bundled sample dataset, each with the raw answer spec a good model would
// write. A fixture that asked for a column the sample does not have, or a value
// no row holds, would grade every model wrong — so it is checked here, against
// the sample's REAL columns (the committed CSV, through the ordinary parser):
//
//   - every expected spec validates, on the sample dataset;
//   - every text filter value is a value the sample actually holds;
//   - DIFFERENTIAL: every follow-up's refine patch, merged onto its question's
//     answer (src/ai/answerRefine.ts), is — leaf by leaf, Object.is — the spec
//     its hand-written `full` gives.
//
// This suite calls no model and there is no runner here that does.
//
//   npm run build:ts && node scripts/test-askQuestions.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

// sampleProject.ts reads app paths; nothing is written there by this suite.
process.env.ORDINATE_LOCAL_DIR = path.join(os.tmpdir(), 'ordinate-askquestions');

const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const R: typeof import('../src/ai/answerRefine') = require('../src/ai/answerRefine');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');

interface Asked { question: string; spec: Record<string, unknown> }
interface Question extends Asked { id: string; followUp?: Asked & { full: Record<string, unknown> } }
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ask-questions.json'), 'utf8')) as { dataset: string; questions: Question[] };

// The sample as `sample:seed` imports it: the committed CSV, typed by the ordinary parser.
const table = parse.parseCsv(fs.readFileSync(sample.sampleCsvPath(), 'utf8'));
const DS = { id: '11111111-1111-4111-8111-111111111111', name: sample.SAMPLE_DATASET_NAME, columns: table.columns };
const validate = (raw: unknown, title: string) => A.validateAnswerSpec(raw, [DS], { title });

function sameLeaves(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  const ka = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && ka.length === Object.keys(b).length
    && ka.every((k) => k in b && sameLeaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Every text value a spec matches on (= != in, not in) that no row of the sample holds — case and outer space aside, as the card matches them. */
function strangers(spec: import('../src/ai/answerSpec').AnswerSpec): string[] {
  const out: string[] = [];
  for (const f of spec.filters) {
    const ci = table.columns.findIndex((c) => c.name === f.column);
    if ('period' in f || table.columns[ci].type !== 'text' || !['=', '!=', 'in', 'not in'].includes(f.op)) continue;
    const held = new Set(table.rows.map((r) => String(r[ci] ?? '').trim().toLowerCase()));
    for (const v of f.values ?? [f.value]) if (typeof v !== 'string' || !held.has(v.trim().toLowerCase())) out.push(`${f.column}=${String(v)}`);
  }
  return out;
}

const all = fixture.questions;
const pairs = all.filter((q) => q.followUp);
ok('fixture: it is about the dataset the sample seeds', fixture.dataset === sample.SAMPLE_DATASET_NAME, fixture.dataset);
ok('fixture: the sample parsed to its real columns — a date, text and numbers',
  table.rows.length > 1000 && table.columns.find((c) => c.name === 'order_date')?.type === 'date'
  && table.columns.find((c) => c.name === 'revenue')?.type === 'number' && table.columns.find((c) => c.name === 'region')?.type === 'text',
  JSON.stringify(table.columns));
ok('fixture: about twenty questions, five of them followed up', all.length + pairs.length >= 20 && pairs.length >= 5, `${all.length} + ${pairs.length}`);
ok('fixture: every question has an id of its own', new Set(all.map((q) => q.id)).size === all.length && all.every((q) => /^[a-z0-9-]+$/.test(q.id)));

for (const q of all) {
  const v = validate(q.spec, q.question);
  ok(`${q.id}: the expected spec validates against the sample's columns`, v.ok && v.spec.datasetId === DS.id, JSON.stringify(v));
  ok(`${q.id}: …it is a whole question, not a refine, and filters only on values the sample holds`,
    !R.isRefine(q.spec) && v.ok && strangers(v.spec).length === 0, v.ok ? strangers(v.spec).join() : '');
  if (!q.followUp || !v.ok) continue;

  const f = q.followUp;
  const merged = validate(R.refineSpec(v.spec, f.spec, DS), f.question);
  const whole = validate(f.full, f.question);
  ok(`${q.id} → "${f.question}": the refine patch, merged, is the spec written out in full`,
    R.isRefine(f.spec) && !R.isRefine(f.full) && merged.ok && whole.ok && sameLeaves(merged.spec, whole.spec), JSON.stringify([merged, whole]));
  ok(`${q.id} → …and it really changed the answer, on values the sample holds`,
    merged.ok && !sameLeaves({ ...merged.spec, title: '' }, { ...v.spec, title: '' }) && strangers(merged.spec).length === 0, JSON.stringify(merged));
  // NEGATIVE CONTROL: without the merge, the patch alone is not that answer.
  const alone = validate(f.spec, f.question);
  ok(`${q.id} → …where the patch on its own is not that spec (the merge is what carried the rest)`,
    whole.ok && !(alone.ok && sameLeaves(alone.spec, whole.spec)), JSON.stringify(alone));
}

// NEGATIVE CONTROLS: the checks above can fail.
const first = all[0];
ok('control: a spec naming a column the sample does not have is refused', !validate({ ...first.spec, category: 'territory' }, first.question).ok);
const offMenu = validate({ ...first.spec, filters: [{ column: 'region', op: '=', value: 'Atlantis' }] }, first.question);
ok('control: a filter value no row holds is noticed', offMenu.ok && strangers(offMenu.spec).join() === 'region=Atlantis', JSON.stringify(offMenu));
ok('control: sameLeaves tells two specs apart, and knows one spec validated twice', (() => {
  const a = validate(first.spec, 't');
  const b = validate({ ...first.spec, top: 3 }, 't');
  const again = validate(first.spec, 't');
  return a.ok && b.ok && again.ok && !sameLeaves(a.spec, b.spec) && sameLeaves(a.spec, again.spec);
})());

finish();
