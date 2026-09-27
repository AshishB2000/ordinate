import {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  systemPreferences,
  nativeTheme,
  BrowserWindow,
  NativeImage,
  Display,
} from 'electron';
import { headlessMode } from './automation/argv';

// Automation: `--cli <command>` / `--mcp` run this binary HEADLESS (no window,
// hotkey, seed or schedules — the guards below) and must NOT take the lock, or a
// CLI run while the GUI is open would silently quit. See src/automation/headless.ts.
const HEADLESS = headlessMode(process.argv);
if (HEADLESS) require('./automation/headless').start(HEADLESS);
// Single-instance lock. A second launch would otherwise hold its own processes
// and steal/contend the global hotkey, so bail out early and let the first
// instance take over (see the 'second-instance' handler below).
else if (!app.requestSingleInstanceLock()) {
  app.quit();
  // Top-level `return` is illegal in a TS module; process.exit preserves the
  // original early bail (nothing below runs in a second instance).
  process.exit(0);
}

// Tell Chromium not to use the OS keychain for its internal encryption key.
// Without this, macOS shows an authorization dialog on every launch for an
// unsigned dev build.
app.commandLine.appendSwitch('password-store', 'basic');

// macOS 14.4+/Sequoia: Electron defaults to the ScreenCaptureKit path for
// desktopCapturer, whose Screen Recording permission handling is broken
// (electron#38190) — getSources can come back denied/black even when the user
// has granted the permission. Force the older, reliable CGDisplayStream/
// CGWindowList capture path by disabling those features. Must be set before the
// app is ready. macOS-only.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'disable-features',
    'ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac'
  );
}

// Windows toast notifications need an explicit AppUserModelID set BEFORE any
// window is created, or they don't show (or show under a generic name). Use the
// app's bundle id for consistency. No-op on macOS/Linux. Signing is NOT required
// on Windows — only this. (macOS notifications still need code-signing — see
// bootstrapNotification below.)
app.setAppUserModelId('app.screenshot.desktop');

// Another launch happened while we're running — focus our existing window.
app.on('second-instance', () => focusHub());

import { captureFrozenFrame, cropToRect, getActiveDisplay } from './app/capture';
import * as config from './app/config';
import * as execConfig from './app/execConfig';
import * as localCli from './cli/localCli';
import * as localCliRun from './cli/localCliRun';
import { analyze, analyzeFollowup } from './ai/analyze';

console.log('[boot] Ordinate', app.getVersion(), '| packaged =', app.isPackaged);

import * as history from './app/history';
import * as projects from './app/projects';
import * as sampleProject from './app/sampleProject';
import * as datasets from './data/datasets';
import * as copilot from './ai/copilot';
import { captureProjectId, persistableResult, seedCaptureConversation, setActiveProject } from './app/captureRecord';
import { resolveUserPath } from './cli/userPath';
import { bootstrapNotification, maybeNotifyDone } from './app/notify';

/** Whether a hub window is on screen and focused — the one thing notify.ts needs to know. */
const hubFocused = (): boolean => hubs.all().some((w) => w.isFocused());

/** Bring the hub forward, opening it if it is gone. Three callers, one rule. */
const focusHub = (): void => {
  const w = hubs.primary();
  if (!w) { openHub(); return; }
  if (w.isMinimized()) w.restore();
  w.focus();
};

// Packaged macOS/Linux GUI launches inherit a stripped PATH (no Homebrew, nvm,
// ~/.local/bin…), which would make Local CLI detection (claude, agy) find nothing.
// Recover the user's real login-shell PATH BEFORE any detection runs. No-op on
// Windows and skipped in dev (`npm start` already has the full terminal PATH),
// and headless, which runs no local CLI and must not spawn a login shell per call.
if (app.isPackaged && !HEADLESS) {
  const recovered = resolveUserPath();
  console.log('[userPath] recovered PATH —', recovered.split(':').length, 'dirs');
}

