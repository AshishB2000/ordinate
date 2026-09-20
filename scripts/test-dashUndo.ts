// The dashboard editor's undo stack — the PURE half of renderer/hub/dashHistory.ts.
//
// Only the four stack functions are exercised here. The glue (dashHistApply,
// markDashDirty's commit, the keyboard path) needs a real editor and a real
// record, which is what the smoke run drives; what this file pins is the part
// that has no excuse for being wrong: push/undo/redo bookkeeping, the 50-entry
// cap, the coalescing window, and the two invariants that make the stack safe
// to point at a live object —
//
//   1. A SNAPSHOT IS NEVER THE CALLER'S OBJECT. The editor mutates the record
//      in place, so if the stack held a reference rather than a clone, every
//      later edit would silently rewrite the past. Asserted by mutating the
//      pushed object afterwards and checking the stack did not move.
//   2. A NEW CHANGE ABANDONS THE REDO BRANCH. Undo three, then edit, and the
//      three redos must be gone, not waiting to reappear over unrelated work.
//
// The module is a classic global-scope renderer script with no exports, so it
// is evaluated in a vm sandbox and the symbols read off it — the pattern
// scripts/test-chartCanRender.ts and scripts/test-plotSpec.ts already use. It
// loads with NO `window` and NO `document` on purpose: that is the assertion
// that the stack half really is pure, and it fails loudly the day someone
// reaches for the DOM above the glue line.
//
//   npm run build:ts && node scripts/test-dashUndo.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const HUB = path.join(__dirname, '..', 'renderer', 'hub');
const sandbox: any = { console, structuredClone };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(HUB, 'dashHistory.js'), 'utf8'), sandbox,
  { filename: 'dashHistory.js' });

type Entry = { label: string; snap: any };
type Hist = { past: Entry[]; future: Entry[]; base: any; at: number; label: string };

const histNew: (base: any) => Hist = sandbox.dashHistNew;
const push: (h: Hist, label: string, next: any, now: number, coalesce?: boolean) => void = sandbox.dashHistPush;
const undo: (h: Hist) => Entry | null = sandbox.dashHistUndo;
const redo: (h: Hist) => Entry | null = sandbox.dashHistRedo;
const undoLabel: (h: Hist | null) => string | null = sandbox.dashHistUndoLabel;
const redoLabel: (h: Hist | null) => string | null = sandbox.dashHistRedoLabel;
// `function` declarations become properties of the sandbox global; top-level
// `const` does not — it lives in the realm's lexical scope, which a second
// script in the SAME context can still see. Hence the eval for the two numbers.
const CAP: number = vm.runInContext('DASH_HIST_CAP', sandbox);
const COALESCE_MS: number = vm.runInContext('DASH_HIST_COALESCE_MS', sandbox);

ok('dashHistory.js loads with no window and no document',
  [histNew, push, undo, redo, undoLabel, redoLabel].every((f) => typeof f === 'function'));
ok('…and exposes the cap and the coalescing window', CAP === 50 && COALESCE_MS === 600,
  `cap=${CAP} coalesce=${COALESCE_MS}`);

/** A record-shaped snapshot, the way dashHistRecord() builds one. */
const rec = (cards: string[]) => ({ name: 'D', pages: [{ id: 'p', cards: cards.map((id) => ({ id })) }], filters: [], style: undefined });
const ids = (snap: any): string[] => snap.pages[0].cards.map((c: any) => c.id);

// ── Nothing to undo on a fresh stack ────────────────────────────────────────
{
  const h = histNew(rec(['a']));
  ok('a fresh stack has nothing to undo or redo',
    undo(h) === null && redo(h) === null && undoLabel(h) === null && redoLabel(h) === null);
}

// ── One change, there and back ──────────────────────────────────────────────
{
  const h = histNew(rec(['a', 'b']));
  push(h, 'Remove card', rec(['a']), 1000);
  ok('after a change, Undo offers it by name', undoLabel(h) === 'Remove card', String(undoLabel(h)));
  ok('…and there is nothing to redo yet', redoLabel(h) === null);

  const u = undo(h);
  ok('undo hands back the state BEFORE the change',
    !!u && JSON.stringify(ids(u.snap)) === JSON.stringify(['a', 'b']), JSON.stringify(u && ids(u.snap)));
  ok('…labelled with the change it reversed', !!u && u.label === 'Remove card');
  ok('…and the direction flips', undoLabel(h) === null && redoLabel(h) === 'Remove card');

  const r = redo(h);
  ok('redo hands back the state AFTER the change',
    !!r && JSON.stringify(ids(r.snap)) === JSON.stringify(['a']), JSON.stringify(r && ids(r.snap)));
  ok('…and the direction flips back', undoLabel(h) === 'Remove card' && redoLabel(h) === null);
}

// ── Several changes unwind in order ─────────────────────────────────────────
{
  const h = histNew(rec([]));
  push(h, 'Add a', rec(['a']), 1000);
  push(h, 'Add b', rec(['a', 'b']), 3000);
  push(h, 'Add c', rec(['a', 'b', 'c']), 5000);
  const seen = [undo(h), undo(h), undo(h)].map((e) => e && e.label);
  ok('undo unwinds newest first', JSON.stringify(seen) === JSON.stringify(['Add c', 'Add b', 'Add a']),
    JSON.stringify(seen));
  ok('…back to the state the stack was created on', JSON.stringify(ids(h.base)) === JSON.stringify([]),
    JSON.stringify(ids(h.base)));
  ok('…and stops there rather than going further', undo(h) === null);
  const back = [redo(h), redo(h), redo(h)].map((e) => e && e.label);
  ok('redo rewinds oldest first', JSON.stringify(back) === JSON.stringify(['Add a', 'Add b', 'Add c']),
    JSON.stringify(back));
  ok('…and stops at the top', redo(h) === null);
}

