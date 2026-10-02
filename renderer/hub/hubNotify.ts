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
// The #key-badge chip that used to live in the capture footer is gone: the AI
// selector in the capture top bar already shows the same state as an icon, so
// the chip was a second, wordier copy of it. Its lookups and branches went with
// it rather than lingering as null-guarded dead code. #api-banner is a
// different element and is still rendered.
const apiBanner     = document.getElementById('api-banner');

// Reflect execution READINESS (Local CLI connected OR a validated BYOK provider),
// not just an API key. The status pill + the empty-state banner follow this.
function applyReadiness(ready) {
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
    // The workspace calendar — what "This fiscal year" is called in a chip.
    if (status && status.formats) wsFormats = status.formats;
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
let notifPrefs = { sound: false, desktop: false, alerts: true, alertExplain: false, jobs: true };
const stpNotifSound   = document.getElementById('stp-notif-sound');
const stpNotifDesktop = document.getElementById('stp-notif-desktop');
// Alert rules have their own two switches. `alerts` defaults ON (an alert about
// a number you are not watching is the whole point) and `alertExplain` OFF (it
// spends a model call). See the Notifications interface in src/app/config.ts.
const stpNotifAlerts  = document.getElementById('stp-notif-alerts');
const stpNotifExplain = document.getElementById('stp-notif-alert-explain');

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
  // `alerts` absent means ON — a config written before alerts existed must not
  // arrive with the feature already switched off.
  notifPrefs = {
    sound: !!n.sound,
    desktop: !!n.desktop,
    alerts: n.alerts === undefined ? true : !!n.alerts,
    alertExplain: !!n.alertExplain,
    jobs: n.jobs === undefined ? true : !!n.jobs,
  };
  reflectSwitch(stpNotifSound, notifPrefs.sound);
  reflectSwitch(stpNotifDesktop, notifPrefs.desktop);
  reflectSwitch(stpNotifAlerts, notifPrefs.alerts);
  reflectSwitch(stpNotifExplain, notifPrefs.alertExplain);
  reflectSwitch(document.getElementById('stp-notif-jobs'), notifPrefs.jobs);
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
      showToast(t('common.could_not_change_that_setting'));
    }
  });
}

// The two alert switches. Same reflectSwitch/aria pattern as the pair below;
// neither needs the OS-registration dance stpNotifDesktop does, because an alert
// notification goes out whether or not the window is focused and the user has
// already been through that prompt if they ever enabled Desktop.
{
  const jobsSwitch = document.getElementById('stp-notif-jobs');
  if (jobsSwitch) {
    jobsSwitch.addEventListener('click', () => {
      const on = !jobsSwitch.classList.contains('stp-switch-on');
      reflectSwitch(jobsSwitch, on);
      void setNotif('jobs', on);
    });
  }
}
if (stpNotifAlerts) {
  stpNotifAlerts.addEventListener('click', () => {
    const on = !stpNotifAlerts.classList.contains('stp-switch-on');
    reflectSwitch(stpNotifAlerts, on);
    setNotif('alerts', on);
  });
}
if (stpNotifExplain) {
  stpNotifExplain.addEventListener('click', () => {
    const on = !stpNotifExplain.classList.contains('stp-switch-on');
    reflectSwitch(stpNotifExplain, on);
    setNotif('alertExplain', on);
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
        if (r && r.supported === false) showToast(t('hubNotify.desktop_notifications_aren_t_supported'));
        // "Screenchart" here is the BUNDLE name, which is what System Settings lists
        // — not a missed rename. See the note in index.html's permission panel.
        else showToast(t('hubNotify.sent_a_test_notification_if_it'));
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
    if (stpDeleteResult) { stpDeleteResult.hidden = false; stpDeleteResult.textContent = t('hubNotify.waiting_for_confirmation'); }
    try {
      const r = await window.hub.deleteData(scope);
      if (r && r.cancelled) { if (stpDeleteResult) stpDeleteResult.hidden = true; return; }
      if (r && r.ok) {
        if (stpDeleteResult) stpDeleteResult.textContent = t('hubNotify.deleted', { p0: (r.removed || []).join(' · ') });
        // Main also pushed key:changed + (for history) hub:history []. Refresh the
        // visible settings/provider state so it shows disconnected/empty now.
        await refreshKeyStatus();
        if (typeof refreshExecPane === 'function') refreshExecPane();
      } else if (stpDeleteResult) {
        stpDeleteResult.textContent = t('hubNotify.couldn_t_delete_try_again');
      }
    } catch (_) {
      if (stpDeleteResult) stpDeleteResult.textContent = t('hubNotify.couldn_t_delete_try_again');
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