import { createOverlayWindow } from './windows/overlayWindow';
import { createHubWindow } from './windows/hubWindow';
// Every hub window main has open. Pushes go to the PRIMARY (once-only work) or
// to all of them (state each window paints) — see the module header.
import * as hubs from './windows/hubRegistry';

import { platformDefaultHotkey, hotkeyLabel } from './app/hotkey';

let overlayWindow: BrowserWindow | null = null;

// Whether the global shortcut registered successfully on startup.
let hotkeyRegistered = true;

// State for the in-flight capture (single primary display scope).
let frozenFrame: NativeImage | null = null;
let captureDisplay: Display | null = null;
let capturing = false;

// Per-entry dataUrl storage so hub can retry without re-capturing.
const entryDataUrls = new Map<number, string>();
// Per-entry Anthropic messages thread (image + all turns). Never sent to renderer.
// ponytail: provider message arrays — model-shaped JSON, typed as any[].
const entryThreads = new Map<number, any[]>();
// Per-entry persistent data: { id, title, createdAt, updatedAt, cropPath, result, turns }
// ponytail: thread envelopes hold the untyped analysis result — any.
const entryData = new Map<number, any>();
// History summaries loaded at startup — main's own cache, used to resolve a
// capture's crop path. The hub reads its Captures tab from disk (history:list).
// ponytail: summary rows come straight from disk JSON.
let historySummaries: any[] = [];


function endCapture(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
  frozenFrame = null;
  captureDisplay = null;
  capturing = false;
}

async function startCapture(): Promise<void> {
  console.log('[capture] startCapture() called | capturing =', capturing,
    '| packaged =', app.isPackaged);
  if (capturing) return;
  capturing = true;

  if (process.platform === 'darwin') {
    // IMPORTANT: getMediaAccessStatus('screen') is ADVISORY ONLY — we never bail
    // on it. It is documented-unreliable: it caches a STALE 'denied' even after
    // the user grants Screen Recording in System Settings (electron#36722), while
    // desktopCapturer.getSources() actually works. It also never prompts. So we
    // log it for diagnostics, then ATTEMPT the capture regardless and treat the
    // real captured frame as the source of truth — an empty frame (below) is the
    // genuine "no access" signal, and on a fresh ('not-determined') state the
    // getSources() call is what triggers the macOS permission prompt.
    const access = systemPreferences.getMediaAccessStatus('screen');
    console.log('[capture] getMediaAccessStatus(screen) =', access, '(advisory — attempting capture regardless)');
  }

  try {
    // Target the display under the cursor, NOT the primary display — on
    // multi-monitor setups the user may be working on an external monitor whose
    // bounds origin is offset/negative relative to the primary. Capturing and
    // overlaying that display is what makes "New capture" appear where the user
    // is actually looking.
    captureDisplay = getActiveDisplay();
    console.log('[capture] target display', captureDisplay.id,
      '| bounds', JSON.stringify(captureDisplay.bounds),
      '| scaleFactor', captureDisplay.scaleFactor);
    frozenFrame = await captureFrozenFrame(captureDisplay);
    console.log('[capture] frozen frame captured', frozenFrame.getSize());

    // The captured frame is the REAL source of truth (we don't trust the status).
    // An empty frame means Screen Recording genuinely isn't active for this app —
    // open the permission panel (which guides removing a stale entry so macOS can
    // re-grant). A non-empty frame means it works, whatever the status claimed.
    if (frozenFrame.isEmpty()) {
      console.warn('[capture] frozen frame is EMPTY — Screen Recording not active for this app. Opening permission panel.');
      capturing = false;
      openPermission();
      return;
    }

    overlayWindow = createOverlayWindow(captureDisplay);
    // Confirm the window actually landed on the target display's bounds (these
    // should match captureDisplay.bounds above — if they don't, the OS clamped it).
    console.log('[capture] overlay window created — actual bounds',
      JSON.stringify(overlayWindow.getBounds()));
    overlayWindow.on('closed', () => {
      overlayWindow = null;
    });
    overlayWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[capture] overlay did-fail-load', code, desc, url);
      // A native dialog, not a window: this is a rare terminal error and the hub
      // may not be open. The Status window that used to carry this message was a
      // 400x320 BrowserWindow reachable from nowhere else — see CLAUDE.md.
      dialog.showErrorBox('Capture failed', 'The capture overlay failed to load.\n\n' + desc);
      endCapture();
    });
    overlayWindow.webContents.once('did-finish-load', () => {
      console.log('[capture] overlay did-finish-load — sending frame');
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      // Re-assert bounds + focus: makes sure the overlay sits exactly on the
      // target display and is the active window so the drag-to-select starts
      // immediately (alwaysOnTop alone doesn't always grab focus on macOS).
      overlayWindow.setBounds(captureDisplay!.bounds);
      overlayWindow.show();
      overlayWindow.focus();
      overlayWindow.webContents.send('overlay:frame', {
        dataUrl: frozenFrame!.toDataURL(),
        width: captureDisplay!.size.width,
        height: captureDisplay!.size.height,
      });
    });
  } catch (err: any) {
    // Extract a real reason from ANY thrown value (some rejections carry no
    // .message, which is why this used to print "Capture failed: undefined").
    const reason = (err && (err.message || err.toString())) || String(err) || 'unknown error';
    console.error('[capture] startCapture failed:', reason, '\n', err && err.stack || err);
    endCapture();
    // The overwhelmingly common cause here is Screen Recording not being active
    // for the app — getSources fails/times out, most often on the FIRST capture
    // while macOS is still showing its OWN permission dialog. Do NOT surface a
    // Ordinate "Capture failed" card here: it duplicates the native OS prompt
    // and reads as a broken app. Log it (above) and route to the permission
    // panel guidance instead — same as the empty-frame path.
    // TODO: post-permission onboarding — route to existing setup window with a
    // "grant Screen Recording, then relaunch" hint.
    openPermission();
  }
}

