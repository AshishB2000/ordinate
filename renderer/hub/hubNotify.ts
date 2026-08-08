'use strict';

// Execution readiness, and the three things that hang off it: the status pill
// and empty-state banner, the completion-notification preferences (plus the
// synthesized beep, so no asset and no network), and Delete my data.
//
// refreshKeyStatus() is the single reader of key:changed — it fans the one
// status payload out to the pill, the exec chip, the notification switches and
// the global-rules box, which is why they are one file.
//
// Split verbatim out of hub.ts — see .claude/rules/file-size.md. Classic
// global-scope <script>: no import/export. Loads after hubMenus.js: the
// load-time refreshKeyStatus() below writes execMode / execByok / execLocal,
// which are declared there.

// ── Key status ────────────────────────────────────────────────────────────
const keyBadge      = document.getElementById('key-badge');
const keyBadgeLabel = document.getElementById('key-badge-label');
const apiBanner     = document.getElementById('api-banner');

// Reflect execution READINESS (Local CLI connected OR a validated BYOK provider),
// not just an API key. The status pill + the empty-state banner follow this.
function applyReadiness(ready) {
  if (keyBadge) {
    keyBadge.className = ready ? 'api-chip key-ok' : 'api-chip key-missing';
  }
  if (keyBadgeLabel) {
    keyBadgeLabel.textContent = ready ? 'AI connected' : 'AI not connected';
  }
  if (apiBanner) {
    // Use style.display directly — author CSS (display:flex) must not fight the hidden attr.
    apiBanner.style.display = ready ? 'none' : 'flex';
  }
}

// Start pessimistic (not ready) until IPC confirms otherwise.
applyReadiness(false);

async function refreshKeyStatus() {
  if (!window.hub || typeof window.hub.getKeyStatus !== 'function') return;
  try {
    const status = await window.hub.getKeyStatus();
    applyReadiness(Boolean(status && status.isReady));
    // Keep the top-right exec button in sync with the real connection state
    // (connect/disconnect/switch/delete all funnel through key:changed → here).
    if (status) {
      execMode  = status.executionMode || execMode;
      if (status.byok)     execByok  = status.byok;
      if (status.localCli) execLocal = status.localCli;
      updateExecBtnIcon();
    }
    if (status && status.notifications) applyNotifPrefs(status.notifications);
    if (stpAutoRefresh) reflectSwitch(stpAutoRefresh, status ? status.autoRefresh !== false : true);
    // Load global rules into the box (don't clobber while the user is typing).
    if (stpPromptEl && status && typeof status.globalRules === 'string'
        && document.activeElement !== stpPromptEl) {
      stpPromptEl.value = status.globalRules;
    }
  } catch (_) {
    // IPC unavailable; leave as "not ready" — the safe default.
    applyReadiness(false);
  }
}

// ── Completion notifications (settings + sound) ─────────────────────────────
// Cached so the completion handlers can decide whether to beep without an async
// round-trip. Desktop notifications fire in MAIN; the sound plays here.
let notifPrefs = { sound: false, desktop: false };
const stpNotifSound   = document.getElementById('stp-notif-sound');
const stpNotifDesktop = document.getElementById('stp-notif-desktop');

// Instructions / Rules box → config.globalRules (debounced; empty allowed).
const stpPromptEl = document.getElementById('stp-prompt') as HTMLTextAreaElement;
if (stpPromptEl) {
  let rulesTimer = null;
  stpPromptEl.addEventListener('input', () => {
    if (rulesTimer) clearTimeout(rulesTimer);
    rulesTimer = setTimeout(() => {
      if (window.hub && typeof window.hub.setGlobalRules === 'function') {
        window.hub.setGlobalRules(stpPromptEl.value).catch(() => {});
      }
    }, 400);
  });
}

function reflectSwitch(btn, on) {
  if (!btn) return;
  btn.classList.toggle('stp-switch-on', !!on);
  btn.setAttribute('aria-checked', String(!!on));
}

function applyNotifPrefs(n) {
  notifPrefs = { sound: !!n.sound, desktop: !!n.desktop };
  reflectSwitch(stpNotifSound, notifPrefs.sound);
  reflectSwitch(stpNotifDesktop, notifPrefs.desktop);
}

