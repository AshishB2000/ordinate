// Config + API-key storage. MAIN PROCESS ONLY.
//
// Schema v2: per-provider {apiKey/endpoint, model} stored under cfg.providers.
// Raw keys never leave main process; renderers see only {hasKey, model} per provider.
// config.json is in .gitignore so keys never enter version control.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ── Shapes ──────────────────────────────────────────────────────────────────
export interface LegacyProviderEntry { apiKey?: string | null; endpoint?: string; model: string }

export interface ByokProviderEntry {
  apiKey: string | null;
  baseUrl: string;
  maxTokens: string;
  model: string;
  verified: boolean;
}

interface ByokBlock { activeProvider: string; providers: Record<string, ByokProviderEntry> }

// Persisted detection rows (see localCli's DetectResult); status is kept a plain
// string because these round-trip through disk JSON.
export interface CliDetectionResult { id: string; status: string; version?: string | null; resolvedPath?: string | null }

interface LocalCliBlock {
  activeId: string | null;
  lastDetection: { at: string; results: CliDetectionResult[] } | null;
  models: Record<string, string>;
}

export interface MemoryModel { mode: string; provider: string | null; model: string }
interface Notifications { sound: boolean; desktop: boolean }

// Per-connection secret (pg password, URL auth token). Stored EXACTLY like an API
// key: plaintext in userData/config.json (gitignored), keyed by the connection's
// generated UUID. NEVER written into a project's connections/*.json, NEVER copied
// into publicConfig()/publicByok(), NEVER returned to a renderer — main reads it
// back only via getConnectionSecret to run a connection.
export interface ConnectionSecret { password?: string | null; token?: string | null }

interface Config {
  version: number;
  activeProvider: string;
  executionMode: string;
  localCli: LocalCliBlock;
  memoryModel: MemoryModel;
  // ponytail: cached model rows are provider-shaped JSON — not worth typing here.
  modelCache: Record<string, { at: string; models: any[] }>;
  hotkey: string;
  theme: string;
  themePreference: string;
  prompt: string;
  globalRules: string;
  notifications: Notifications;
  /**
   * The master switch for unattended dataset refresh. ON by default: a schedule
   * a user set is a schedule they want run, and this exists to stop it globally
   * (on a metered connection, say), not to make them opt in twice.
   */
  autoRefresh: boolean;
  // Week 11 — the AI Copilot panel is OPT-OUTABLE (a hard OFF switch, distinct
  // from execution-readiness). Default true; when false the renderer hides the
  // chat entirely and never calls the model.
  copilotEnabled: boolean;

  /** Whether the bundled sample project has EVER been seeded (sampleProject.ts).
   *  Records the event, not the sample's presence — the user may delete it, and
   *  re-creating it next launch would make that impossible. Main-only. */
  sampleSeeded: boolean;
  // Home "Starred" pins — a flat list of "type:id" keys (e.g. "analysis:<uuid>").
  // ONE array for all four record types, so a record never carries a starred flag
  // and there are no per-type migrations.
  starred: string[];
  providers: Record<string, LegacyProviderEntry>;
  byok: ByokBlock;
  // Connection secrets, keyed by connection UUID. Never reaches a renderer.
  connectionSecrets: Record<string, ConnectionSecret>;
}

// A connection id is a generated UUID (see src/connections.ts). Validate the
// SHAPE before using it as a config key — mirrors the datasets/projects guard.
const CONN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _unusedIsConnId(id: unknown): id is string {
  return typeof id === 'string' && CONN_UUID_RE.test(id);
}

export const PROVIDERS: string[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'ollama', 'custom'];

// ── Execution mode (BYOK) ───────────────────────────────────────────────────
// New richer per-provider shape for the Execution mode rework. Lives alongside
// the legacy `providers` block (kept for the old setup panel) — analyze routes
// via this byok block. apiKey stays plaintext on disk (established decision).
export const EXECUTION_MODES: string[] = ['local', 'byok'];
export const BYOK_PROVIDERS: string[] = ['anthropic', 'openai', 'gemini', 'gateway'];

