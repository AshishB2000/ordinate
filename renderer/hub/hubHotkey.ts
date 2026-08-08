'use strict';

// The global capture hotkey, renderer side. Three pieces of one job: the label
// helpers (accelerator ⇄ "⌘ ⇧ S" ⇄ <kbd> chips), the banner shown when MAIN
// fails to register the shortcut, and the Settings recorder that rebinds it.
//
// Split verbatim out of hub.ts — see .claude/rules/file-size.md. Classic
// global-scope <script>: no import/export, and every symbol here is visible to
// the other hub files by bare name.

// ── Hotkey label helpers ──────────────────────────────────────────────────
// Split a label like "⌘ ⇧ S" or "Ctrl + Alt + S" into individual key tokens.
function labelToKeys(label) {
  return label.split(' ').filter(k => k !== '+');
}

// Mirror of main's hotkeyLabel() — used in the renderer for live recorder preview.
function accelToLabel(accelerator) {
  const mac = navigator.platform.toLowerCase().includes('mac');
  const parts = (accelerator || '').split('+');
  if (mac) {
    return parts.map(p => {
      switch (p.toLowerCase()) {
        case 'commandorcontrol': case 'command': case 'cmd': return '⌘';
        case 'shift': return '⇧';
        case 'alt': case 'option': return '⌥';
        case 'control': case 'ctrl': return '⌃';
        default: return p.toUpperCase();
      }
    }).join(' ');
  }
  return parts.map(p => {
    switch (p.toLowerCase()) {
      case 'commandorcontrol': case 'command': case 'cmd':
      case 'control': case 'ctrl': return 'Ctrl';
      case 'shift': return 'Shift';
      case 'alt': case 'option': return 'Alt';
      default: return p.toUpperCase();
    }
  }).join(' + ');
}

// Map a KeyboardEvent.key to an Electron accelerator key name.
// Uses e.code (physical key position) so Alt/Option combos on macOS don't produce
// special Unicode characters that break recognition.
function keyToAccelKey(code) {
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);       // KeyS → S
  if (/^Digit(\d)$/.test(code)) return code.slice(5);        // Digit1 → 1
  if (/^F(\d+)$/.test(code)) return code;                    // F1, F12
  const MAP = {
    Space: 'Space', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
    Tab: 'Tab', Escape: 'Escape', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backquote: '`',
  };
  return MAP[code] || null;
}

async function applyHotkeyLabel() {
  if (!window.hub || typeof window.hub.getHotkeyLabel !== 'function') return;
  try {
    const { label } = await window.hub.getHotkeyLabel();
    const hotkeyHintEl = document.getElementById('hotkey-hint');
    if (hotkeyHintEl) hotkeyHintEl.textContent = label;
    const stepKeysEl = document.getElementById('step-hotkey-keys');
    if (stepKeysEl) {
      stepKeysEl.innerHTML = labelToKeys(label).map(k => `<kbd>${k}</kbd>`).join(' ');
    }
  } catch (_) {}
}
applyHotkeyLabel();

// ── Hotkey registration failure banner ────────────────────────────────────
const hotkeyFailBanner   = document.getElementById('hotkey-fail-banner');
const hotkeyFailMsg      = document.getElementById('hotkey-fail-msg');
const hotkeyFailChange   = document.getElementById('hotkey-fail-change');
const hotkeyFailDismiss  = document.getElementById('hotkey-fail-dismiss');

if (window.hub && typeof window.hub.onHotkeyState === 'function') {
  window.hub.onHotkeyState((data) => {
    // Success → hide the banner; failure → show it with the real label.
    if (data && data.registered) {
      if (hotkeyFailBanner) hotkeyFailBanner.style.display = 'none';
      return;
    }
    const label = data && data.label;
    if (hotkeyFailMsg) {
      hotkeyFailMsg.textContent = label
        ? `Couldn't register ${label} — it may already be in use by another app.`
        : `Couldn't register the shortcut — it may already be in use by another app.`;
    }
    if (hotkeyFailBanner) hotkeyFailBanner.style.display = 'flex';
  });
}

