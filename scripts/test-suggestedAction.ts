// The Copilot answer's ONE structured field: whitelist, split, and the
// streaming filter that keeps the action line out of the user's bubble.
//
// Why this file matters more than its size suggests: the dock now decides what
// to propose from `suggestedAction.kind` alone — the three keyword regexes it
// used to guess with are gone. So "an unrecognised action degrades to none"
// is no longer a nicety, it is the only thing standing between a malformed
// model reply and a wrong proposal appearing over the user's data.
//
// The streaming assertions are the subtle half. A marker split across two
// chunks ("…done.\n@@AC" / "TION {…}") would paint "@@AC" into a live bubble
// that no later chunk can take back, and only a chunk-by-chunk test catches it.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled sibling of ../src/ai/suggestedAction.ts.
const sa: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');

const { ACTION_MARKER, MAX_INTENT, CHAT_SYSTEM_PROMPT } = sa;

// ── validateAction: the whitelist ───────────────────────────────────────────

for (const kind of ['dashboard', 'chart', 'step', 'calc']) {
  const got = sa.validateAction({ kind, intent: 'x' });
  ok('validate: "' + kind + '" survives the whitelist', got.kind === kind, JSON.stringify(got));
}
ok('validate: "none" is none', sa.validateAction({ kind: 'none', intent: 'x' }).kind === 'none');

// Everything unrecognised collapses to none. These are the shapes a real model
// actually produces when it half-follows the format.
const junk: unknown[] = [
  null, undefined, 'dashboard', 42, [], {},
  { kind: 'DASHBOARD' },                 // wrong case — not on the list
  { kind: 'dashboards' },                // near-miss
  { kind: 'delete_everything' },         // invented
  { kind: '__proto__' },                 // not a kind, and not a prototype hazard
  { kind: 7 },
  { intent: 'build me a dashboard' },    // intent without a kind
];
for (const raw of junk) {
  const got = sa.validateAction(raw);
  ok('validate: ' + JSON.stringify(raw) + ' → none', got.kind === 'none' && got.intent === '',
    JSON.stringify(got));
}

// The intent is model text that goes back INTO a prompt and into the composer,
// so it is bounded and whitespace-collapsed like every other such string.
const long = sa.validateAction({ kind: 'dashboard', intent: 'a'.repeat(MAX_INTENT + 500) });
ok('validate: a runaway intent is clamped to MAX_INTENT',
  long.intent.length === MAX_INTENT, String(long.intent.length));
ok('validate: whitespace in an intent is collapsed, not spent against the budget',
  sa.validateAction({ kind: 'chart', intent: '  a\n\n\t b  ' }).intent === 'a b');
ok('validate: a non-string intent becomes empty, not "undefined"',
  sa.validateAction({ kind: 'chart', intent: { a: 1 } }).intent === '');

// ── splitAction: prose out, action out, marker gone ─────────────────────────

const clean = 'Revenue rose in Q3.\n' + ACTION_MARKER + ' {"kind":"dashboard","intent":"sales overview"}';
const cleanRes = sa.splitAction(clean);
ok('split: the prose is everything before the marker', cleanRes.text === 'Revenue rose in Q3.', cleanRes.text);
ok('split: the action comes through', cleanRes.action.kind === 'dashboard' && cleanRes.action.intent === 'sales overview');
ok('split: the marker never survives into the prose', cleanRes.text.indexOf(ACTION_MARKER) < 0);

const noMarker = sa.splitAction('Just an answer, no action line.');
ok('split: no marker → the whole reply is prose', noMarker.text === 'Just an answer, no action line.');
ok('split: …and the action is none', noMarker.action.kind === 'none');

ok('split: null/empty is safe', sa.splitAction(null).text === '' && sa.splitAction(undefined).action.kind === 'none');

// A model that fences the line, or mentions the format mid-answer and then
// emits the real one: the LAST marker wins and the fence is not left dangling.
const fenced = sa.splitAction('Answer.\n```json\n' + ACTION_MARKER + ' {"kind":"chart","intent":"revenue by region"}\n```');
ok('split: a fenced action line still parses', fenced.action.kind === 'chart', JSON.stringify(fenced.action));
ok('split: …and the fence is not left in the prose', fenced.text === 'Answer.', JSON.stringify(fenced.text));

