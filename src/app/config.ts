// Config + API-key storage. MAIN PROCESS ONLY.
//
// Schema v2: per-provider {apiKey/endpoint, model} stored under cfg.providers.
// Raw keys never leave main process; renderers see only {hasKey, model} per provider.
// config.json is in .gitignore so keys never enter version control.

import * as fs from 'fs';
import * as path from 'path';
import * as appPaths from './paths';
import { setCalendar } from '../analysis/dateIntel';
import { FORMAT_DEFAULTS, sanitizeFormatPrefs, setFormatPrefs } from './format';
import type { FormatPrefs } from './format';
import { BRANDING_DEFAULTS, sanitizeBranding } from './branding';
import type { Branding } from './branding';
import type { OnboardingState } from './onboarding';
import { BACKUP_DEFAULTS, sanitizeBackups } from './backupSettings';
import type { BackupSettings } from './backupSettings';
import { isLanguage, setLanguage } from './i18n';

// ── Shapes ──────────────────────────────────────────────────────────────────
export interface LegacyProviderEntry { apiKey?: string | null; endpoint?: string; model: string }

export interface ByokProviderEntry {
  apiKey: string | null;
  baseUrl: string;
  maxTokens: string;
  model: string;
  verified: boolean;
  /** Server only: a key for this provider is in the org's secrets store (apiKey stays null). */
  keyStored?: boolean;
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
export interface SampleIds { projectId: string; datasetId: string; analysisId: string; visualIds: string[] }
// `alerts` defaults ON and the other three OFF, which is the whole difference
// between the two kinds of notification this app sends. sound/desktop are about
// an analysis you started and are watching; `alerts` is about a rule you wrote
// for a number you are NOT watching, so a default of off would make the feature
// quietly do nothing. `alertExplain` is opt-in because it spends a model call.
// `jobs`: an OS notification when a background job (src/app/jobs.ts) finishes
// while the window is not focused. ON by default, like `alerts` — the user
// started the job and walked away, so the finish is the thing they are waiting on.
interface Notifications { sound: boolean; desktop: boolean; alerts: boolean; alertExplain: boolean; jobs: boolean }

/**
 * Workspace formats — locale, number style, currency, date style, compact
 * numbers (src/app/format.ts renders every figure under them) and the calendar
 * every relative period is resolved under (src/analysis/dateIntel.ts).
 */
export type Formats = FormatPrefs;

// Per-connection secret (pg password, URL auth token). Stored EXACTLY like an API
// key: plaintext in userData/config.json (gitignored), keyed by the connection's
// generated UUID. NEVER written into a project's connections/*.json, NEVER copied
// into publicConfig()/publicByok(), NEVER returned to a renderer — main reads it
// back only via getConnectionSecret to run a connection.
export interface ConnectionSecret { password?: string | null; token?: string | null }

/** Settings → Automation. `http` only matters while `enabled`; the port is loopback-only. */
export interface AutomationPrefs { enabled: boolean; http: boolean; port: number }
export const AUTOMATION_PORT = 7719;

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
  formats: Formats;
  /** Accent colour, logo and the default dashboard style — src/app/branding.ts. */
  branding: Branding;
  /** Where and how often every project is backed up — src/app/backups.ts. */
  backups: BackupSettings;
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
  /** WHAT the seed created, so the project switcher can badge the project it
   *  landed in and first-run guidance can tell the user's own work from it.
   *  Null on an install seeded before this existed. Main-only. */
  sample: SampleIds | null;
  /** First-run guidance (onboarding.ts). Null on an install seeded before it
   *  existed, which is what keeps the card and the tour off those. Main-only. */
  onboarding: OnboardingState | null;
  // Home "Starred" pins — a flat list of "type:id" keys (e.g. "analysis:<uuid>").
  // ONE array for all four record types, so a record never carries a starred flag
  // and there are no per-type migrations.
  starred: string[];
  /** Settings → Automation (src/ipc/automation.ts). The HTTP token is never stored. */
  automation: AutomationPrefs;
  /** Settings → General: the name on your comments. '' → the OS user name
   *  (src/app/comments.ts resolves it in main; a renderer never sends one). */
  displayName: string;
  /** Settings → General → Language: a code from src/app/i18n.ts, 'en' by default. */
  language: string;
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
  // `alerts`/`alertExplain` are the alert rules' own switches — see the
  // Notifications interface above for why one of them defaults the other way.
  notifications: { sound: false, desktop: false, alerts: true, alertExplain: false, jobs: true },
  // The system locale, dollars, Monday weeks and calendar-year quarters until
  // the user says otherwise.
  formats: { ...FORMAT_DEFAULTS },
  branding: { ...BRANDING_DEFAULTS },
  backups: { ...BACKUP_DEFAULTS },
  autoRefresh: true,
  // AI Copilot panel is ON by default — it stays fully optional (execution-gated),
  // but the user can also switch it OFF entirely from the panel's toggle.
  copilotEnabled: true,
  // Absent means not-yet-seeded, so an existing config.json seeds once on upgrade.
  sampleSeeded: false,
  sample: null,
  onboarding: null,
  // Home "Starred" pins, as "type:id" keys. One flat array, one setter — no
  // per-record flag, no migration.
  starred: [],
  // Automation (MCP) is OFF until the user turns it on; the loopback HTTP
  // transport is a second, separate opt-in.
  automation: { enabled: false, http: false, port: AUTOMATION_PORT },
  displayName: '',
  language: 'en',
  // Connection secrets (pg passwords / URL tokens), keyed by connection UUID.
  // Plaintext on disk like API keys; stripped from every renderer-facing view.
  connectionSecrets: {},
};

