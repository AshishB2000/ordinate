// EXECUTION SETUP — which model runs, and whether one is ready to.
//
// Split out of config.ts (.claude/rules/file-size.md): that file stores what the
// app's settings ARE, this one answers what they MEAN for running a model —
// per-provider keys, the BYOK block, detected local CLIs, and the single
// readiness predicate the whole app gates on.
//
// The dependency runs ONE WAY, execConfig → config, and it has to: config.ts
// must never import this file back, or the two form a require cycle in which
// whichever module loads second sees a half-built copy of the other. That is
// also why publicConfig() lives here rather than beside the store — it reports
// isReady/byok/localCli, so it belongs on the side that knows them.
//
// The moved code is unchanged apart from these imports.

import * as localCli from '../cli/localCli';
import type {
  ByokProviderEntry, CliDetectionResult, LegacyProviderEntry, MemoryModel,
} from './config';
import {
  BYOK_PROVIDERS, EXECUTION_MODES, MEMORY_MODES, PROVIDERS,
  freshByokProvider, get, persist,
} from './config';

// ── Per-provider key / model helpers ────────────────────────────────────────

function provData(prov: string): Partial<LegacyProviderEntry> {
  return get().providers[prov] || {};
}

export function hasKey(prov: string): boolean {
  const d = provData(prov);
  return prov === 'ollama' ? Boolean(d.endpoint) : Boolean(d.apiKey);
}

// Store an API key for a cloud provider. Sets that provider as active.
export async function setApiKey(plaintext: unknown, provider?: unknown): Promise<{ ok: boolean }> {
  if (typeof plaintext !== 'string' || !plaintext) return { ok: false };
  const prov = (typeof provider === 'string' && PROVIDERS.includes(provider))
    ? provider : get().activeProvider;
  if (prov === 'ollama') return { ok: false };
  const cfg = get();
  cfg.providers[prov] = { ...cfg.providers[prov], apiKey: plaintext };
  cfg.activeProvider = prov;
  persist(cfg);
  return { ok: true };
}

// Return the raw key for a provider — main-process only.
export async function getApiKey(provider?: string): Promise<string | null> {
  const prov = provider || get().activeProvider;
  return provData(prov).apiKey || null;
}

// Store an Ollama endpoint. Sets ollama as active.
export function setOllamaEndpoint(endpoint: string): { ok: boolean } {
  const cfg = get();
  cfg.providers.ollama = { ...cfg.providers.ollama, endpoint };
  cfg.activeProvider = 'ollama';
  persist(cfg);
  return { ok: true };
}

// Clear a specific provider's credential. If it was active, switch to another.
export function clearProviderKey(provider?: unknown): { ok: boolean } {
  const cfg = get();
  const prov = (typeof provider === 'string' && PROVIDERS.includes(provider))
    ? provider : cfg.activeProvider;

  if (cfg.providers[prov]) {
    if (prov === 'ollama') {
      cfg.providers[prov].endpoint = '';
    } else {
      cfg.providers[prov].apiKey = null;
    }
  }

  if (prov === cfg.activeProvider) {
    // Find another provider that still has a key
    const other = PROVIDERS.find(p => {
      if (p === prov) return false;
      const d = cfg.providers[p] || {};
      return p === 'ollama' ? Boolean(d.endpoint) : Boolean(d.apiKey);
    });
    cfg.activeProvider = other || 'anthropic';
  }

  persist(cfg);
  return { ok: true };
}

// Save the chosen model for a specific provider.
export function setModel(model: unknown, provider?: unknown): { ok: boolean } {
  const cfg = get();
  const prov = (typeof provider === 'string' && PROVIDERS.includes(provider))
    ? provider : cfg.activeProvider;
  cfg.providers[prov] = { ...cfg.providers[prov], model: typeof model === 'string' ? model.trim() : '' };
  persist(cfg);
  return { ok: true };
}

// Change which provider is used for captures.
export function setActiveProvider(provider: string): { ok: boolean } {
  if (!PROVIDERS.includes(provider)) return { ok: false };
  const cfg = get();
  cfg.activeProvider = provider;
  persist(cfg);
  return { ok: true };
}

// ── Execution mode / BYOK helpers ───────────────────────────────────────────

