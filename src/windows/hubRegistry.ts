// The hub windows that are open — MAIN PROCESS.
//
// main.ts held ONE `let hubWindow`, reassigned from five places, and every push
// to the renderer read it. A second hub window (a tab's "Open in new window")
// makes that one variable a lie, so this module owns the list and answers the
// only two questions a sender has:
//
//   send()      → the PRIMARY window only. Anything that must happen ONCE goes
//                 here: scheduled reports (reports:run-due — each window would
//                 otherwise generate the same file), the capture flow, "open
//                 settings", the permission panel.
//   broadcast() → every live window. State each window paints for itself: the
//                 theme, a refreshed dataset, the alert bell, key status.
//
// PRIMARY is the oldest live window. The list is kept in open order and a
// window leaves it when it closes, so closing the primary promotes the next
// one by construction — there is no second field to keep in sync.
//
// It only ever calls isDestroyed(), on('closed') and webContents.send(), which
// is what lets scripts/test-hubRegistry.ts drive it with plain fake objects.

import type { BrowserWindow } from 'electron';

const open: BrowserWindow[] = [];

/** Track a hub window from now until it closes. Returns it, for chaining. */
export function add(win: BrowserWindow): BrowserWindow {
  open.push(win);
  win.on('closed', () => {
    const i = open.indexOf(win);
    if (i >= 0) open.splice(i, 1);
  });
  return win;
}

/** Every live hub window, oldest first. */
export function all(): BrowserWindow[] {
  return open.filter((w) => !w.isDestroyed());
}

/** The oldest live hub window, or null when none is open. */
export function primary(): BrowserWindow | null {
  return all()[0] || null;
}

/** Push to the primary window only — for work that must happen once. */
export function send(channel: string, ...args: unknown[]): void {
  const w = primary();
  if (w) w.webContents.send(channel, ...args);
}

/** Push to every live hub window. */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of all()) w.webContents.send(channel, ...args);
}
