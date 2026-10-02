// What must not outlive the app — MAIN PROCESS.
//
// Every repeating timer main starts is `track`ed here, and on before-quit
// `runQuit` clears them all, runs the stop hooks, and destroys every window that
// is not a hub (the offscreen report/export windows, the overlay). Hubs are left
// to close normally so an unsaved-changes prompt still gets its say.
//
// Before this, each module cleared (or merely unref'd) its own interval on its
// own quit event, and a hidden window was only ever destroyed by the code path
// that made it. A quit that raced one of those left a handle alive — and a smoke
// that cannot close its app hangs CI for six hours instead of failing.
//
// Loads under plain node: electron is imported for nothing, the windows are
// passed in, so scripts/test-quitCleanup.ts drives it with fakes.

type Timer = ReturnType<typeof setTimeout>;
interface Win { isDestroyed(): boolean; destroy(): void }

const timers = new Set<Timer>();
const hooks: Array<() => void> = [];

/** Register a timer (interval or timeout) to be cleared on quit. Unref'd, so it
 *  can never hold the process open by itself either. Returns it, for chaining. */
export function track<T extends Timer>(t: T): T {
  timers.add(t);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

/** A stop function to run on quit (a watcher, a server, a scheduler). */
export function onQuit(fn: () => void): void {
  hooks.push(fn);
}

/** Clear every tracked timer, run every hook, destroy every window given.
 *  One throwing hook or window never stops the rest. Idempotent. */
export function runQuit(windows: Win[]): { timers: number; hooks: number; windows: number; failed: number } {
  let failed = 0;
  const cleared = timers.size;
  // clearInterval and clearTimeout share one id space in node and electron.
  for (const t of timers) clearInterval(t);
  timers.clear();
  const ran = hooks.length;
  for (const fn of hooks.splice(0)) {
    try { fn(); } catch (_) { failed++; }
  }
  let destroyed = 0;
  for (const w of windows) {
    try {
      if (!w.isDestroyed()) { w.destroy(); destroyed++; }
    } catch (_) { failed++; }
  }
  return { timers: cleared, hooks: ran, windows: destroyed, failed };
}