export function setExecutionMode(mode: string): { ok: boolean } {
  if (!EXECUTION_MODES.includes(mode)) return { ok: false };
  const cfg = get();
  cfg.executionMode = mode;
  persist(cfg);
  return { ok: true };
}

// Persist the memory-model choice. fields: { mode, provider?, model? }.
// Setting-only today — no memory step consumes it yet (see analyze.js stub).
// ponytail: fields is an IPC payload, validated per-field below.
export function setMemoryModel(fields: any): { ok: boolean; memoryModel: MemoryModel } {
  const cfg = get();
  const cur = cfg.memoryModel || { mode: 'same_as_chat', provider: null, model: '' };
  const next = { ...cur };
  if (fields && MEMORY_MODES.includes(fields.mode)) next.mode = fields.mode;
  if (fields && 'provider' in fields) {
    next.provider = BYOK_PROVIDERS.includes(fields.provider) ? fields.provider : null;
  }
  if (fields && typeof fields.model === 'string') next.model = fields.model;
  if (next.mode === 'same_as_chat') { next.provider = null; next.model = ''; }
  cfg.memoryModel = next;
  persist(cfg);
  return { ok: true, memoryModel: next };
}

// Full byok entry for a provider INCLUDING the raw key — main-process only.
export function getByokProvider(prov: string): { provider: string } & ByokProviderEntry {
  const p = BYOK_PROVIDERS.includes(prov) ? prov : get().byok.activeProvider;
  return { provider: p, ...freshByokProvider(p), ...(get().byok.providers[p] || {}) };
}

// Merge editable fields (apiKey/baseUrl/maxTokens/model) into a provider entry.
// ponytail: fields is an IPC payload, validated per-field below.
export function setByokProvider(prov: string, fields: any): { ok: boolean } {
  if (!BYOK_PROVIDERS.includes(prov)) return { ok: false };
  const cfg = get();
  const cur = cfg.byok.providers[prov] || freshByokProvider(prov);
  const next = { ...cur };
  // A changed credential (key or endpoint) invalidates any prior verification —
  // it must be re-tested before the provider is "connected" again.
  if (typeof fields.apiKey === 'string')   { next.apiKey = fields.apiKey || null; next.verified = false; }
  if (typeof fields.baseUrl === 'string')  { next.baseUrl = fields.baseUrl.trim(); next.verified = false; }
  if (typeof fields.model === 'string')    next.model = fields.model.trim();
  if (fields.maxTokens !== undefined)      next.maxTokens = String(fields.maxTokens || '').trim();
  cfg.byok.providers[prov] = next;
  persist(cfg);
  return { ok: true };
}

// A provider is "connected" only when its credential is present AND a real
// connectivity test has verified it. A key string alone is not connected.
export function byokConnected(prov: string): boolean {
  if (!BYOK_PROVIDERS.includes(prov)) return false;
  const d = get().byok.providers[prov] || {};
  if (!d.verified) return false;
  return prov === 'gateway' ? Boolean(d.baseUrl) : Boolean(d.apiKey);
}

// The provider that should actually be Active: the stored one if it's connected,
// else the first connected provider, else null (nothing connected → no Active).
export function effectiveByokActive(): string | null {
  const stored = get().byok.activeProvider;
  if (byokConnected(stored)) return stored;
  return BYOK_PROVIDERS.find(byokConnected) || null;
}

// Flip a provider's verified flag — true only after a successful connectivity
// test. Persisted so the popup/settings reflect Connected across reopens.
export function setByokVerified(prov: string, ok: unknown): { ok: boolean } {
  if (!BYOK_PROVIDERS.includes(prov)) return { ok: false };
  const cfg = get();
  const cur = cfg.byok.providers[prov] || freshByokProvider(prov);
  cfg.byok.providers[prov] = { ...cur, verified: Boolean(ok) };
  persist(cfg);
  return { ok: true };
}

// Active requires Connected: refuse to activate a provider that hasn't verified.
export function setByokActiveProvider(prov: string): { ok: boolean; error?: string } {
  if (!BYOK_PROVIDERS.includes(prov)) return { ok: false };
  if (!byokConnected(prov)) return { ok: false, error: 'not_connected' };
  const cfg = get();
  cfg.byok.activeProvider = prov;
  persist(cfg);
  return { ok: true };
}