// ── A new change abandons the redo branch ───────────────────────────────────
{
  const h = histNew(rec([]));
  push(h, 'Add a', rec(['a']), 1000);
  push(h, 'Add b', rec(['a', 'b']), 3000);
  undo(h); undo(h);
  ok('two undos leave two redos', h.future.length === 2, String(h.future.length));
  push(h, 'Add z', rec(['z']), 9000);
  ok('a new change drops the redo branch it diverged from',
    h.future.length === 0 && redoLabel(h) === null, String(h.future.length));
  ok('…and is itself undoable', undoLabel(h) === 'Add z', String(undoLabel(h)));
}

// ── The cap drops the OLDEST, never the newest ──────────────────────────────
{
  const h = histNew(rec([]));
  for (let i = 0; i < CAP + 10; i += 1) push(h, 'Edit ' + i, rec(['c' + i]), 1000 + i * 2000);
  ok(`the stack holds at most ${CAP} entries`, h.past.length === CAP, String(h.past.length));
  ok('…and it is the newest that survived, not the oldest',
    undoLabel(h) === 'Edit ' + (CAP + 9), String(undoLabel(h)));
  ok('…with the oldest reachable entry being the (n-cap)th',
    Boolean(h.past[0]) && h.past[0].label === 'Edit ' + 10, h.past[0] && h.past[0].label);
}

// ── Coalescing: one edit, not one per keystroke ─────────────────────────────
{
  const h = histNew(rec([]));
  let t = 1000;
  for (const ch of 'Region'.split('')) { push(h, 'Edit control label', rec([ch]), t, true); t += 100; }
  ok('six coalescing keystrokes are ONE undo', h.past.length === 1, String(h.past.length));
  ok('…which reverts to the state before the first of them',
    JSON.stringify(ids(h.past[0].snap)) === JSON.stringify([]), JSON.stringify(ids(h.past[0].snap)));

  // Past the window, typing again is a second edit.
  push(h, 'Edit control label', rec(['x']), t + COALESCE_MS + 1, true);
  ok('…but a pause past the window starts a new one', h.past.length === 2, String(h.past.length));

  // A DIFFERENT label never merges, however close it lands.
  push(h, 'Remove card', rec([]), t + COALESCE_MS + 2, true);
  ok('a different label never merges into the one before it', h.past.length === 3, String(h.past.length));

  // And a non-coalescing caller never merges either — two fast clicks of the
  // same button are two separate undos.
  const h2 = histNew(rec([]));
  push(h2, 'Move card', rec(['a']), 1000);
  push(h2, 'Move card', rec(['b']), 1010);
  ok('two fast clicks of the same button stay two undos', h2.past.length === 2, String(h2.past.length));

  // Nothing coalesces across an undo — the head is no longer "what you were
  // just typing into".
  const h3 = histNew(rec([]));
  push(h3, 'Edit control label', rec(['a']), 1000, true);
  push(h3, 'Edit control label', rec(['ab']), 1050, true);
  undo(h3);
  redo(h3);
  push(h3, 'Edit control label', rec(['abc']), 1100, true);
  ok('an undo/redo round trip breaks the coalescing run', h3.past.length === 2, String(h3.past.length));
}

// ── The stack never holds the caller's object ───────────────────────────────
{
  const live = rec(['a', 'b']);
  const h = histNew(live);
  live.pages[0].cards.push({ id: 'SNEAK' }); // the editor keeps mutating in place
  ok('the floor snapshot is a clone, not the record',
    JSON.stringify(ids(h.base)) === JSON.stringify(['a', 'b']), JSON.stringify(ids(h.base)));

  const next = rec(['a']);
  push(h, 'Remove card', next, 2000);
  next.pages[0].cards.push({ id: 'SNEAK2' });
  ok('a pushed snapshot is a clone too',
    JSON.stringify(ids(h.base)) === JSON.stringify(['a']), JSON.stringify(ids(h.base)));

  const u = undo(h)!;
  u.snap.pages[0].cards.push({ id: 'SNEAK3' }); // the caller installs and then edits it
  const r = redo(h)!;
  ok('…and what undo hands back is a clone as well, so editing it cannot corrupt the stack',
    JSON.stringify(ids(r.snap)) === JSON.stringify(['a']), JSON.stringify(ids(r.snap)));
  ok('…leaving the undo side intact for a second trip',
    JSON.stringify(ids(undo(h)!.snap)) === JSON.stringify(['a', 'b']));
}

// ── structuredClone, not a JSON round trip ──────────────────────────────────
// A Date in a record (a date_range control's bounds arrive as one) survives the
// clone as a Date. JSON.parse(JSON.stringify(x)) would hand back a string, and
// the difference only shows up the day something calls .getTime() on it.
{
  const when = new Date('2020-03-04T05:06:07.000Z');
  const h = histNew({ name: 'D', pages: [], filters: [{ from: when }], style: undefined });
  push(h, 'Change filters', { name: 'D', pages: [], filters: [], style: undefined }, 1000);
  const u = undo(h)!;
  ok('a Date in the record is still a Date after a round trip',
    u.snap.filters[0].from instanceof Date
      && u.snap.filters[0].from.getTime() === when.getTime(),
    String(u.snap.filters[0].from));
}

finish();
if (failureCount()) process.exit(1);