// Per-provider defaults. baseUrl is the API root (adapters append their path);
// maxTokens '' means "use the adapter's tuned default". All user-editable.
export const BYOK_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com',                       model: 'claude-sonnet-4-6'  },
  openai:    { baseUrl: 'https://api.openai.com/v1',                       model: 'gpt-4o'             },
  gemini:    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash'   },
  gateway:   { baseUrl: '',                                                 model: ''                  },
};

export function freshByokProvider(prov: string): ByokProviderEntry {
  const d = BYOK_DEFAULTS[prov] || { baseUrl: '', model: '' };
  // verified: true only after a successful connectivity test (see setByokVerified).
  // A saved key alone is NOT "connected" — it must validate first.
  return { apiKey: null, baseUrl: d.baseUrl, maxTokens: '', model: d.model, verified: false };
}

function freshByok(): ByokBlock {
  const providers: Record<string, ByokProviderEntry> = {};
  for (const p of BYOK_PROVIDERS) providers[p] = freshByokProvider(p);
  return { activeProvider: 'anthropic', providers };
}

export const THEMES: string[] = ['light', 'dark'];
// Single source of truth for the UI theme. 'system' follows the OS (resolved in
// main via nativeTheme); 'light'/'dark' force that theme.
export const THEME_PREFERENCES: string[] = ['system', 'light', 'dark'];

function freshProviders(): Record<string, LegacyProviderEntry> {
  return {
    anthropic:  { apiKey: null, model: '' },
    openai:     { apiKey: null, model: '' },
    gemini:     { apiKey: null, model: '' },
    openrouter: { apiKey: null, model: '' },
    ollama:     { endpoint: '', model: '' },
    custom:     { apiKey: null, model: '' },
  };
}

const DEFAULTS: Omit<Config, 'providers' | 'byok'> = {
  version: 2,
  activeProvider: 'anthropic',
  executionMode: 'local',
  // Local CLI detection state. lastDetection: { at: ISO, results: [{id,status,version,resolvedPath}] }
  // models: per-CLI selected model, e.g. { antigravity: 'Gemini 3.5 Flash (Medium)' }.
  localCli: { activeId: null, lastDetection: null, models: {} },
  // Which model handles memory/summary work, distinct from the main analyze call.
  // mode 'same_as_chat' uses the active execution path; 'override' falls back to a
  // specific BYOK provider family. NOTE: no memory step is wired yet — see analyze.js.
  memoryModel: { mode: 'same_as_chat', provider: null, model: '' },
  // Last good live model list per provider/CLI, so dropdowns render instantly
  // then refresh. Keyed by provider name or CLI id: { key: { at: ISO, models: [{id,label}] } }.
  modelCache: {},
  hotkey: 'CommandOrControl+Alt+S',
  theme: 'light',
  themePreference: 'system',
  prompt: '',
  // User's free-text "Instructions / Rules", appended ADDITIVELY to the system
  // prompt for every analysis (see analyze.js buildSystemPrompt). Empty = none.
  globalRules: '',
  // Completion notifications, both OFF by default. sound: play a short beep when
  // an analysis turn finishes. desktop: OS notification when it finishes AND the
  // window isn't focused. Best-effort — never block/error the analysis.
  notifications: { sound: false, desktop: false },
  autoRefresh: true,
  // AI Copilot panel is ON by default — it stays fully optional (execution-gated),
  // but the user can also switch it OFF entirely from the panel's toggle.
  copilotEnabled: true,
  // Absent means not-yet-seeded, so an existing config.json seeds once on upgrade.
  sampleSeeded: false,
  // Home "Starred" pins, as "type:id" keys. One flat array, one setter — no
  // per-record flag, no migration.
  starred: [],
  // Connection secrets (pg passwords / URL tokens), keyed by connection UUID.
  // Plaintext on disk like API keys; stripped from every renderer-facing view.
  connectionSecrets: {},
};

export const MEMORY_MODES: string[] = ['same_as_chat', 'override'];

let cache: Config | null = null;

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