/**
 * Run `fn` on the PRIMARY hub window — opening one first, and waiting for it to
 * load, when none is open. Every "bring the hub up and tell it X" in this file
 * is this one shape; it was four hand-written copies of it.
 */
function withHub(fn: (w: BrowserWindow) => void): void {
  const w = hubs.primary();
  if (w) { fn(w); return; }
  const fresh = hubs.add(createHubWindow());
  fresh.webContents.once('did-finish-load', () => { if (!fresh.isDestroyed()) fn(fresh); });
}

// Open the hub and show the Execution mode settings (the modern setup surface —
// Local CLI + BYOK live here). Replaces the old standalone/onboarding setup.
function openExecutionSettings(): void {
  withHub((w) => { w.focus(); w.webContents.send('hub:open-settings', 'exec'); });
}

// Push the current hotkey registration state to the hub (both success and
// failure) so the banner shows on failure and clears on success.
function notifyHotkeyState(): void {
  if (!hubs.primary()) return;
  console.log('[hotkey] notifyHotkeyState read hotkeyRegistered =', hotkeyRegistered);
  hubs.send('hub:hotkey-state', {
    registered: hotkeyRegistered,
    label: hotkeyLabel(config.get().hotkey),
  });
}

// Open (or focus) the hub window.
function openHub(): void {
  withHub((w) => { w.focus(); notifyHotkeyState(); });
}

// Notify every hub window that key status changed.
function notifyKeyChanged(): void {
  hubs.broadcast('key:changed');
}

ipcMain.handle('notifications:bootstrap', () => bootstrapNotification());

// Show the permission panel inside the hub (single-window experience).
function openPermission(): void {
  withHub((w) => { w.focus(); w.webContents.send('hub:show-permission'); });
}

