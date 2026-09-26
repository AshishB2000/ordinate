// Unattended dataset refresh — the scheduler's wiring. MAIN PROCESS.
//
// Moved out of src/main.ts unchanged (that file sits at the 800-line cap).
// Hub windows come from the registry (windows/hubRegistry); main passes in
// only whether the hub is focused, for the notifications.
//
// Ordinate has no daemon: this ticks while the app is RUNNING, and anything
// that came due while it was closed is simply overdue on the first tick after
// launch. The settings copy says exactly that.
//
// The master switch is read on EVERY tick rather than captured here, so turning
// it off in Settings takes effect at once instead of at the next restart.

import { app } from 'electron';

import * as config from './config';
import { maybeNotify } from './notify';
import * as hubs from '../windows/hubRegistry';

export function start({ hubFocused }: { hubFocused: () => boolean }): void {
  const scheduler = require('./refreshScheduler');
  scheduler.setEnabledCheck(() => config.get().autoRefresh !== false);

  // A row count that moves this much is worth interrupting someone for; a
  // smaller drift is what a refresh is FOR, and the freshness line already says
  // it happened.
  // ponytail: fixed ±20%; per-dataset threshold when someone asks
  const BIG_CHANGE = 0.2;

  scheduler.onRefreshed((o: any) => {
    // Always push to every hub window: each updates its freshness line in
    // place. send/on, not invoke/handle — no answer is wanted.
    hubs.broadcast('hub:dataset-refreshed', o);
    // At most ONE notification per dataset per tick, and only for these two.
    // A success inside the interval is silent by design.
    if (!o.ok) {
      maybeNotify(`Couldn't refresh "${o.name}" — ${o.error || 'refresh failed.'}`, hubFocused);
      return;
    }
    const before = o.rowsBefore;
    if (before > 0 && Math.abs(o.rowsAfter - before) / before > BIG_CHANGE) {
      maybeNotify(`"${o.name}" changed: ${before.toLocaleString()} → ${o.rowsAfter.toLocaleString()} rows.`, hubFocused);
    }
    // A rule firing is NOT reported here — it goes out at the end of the tick,
    // which is what lets the digest option exist (ipc/alerts.wireScheduler).
  });

  // THE ALERT HOOKS, wired by ipc/alerts itself — evaluating on fresh data and
  // batching a tick into one digest are that module's rules, not this file's.
  require('../ipc/alerts').wireScheduler(scheduler);

  // THE REPORT HOOK. Scheduled reports ride the dataset scheduler's tick rather
  // than starting a second timer: a report prints figures, so it must be
  // generated AFTER any refresh due for its datasets in the same tick, and
  // "after" is only guaranteed if there is one tick. `afterTick` fires when the
  // refresh pass has finished (serially — see refreshScheduler's header).
  //
  // Main only rings the bell. The hub renderer owns generation, because the
  // chart engine and the three document libraries live there; it answers by
  // calling `reports:writeScheduled`, which is where the bytes reach disk.
  // PRIMARY only: every window would otherwise generate the same file.
  scheduler.afterTick(() => hubs.send('reports:run-due'));

  scheduler.start();
  app.on('before-quit', () => scheduler.stop());
}