// Starred pins are "type:id" strings: keep only non-empty strings, dedupe, and
// bound the length (a pin list is small — this only guards against junk on disk
// or a bad IPC payload). Shared by sanitize() and setStarred().
function cleanStarred(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s === 'string' && s.length > 0 && !seen.has(s)) {
      seen.add(s);
      out.push(s);
      if (out.length >= 1000) break;
    }
  }
  return out;
}

// ponytail: input is raw disk/IPC JSON — validated field-by-field below.
function sanitize(input: any): Partial<Config> {
  const out: Partial<Config> = {};
  if (!input || typeof input !== 'object') return out;
  if (PROVIDERS.includes(input.activeProvider)) out.activeProvider = input.activeProvider;
  if (EXECUTION_MODES.includes(input.executionMode)) out.executionMode = input.executionMode;
  if (typeof input.hotkey === 'string' && input.hotkey.trim()) out.hotkey = input.hotkey.trim();
  if (THEMES.includes(input.theme)) out.theme = input.theme;
  if (THEME_PREFERENCES.includes(input.themePreference)) out.themePreference = input.themePreference;
  if (typeof input.prompt === 'string') out.prompt = input.prompt;
  if (typeof input.globalRules === 'string') out.globalRules = input.globalRules;
  // Absent means ON, so every config written before this existed keeps working
  // the way the feature is documented rather than silently disabled.
  out.autoRefresh = input.autoRefresh === undefined ? true : Boolean(input.autoRefresh);
  if (input.notifications && typeof input.notifications === 'object') {
    out.notifications = {
      sound: Boolean(input.notifications.sound),
      desktop: Boolean(input.notifications.desktop),
    };
  }
  if (typeof input.copilotEnabled === 'boolean') out.copilotEnabled = input.copilotEnabled;
  if (typeof input.sampleSeeded === 'boolean') out.sampleSeeded = input.sampleSeeded;
  // Whitelisted so it survives disk load ({...DEFAULTS, ...sanitize(onDisk)}).
  if (Array.isArray(input.starred)) out.starred = cleanStarred(input.starred);
  return out;
}

