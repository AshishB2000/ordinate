// The Assistant has ONE name, and the "no model configured" sentence has ONE
// wording — in both worlds.
//
// The main process and the renderer cannot share a module (one is CommonJS
// under Electron's main, the other a classic global-scope <script>), so the
// sentence is declared twice: config.AI_NOT_CONFIGURED and execMenu.ts's
// `const AI_NOT_CONFIGURED`. Two declarations of one string is exactly the
// shape that drifts, so this asserts they are byte-identical — and that the
// old spellings the sweep replaced ("Copilot", "Execution settings", "AI
// draft", "Start with AI") have not come back into anything a user reads.

export {};
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const config = require('../src/app/config.js');

const REPO = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(REPO, p), 'utf8');

// ── The one sentence, declared in two worlds ────────────────────────────────
const MAIN = config.AI_NOT_CONFIGURED;
ok('the main process exports the not-configured sentence',
  MAIN === 'Connect a model in Settings → Execution to use the Assistant.', String(MAIN));

const execMenu = read('renderer/hub/execMenu.ts');
const m = /^const AI_NOT_CONFIGURED = '([^']*)';$/m.exec(execMenu);
ok("execMenu.ts declares the renderer's copy", Boolean(m));
ok('…and the two copies are byte-identical', Boolean(m) && m![1] === MAIN,
  `renderer=${m ? m[1] : '(none)'}`);

// ── No surface reads the sentence a second way ──────────────────────────────
// Every file that has to say it now interpolates the constant; a fresh literal
// is how the six near-copies happened the first time.
const SURFACES = [
  'renderer/hub/dock.ts', 'renderer/hub/prepare.ts', 'renderer/hub/dsExplorer.ts',
  'renderer/hub/dashAdd.ts', 'renderer/hub/vizNew.ts', 'renderer/hub/anDraft.ts',
  'renderer/hub/anNew.ts', 'renderer/hub/authoringPanes.ts', 'src/ai/analyze.ts',
];
for (const f of SURFACES) {
  const src = read(f);
  ok(`${f} does not re-spell "Connect a model in…"`,
    !/'Connect a model in[^']*'/.test(src),
    (/'Connect a model in[^']*'/.exec(src) || [''])[0]);
}

// ── The retired names stay retired ──────────────────────────────────────────
// Comments are stripped first: the files legitimately narrate the history
// ("the retired Copilot panel", "AI dock"), and that prose is not a user
// string. What is checked is the code and the markup a user actually reads.
const stripTs = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripHtml = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, '');

const RETIRED: Array<[RegExp, string]> = [
  [/\bCopilot\b/, 'Copilot — the feature is the Assistant'],
  [/Execution settings/, '"Execution settings" — the screen is Settings → Execution'],
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
const UI_FILES = [
  ...fs.readdirSync(path.join(REPO, 'renderer/hub'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .map((f) => 'renderer/hub/' + f),
  'src/ai/analyze.ts', 'src/analysis/analysisPlan.ts',
];
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

const html = stripHtml(read('renderer/hub/index.html'));
for (const [re, label] of RETIRED) {
  const hits = html.split('\n').filter((l) => re.test(l));
  ok(`index.html has no ${label}`, hits.length === 0, hits.join(' | ').slice(0, 160));
}

if (failureCount()) {
  console.error('\n' + failureCount() + ' AI-naming check(s) FAILED');
  process.exit(1);
}
console.log('\nAll AI-naming checks passed.');
