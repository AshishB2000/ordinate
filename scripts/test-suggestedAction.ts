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

// ── validateAction: the 'style' kind and its preset ─────────────────────────
// 'style' is the only kind that carries a second field, and the field is a
// PRESET NAME, never a style: the app owns the four triples in dashboards.ts,
// so the model's whole job is to pick one of ours. That makes the preset
// whitelist load-bearing in a way the kind whitelist is not — a wrong kind
// proposes the wrong door, a wrong preset would repaint the user's dashboard.

// This list is deliberately WRITTEN OUT rather than imported. suggestedAction.ts
// keeps its own copy of the four names (a runtime import of dashboards.ts would
// drag electron and fs into a pure parser), and tsc pins that copy to
// DashboardStylePreset via an exhaustive Record. Spelling them a third time here
// means a silent rename has to survive three independent edits to go unnoticed.
const PRESETS = ['clean', 'executive', 'dense', 'dark'];

for (const preset of PRESETS) {
  const got = sa.validateAction({ kind: 'style', intent: 'make it ' + preset, preset });
  ok('validate: style/"' + preset + '" survives and round-trips its preset',
    got.kind === 'style' && got.preset === preset && got.intent === 'make it ' + preset,
    JSON.stringify(got));
}

// An unusable preset collapses the WHOLE action, it does not default.
//
// Defaulting is the tempting bug and the worse one: the user says "make it
// dark", a weaker model writes "darker", and a one-click confirm silently
// restyles their dashboard to `clean`. A style action the app cannot trust is
// simply no proposal — the prose answer still stands, which is what this file's
// module header says a malformed action has always meant.
const badPresets: unknown[] = [
  undefined,          // missing entirely — the common weak-model failure
  'Dark',             // wrong case
  'darker',           // near-miss, and the one a real model actually emits
  'denses',           // near-miss the other way
  'neon',             // invented outright
  '__proto__',        // not a preset, and not a prototype hazard
  '',                 // empty string is not a name
  ' dark ',           // padded — the whitelist is exact, not trimmed
  7,
  ['dark'],
  { preset: 'dark' },
  null,
];
for (const preset of badPresets) {
  const raw = preset === undefined
    ? { kind: 'style', intent: 'make it dark' }
    : { kind: 'style', intent: 'make it dark', preset };
  const got = sa.validateAction(raw);
  ok('validate: style with preset ' + JSON.stringify(preset) + ' → none, never a default',
    got.kind === 'none' && got.intent === '' && got.preset === undefined, JSON.stringify(got));
}

// The preset must never RIDE ALONG on another kind. validateAction returns an
// object literal precisely so unnamed keys are dropped, and a 'dashboard'
// proposal that quietly carried a preset would restyle the sheet on a click the
// user read as "build me a dashboard".
for (const kind of ['dashboard', 'chart', 'step', 'calc']) {
  const got = sa.validateAction({ kind, intent: 'x', preset: 'dark' });
  ok('validate: preset is stripped from a "' + kind + '" action',
    got.kind === kind && !('preset' in got), JSON.stringify(got));
}

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
  { kind: 'styles', preset: 'dark' },    // near-miss on the newest kind
  { kind: 'Style', preset: 'dark' },     // wrong case
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

// The real shape the model emits for a restyle, three fields on one line.
const styleLine = 'Switching to the dark palette.\n' + ACTION_MARKER +
  ' {"kind":"style","intent":"make it dark","preset":"dark"}';
const styleRes = sa.splitAction(styleLine);
ok('split: a style tail line yields kind, intent AND preset',
  styleRes.action.kind === 'style' && styleRes.action.intent === 'make it dark' &&
  styleRes.action.preset === 'dark', JSON.stringify(styleRes.action));
ok('split: …and its prose is untouched', styleRes.text === 'Switching to the dark palette.', styleRes.text);