// ponytail: cfg may still carry v1 flat fields (provider/apiKey/endpoint/model)
// straight off disk — typed loose until migration normalizes it.
function migrate(cfg: any): Config {
  // v1 → v2: flat {provider, apiKey, endpoint, model} → {activeProvider, providers}
  if (!cfg.version || cfg.version < 2) {
    const oldProv     = cfg.provider  || 'anthropic';
    const oldKey      = cfg.apiKey    || null;
    const oldEndpoint = cfg.endpoint  || '';
    const oldModel    = cfg.model     || '';
    const provs = freshProviders();
    if (oldProv === 'ollama') {
      provs.ollama = { endpoint: oldEndpoint, model: oldModel };
    } else if (oldKey) {
      provs[oldProv] = { apiKey: oldKey, model: oldModel };
    }
    cfg.providers      = provs;
    cfg.activeProvider = oldProv;
    delete cfg.provider; delete cfg.apiKey; delete cfg.endpoint; delete cfg.model;
    cfg.version = 2;
  }
  // Ensure all provider slots exist (handles partial disk state)
  cfg.providers = { ...freshProviders(), ...cfg.providers };

  // Seed the byok block from the legacy providers on first run after the
  // Execution mode rework. Copies (does not delete) so the old block still works.
  if (!cfg.byok || typeof cfg.byok !== 'object') {
    const byok = freshByok();
    const legacy = cfg.providers || {};
    // Direct 1:1 maps; gateway (OpenAI-compatible) inherits from custom, else openrouter.
    const copyKeyModel = (from: string, to: string) => {
      const src = legacy[from] || {};
      if (src.apiKey) byok.providers[to].apiKey = src.apiKey;
      if (src.model)  byok.providers[to].model = src.model;
    };
    copyKeyModel('anthropic', 'anthropic');
    copyKeyModel('openai', 'openai');
    copyKeyModel('gemini', 'gemini');
    if (legacy.custom && legacy.custom.apiKey) copyKeyModel('custom', 'gateway');
    else if (legacy.openrouter && legacy.openrouter.apiKey) copyKeyModel('openrouter', 'gateway');

    // Map the legacy active provider into a byok provider.
    const a = cfg.activeProvider;
    byok.activeProvider = BYOK_PROVIDERS.includes(a) ? a
      : (a === 'custom' || a === 'openrouter') ? 'gateway'
      : 'anthropic';
    cfg.byok = byok;
  }
  // Backfill any missing byok provider slots / fields (partial disk state).
  if (!EXECUTION_MODES.includes(cfg.executionMode)) cfg.executionMode = 'local';
  cfg.byok.providers = cfg.byok.providers || {};
  for (const p of BYOK_PROVIDERS) {
    cfg.byok.providers[p] = { ...freshByokProvider(p), ...cfg.byok.providers[p] };
  }
  if (!BYOK_PROVIDERS.includes(cfg.byok.activeProvider)) cfg.byok.activeProvider = 'anthropic';

  // Ensure the localCli block exists (detection state persisted across launches).
  if (!cfg.localCli || typeof cfg.localCli !== 'object') {
    cfg.localCli = { activeId: null, lastDetection: null, models: {} };
  }
  if (!('activeId' in cfg.localCli)) cfg.localCli.activeId = null;
  if (!('lastDetection' in cfg.localCli)) cfg.localCli.lastDetection = null;
  // Per-CLI selected model (e.g. { antigravity: 'Gemini 3.5 Flash (Medium)' }).
  if (!cfg.localCli.models || typeof cfg.localCli.models !== 'object') cfg.localCli.models = {};

  // Ensure the model-list cache exists.
  if (!cfg.modelCache || typeof cfg.modelCache !== 'object') cfg.modelCache = {};

  // Ensure the connection-secrets block exists (never round-trips via sanitize).
  if (!cfg.connectionSecrets || typeof cfg.connectionSecrets !== 'object') cfg.connectionSecrets = {};

  // Validate / backfill the memoryModel block.
  if (!cfg.memoryModel || typeof cfg.memoryModel !== 'object') {
    cfg.memoryModel = { mode: 'same_as_chat', provider: null, model: '' };
  }
  if (!MEMORY_MODES.includes(cfg.memoryModel.mode)) cfg.memoryModel.mode = 'same_as_chat';
  if (!BYOK_PROVIDERS.includes(cfg.memoryModel.provider)) cfg.memoryModel.provider = null;
  if (typeof cfg.memoryModel.model !== 'string') cfg.memoryModel.model = '';
  // Adopt themePreference from a pre-existing light/dark theme, else default to system.
  if (!THEME_PREFERENCES.includes(cfg.themePreference)) {
    cfg.themePreference = THEMES.includes(cfg.theme) ? cfg.theme : 'system';
  }
  return cfg;
}