// ── Local CLI detection state ───────────────────────────────────────────────

// Persist a detection scan (full results, incl. internal resolvedPath) + timestamp.
export function saveLocalCliDetection(results: unknown): { ok: boolean } {
  const cfg = get();
  cfg.localCli.lastDetection = {
    at: new Date().toISOString(),
    results: Array.isArray(results) ? results : [],
  };
  persist(cfg);
  return { ok: true };
}

// Set the selected Local CLI (must be a known registry id, or null to clear).
export function setLocalCliActive(id: string | null): { ok: boolean } {
  const valid = id === null || localCli.REGISTRY.some((e: { id: string }) => e.id === id);
  if (!valid) return { ok: false };
  const cfg = get();
  cfg.localCli.activeId = id;
  persist(cfg);
  return { ok: true };
}

// Internal-only: the full stored detection result for one id (incl. resolvedPath).
export function getLocalCliResult(id: string): CliDetectionResult | null {
  const det = get().localCli.lastDetection;
  const results = (det && det.results) || [];
  return results.find(r => r && r.id === id) || null;
}

// Persist the chosen model for a Local CLI (must be a known registry id).
// Empty/non-string clears it (CLI default).
export function setLocalCliModel(id: string, model: unknown): { ok: boolean } {
  if (!localCli.REGISTRY.some((e: { id: string }) => e.id === id)) return { ok: false };
  const cfg = get();
  const m = typeof model === 'string' ? model.trim() : '';
  if (m) cfg.localCli.models[id] = m;
  else delete cfg.localCli.models[id];
  persist(cfg);
  return { ok: true };
}

// The selected model for a Local CLI, or '' when none (use the CLI default).
export function getLocalCliModel(id: string): string {
  const models = get().localCli.models || {};
  return models[id] || '';
}

// Model-list cache (last good live list per provider/CLI key).
export function setModelCache(key: unknown, models: unknown): { ok: boolean } {
  if (typeof key !== 'string' || !Array.isArray(models)) return { ok: false };
  const cfg = get();
  cfg.modelCache[key] = { at: new Date().toISOString(), models };
  persist(cfg);
  return { ok: true };
}
export function getModelCache(key: string): { at: string; models: any[] } | null {
  const c = get().modelCache || {};
  return c[key] || null;
}

// Renderer-safe view: activeId + merged registry/detection list, NO resolvedPath.
export function publicLocalCli() {
  const cfg = get();
  const det = cfg.localCli.lastDetection;
  return {
    activeId: cfg.localCli.activeId || null,
    detectedAt: (det && det.at) || null,
    models: { ...(cfg.localCli.models || {}) },
    clis: localCli.toPublic(det && (det.results as any)), // ponytail: disk JSON rows; toPublic tolerates junk
  };
}

// Renderer-safe byok view: per-provider hasKey + baseUrl/maxTokens/model, NO keys.
export function publicByok() {
  const cfg = get();
  const providers: Record<string, {
    hasKey: boolean; verified: boolean; connected: boolean;
    baseUrl: string; maxTokens: string; model: string;
  }> = {};
  for (const p of BYOK_PROVIDERS) {
    const d = cfg.byok.providers[p] || freshByokProvider(p);
    providers[p] = {
      hasKey:    Boolean(d.apiKey),
      verified:  Boolean(d.verified),
      connected: byokConnected(p),  // hasKey/baseUrl AND verified
      baseUrl:   d.baseUrl || '',
      maxTokens: d.maxTokens || '',
      model:     d.model || '',
    };
  }
  // activeProvider is the EFFECTIVE active (connected, or null) — never a stale
  // keyless provider. The renderer treats null as "no provider Active".
  return { activeProvider: effectiveByokActive(), providers };
}

// Runnable local CLIs (have a working adapter) — keep in sync with analyze.js.
const RUNNABLE_LOCAL: string[] = ['claude', 'antigravity', 'codex', 'grok', 'opencode', 'cursor'];

// What every surface says when executionReady() is false. One sentence, one
// name for the feature: it used to be six near-copies that named it three ways
// ("…to use Copilot.", "…to draft a dashboard."). It no longer spells out a
// route either — the renderer puts a real "Set up the Assistant" button next to
// it. The renderer keeps its own copy in execMenu.ts (two worlds, no shared
// module); test-ai-naming.ts asserts the two stay identical.
export const AI_NOT_CONFIGURED = 'The Assistant isn’t set up yet.';