// Detect Local CLIs ONCE at startup using the recovered PATH, so the capture
// readiness gate (execConfig.executionReady) is correct from the very FIRST hotkey
// press — without the user having to open Settings first. This is the missing
// link that made New capture "do nothing" from a Finder launch: detection only
// ran on settings-open, so the gate read a stale/empty cache and silently routed
// capture to settings. Bounded by readVersion's hard guard (never hangs); runs in
// the background so it never delays the hub.
async function refreshLocalCliDetectionAtStartup(): Promise<void> {
  try {
    const results = await localCli.detectAll();
    execConfig.saveLocalCliDetection(results);
    const installed = results.filter((r: any) => r && r.status === 'installed').map((r: any) => r.id);
    console.log('[localCli] startup detection complete — installed:', installed.join(', ') || 'none');
    notifyKeyChanged(); // refresh the hub's readiness badge if it's already open
  } catch (err: any) {
    console.error('[localCli] startup detection failed:', err && err.message);
  }
}

// ── IPC: capture overlay ──────────────────────────────────────────────────

ipcMain.on('capture:commit', (_e, rect) => {
  if (!frozenFrame || !captureDisplay) {
    endCapture();
    return;
  }
  const cropped = cropToRect(frozenFrame, rect, captureDisplay);
  endCapture();
  if (!cropped) return;
  ingestCapture(cropped.toDataURL());
});

/**
 * Everything that happens to a captured IMAGE: store it, analyze it, write the
 * record, and tell the hub.
 *
 * Exported and taking a plain data URL so the ONE thing a test cannot do —
 * grab pixels off a real screen — is the only thing it has to replace.
 * scripts/smoke-capture.ts swaps the `hub:capture` listener for one that calls
 * this with a fixture PNG; every line below it is then the shipped path.
 */
export function ingestCapture(dataUrl: string): void {
  const entryId = Date.now();
  const createdAt = new Date().toISOString();
  entryDataUrls.set(entryId, dataUrl);
  // Resolved once, here, and carried onto the thread: which project this capture
  // belongs to. Async, so it is awaited where the thread is written.
  const projectIdPromise = captureProjectId();

  // Save crop image to disk immediately so it's available even if analysis
  // fails. AWAITED where the thread is written, not merely fired: the record
  // stores the crop PATH, and analysis finishing first would write a thread
  // with `cropPath: null` — a capture with no image in the Captures grid and
  // no "view original" on the dataset it produces. A real model call takes
  // seconds and hid this; a fast one does not.
  const cropPromise = history.saveCrop(entryId, dataUrl)
    .then((cropPath: string) => {
      const stub = entryData.get(entryId) || {};
      stub.cropPath = cropPath;
      entryData.set(entryId, stub);
      return cropPath;
    })
    .catch((err: any) => {
      console.error('[history] saveCrop failed:', err.message);
      return null;
    });

  function sendToHub(hub: BrowserWindow) {
    hub.focus();
    hub.webContents.send('hub:new-entry', { entryId, dataUrl });
    analyze(dataUrl).then(async (result: any) => {
      if (!hubs.primary()) return;
      if (result.ok && result._messages) {
        entryThreads.set(entryId, result._messages);
        const cropPath = await cropPromise;
        const projectId = await projectIdPromise;
        // The narration is the first assistant turn of a dock conversation, not a
        // thread of its own: a capture's follow-ups are ordinary dock asks, and a
        // second conversation surface for one source of data is the thing this
        // change exists to delete. Seeded in MAIN because main is what holds the
        // analysis text — the renderer never re-posts it.
        const copilotThreadId = await seedCaptureConversation(projectId, result);
        const thread = {
          id: entryId,
          projectId,
          title: result.title || 'Analysis',
          createdAt,
          updatedAt: new Date().toISOString(),
          cropPath,
          copilotThreadId,
          datasetId: null,
          messages: result._messages,
          result: persistableResult(result),
          turns: [],
        };
        entryData.set(entryId, thread);
        history.saveThread(thread).catch((e: any) => console.error('[history] saveThread failed:', e.message));
        // main's own crop-path cache; the hub reads Captures from disk.
        historySummaries = [{ id: entryId, projectId, title: thread.title, updatedAt: thread.updatedAt, cropPath: thread.cropPath }, ...historySummaries.filter(s => s.id !== entryId)];
        delete result._messages;
        result.copilotThreadId = copilotThreadId;
      }
      if (!hubs.primary()) return;
      hubs.send('hub:entry-result', { entryId, ...result });
      if (result.ok) maybeNotifyDone(result.title, hubFocused);
    }).catch(() => {
      hubs.send('hub:entry-result', {
        entryId, ok: false, errorType: 'unknown', message: 'Something went wrong. Try again.',
      });
    });
  }

  withHub(sendToHub);
}