// The same line with a preset we do not own: no proposal, but the ANSWER STANDS.
// This is the whole point of collapsing rather than defaulting — the user still
// gets told what happened, they just do not get a button that does the wrong thing.
const styleBad = sa.splitAction('Here is what I would change.\n' + ACTION_MARKER +
  ' {"kind":"style","intent":"make it dark","preset":"midnight"}');
ok('split: an off-whitelist preset drops the proposal, not the answer',
  styleBad.text === 'Here is what I would change.' && styleBad.action.kind === 'none',
  JSON.stringify(styleBad));

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

const PROSE = 'Revenue rose in Q3 across every region.\n';
const REPLY = PROSE + ACTION_MARKER + ' {"kind":"dashboard","intent":"sales overview"}';

// The style line is the LONGEST tail the contract produces (three fields), so it
// is the one most likely to straddle a chunk boundary in a new place. Nothing
// about the filter is kind-aware — it only hunts the marker — which is exactly
// why the guard is cheapest to keep honest by running both shapes through it.
const STYLE_PROSE = 'Switching the dashboard to the dark palette.\n';
const STYLE_REPLY = STYLE_PROSE + ACTION_MARKER + ' {"kind":"style","intent":"make it dark","preset":"dark"}';

// Every chunk size, including 1 (which splits the marker maximally) and sizes
// that land a boundary mid-marker. This is the regression guard.
for (const [label, reply, prose] of [['dashboard', REPLY, PROSE], ['style', STYLE_REPLY, STYLE_PROSE]]) {
  let leaked = '';
  let truncated = '';
  for (let size = 1; size <= 40; size++) {
    const got = stream(reply, size);
    if (got.indexOf('@@') >= 0) leaked += size + ' ';
    if (got !== prose) truncated += size + '(' + JSON.stringify(got) + ') ';
  }
  ok('filter: no chunk size leaks any part of the marker into a ' + label + ' stream', leaked === '', leaked);
  ok('filter: every chunk size emits exactly the ' + label + ' prose, nothing withheld',
    truncated === '', truncated.slice(0, 200));
}

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
for (const kind of ['dashboard', 'chart', 'step', 'calc', 'style', 'none']) {
  // 'style' is the one kind that is invalid without a second field, so its
  // round-trip probe carries a preset — the parser rejecting a bare style
  // action is the documented behaviour, not a drift between prompt and parser.
  const probe = kind === 'style' ? { kind, intent: '', preset: 'dark' } : { kind, intent: '' };
  ok('prompt: offers "' + kind + '", which the parser accepts',
    CHAT_SYSTEM_PROMPT.indexOf(kind) >= 0 && sa.validateAction(probe).kind === kind);
}

// The same guard one level down, for the preset names. This is where drift is
// most likely and least visible: rename a preset in dashboards.ts, update the
// parser's copy, forget the prompt, and the model keeps offering a name the
// parser now throws away — a "make it dark" that silently does nothing.
//
// indexOf is too weak here, because "dark" also occurs inside "darker" in the
// prompt's own description of when to use the kind. A word-boundary match is
// what actually proves the standalone spelling is still listed.
for (const preset of PRESETS) {
  ok('prompt: names the preset "' + preset + '", which the parser accepts',
    new RegExp('\\b' + preset + '\\b').test(CHAT_SYSTEM_PROMPT) &&
    sa.validateAction({ kind: 'style', intent: '', preset }).preset === preset);
}
ok('prompt: tells the model the preset field is style-only',
  /"style" ONLY/.test(CHAT_SYSTEM_PROMPT));
ok('prompt: still carries the never-invent-a-number rule the answer depends on',
  /NEVER invent, round, or recompute any number/.test(CHAT_SYSTEM_PROMPT));

if (failureCount()) {
  console.error('\n' + failureCount() + ' suggestedAction check(s) FAILED');
  process.exit(1);
}
console.log('\nAll suggestedAction checks passed.');
