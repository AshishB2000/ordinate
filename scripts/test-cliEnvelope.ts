// Self-check for extractEnvelope (src/cli/localCliRun.ts) — the JSON-envelope
// hunter five of the six local-CLI adapters run every reply through.
//
// WHY THIS FILE EXISTS. It hunts the FIRST balanced {…} anywhere in a reply.
// That is right for `analyze()`, which asked for a JSON envelope and may get it
// wrapped in a banner or a markdown fence. It is CATASTROPHIC for a caller that
// asked for prose: askCopilot's answers end with an `@@ACTION {"kind":…}` line
// (src/ai/suggestedAction.ts), so the first {…} in a chat answer is the ACTION
// LINE — the hunter returned that and threw the whole answer away. Typing "hi"
// into the Assistant dock rendered `{"kind":"none","intent":""}` as the reply.
//
// The fix is the `prose` argument, and this file is its guard, in both
// directions: prose callers must get their text back UNTOUCHED, and JSON callers
// must still get the extraction they depend on. A one-way test would pass with
// the hunter deleted.
//
// `electron` is stubbed via Module._load only because localCliRun.ts imports it
// at module scope for app.getPath — nothing here touches disk or spawns a CLI.
//
//   npm run build:ts && node scripts/test-cliEnvelope.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const Module: any = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => '/tmp' }, net: {} };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const cli: typeof import('../src/cli/localCliRun') = require('../src/cli/localCliRun');
const sa: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');

// ── The exact reply that broke the dock ─────────────────────────────────────
// Captured from the configured local CLI (agy) answering "hi": prose, then the
// action line the CHAT_SYSTEM_PROMPT asks for.
const CHAT_REPLY =
  'Hello! How can I help you with your Demo project today? There is currently no dataset open.\n' +
  sa.ACTION_MARKER + ' {"kind":"none","intent":""}';

const hunted = cli.extractEnvelope(CHAT_REPLY);
ok('envelope: without `prose`, the hunter really does return the ACTION LINE',
  hunted === '{"kind":"none","intent":""}', JSON.stringify(hunted));

const kept = cli.extractEnvelope(CHAT_REPLY, true);
ok('envelope: `prose` hands the whole reply back, action line and all',
  kept === CHAT_REPLY, JSON.stringify(kept));

// End to end: what the dock would render. This is the assertion the bug report
// is written against — no brace ever reaches the bubble.
const shown = sa.splitAction(cli.extractEnvelope(CHAT_REPLY, true)).text;
ok('envelope: the prose survives all the way to the rendered answer',
  shown === 'Hello! How can I help you with your Demo project today? There is currently no dataset open.',
  JSON.stringify(shown));
ok('envelope: …and no JSON reaches the user', shown.indexOf('{') < 0, JSON.stringify(shown));

// The other direction, or the fix is just a deletion: `analyze()` still needs
// its envelope pulled out of a banner and out of a markdown fence.
ok('envelope: a JSON caller still gets the envelope out of a banner',
  cli.extractEnvelope('Reading image.png…\n{"title":"Q3","insights":[]}\nDone.') === '{"title":"Q3","insights":[]}');
ok('envelope: …and out of a markdown fence',
  cli.extractEnvelope('Here you go:\n```json\n{"title":"Q3"}\n```') === '{"title":"Q3"}');
ok('envelope: a reply with no JSON at all passes through either way',
  cli.extractEnvelope('OK') === 'OK' && cli.extractEnvelope('OK', true) === 'OK');

if (failureCount()) {
  console.error('\n' + failureCount() + ' cliEnvelope check(s) FAILED');
  process.exit(1);
}
console.log('\nAll cliEnvelope checks passed.');