ipcMain.on('capture:cancel', () => {
  endCapture();
});

// ── IPC: hub ──────────────────────────────────────────────────────────────

ipcMain.on('hub:open', openHub);

// Take-screenshot / new-capture: gate on execution readiness (Local CLI OR BYOK),
// not just an API key. When not ready, open the Execution mode settings.
ipcMain.on('hub:capture', () => {
  const ready = execConfig.executionReady();
  console.log('[capture] hub:capture (New capture button) | executionReady =', ready);
  if (!ready) {
    openExecutionSettings();
    return;
  }
  void startCapture();
});

// ── IPC: key management ───────────────────────────────────────────────────

// Returns { isReady, hasApiKey, provider, theme, ... } — no raw key.
ipcMain.handle('key:status', () => execConfig.publicConfig());

// NOTE: these IPC registrations stay as positional require(...).register(...)
// calls (not hoisted imports) so module load order matches the original main.js.
require("./ipc/geo").register();

require("./ipc/theme").register();
// Workspace formats and branding (Settings → General / Appearance).
require("./ipc/prefs").register();

require("./ipc/providers").register({
  getHubWindow: hubs.primary, notifyKeyChanged,
  entryData, entryThreads, entryDataUrls,
  clearHistorySummaries: () => { historySummaries = []; },
});

require("./ipc/cli").register({ notifyKeyChanged });

// ── IPC: hotkey ───────────────────────────────────────────────────────────

// Return the display label for the configured hotkey — renderers must not compute it.
ipcMain.handle('hotkey:label', () => ({
  label: hotkeyLabel(config.get().hotkey),
  accelerator: config.get().hotkey,
}));

// Save a new hotkey: unregister old, register new, persist if successful.
ipcMain.handle('hotkey:save', (_e, { accelerator }) => {
  if (typeof accelerator !== 'string' || !accelerator.trim()) {
    return { ok: false, error: 'Empty accelerator' };
  }
  const newHotkey = accelerator.trim();
  const oldHotkey = config.get().hotkey;

  globalShortcut.unregister(oldHotkey);

  const handler = () => {
    if (!execConfig.executionReady()) { openExecutionSettings(); return; }
    void startCapture();
  };

  const registered = globalShortcut.register(newHotkey, handler);
  if (registered) {
    config.save({ hotkey: newHotkey });
    hotkeyRegistered = true;
    return { ok: true, label: hotkeyLabel(newHotkey), accelerator: newHotkey };
  }

  // New hotkey failed — restore the old one.
  hotkeyRegistered = globalShortcut.register(oldHotkey, handler);
  return { ok: false, error: 'Could not register — it may be in use by another app' };
});

require("./ipc/shell").register();

// ── IPC: hub capture actions ──────────────────────────────────────────────

