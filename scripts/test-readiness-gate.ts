// Self-check for the capture readiness gate + BYOK-mode adoption.
// config.js requires Electron (safeStorage), so it can't run under plain node —
// these mirror the pure decision logic in src/config.js (executionReady and
// adoptByokModeIfLocalUnready). KEEP IN SYNC with those two functions.

export {}; // module scope — sibling test scripts share top-level names

// Explicit annotation (not a cast): assert.ok is an assertion function, and
// TS requires the call target itself to carry a declared type (TS2775).
const assert: typeof import('assert') = require('assert');

const RUNNABLE_LOCAL = ['claude', 'antigravity', 'codex', 'grok', 'opencode', 'cursor'];

// ponytail: cfg mirrors the v2 config envelope — any keeps these mirrors terse
// Mirror of byokConnected(prov): verified AND has a key (or baseUrl for gateway).
function byokConnected(cfg: any, prov: string): boolean {
  const d = (cfg.byok.providers || {})[prov] || {};
  if (!d.verified) return false;
  return prov === 'gateway' ? Boolean(d.baseUrl) : Boolean(d.apiKey);
}
function effectiveByokActive(cfg: any): string | null {
  const stored = cfg.byok.activeProvider;
  if (byokConnected(cfg, stored)) return stored;
  return (cfg.byok.order || []).find((p: string) => byokConnected(cfg, p)) || null;
}
function localReady(cfg: any): boolean {
  const id = cfg.localCli.activeId;
  if (!id || !RUNNABLE_LOCAL.includes(id)) return false;
  const r = (cfg.localCli.results || {})[id];
  return Boolean(r && r.status === 'installed');
}
// Mirror of executionReady().
function executionReady(cfg: any): boolean {
  if ((cfg.executionMode || 'local') === 'local') return localReady(cfg);
  return Boolean(effectiveByokActive(cfg));
}
// Mirror of adoptByokModeIfLocalUnready(prov): only adopts when in local mode,
// local isn't ready, and the provider is connected. Mutates + returns switched?.
function adoptByokModeIfLocalUnready(cfg: any, prov: string): boolean {
  if ((cfg.executionMode || 'local') !== 'local') return false;
  if (localReady(cfg)) return false;
  if (!byokConnected(cfg, prov)) return false;
  cfg.byok.activeProvider = prov;
  cfg.executionMode = 'byok';
  return true;
}

let failures = 0;
function ok(label: string, cond: boolean) { if (cond) console.log('ok   ' + label); else { console.error('FAIL ' + label); failures++; } }

// THE BUG: BYOK connected + tested, but mode still local → gate ignores BYOK.
const bug = {
  executionMode: 'local',
  localCli: { activeId: null, results: {} },
  byok: { activeProvider: 'anthropic', order: ['anthropic'], providers: { anthropic: { verified: true, apiKey: 'sk-x' } } },
};
ok('local mode + connected BYOK → NOT ready (reproduces the reported bug)', executionReady(bug) === false);

// THE FIX: adopting BYOK mode when local is unready flips the gate to ready.
const switched = adoptByokModeIfLocalUnready(bug, 'anthropic');
ok('adopt switches mode to byok', switched === true && bug.executionMode === 'byok');
ok('after adoption → executionReady TRUE', executionReady(bug) === true);

// SAFETY: a ready local CLI is never hijacked by a BYOK test.
const localGood = {
  executionMode: 'local',
  localCli: { activeId: 'claude', results: { claude: { status: 'installed' } } },
  byok: { activeProvider: 'anthropic', order: ['anthropic'], providers: { anthropic: { verified: true, apiKey: 'sk-x' } } },
};
ok('ready local CLI → already ready', executionReady(localGood) === true);
ok('adopt does NOT hijack a working local setup', adoptByokModeIfLocalUnready(localGood, 'anthropic') === false && localGood.executionMode === 'local');

// Unverified provider doesn't count as connected.
const unverified = {
  executionMode: 'byok',
  localCli: { activeId: null, results: {} },
  byok: { activeProvider: 'openai', order: ['openai'], providers: { openai: { verified: false, apiKey: 'sk-x' } } },
};
ok('byok mode + unverified provider → NOT ready', executionReady(unverified) === false);

if (failures) { console.error('\n' + failures + ' readiness-gate check(s) FAILED'); process.exit(1); }
console.log('\nAll readiness-gate checks passed.');
