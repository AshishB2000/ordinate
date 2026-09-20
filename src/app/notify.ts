// OS notifications — MAIN PROCESS. Three small functions and one rule: a
// notification must never block, delay or error the thing it is reporting on,
// so every path here swallows its own failure.
//
// Split out of main.ts under the 800-line cap (.claude/rules/file-size.md).
// `isHubFocused` is passed in rather than imported: whether to notify depends
// on the hub window, which main.ts owns, and a second module reaching for that
// window is how two files end up disagreeing about which one is live.

import { Notification } from 'electron';
import * as config from './config';

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