// Re-analyze the same crop for a specific entry without re-capturing.
ipcMain.on('hub:retry', (_e, { entryId }) => {
  const dataUrl = entryDataUrls.get(entryId);
  if (!dataUrl || !hubs.primary()) return;
  entryThreads.delete(entryId);
  const existingData = entryData.get(entryId);
  analyze(dataUrl).then((result: any) => {
    if (!hubs.primary()) return;
    if (result.ok && result._messages) {
      entryThreads.set(entryId, result._messages);
      const thread = {
        id: entryId,
        title: result.title || 'Analysis',
        createdAt: existingData ? existingData.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cropPath: existingData ? existingData.cropPath : null,
        messages: result._messages,
        result: persistableResult(result),
        turns: [],
      };
      entryData.set(entryId, thread);
      history.saveThread(thread).catch((e: any) => console.error('[history] saveThread (retry) failed:', e.message));
      historySummaries = [{ id: entryId, title: thread.title, updatedAt: thread.updatedAt, cropPath: thread.cropPath }, ...historySummaries.filter(s => s.id !== entryId)];
      delete result._messages;
    }
    hubs.send('hub:entry-result', { entryId, ...result });
    if (result.ok) maybeNotifyDone(result.title, hubFocused); // parity with initial capture + follow-up
  }).catch(() => {
    hubs.send('hub:entry-result', {
      entryId, ok: false, errorType: 'unknown', message: 'Something went wrong. Try again.',
    });
  });
});

// Follow-up question on an existing thread.
ipcMain.on('hub:followup', (_e, { entryId, text }) => {
  const messages = entryThreads.get(entryId);
  if (!messages || !hubs.primary()) return;
  analyzeFollowup(messages, text).then((result: any) => {
    if (!hubs.primary()) return;
    if (result.ok && result._messages) {
      entryThreads.set(entryId, result._messages);
      const thread = entryData.get(entryId);
      if (thread) {
        thread.updatedAt = new Date().toISOString();
        thread.messages = result._messages;
        thread.turns = thread.turns || [];
        thread.turns.push({
          text,
          state: 'result',
          result: persistableResult(result),
        });
        history.saveThread(thread).catch((e: any) => console.error('[history] saveThread (followup) failed:', e.message));
        historySummaries = [{ id: entryId, title: thread.title, updatedAt: thread.updatedAt, cropPath: thread.cropPath }, ...historySummaries.filter(s => s.id !== entryId)];
      }
      delete result._messages;
    }
    hubs.send('hub:followup-result', { entryId, ...result });
    if (result.ok) maybeNotifyDone(result.title, hubFocused);
  }).catch(() => {
    hubs.send('hub:followup-result', {
      entryId, ok: false, errorType: 'unknown', message: 'Something went wrong. Try again.',
    });
  });
});

require("./ipc/historyIpc").register({
  entryData, entryThreads, entryDataUrls,
  removeSummary: (id: string) => { historySummaries = historySummaries.filter(s => s.id !== id); },
});

require("./ipc/clipboard").register();
require("./ipc/fileSave").register();
require("./ipc/capture").register();

require("./ipc/projects").register({ onActive: setActiveProject, getHubWindow: hubs.primary });

require("./ipc/recent").register();
// Stories — the scrolling document record, and the Assistant's story outline.
require("./ipc/stories").register();

require("./ipc/datasets").register();
// The composer's two handlers. Registered AFTER datasets, which hands it the
// commitSteps primitive during its own register().
require("./ipc/datasetCompose").register();
// The formula editor's check/catalog handlers. AFTER datasets, whose `pageFor`
// it reads the eight preview rows through.
require("./ipc/formula").register();
require("./ipc/search").register();
// The application menu, built from the renderer's command registry (src/ipc/menu.ts).
require("./ipc/menu").register();
// "Open in new window" — a second hub window on one record (src/ipc/windows.ts).
require("./ipc/windows").register();

// What the app found in the data. Pure disk + the resident query layer; no deps.
require("./ipc/insights").register();

// Unattended dataset refresh, and the alert/report hooks that ride its tick.
// Never in a headless run: the GUI owns schedules.
if (!HEADLESS) require("./app/refreshWiring").start({ hubFocused });

// Reports — the record's CRUD, caption, folder picker and scheduled write.
require("./ipc/reports").register();
require("./ipc/connections").register();
require("./ipc/sqlQuery").register(); // Data → Query: SQL over this project's own datasets
require("./ipc/visuals").register();
require("./ipc/dashboards").register();
require("./ipc/catalog").register();