export const MEMORY_MODES: string[] = ['same_as_chat', 'override'];

// The cache is keyed by the file it came from: on the server configPath() is
// per org, and one org must never be handed another's config (it holds keys).
// ponytail: setCalendar/setFormatPrefs/setLanguage below are process-wide, so
// two orgs' format settings still race on the server; per-org config moves to
// Postgres in P5.
let cache: Config | null = null;
let cacheFile = '';

function configPath(): string {
  return path.join(appPaths.userData(), 'config.json');
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

const SAMPLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ponytail: raw disk JSON — every field is checked before it is kept
function cleanSample(raw: any): SampleIds | null {
  const id = (v: unknown): string => (typeof v === 'string' && SAMPLE_UUID.test(v) ? v : '');
  const s: SampleIds = {
    projectId: id(raw.projectId), datasetId: id(raw.datasetId), analysisId: id(raw.analysisId),
    visualIds: Array.isArray(raw.visualIds) ? raw.visualIds.map(id).filter(Boolean).slice(0, 50) : [],
  };
  return s.projectId && s.datasetId ? s : null;
}

// ponytail: raw disk/IPC JSON — every field is checked before it is kept
function cleanAutomation(raw: any): AutomationPrefs {
  const port = Number(raw.port);
  return {
    enabled: raw.enabled === true,
    http: raw.http === true,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : AUTOMATION_PORT,
  };
}

const ONBOARDING_STEPS = ['import', 'visual', 'dashboard', 'assistant'];
// ponytail: raw disk JSON — every field is checked before it is kept
function cleanOnboarding(raw: any): OnboardingState | null {
  if (typeof raw.startedAt !== 'string') return null;
  const done: OnboardingState['done'] = {};
  const d = raw.done && typeof raw.done === 'object' ? raw.done : {};
  for (const k of ONBOARDING_STEPS) if (typeof d[k] === 'string') done[k as keyof OnboardingState['done']] = d[k];
  return {
    startedAt: raw.startedAt, done,
    collapsed: raw.collapsed === true, dismissed: raw.dismissed === true, coachSeen: raw.coachSeen === true,
  };
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
      // Absent means ON, so a config written before alerts existed does not
      // arrive with the feature already switched off.
      alerts: input.notifications.alerts === undefined ? true : Boolean(input.notifications.alerts),
      alertExplain: Boolean(input.notifications.alertExplain),
      jobs: input.notifications.jobs === undefined ? true : Boolean(input.notifications.jobs),
    };
  }
  if (input.formats && typeof input.formats === 'object') out.formats = sanitizeFormatPrefs(input.formats);
  if (input.branding && typeof input.branding === 'object') out.branding = sanitizeBranding(input.branding);
  if (input.backups && typeof input.backups === 'object') out.backups = sanitizeBackups(input.backups);
  if (typeof input.copilotEnabled === 'boolean') out.copilotEnabled = input.copilotEnabled;
  if (typeof input.sampleSeeded === 'boolean') out.sampleSeeded = input.sampleSeeded;
  if (input.sample === null) out.sample = null;
  else if (input.sample && typeof input.sample === 'object') out.sample = cleanSample(input.sample);
  if (input.onboarding === null) out.onboarding = null;
  else if (input.onboarding && typeof input.onboarding === 'object') out.onboarding = cleanOnboarding(input.onboarding);
  // Whitelisted so it survives disk load ({...DEFAULTS, ...sanitize(onDisk)}).
  if (Array.isArray(input.starred)) out.starred = cleanStarred(input.starred);
  if (input.automation && typeof input.automation === 'object') out.automation = cleanAutomation(input.automation);
  if (typeof input.displayName === 'string') out.displayName = input.displayName.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (isLanguage(input.language)) out.language = input.language;
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
  cacheFile = configPath();
  // Every write passes here, reset-to-defaults included, so the calendar the
  // date evaluators read and the formats every figure is written in can never
  // lag the ones on disk.
  setCalendar(cfg.formats);
  setFormatPrefs(cfg.formats);
  setLanguage(cfg.language);
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
  cacheFile = p;
  setCalendar(cache.formats);
  setFormatPrefs(cache.formats);
  setLanguage(cache.language);
  return cache;
}

export function get(): Config {
  return cache && cacheFile === configPath() ? cache : load();
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
  const cur = cfg.notifications || { sound: false, desktop: false, alerts: true, alertExplain: false, jobs: true };
  const next = { ...cur };
  if (fields && 'sound' in fields)   next.sound = Boolean(fields.sound);
  if (fields && 'desktop' in fields) next.desktop = Boolean(fields.desktop);
  if (fields && 'alerts' in fields)  next.alerts = Boolean(fields.alerts);
  if (fields && 'alertExplain' in fields) next.alertExplain = Boolean(fields.alertExplain);
  if (fields && 'jobs' in fields) next.jobs = Boolean(fields.jobs);
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
    modelCache: {}, notifications: { sound: false, desktop: false, alerts: true, alertExplain: false, jobs: true },
    connectionSecrets: {} };
  persist(fresh);
  return { ok: true };
}