// Exported for configSecrets.ts, which mutates the secrets map in place (the
// only writer that does) and must flush it. Not an invitation: everything else
// goes through save().
export function persist(cfg: Config): void {
  cache = cfg;
  // Atomic write (temp sibling → rename), mirroring the BI stores. config.json
  // holds every plaintext API key + connection secret; a crash / full disk mid-
  // write must never leave it truncated (which load() would then read as {} and
  // migrate() would overwrite with fresh empty blocks, silently losing all keys).
  const p = configPath();
  const tmp = `${p}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function load(): Config {
  let onDisk: any = {}; // ponytail: raw JSON off disk, shape unknown until migrate()
  const p = configPath();
  try {
    onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err: any) {
    // If the file exists but failed to parse (corruption/truncation), preserve it
    // as config.json.corrupt BEFORE defaults are re-persisted — keys stay
    // recoverable rather than being overwritten on the next save. A plain ENOENT
    // (first run) is not corruption; leave it alone.
    if (err && err.code !== 'ENOENT') {
      try { fs.renameSync(p, `${p}.corrupt`); } catch (_) {}
    }
    onDisk = {};
  }
  const merged: any = { ...DEFAULTS, ...sanitize(onDisk) };
  merged.providers = { ...freshProviders(), ...(onDisk.providers || {}) };
  // Carry the byok block through verbatim; migrate() backfills/validates it.
  if (onDisk.byok && typeof onDisk.byok === 'object') merged.byok = onDisk.byok;
  if (onDisk.localCli && typeof onDisk.localCli === 'object') merged.localCli = onDisk.localCli;
  if (onDisk.modelCache && typeof onDisk.modelCache === 'object') merged.modelCache = onDisk.modelCache;
  if (onDisk.memoryModel && typeof onDisk.memoryModel === 'object') merged.memoryModel = onDisk.memoryModel;
  // Secrets never round-trip through sanitize() (that path is renderer-facing) —
  // carry them verbatim from disk, exactly like byok keys.
  if (onDisk.connectionSecrets && typeof onDisk.connectionSecrets === 'object') merged.connectionSecrets = onDisk.connectionSecrets;
  cache = migrate(merged);
  return cache;
}

export function get(): Config {
  return cache || load();
}

export function save(partial: any): Config {
  const cfg = get();
  Object.assign(cfg, sanitize(partial));
  persist(cfg);
  return cfg;
}
// Replace the Home "Starred" pin list (the renderer toggles then sends the whole
// list). Validated/deduped/bounded like the disk path.
export function setStarred(ids: unknown): { ok: boolean; starred: string[] } {
  const cfg = get();
  cfg.starred = cleanStarred(ids);
  persist(cfg);
  return { ok: true, starred: cfg.starred };
}

// Persist the user's global rules (Instructions / Rules box). Empty allowed.
export function setGlobalRules(text: unknown): { ok: boolean } {
  const cfg = get();
  cfg.globalRules = typeof text === 'string' ? text : '';
  persist(cfg);
  return { ok: true };
}

// Merge notification toggles ({ sound?, desktop? }) and persist.
// ponytail: fields is an IPC payload, validated per-field below.
/** The master auto-refresh switch. Read by the scheduler on every tick. */
export function setAutoRefreshEnabled(on: boolean): { ok: boolean; autoRefresh: boolean } {
  const cfg = save({ autoRefresh: Boolean(on) });
  return { ok: true, autoRefresh: cfg.autoRefresh };
}

export function setNotifications(fields: any): { ok: boolean; notifications: Notifications } {
  const cfg = get();
  const cur = cfg.notifications || { sound: false, desktop: false };
  const next = { ...cur };
  if (fields && 'sound' in fields)   next.sound = Boolean(fields.sound);
  if (fields && 'desktop' in fields) next.desktop = Boolean(fields.desktop);
  cfg.notifications = next;
  persist(cfg);
  return { ok: true, notifications: next };
}

// ── Destructive: delete-my-data helpers (only ever called from an explicit,
// confirmed user action in MAIN — never automatically) ──────────────────────

// Remove every stored credential: BYOK keys + verified flags, and the legacy
// providers' keys/endpoint. Resets active selections to defaults. Other
// settings (theme, hotkey, prompt, notifications…) are left intact.
export function clearAllCredentials(): { ok: boolean } {
  const cfg = get();
  for (const p of BYOK_PROVIDERS) {
    cfg.byok.providers[p] = { ...freshByokProvider(p) }; // apiKey:null, verified:false, defaults
  }
  cfg.byok.activeProvider = 'anthropic';
  cfg.providers = freshProviders(); // clears legacy apiKey/endpoint for all providers
  cfg.activeProvider = 'anthropic';
  cfg.connectionSecrets = {}; // pg passwords / URL tokens are credentials too
  persist(cfg);
  return { ok: true };
}

// Reset ALL settings/preferences to defaults. Note: keys live in config.json, so
// this also clears stored credentials (a superset of clearAllCredentials).
export function resetToDefaults(): { ok: boolean } {
  const fresh = { ...DEFAULTS, providers: freshProviders(), byok: freshByok(),
    localCli: { activeId: null, lastDetection: null, models: {} },
    memoryModel: { mode: 'same_as_chat', provider: null, model: '' },
    modelCache: {}, notifications: { sound: false, desktop: false },
    connectionSecrets: {} };
  persist(fresh);
  return { ok: true };
}