require("./ipc/metrics").register(); // after dashboards: figures bottom out in computeCardMetric
require("./ipc/periods").register(); // relative periods: a preset's display, and a KPI card's Compare
require("./ipc/tableCalcKpi").register(); // a KPI card's "Calculate as", over its period series
// Alert rules and their inbox. After dashboards deliberately — see ipc/alerts.
require("./ipc/alerts").register({ focusHub });

// Analyses — the AUTHORING container a dashboard is published FROM. Also owns
// `analysis:draft`, which replaced the deleted `dashboard:draft`.
require("./ipc/analyses").register();
require("./ipc/versions").register(); // every save of a record, kept and restorable
require("./ipc/trash").register(); // deletes land here for 30 days
require("./ipc/lineage").register(); // what a record is built from, and what is built from it
require("./ipc/onboarding").register(); // the Get-started card and the sample dashboard's tour

// Dashboard TEMPLATES — the create wizard's gallery. Model-free; its plans go
// through `analysis:previewPlan` / `analysis:buildPlan` like every other plan.
require("./ipc/templates").register();
require("./ipc/quality").register(); // data-quality rules: list/save/delete/run/preview/failingRows
require("./ipc/dashboardExport").register();
require("./ipc/copilot").register();

// Phase 3c — the Mosaic connector (mosaic:view / mosaic:query). Registering is
// free: the DuckDB connection is hardened lazily on the FIRST Mosaic call, so a
// session that never opens a Mosaic chart pays nothing and the bridge stays lazy.
require("./ipc/mosaic").register();

// Phase 7 — pre-register the folders the local-file connectors have been pointed
// at, BEFORE anything can harden the connection.
//
// `allowed_directories` may only be set while `enable_external_access` is still
// on, and `lock_configuration` makes the whole thing irreversible for the
// process lifetime. So a folder that is not inside the lock when it closes
// cannot be read at all until the next launch. Without this, "query folder A,
// then add and query folder B" fails in the same session.
//
// Deliberately conditional: an empty registry means the user has never used one
// of these connectors, and hardening eagerly would start the DuckDB worker on
// every launch for a feature they do not use — the exact laziness the comment
// above is protecting.
try {
  const localDirs = require("./connectors/local").registeredDirs(app.getPath("userData"));
  if (Array.isArray(localDirs) && localDirs.length) {
    require("./ipc/mosaic")
      .hardenConnection([app.getPath("userData"), ...localDirs])
      .catch(() => { /* best-effort: a failure costs a restart, never correctness */ });
  }
} catch (_) { /* connector module absent or registry unreadable — stay lazy */ }
require("./ipc/authoringDepth").register(); // relationships, project assets, boundaries, places
// Headless: no timers, and no job notifications — a CLI run's jobs reach the GUI's
// popover through automation-log.jsonl instead.
require("./ipc/platform").register({ hubFocused: HEADLESS ? () => true : hubFocused, focusHub, headless: !!HEADLESS }); // jobs, publish, privacy, automation, backups
require("./ipc/preparePower").register(); // prepare power steps: editor previews + per-step row counts
require("./ipc/comments").register(); // comment threads, the display name they are signed with, the sync folder
require("./ipc/scorecards").register(); // scorecards: metrics against targets, one period at a time
require("./ipc/drivers").register(); // key drivers: why a figure changed between two periods
require("./ipc/scenarios").register(); // scenarios: what-if drivers over the metrics
require("./ipc/segments").register(); // Find segments: k-means and RFM, off the stored Parquet
require("./ipc/filterParse").register(); // typed filters: "west technology last quarter" → chips, no model
require("./ipc/build").register({ headless: !!HEADLESS }); // plans, formatting, themes, SaaS sources, snapshots
// Week 13 — capture → dataset bridge. resolveCropPath hands the on-disk crop path
// from main's per-entry state (entryData, then the summaries cache) so a renderer-
// sent path is never trusted; both maps already carry cropPath per entryId.
require("./ipc/captureDataset").register({
  resolveCropPath: (entryId: any) => {
    const data = entryData.get(entryId);
    if (data && typeof data.cropPath === 'string' && data.cropPath) return data.cropPath;
    const summary = historySummaries.find((s) => s && s.id === entryId);
    return summary && typeof summary.cropPath === 'string' && summary.cropPath ? summary.cropPath : null;
  },
});

