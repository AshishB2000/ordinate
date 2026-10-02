// The quit path (src/app/quitCleanup.ts) — every tracked timer cleared, every
// stop hook run, every auxiliary window destroyed, and one failure never
// stopping the rest. A handle that survives quit is what kept a CI smoke alive
// for six hours, so this is checked under plain node with fake windows.
//
//   npm run build:ts && node scripts/test-quitCleanup.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

import * as qc from '../src/app/quitCleanup';

function fakeWin(opts: { destroyed?: boolean; throws?: boolean } = {}) {
  const w = {
    destroyed: !!opts.destroyed,
    destroyCalls: 0,
    isDestroyed: () => w.destroyed,
    destroy: () => {
      w.destroyCalls++;
      if (opts.throws) throw new Error('boom');
      w.destroyed = true;
    },
  };
  return w;
}

async function main(): Promise<void> {
  let intervalTicks = 0;
  let timeoutFired = false;
  const iv = qc.track(setInterval(() => { intervalTicks++; }, 5));
  qc.track(setTimeout(() => { timeoutFired = true; }, 200));
  ok('track returns the timer it was given, for chaining', typeof iv === 'object' && iv !== null);
  ok('a tracked timer is unref\'d, so it cannot hold the process by itself', iv.hasRef() === false);

  const ran: string[] = [];
  qc.onQuit(() => ran.push('first'));
  qc.onQuit(() => { throw new Error('a stop hook that throws'); });
  qc.onQuit(() => ran.push('third'));

  const aux = fakeWin();
  const gone = fakeWin({ destroyed: true });
  const bad = fakeWin({ throws: true });
  const after = fakeWin();

  await new Promise((r) => setTimeout(r, 20));
  const before = intervalTicks;
  const res = qc.runQuit([aux, gone, bad, after]);
  ok('the interval had been running', before > 0, before);

  await new Promise((r) => setTimeout(r, 250));
  ok('the interval stops ticking after quit', intervalTicks === before, `${before} → ${intervalTicks}`);
  ok('the pending timeout never fires after quit', timeoutFired === false);
  ok('it reports both timers cleared', res.timers === 2, JSON.stringify(res));

  ok('every stop hook ran, the throwing one did not stop the third', ran.join(',') === 'first,third', ran.join(','));
  ok('it reports three hooks run', res.hooks === 3, JSON.stringify(res));

  ok('a live auxiliary window is destroyed', aux.destroyed === true && aux.destroyCalls === 1);
  ok('an already-destroyed window is skipped, not destroyed twice', gone.destroyCalls === 0);
  ok('a window that throws on destroy does not stop the next one', after.destroyed === true);
  ok('it counts destroyed windows and failures', res.windows === 2 && res.failed === 2, JSON.stringify(res));

  // before-quit can fire more than once (a quit the user cancels, then retries).
  const again = qc.runQuit([fakeWin({ destroyed: true })]);
  ok('a second run is a no-op: nothing left to clear or run', again.timers === 0 && again.hooks === 0 && again.windows === 0, JSON.stringify(again));
}

main().then(finish, (e) => { ok('harness threw', false, e && e.stack); finish(); });