const twice = sa.splitAction(
  'I would emit ' + ACTION_MARKER + ' {"kind":"none","intent":""} normally.\n' +
  ACTION_MARKER + ' {"kind":"dashboard","intent":"real one"}');
ok('split: the LAST marker wins when the model mentions the format first',
  twice.action.kind === 'dashboard' && twice.action.intent === 'real one', JSON.stringify(twice.action));

// Malformed tails: the answer must still stand.
for (const tail of ['', ' not json at all', ' {', ' {"kind":', ' {"kind":"dashboard"', ' []']) {
  const r = sa.splitAction('Prose.\n' + ACTION_MARKER + tail);
  ok('split: malformed tail ' + JSON.stringify(tail) + ' → prose kept, action none',
    r.text === 'Prose.' && r.action.kind === 'none', JSON.stringify(r));
}

// ── makeActionFilter: the marker never reaches the stream ───────────────────

/** Feed `full` through the filter in fixed-size chunks; return what was emitted. */
function stream(full: string, size: number): string {
  let out = '';
  const f = sa.makeActionFilter((d: string) => { out += d; });
  if (!f.onDelta) return out;
  for (let i = 0; i < full.length; i += size) f.onDelta(full.slice(i, i + size));
  f.flush(); // end of stream — release any tail withheld against a partial marker
  return out;
}

ok('filter: undefined in, undefined out (a non-streaming caller is untouched)',
  sa.makeActionFilter(undefined).onDelta === undefined);

const REPLY = 'Revenue rose in Q3 across every region.\n' + ACTION_MARKER + ' {"kind":"dashboard","intent":"sales overview"}';
const PROSE = 'Revenue rose in Q3 across every region.\n';

// Every chunk size, including 1 (which splits the marker maximally) and sizes
// that land a boundary mid-marker. This is the regression guard.
let leaked = '';
let truncated = '';
for (let size = 1; size <= 40; size++) {
  const got = stream(REPLY, size);
  if (got.indexOf('@@') >= 0) leaked += size + ' ';
  if (got !== PROSE) truncated += size + '(' + JSON.stringify(got) + ') ';
}
ok('filter: no chunk size leaks any part of the marker into the stream', leaked === '', leaked);
ok('filter: every chunk size emits exactly the prose, nothing withheld', truncated === '', truncated.slice(0, 200));

// A reply with NO action line must stream in full — the filter holds back a
// tail while it waits, so the only question is whether it ever lets go.
const plain = 'A complete answer with no action line at all.';
let plainBad = '';
for (let size = 1; size <= 20; size++) if (stream(plain, size) !== plain) plainBad += size + ' ';
ok('filter: a reply with no action line still streams in full', plainBad === '', plainBad);

// Text arriving AFTER the marker is never forwarded, whatever it is.
const after = stream('Prose.' + ACTION_MARKER + ' {"kind":"dashboard","intent":"x"}\nand more prose', 3);
ok('filter: nothing after the marker is ever emitted', after === 'Prose.', JSON.stringify(after));

// ── The prompt and the parser must agree ────────────────────────────────────
// A prompt that drifts from its whitelist is a bug with no symptom: the model
// dutifully returns a kind the parser then throws away as 'none'.

ok('prompt: names the exact marker the parser looks for',
  CHAT_SYSTEM_PROMPT.indexOf(ACTION_MARKER) >= 0);
for (const kind of ['dashboard', 'chart', 'step', 'calc', 'none']) {
  ok('prompt: offers "' + kind + '", which the parser accepts',
    CHAT_SYSTEM_PROMPT.indexOf(kind) >= 0 && sa.validateAction({ kind, intent: '' }).kind === kind);
}
ok('prompt: still carries the never-invent-a-number rule the answer depends on',
  /NEVER invent, round, or recompute any number/.test(CHAT_SYSTEM_PROMPT));

if (failureCount()) {
  console.error('\n' + failureCount() + ' suggestedAction check(s) FAILED');
  process.exit(1);
}
console.log('\nAll suggestedAction checks passed.');
