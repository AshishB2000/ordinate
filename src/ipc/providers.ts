import { ipcMain, app, dialog, BrowserWindow, MessageBoxOptions } from 'electron';
import * as config from '../config';
import { testProvider } from '../analyze';
import * as history from '../history';

// PRESERVED VERBATIM from the JS original: these four identifiers are NOT in
// scope in this module (they are module-level state in main.js and are not
// passed via deps here). The ambient declarations emit nothing, so the compiled
// output keeps the identical bare references inside wipeHistory (a latent
// ReferenceError if data:delete runs with scope history/everything).
declare let historySummaries: any[];
declare const entryData: Map<string, any>;
declare const entryThreads: Map<string, any>;
declare const entryDataUrls: Map<string, string>;

// Key / provider management IPC — Ollama endpoint, key validate/save/clear,
// provider + execution-mode activation, BYOK provider config/test/reveal, global
// rules, notifications, and the 'delete my data' flow. Extracted from main.js as a
// pure structural move; notifyKeyChanged + the (reassigned) hubWindow ref arrive
// via deps. No logic changes.
export function register({ getHubWindow, notifyKeyChanged }: {
  getHubWindow: () => BrowserWindow | null | undefined;
  notifyKeyChanged: () => void;
}) {
  // Save local Ollama endpoint (no API key needed).
  // ponytail: untrusted renderer payloads — any, validated field-by-field below.
  ipcMain.handle('local:save', (_e, { endpoint }: any) => {
    if (typeof endpoint !== 'string' || !endpoint.trim()) return { ok: false };
    config.setOllamaEndpoint(endpoint.trim());
    notifyKeyChanged();
    return { ok: true };
  });

  // Validate API key/endpoint and fetch available models in one request.
  // Returns { ok: boolean, models: [{id, label}], error?: string }.
  // Never echoes the key back.
  ipcMain.handle('key:validate', async (_e, { provider, key, endpoint }: any) => {
    if (typeof provider !== 'string') return { ok: false, models: [], error: 'Bad provider' };

    const { net } = require('electron');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);

    try {
      let res: any, models: any[] = [];

      switch (provider) {
        case 'anthropic': {
          res = await net.fetch('https://api.anthropic.com/v1/models', {
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            signal: ctrl.signal,
          });
          if (res.ok) {
            const json = await res.json();
            models = (json.data || [])
              .filter((m: any) => /claude-(opus|sonnet|haiku)/.test(m.id))
              .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))
              .map((m: any) => ({ id: m.id, label: m.display_name || m.id }));
          }
          break;
        }
        case 'openai': {
          res = await net.fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': 'Bearer ' + key },
            signal: ctrl.signal,
          });
          if (res.ok) {
            const json = await res.json();
            // Only vision-capable models are useful for Screenchart
            models = (json.data || [])
              .filter((m: any) => /^(gpt-4o|gpt-4-turbo|gpt-4-vision|o1|o3)/.test(m.id))
              .sort((a: any, b: any) => b.id.localeCompare(a.id))
              .map((m: any) => ({ id: m.id, label: m.id }));
          }
          break;
        }
        case 'gemini': {
          res = await net.fetch(
            'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key),
            { signal: ctrl.signal }
          );
          if (res.ok) {
            const json = await res.json();
            models = (json.models || [])
              .filter((m: any) => /gemini/.test(m.name) &&
                (m.supportedGenerationMethods || []).includes('generateContent'))
              .map((m: any) => ({ id: m.name.replace('models/', ''), label: m.displayName || m.name }));
          }
          break;
        }
        case 'openrouter': {
          res = await net.fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': 'Bearer ' + key },
            signal: ctrl.signal,
          });
          if (res.ok) {
            const json = await res.json();
            models = (json.data || []).map((m: any) => ({ id: m.id, label: m.name || m.id }));
          }
          break;
        }
        case 'ollama': {
          const base = (endpoint || 'http://localhost:11434').replace(/\/$/, '');
          res = await net.fetch(base + '/api/tags', { signal: ctrl.signal });
          if (res.ok) {
            const json = await res.json();
            models = (json.models || []).map((m: any) => ({ id: m.name, label: m.name }));
          }
          break;
        }
        case 'custom':
          clearTimeout(timer);
          return { ok: true, models: [] };
        default:
          throw new Error('Unknown provider');
      }

      clearTimeout(timer);
      const badKey = res.status === 401 || res.status === 403;
      const ok = !badKey;
      return { ok, models: ok ? models : [], error: ok ? undefined : 'Invalid key — check and try again' };

    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError') return { ok: false, models: [], error: 'Timeout' };
      return { ok: false, models: [], error: 'Network error' };
    }
  });

  // Fetch available models using the stored key — key stays in main, only model list returns.
  ipcMain.handle('key:models', async (_e, { provider }: any = {}) => {
    const prov = (typeof provider === 'string' && config.PROVIDERS.includes(provider))
      ? provider : config.get().activeProvider;

    const { net } = require('electron');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);

    try {
      const key = await config.getApiKey(prov);
      const ollamaEndpoint = (config.get().providers?.ollama?.endpoint || 'http://localhost:11434').replace(/\/$/, '');
      let res: any, models: any[] = [];

      switch (prov) {
        case 'anthropic': {
          if (!key) { clearTimeout(timer); return { ok: false, models: [] }; }
          res = await net.fetch('https://api.anthropic.com/v1/models', {
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            signal: ctrl.signal,
          });
          if (res.ok) {
            const json = await res.json();
            // Exclude pre-claude-3 models (no vision) and sort newest first.
            models = (json.data || [])
              .filter((m: any) => /claude-(opus|sonnet|haiku)/.test(m.id))
              .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))
              .map((m: any) => ({ id: m.id, label: m.display_name || m.id }));
          }
          break;
        }
        case 'openai': {
          if (!key) { clearTimeout(timer); return { ok: false, models: [] }; }
          res = await net.fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': 'Bearer ' + key },
            signal: ctrl.signal,
          });
          if (res.ok) {
            const json = await res.json();
            models = (json.data || [])
              .filter((m: any) => /^(gpt-4o|gpt-4-turbo|gpt-4-vision|o1|o3)/.test(m.id))
              .sort((a: any, b: any) => b.id.localeCompare(a.id))
              .map((m: any) => ({ id: m.id, label: m.id }));
          }
          break;
        }
        case 'gemini': {
          if (!key) { clearTimeout(timer); return { ok: false, models: [] }; }
          res = await net.fetch(
            'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key),
            { signal: ctrl.signal }
          );
          if (res.ok) {
            const json = await res.json();
            models = (json.models || [])
              .filter((m: any) => /gemini/.test(m.name) &&
                (m.supportedGenerationMethods || []).includes('generateContent'))
              .map((m: any) => ({ id: m.name.replace('models/', ''), label: m.displayName || m.name }));
          }
          break;
        }
        case 'openrouter': {
          if (!key) { clearTimeout(timer); return { ok: false, models: [] }; }
          res = await net.fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': 'Bearer ' + key },
            signal: ctrl.signal,
          });
          if (res.ok) {
            const json = await res.json();
            models = (json.data || []).map((m: any) => ({ id: m.id, label: m.name || m.id }));
          }
          break;
        }
        case 'ollama': {
          res = await net.fetch(ollamaEndpoint + '/api/tags', { signal: ctrl.signal });
          if (res.ok) {
            const json = await res.json();
            models = (json.models || []).map((m: any) => ({ id: m.name, label: m.name }));
          }
          break;
        }
        default:
          clearTimeout(timer);
          return { ok: true, models: [] };
      }

      clearTimeout(timer);
      return { ok: Boolean(res && res.ok), models };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, models: [] };
    }
  });

  // Save the chosen model for a specific provider.
  ipcMain.handle('model:save', (_e, { model, provider }: any) => {
    if (typeof model === 'string' && model.trim()) {
      config.setModel(model.trim(), provider);
    }
    return { ok: true };
  });

  // Remove the stored key for a specific provider and notify the hub.
  ipcMain.handle('key:clear', (_e, { provider }: any = {}) => {
    config.clearProviderKey(provider);
    notifyKeyChanged();
    return { ok: true };
  });

  // Save the API key for a specific provider.
  ipcMain.handle('key:save', async (_e, { provider, key }: any) => {
    if (typeof provider !== 'string' || typeof key !== 'string') return { ok: false };
    const result = await config.setApiKey(key, provider);
    if (result.ok) notifyKeyChanged();
    return result;
  });

  // Switch the active provider (which one is used for captures).
  ipcMain.handle('provider:activate', (_e, { provider }: any) => {
    const result = config.setActiveProvider(provider);
    if (result.ok) notifyKeyChanged();
    return result;
  });

  // ── IPC: Execution mode / BYOK ────────────────────────────────────────────

  // Set execution mode ('local' | 'byok').
  ipcMain.handle('exec:setMode', (_e, { mode }: any) => {
    const result = config.setExecutionMode(mode);
    if (result.ok) notifyKeyChanged();
    return result;
  });

  // Persist the memory-model choice (setting-only — no memory step consumes it yet).
  ipcMain.handle('memory:setModel', (_e, { fields }: any) => {
    const result = config.setMemoryModel(fields);
    if (result.ok) notifyKeyChanged();
    return result;
  });

  // Save editable fields for a byok provider (apiKey/baseUrl/maxTokens/model).
  ipcMain.handle('byok:saveProvider', (_e, { provider, fields }: any) => {
    if (typeof provider !== 'string' || !fields || typeof fields !== 'object') return { ok: false };
    const result = config.setByokProvider(provider, fields);
    if (result.ok) notifyKeyChanged();
    return result;
  });

  // Switch which byok provider is active for captures. Activating a BYOK provider
  // is an explicit "use this AI" choice, so move execution to BYOK mode too —
  // otherwise executionMode stays 'local' and the readiness gate ignores BYOK
  // (New capture would keep doing nothing despite a connected provider).
  ipcMain.handle('byok:activate', (_e, { provider }: any) => {
    const result = config.setByokActiveProvider(provider);
    if (result.ok) {
      config.setExecutionMode('byok');
      notifyKeyChanged();
    }
    return result;
  });

  // Minimal real connectivity test against a provider's saved credentials.
  // The test result is the SOURCE OF TRUTH for "Connected": persist verified so
  // the popup/settings reflect it, and a passing test makes the provider eligible
  // to be Active.
  ipcMain.handle('byok:test', async (_e, { provider }: any) => {
    try {
      const r = await testProvider(provider);
      if (typeof provider === 'string') {
        config.setByokVerified(provider, Boolean(r && r.ok));
        // A passing test means "AI connected". If local execution isn't usable,
        // adopt BYOK as the active mode so capture actually works without the
        // user also having to flip the Local/BYOK toggle by hand.
        if (r && r.ok) config.adoptByokModeIfLocalUnready(provider);
      }
      notifyKeyChanged();
      return r;
    } catch (err: any) {
      if (typeof provider === 'string') config.setByokVerified(provider, false);
      notifyKeyChanged();
      console.error('[byok:test] error', err && err.message);
      return { ok: false, errorType: 'unknown', message: 'Test failed. Try again.' };
    }
  });

  // Persist the user's global rules (Instructions / Rules). Pure instruction text,
  // stored as-is; analyze.js appends it to the system prompt (never to a command).
  ipcMain.handle('rules:set', (_e, { text }: any = {}) => {
    return config.setGlobalRules(typeof text === 'string' ? text : '');
  });

  // Persist completion-notification toggles ({ sound?, desktop? }).
  ipcMain.handle('notifications:set', (_e, { fields }: any = {}) => {
    return config.setNotifications(fields || {});
  });

  // Delete-my-data — destructive, irreversible, LOCAL ONLY. Runs ONLY on an
  // explicit user click and ONLY after the user accepts the confirm dialog below.
  // scope: 'history' | 'credentials' | 'settings' | 'everything'. Returns the exact
  // list of removed paths/keys so the UI/report can show what was destroyed.
  ipcMain.handle('data:delete', async (_e, { scope }: any = {}) => {
    const hubWindow = getHubWindow();
    const SCOPES = ['history', 'credentials', 'settings', 'everything'];
    if (!SCOPES.includes(scope)) return { ok: false };

    const DETAIL = ({
      history:     'Deletes ALL saved captures, threads and thumbnails from this device.',
      credentials: 'Deletes ALL saved API keys / provider credentials from this device.',
      settings:    'Resets ALL settings to defaults. This also clears saved API keys.',
      everything:  'Deletes EVERYTHING: capture history, saved API keys, and all settings (reset to defaults).',
    } as Record<string, string>)[scope];

    const parent = hubWindow && !hubWindow.isDestroyed() ? hubWindow : null;
    const opts: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete my data',
      message: 'Delete this data? This cannot be undone.',
      detail: DETAIL + '\n\nThis only removes local data on this device — it does NOT touch anything on the provider’s servers.',
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts);
    if (response !== 1) return { ok: false, cancelled: true };

    const fsp = require('fs').promises;
    const tmpDir = require('path').join(app.getPath('userData'), 'tmp');
    const removed: string[] = [];

    async function wipeHistory() {
      try { const dir = await history.clearAll(); removed.push(dir + ' (all threads: thread.json + crop.png)'); } catch (_) {}
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); removed.push(tmpDir + ' (temp capture images)'); } catch (_) {}
      entryData.clear(); entryThreads.clear(); entryDataUrls.clear();
      historySummaries = [];
      if (hubWindow && !hubWindow.isDestroyed()) hubWindow.webContents.send('hub:history', []);
    }

    if (scope === 'history' || scope === 'everything') await wipeHistory();
    if (scope === 'credentials') {
      config.clearAllCredentials();
      removed.push('config.json: byok.providers.*.apiKey + .verified, providers.*.apiKey, providers.ollama.endpoint (active providers reset)');
    }
    if (scope === 'settings' || scope === 'everything') {
      config.resetToDefaults();
      removed.push('config.json: reset to defaults (clears all keys, models, prefs, hotkey, theme, prompt, notifications)');
    }

    notifyKeyChanged(); // refresh popup/settings → providers show disconnected
    return { ok: true, scope, removed };
  });

  // Reveal a BYOK provider's saved key for the Settings "Show" toggle. The key is
  // sent to the renderer ONLY on this explicit, user-initiated request — never in
  // the broad status payload. BYOK keys are stored plaintext on disk by design.
  ipcMain.handle('byok:revealKey', (_e, { provider }: any = {}) => {
    if (typeof provider !== 'string') return '';
    const e = config.getByokProvider(provider);
    return (e && e.apiKey) || '';
  });
}
