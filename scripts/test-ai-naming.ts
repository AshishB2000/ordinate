// The Assistant has ONE name, and the "no model configured" sentence has ONE
// wording.
//
// The desktop app declared the sentence twice — execConfig.AI_NOT_CONFIGURED
// and its classic-script execMenu.ts's `const AI_NOT_CONFIGURED` — and this
// asserted they were byte-identical. The desktop copy went with the desktop app
// (T8.1); its text is the golden fixture scripts/fixtures/golden/declaredTwice.json.
// This also asserts the old spellings the sweep replaced ("Copilot",
// "Execution settings", "AI draft", "Start with AI") have not come back into
// anything the server writes for a user.

export {};
import { ok, failureCount } from './selfcheck';
import { golden } from './golden';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const execConfig = require('../src/app/execConfig.js');

const REPO = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(REPO, p), 'utf8');

// ── The one sentence, declared in two worlds ────────────────────────────────
const MAIN = execConfig.AI_NOT_CONFIGURED;
ok('the main process exports the not-configured sentence',
  MAIN === 'The Assistant isn’t set up yet.', String(MAIN));

const desktop = golden<{ aiNotConfigured: string | null }>('declaredTwice').aiNotConfigured;
ok("the desktop's copy was recorded", typeof desktop === 'string' && desktop.length > 0);
ok('…and the two copies are byte-identical', desktop === MAIN, `desktop=${desktop}`);

// ── No surface reads the sentence a second way ──────────────────────────────
// Every file that has to say it now interpolates the constant; a fresh literal
// is how the six near-copies happened the first time.
const SURFACES = ['src/ai/analyze.ts', 'src/ai/prompts.ts'];
for (const f of SURFACES) {
  const src = read(f);
  ok(`${f} does not re-spell the not-set-up sentence`,
    !/'(Connect a model|The Assistant isn’t set up)[^']*'/.test(src),
    (/'(Connect a model|The Assistant isn’t set up)[^']*'/.exec(src) || [''])[0]);
}

// ── The retired names stay retired ──────────────────────────────────────────
// Comments are stripped first: the files legitimately narrate the history
// ("the retired Copilot panel", "AI dock"), and that prose is not a user
// string. What is checked is the code and the markup a user actually reads.
const stripTs = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const RETIRED: Array<[RegExp, string]> = [
  [/\bCopilot\b/, 'Copilot — the feature is the Assistant'],
  [/Execution settings/, '"Execution settings" — the tab is Settings → Assistant'],
  // The tab was renamed for people who do not know what an execution mode is.
  // Prose that still routes them to the old name is the drift this pins.
  [/Settings → Execution/, '"Settings → Execution" — the tab is Settings → Assistant'],
  [/\bExecution mode\b/, '"Execution mode" — the settings tab is "Assistant"'],
  [/Connect a model/, '"Connect a model" — the button is "Set up the Assistant"'],
  [/\bAI draft\b/, '"AI draft" — say "Draft with the Assistant"'],
  [/Start with AI\b/, '"Start with AI"'],
  [/Let AI design/, '"Let AI design it"'],
  [/Suggest with AI\b/, '"Suggest with AI"'],
  [/Draft with AI\b/, '"Draft with AI"'],
  [/'AI: O(n|ff)'/, '"AI: On/Off" — the pill names the Assistant'],
  // The catch-all, and the reason the others can stay narrow: no user-visible
  // string says "AI" at all any more. Case-SENSITIVE, so the historical
  // lowercase ids and classes (#side-ai-btn, .ai-interp, .ai-badge) — which
  // deliberately keep their spelling, because renaming them moves persisted
  // state — do not trip it. Comments are stripped before this runs, so the
  // files can still narrate their own history.
  [/\bAI\b/, 'bare "AI" in a user-visible string — the feature is the Assistant'],
];
// window.hub.* IPC names and CSS/DOM ids keep their historical spelling on
// purpose (renaming them moves persisted state), so only quoted UI strings and
// markup text are searched.
const UI_FILES = ['src/ai/analyze.ts', 'src/ai/prompts.ts', 'src/analysis/analysisPlan.ts'];
for (const [re, label] of RETIRED) {
  const hits: string[] = [];
  for (const f of UI_FILES) {
    for (const line of stripTs(read(f)).split('\n')) {
      // Only lines carrying a quoted string or a DOM text assignment.
      if (/['"`]/.test(line) && re.test(line)) hits.push(`${f}: ${line.trim().slice(0, 90)}`);
    }
  }
  ok(`no user-facing ${label}`, hits.length === 0, hits.join(' | '));
}

if (failureCount()) {
  console.error('\n' + failureCount() + ' AI-naming check(s) FAILED');
  process.exit(1);
}
console.log('\nAll AI-naming checks passed.');