// THE single readiness concept used everywhere (banner, empty state, status pill,
// capture gate): ready when the active execution path can actually run.
//   Local  → a runnable local CLI is selected active AND detected installed.
//   BYOK   → a connected (key saved + validated) provider exists.
export function executionReady(): boolean {
  const cfg = get();
  if ((cfg.executionMode || 'local') === 'local') {
    const id = cfg.localCli.activeId;
    if (!id || !RUNNABLE_LOCAL.includes(id)) return false;
    const r = getLocalCliResult(id);
    return Boolean(r && r.status === 'installed');
  }
  return Boolean(effectiveByokActive());
}

// True iff the *local* path is usable right now (active CLI detected installed).
export function localExecutionReady(): boolean {
  const cfg = get();
  const id = cfg.localCli && cfg.localCli.activeId;
  if (!id || !RUNNABLE_LOCAL.includes(id)) return false;
  const r = getLocalCliResult(id);
  return Boolean(r && r.status === 'installed');
}

// When a BYOK provider connects, make it actually usable for capture: if the
// user is still in local mode AND local execution isn't ready, switch to BYOK
// (visible in the mode toggle) so executionReady + analyze use the working
// provider. Never overrides a ready local setup. This is the fix for "BYOK
// connected but New capture does nothing" — the gate only consults BYOK when
// executionMode !== 'local', and connecting BYOK never flipped the mode.
// Returns true if it switched the mode.
export function adoptByokModeIfLocalUnready(prov: string): boolean {
  const cfg = get();
  if ((cfg.executionMode || 'local') !== 'local') return false; // already byok
  if (localExecutionReady()) return false;                      // respect working local
  if (!byokConnected(prov)) return false;
  cfg.byok.activeProvider = prov;
  cfg.executionMode = 'byok';
  persist(cfg);
  return true;
}

// Renderer-safe view: no raw keys, exposes hasKey/model per provider.
export function publicConfig() {
  const cfg = get();
  const active = cfg.activeProvider || 'anthropic';

  const providerStatus: Record<string, { hasKey: boolean; model: string }> = {};
  for (const prov of PROVIDERS) {
    const d = cfg.providers[prov] || {};
    providerStatus[prov] = {
      hasKey: prov === 'ollama' ? Boolean(d.endpoint) : Boolean(d.apiKey),
      model:  d.model || '',
    };
  }

  const activeStatus = providerStatus[active] || { hasKey: false, model: '' };
  return {
    version:        cfg.version,
    activeProvider: active,
    executionMode:  cfg.executionMode || 'byok',
    isReady:        executionReady(), // single readiness source (Local CLI OR BYOK)
    byok:           publicByok(), // { activeProvider, providers: { name: { hasKey, baseUrl, maxTokens, model } } }
    localCli:       publicLocalCli(), // { activeId, detectedAt, clis: [...] } — no resolvedPath
    memoryModel:    { ...(cfg.memoryModel || { mode: 'same_as_chat', provider: null, model: '' }) },

    model:          activeStatus.model,
    hasApiKey:      activeStatus.hasKey,
    providerStatus, // { anthropic: { hasKey, model }, ... } — no raw keys
    hotkey:         cfg.hotkey,
    theme:          cfg.theme,
    themePreference: cfg.themePreference || 'system',
    prompt:         cfg.prompt,
    globalRules:    cfg.globalRules || '',
    notifications:  { ...(cfg.notifications || { sound: false, desktop: false }) },
    autoRefresh:    cfg.autoRefresh !== false,
    // Default true when absent (older config.json predating Week 11).
    copilotEnabled: cfg.copilotEnabled !== false,
    // Home "Starred" pins — a flat "type:id" list, safe to expose (no secrets).
    starred: [...(cfg.starred || [])],
    // Formats and branding carry no secrets: the renderer formats every figure
    // under them and paints its accent from them. The logo itself is fetched
    // separately (branding:logo) — it is a file, not a setting.
    formats: { ...cfg.formats },
    branding: { ...cfg.branding },
    // Settings → General → Collaboration. No secrets: a name and a folder path.
    displayName: cfg.displayName || '',
  };
}