// ── App lifecycle ─────────────────────────────────────────────────────────

void app.whenReady().then(async () => {
  if (HEADLESS) return; // headless.ts boots its own run: no hotkey, hub, seed or CLI probe
  config.load();

  // Recompute Local CLI availability with the recovered PATH before the user can
  // trigger capture (the readiness gate reads this). Background — bounded by the
  // readVersion guard, so it never blocks the hub or hangs.
  void refreshLocalCliDetectionAtStartup();

  // Apply the saved theme preference to nativeTheme so 'system' tracks the OS
  // and forced light/dark are honored before any window opens.
  // Cast: config's sanitize() constrains themePreference to system|light|dark,
  // but its schema type is plain string.
  nativeTheme.themeSource = (config.get().themePreference || 'system') as 'system' | 'dark' | 'light';

  // On first run (or migration from the old cross-platform default), store the
  // platform-specific default so the configured accelerator is always explicit.
  const storedHotkey = config.get().hotkey;
  const platformDefault = platformDefaultHotkey();
  if (!storedHotkey || storedHotkey === 'CommandOrControl+Shift+S') {
    if (storedHotkey !== platformDefault) config.save({ hotkey: platformDefault });
  }

  // Gate the global hotkey on execution readiness (Local CLI OR BYOK).
  const registerReturn = globalShortcut.register(config.get().hotkey, () => {
    const ready = execConfig.executionReady();
    console.log('[capture] hotkey fired | executionReady =', ready);
    if (!ready) {
      openExecutionSettings();
      return;
    }
    void startCapture();
  });

  // register() returns false if the accelerator is already registered, but the
  // shortcut is still active in that case — so isRegistered() is the truth.
  hotkeyRegistered = registerReturn || globalShortcut.isRegistered(config.get().hotkey);

  console.log('[hotkey] register() returned:', registerReturn,
    '| isRegistered:', globalShortcut.isRegistered(config.get().hotkey),
    '| hotkeyRegistered:', hotkeyRegistered);

  if (!hotkeyRegistered) {
    console.warn('[hotkey] Failed to register', config.get().hotkey,
      '— it may be claimed by another app');
  }

  // Init history store and load summaries before opening the hub.
  try {
    await history.init();
    await projects.init();
    await datasets.init();
    await copilot.init();
    // Captures are project records now. Every entry written before that has no
    // projectId and would be invisible under any project, so adopt them into the
    // newest one — ONE pass, idempotent, logged with a real count.
    const newest = (await projects.listProjects())[0];
    if (newest) await history.migrateProjectIds(newest.id);
    historySummaries = await history.loadAllSummaries();
  } catch (err: any) {
    console.error('[history] Failed to load summaries on startup:', err.message);
    historySummaries = [];
  }

  // First launch only: a bundled sample project, so the app is never empty.
  // Its OWN try/catch — the block above logs under a [history] label and
  // swallows, so a seed failure there would be both invisible and would skip
  // whatever init came after it.
  try {
    await sampleProject.seedSampleProject();
  } catch (err: any) {
    console.error('[sample] Failed to seed the sample project:', err && err.message);
  }

  // Always open the hub on launch.
  openHub();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Reap any in-flight agent children (detached → own process group) so a running
  // test/analysis/probe can't leak an orphaned CLI process on quit.
  localCli.killAllProbes();
  localCliRun.killAllRunning();
});

// On macOS, re-open the hub when the dock icon is clicked.
app.on('activate', () => {
  if (!HEADLESS) openHub();
});