async function setNotif(field, value) {
  notifPrefs = { ...notifPrefs, [field]: value };
  if (window.hub && typeof window.hub.setNotifications === 'function') {
    try { await window.hub.setNotifications({ [field]: value }); } catch (_) {}
  }
}

// The master auto-refresh switch. Same reflectSwitch/aria pattern as the two
// notification toggles it sits beside; the copy in index.html states the honest
// constraint (no daemon — schedules run while the app is open).
const stpAutoRefresh = document.getElementById('stp-autorefresh');
if (stpAutoRefresh) {
  stpAutoRefresh.addEventListener('click', async () => {
    const on = !stpAutoRefresh.classList.contains('stp-switch-on');
    reflectSwitch(stpAutoRefresh, on);
    try {
      await window.hub.setAutoRefreshEnabled(on);
    } catch (_) {
      reflectSwitch(stpAutoRefresh, !on); // put it back; nothing was saved
      showToast('Could not change that setting.');
    }
  });
}

if (stpNotifSound) {
  stpNotifSound.addEventListener('click', () => {
    const on = !stpNotifSound.classList.contains('stp-switch-on');
    reflectSwitch(stpNotifSound, on);
    setNotif('sound', on);
    if (on) playCompletionSound(); // immediate preview so the user hears it
  });
}
if (stpNotifDesktop) {
  stpNotifDesktop.addEventListener('click', async () => {
    const on = !stpNotifDesktop.classList.contains('stp-switch-on');
    reflectSwitch(stpNotifDesktop, on);
    setNotif('desktop', on);
    // On enable, register with the OS now (so the app shows in System Settings →
    // Notifications) rather than lazily on the first unfocused completion. macOS
    // doesn't report allow/deny to us, so nudge the user toward System Settings.
    if (on && window.hub && typeof window.hub.bootstrapNotifications === 'function') {
      try {
        const r = await window.hub.bootstrapNotifications();
        if (r && r.supported === false) showToast('Desktop notifications aren’t supported on this system.');
        // "Screenchart" here is the BUNDLE name, which is what System Settings lists
        // — not a missed rename. See the note in index.html's permission panel.
        else showToast('Sent a test notification. If it didn’t appear, allow Screenchart in System Settings → Notifications.');
      } catch (_) { /* never block the toggle */ }
    }
  });
}

// Short synthesized beep via Web Audio — no bundled asset, no network. Wrapped
// so a missing/blocked AudioContext can never throw into the analysis flow.
function playCompletionSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => { try { ctx.close(); } catch (_) {} };
  } catch (_) { /* best-effort: never block the result */ }
}

// ── Delete my data (General → Privacy). The confirm dialog + actual deletion
// happen in MAIN; here we just trigger it and reflect the reset state. ────────
const stpDeleteResult = document.getElementById('stp-delete-result');
document.querySelectorAll('[data-delete]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const scope = btn.getAttribute('data-delete');
    if (!window.hub || typeof window.hub.deleteData !== 'function') return;
    if (stpDeleteResult) { stpDeleteResult.hidden = false; stpDeleteResult.textContent = 'Waiting for confirmation…'; }
    try {
      const r = await window.hub.deleteData(scope);
      if (r && r.cancelled) { if (stpDeleteResult) stpDeleteResult.hidden = true; return; }
      if (r && r.ok) {
        if (stpDeleteResult) stpDeleteResult.textContent = 'Deleted. ' + (r.removed || []).join(' · ');
        // Main also pushed key:changed + (for history) hub:history []. Refresh the
        // visible settings/provider state so it shows disconnected/empty now.
        await refreshKeyStatus();
        if (typeof refreshExecPane === 'function') refreshExecPane();
      } else if (stpDeleteResult) {
        stpDeleteResult.textContent = 'Couldn’t delete. Try again.';
      }
    } catch (_) {
      if (stpDeleteResult) stpDeleteResult.textContent = 'Couldn’t delete. Try again.';
    }
  });
});

refreshKeyStatus();

if (window.hub && typeof window.hub.onKeyChanged === 'function') {
  window.hub.onKeyChanged(() => refreshKeyStatus());
}

// Main asks us to open settings (e.g. New capture while not ready) → open the
// settings modal at the requested category (Execution mode by default).
if (window.hub && typeof window.hub.onOpenSettings === 'function') {
  window.hub.onOpenSettings((cat) => showSettingsPanel(cat || 'exec'));
}

