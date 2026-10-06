// Self-check for the function catalog: `formula/formulaDocs.FUNCTION_DOCS`
// against `formula/formulaEval.FUNCTIONS`.
//
// THE POINT OF THIS FILE IS THE PARITY ASSERTION. A catalog is documentation,
// and documentation rots silently — the failure mode is not a crash, it is a
// function that works perfectly and that nobody can find because the editor's
// list never heard of it. So the two key sets are asserted IDENTICAL in both
// directions: a new function with no entry fails here, and an entry for a
// function that was renamed or removed fails here too. Neither can reach a
// release as "the list just doesn't show it".
//
// The second assertion is that every `example` COMPILES, through the real
// `compile()`. An example is the one line a user is most likely to copy; one
// that no longer parses is worse than no example at all. It also catches the
// ordinary copy-paste slip, because each example is required to actually call
// the function it illustrates.
//
// Pure logic — no fs, no dataset. The examples reference invented
// column names on purpose: an unknown column is a runtime null in this
// language, never a compile error, so they stay valid against any data.
//
//   npm run build:ts && node scripts/test-formulaDocs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const docs: typeof import('../src/formula/formulaDocs') = require('../src/formula/formulaDocs');
const evalMod: typeof import('../src/formula/formulaEval') = require('../src/formula/formulaEval');
const formula: typeof import('../src/formula/formula') = require('../src/formula/formula');

const CATEGORIES = ['number', 'string', 'date', 'logical', 'conversion'];

const fnNames = Object.keys(evalMod.FUNCTIONS).sort();
const docNames = Object.keys(docs.FUNCTION_DOCS).sort();

// ── 1. Parity, both directions ───────────────────────────────────────────────
const undocumented = fnNames.filter((n) => !docs.FUNCTION_DOCS[n]);
const orphaned = docNames.filter((n) => !evalMod.FUNCTIONS[n]);

ok('every FUNCTIONS entry is documented', undocumented.length === 0, undocumented.join(', '));
ok('no catalog entry documents a function that does not exist', orphaned.length === 0, orphaned.join(', '));
ok('the two key sets are identical', fnNames.join(',') === docNames.join(','),
  `${fnNames.length} functions vs ${docNames.length} entries`);

// ── 2. Every entry is complete and self-consistent ───────────────────────────
let badCategory = 0;
let badName = 0;
let badSignature = 0;
let badSummary = 0;
for (const name of docNames) {
  const doc = docs.FUNCTION_DOCS[name];
  if (CATEGORIES.indexOf(doc.category) < 0) badCategory++;
  // `name` is injected from the key, so this is really asserting that the
  // injection happened — an entry read straight out of RAW would have none.
  if (doc.name !== name) badName++;
  // A signature that does not start with its own name is a copied line.
  if (doc.signature.indexOf(name + '(') !== 0) badSignature++;
  if (!doc.summary || doc.summary.trim().length < 10) badSummary++;
}
ok('every entry has a known category', badCategory === 0, badCategory + ' bad');
ok('every entry carries its own name', badName === 0, badName + ' bad');
ok('every signature starts with its function name', badSignature === 0, badSignature + ' bad');
ok('every entry has a real summary', badSummary === 0, badSummary + ' bad');

// ── 3. Every example compiles, and calls what it documents ───────────────────
const wontCompile: string[] = [];
const wrongFunction: string[] = [];
for (const name of docNames) {
  const doc = docs.FUNCTION_DOCS[name];
  const res = formula.compile(doc.example);
  if (!res.ok) wontCompile.push(`${name}: ${doc.example} → ${res.error}`);
  if (doc.example.indexOf(name + '(') < 0) wrongFunction.push(`${name}: ${doc.example}`);
}
ok('every example compiles', wontCompile.length === 0, wontCompile.slice(0, 5).join(' | '));
ok('every example calls the function it documents', wrongFunction.length === 0, wrongFunction.slice(0, 5).join(' | '));

// ── 4. The list the editor actually renders ──────────────────────────────────
const listed = docs.listFunctionDocs();
ok('listFunctionDocs returns every entry once', listed.length === docNames.length,
  `${listed.length} vs ${docNames.length}`);

// Grouped, not interleaved: the editor prints one heading per category and
// relies on the order to decide where the next one starts.
const seen: string[] = [];
let interleaved = 0;
for (const doc of listed) {
  if (seen[seen.length - 1] !== doc.category) {
    if (seen.indexOf(doc.category) >= 0) interleaved++;
    seen.push(doc.category);
  }
}
ok('categories come out in contiguous runs', interleaved === 0, seen.join(' → '));
ok('categories come out in the declared order',
  seen.join(',') === docs.FUNCTION_CATEGORIES.filter((c) => seen.indexOf(c) >= 0).join(','), seen.join(' → '));

// Every category is actually populated — a category that names no function is a
// heading the editor would draw over an empty list.
const empty = docs.FUNCTION_CATEGORIES.filter((c) => !listed.some((d) => d.category === c));
ok('every declared category has at least one function', empty.length === 0, empty.join(', '));

finish();
