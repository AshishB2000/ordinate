// OS notifications — MAIN PROCESS. Three small functions and one rule: a
// notification must never block, delay or error the thing it is reporting on,
// so every path here swallows its own failure.
//
// Split out of main.ts under the 800-line cap (.claude/rules/file-size.md).
// `isHubFocused` is passed in rather than imported: whether to notify depends
// on the hub window, which main.ts owns, and a second module reaching for that
// window is how two files end up disagreeing about which one is live.

import { Notification, shell } from 'electron';
import * as config from './config';
import type { AlertEvent } from '../analysis/alerts';
import { digestMessage } from '../analysis/alerts';

// Best-effort OS notification when an analysis turn finishes AND the window is
// not focused. Gated on the user's setting; failures are swallowed so they can
// never block or error the analysis. (The completion SOUND is played in the
// renderer — see hub.js.)
export function maybeNotify(body: string, isHubFocused: () => boolean): void {
  try {
    const prefs = config.get().notifications || {};
    if (!prefs.desktop) return;
    if (isHubFocused()) return;
    if (!Notification.isSupported || !Notification.isSupported()) return;
    new Notification({ title: 'Ordinate', body, silent: false }).show();
  } catch (_) { /* a notification must never block the thing it reports on */ }
}

export function maybeNotifyDone(title: string | undefined, isHubFocused: () => boolean): void {
  maybeNotify(title ? `Analysis ready — ${title}` : 'Analysis ready.', isHubFocused);
}

/**
 * An alert that fired. Deliberately NOT `maybeNotify`, for two reasons.
 *
 * 1. FOCUS IS IRRELEVANT. "Analysis ready" is silent when you are already
 *    looking at the window because you can see it finish. An alert is about a
 *    number on a schedule you are not watching, so it fires either way — the
 *    inbox count is what a focused user would otherwise have to notice.
 * 2. IT HAS ITS OWN SWITCH, `notifications.alerts`, and it is ON by default.
 *    `notifications.desktop` is off by default and is about completion chatter;
 *    a rule the user deliberately wrote is not chatter, and an alert that
 *    silently never arrives is worse than no alert at all.
 *
 * `onClick` is how main takes the user to the event — the caller owns window
 * focus, so it is passed in rather than reached for here.
 *
 * Returns whether a notification was actually shown, so a caller can fall back
 * (and so the smoke can assert it). Never throws.
 */
export function notifyAlert(events: AlertEvent[], onClick?: () => void): boolean {
  try {
    const list = Array.isArray(events) ? events.filter(Boolean) : [];
    if (list.length === 0) return false;
    const prefs = config.get().notifications || {};
    if (prefs.alerts === false) return false;
    if (!Notification.isSupported || !Notification.isSupported()) return false;
    // One notification per call. A caller batching a whole tick passes every
    // event and gets the digest sentence; a caller notifying individually calls
    // this once per event. Either way the BODY is app-composed (alerts.ts) out
    // of app-computed figures — no model is on this path.
    const title = list.length === 1 ? list[0].ruleName : 'Ordinate alerts';
    const n = new Notification({ title, body: digestMessage(list), silent: false });
    if (onClick) n.on('click', () => { try { onClick(); } catch (_) { /* never throw at the OS */ } });
    n.show();
    return true;
  } catch (_) {
    return false; // a notification must never block the thing it reports on
  }
}

// Register with the OS the moment the user ENABLES the Desktop toggle — a benign,
// focus-independent show — so the app appears in System Settings → Notifications,
// instead of lazily on the first unfocused completion (which the OS may silently
// drop). Electron exposes no allow/deny status here, so `supported:false` only
// means the platform has no notifications at all; the renderer nudges toward
// System Settings either way.
//
// KNOWN macOS LIMITATION (signing-dependent, not a code bug): Apple's
// UNUserNotification API requires the app to be code-signed to emit; an UNSIGNED
// build emits a 'failed' event and shows nothing. So this bootstrap is correct
// but macOS notifications stay non-functional until the app is signed. Windows
// has no such requirement — the AppUserModelID set above is enough.
export function bootstrapNotification(): { ok: boolean; supported: boolean } {
  try {
    if (!Notification.isSupported || !Notification.isSupported()) return { ok: false, supported: false };
    new Notification({
      title: 'Ordinate',
      body: 'Desktop notifications are on. You’ll be alerted when an analysis finishes and this window isn’t focused.',
      silent: true,
    }).show();
    return { ok: true, supported: true };
  } catch (_) {
    return { ok: false, supported: false };
  }
}

/**
 * A generated file landed — say so, and make the notification actionable.
 *
 * Unlike maybeNotify this is NOT gated on window focus. A scheduled report is
 * written unattended: the file appearing in a folder is the only evidence it
 * happened, and suppressing the message because the window happens to be in
 * front would hide the one thing the user asked to be told about. It IS still
 * gated on the Desktop toggle, which is the setting that means "tell me things".
 *
 * Clicking reveals the file in the OS file manager — `showItemInFolder`, which
 * selects it rather than opening it: a .pptx is another application's business
 * to launch, not ours.
 *
 * Returns whether a notification was actually shown, so the caller that wrote
 * the file can report it. On an unsigned macOS build nothing is emitted (see
 * bootstrapNotification above), and a silent false is more useful than a lie.
 */
export function notifyFile(body: string, filePath: string): boolean {
  try {
    const prefs = config.get().notifications || {};
    if (!prefs.desktop) return false;
    if (!Notification.isSupported || !Notification.isSupported()) return false;
    const n = new Notification({ title: 'Ordinate', body, silent: false });
    n.on('click', () => {
      try { shell.showItemInFolder(filePath); } catch (_) { /* nothing to reveal */ }
    });
    n.show();
    return true;
  } catch (_) {
    return false; // a notification must never block the thing it reports on
  }
}