if (hotkeyFailChange) {
  // Open Settings at the Hotkey category, where the recorder lets the user rebind.
  hotkeyFailChange.addEventListener('click', () => { showSettingsPanel('hotkey'); });
}
if (hotkeyFailDismiss) {
  hotkeyFailDismiss.addEventListener('click', () => {
    if (hotkeyFailBanner) hotkeyFailBanner.style.display = 'none';
  });
}

// ── Settings panel — hotkey recorder ─────────────────────────────────────
let stpRecording = false;
let stpCapturedAccel = null;
let stpRecordingHandler = null;

function stpRenderHotkeyDisplay(label) {
  if (!stpHotkeyEl) return;
  const chips = labelToKeys(label).map(k => `<span class="kbd">${k}</span>`).join('');
  stpHotkeyEl.innerHTML = chips +
    `<button id="stp-hotkey-change" class="btn btn-sm" type="button">Change</button>`;
  document.getElementById('stp-hotkey-change').addEventListener('click', async () => {
    const { accelerator } = await window.hub.getHotkeyLabel().catch(() => ({ accelerator: '' }));
    stpStartRecording(accelerator);
  });
}

function stpStartRecording(prevAccel) {
  stpRecording = true;
  stpCapturedAccel = null;
  if (!stpHotkeyEl) return;
  stpHotkeyEl.innerHTML =
    `<div class="stp-recorder" id="stp-recorder"><span class="stp-recorder-hint">Press your shortcut…</span></div>` +
    `<button id="stp-rec-save" class="btn btn-sm btn-primary" type="button" disabled>Save</button>` +
    `<button id="stp-rec-cancel" class="btn btn-sm" type="button">Cancel</button>`;

  document.getElementById('stp-rec-save').addEventListener('click', stpSaveHotkey);
  document.getElementById('stp-rec-cancel').addEventListener('click', () => stpCancelRecording(prevAccel));

  stpRecordingHandler = (e) => {
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const parts = [];
    if (e.metaKey) parts.push('CommandOrControl');
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    const key = keyToAccelKey(e.code);
    const isFKey = key && /^F\d+$/.test(key);
    // F-keys work without a modifier; all other keys need at least one modifier.
    if (!key || (parts.length === 0 && !isFKey)) return;
    parts.push(key);
    stpCapturedAccel = parts.join('+');
    const rec = document.getElementById('stp-recorder');
    if (rec) {
      rec.innerHTML = labelToKeys(accelToLabel(stpCapturedAccel))
        .map(k => `<span class="kbd">${k}</span>`).join('');
    }
    const saveBtn = document.getElementById('stp-rec-save') as HTMLButtonElement;
    if (saveBtn) saveBtn.disabled = false;
  };
  window.addEventListener('keydown', stpRecordingHandler, true);
}

async function stpSaveHotkey() {
  if (!stpCapturedAccel || !window.hub || typeof window.hub.saveHotkey !== 'function') return;
  const saveBtn = document.getElementById('stp-rec-save') as HTMLButtonElement;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const result = await window.hub.saveHotkey(stpCapturedAccel);
    if (result && result.ok) {
      stpStopRecording();
      stpRenderHotkeyDisplay(result.label || accelToLabel(stpCapturedAccel));
      await applyHotkeyLabel();
      if (hotkeyFailBanner) hotkeyFailBanner.style.display = 'none';
    } else {
      const rec = document.getElementById('stp-recorder');
      if (rec) rec.textContent = (result && result.error) || 'Could not register — try another combo';
      if (saveBtn) saveBtn.disabled = false;
    }
  } catch (_) {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function stpCancelRecording(prevAccel) {
  stpStopRecording();
  if (stpHotkeyEl) {
    stpRenderHotkeyDisplay(prevAccel ? accelToLabel(prevAccel) : '–');
  }
}

function stpStopRecording() {
  stpRecording = false;
  stpCapturedAccel = null;
  if (stpRecordingHandler) {
    window.removeEventListener('keydown', stpRecordingHandler, true);
    stpRecordingHandler = null;
  }
}
