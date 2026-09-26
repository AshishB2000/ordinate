// The tab set — the PURE half of the tabs feature (renderer/hub/tabModel.ts).
//
// What the strip does on screen is the smoke's job (scripts/wfTabs.ts). What is
// pinned here is the bookkeeping underneath it, which a smoke only ever sees one
// path through:
//
//   1. WHERE A TAB GOES. A new tab lands right after the focused one; a
//      background (⌘-click) tab is appended and does not steal focus; opening a
//      record that already has a tab focuses it rather than duplicating it.
//   2. WHAT FOCUS FALLS TO. Closing the focused tab focuses its right-hand
//      neighbour, else its left, else nothing — and closing either side of a
//      split ends the split with the survivor focused.
//   3. RESTORE IS FORGIVING. A saved set whose records were deleted comes back
//      without them — silently — and junk in localStorage costs the tabs, never
//      the launch.
//
// The module is a classic global-scope renderer script with no exports, so it is
// evaluated in a vm sandbox with NO window and NO document — the assertion that
// it really is pure (the pattern scripts/test-dashUndo.ts uses).
//
//   npm run build:ts && node scripts/test-tabModel.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

type Rec = { kind: string; id: string; name: string };
type State = { tabs: Rec[]; active: string | null; split: { left: string; right: string; ratio: number } | null };

const sandbox: any = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub', 'tabModel.js'), 'utf8'),
  sandbox, { filename: 'tabModel.js' });

const M = sandbox;
const empty: () => State = M.tabEmpty;
const open: (s: State, t: Rec, bg?: boolean) => State = M.tabOpen;
const close: (s: State, key: string) => State = M.tabClose;
const closeOthers: (s: State, key: string) => State = M.tabCloseOthers;
const activate: (s: State, key: string | null) => State = M.tabActivate;
const move: (s: State, from: number, to: number) => State = M.tabMove;
const cycle: (s: State, dir: number) => State = M.tabCycle;
const partner: (s: State, fits: (a: Rec, b: Rec) => boolean) => string | null = M.tabSplitPartner;
const splitToggle: (s: State, right?: string | null) => State = M.tabSplitToggle;
const setRatio: (s: State, r: number) => State = M.tabSplitSetRatio;
const serialize: (s: State) => string = M.tabSerialize;
const restore: (raw: unknown, exists: (k: string) => boolean) => State = M.tabRestore;

ok('tabModel.js loads with no window and no document',
  [empty, open, close, closeOthers, activate, move, cycle, partner, splitToggle, setRatio, serialize, restore]
    .every((f) => typeof f === 'function'));

const ds = (id: string, name = 'D' + id): Rec => ({ kind: 'dataset', id, name });
const viz = (id: string, name = 'V' + id): Rec => ({ kind: 'visual', id, name });
const an = (id: string, name = 'A' + id): Rec => ({ kind: 'analysis', id, name });
const keys = (s: State): string => s.tabs.map((t) => t.kind[0] + t.id).join(',');

// ── Open ─────────────────────────────────────────────────────────────────────
let s = open(empty(), ds('1'));
ok('opening onto an empty strip adds one focused tab', keys(s) === 'd1' && s.active === 'dataset:1');
s = open(s, viz('2'));
s = open(s, an('3'));
ok('each open focuses the new tab', keys(s) === 'd1,v2,a3' && s.active === 'analysis:3');
s = activate(s, 'dataset:1');
s = open(s, viz('4'));
ok('a new tab goes right AFTER the focused one, not at the end', keys(s) === 'd1,v4,v2,a3', keys(s));
const before = s;
s = open(s, ds('1', 'Renamed'));
ok('opening a record that already has a tab focuses it — no duplicate',
  keys(s) === 'd1,v4,v2,a3' && s.active === 'dataset:1');
ok('…and refreshes its name', s.tabs[0].name === 'Renamed');
ok('the previous state is untouched (no mutation)', before.tabs[0].name === 'D1' && before.tabs.length === 4);
s = open(s, ds('5'), true);
ok('a background tab is appended and does NOT take focus',
  keys(s) === 'd1,v4,v2,a3,d5' && s.active === 'dataset:1', `${keys(s)} active=${s.active}`);
s = open(s, ds('6'), true);
ok('…and a second one lands after it, in click order', keys(s) === 'd1,v4,v2,a3,d5,d6');
s = open(s, ds('5', 'Named later'), true);
ok('a background open of an existing tab only renames it',
  keys(s) === 'd1,v4,v2,a3,d5,d6' && s.active === 'dataset:1' && s.tabs[4].name === 'Named later');
ok('with nothing focused a new tab goes to the end', keys(open(activate(s, null), viz('7'))) === 'd1,v4,v2,a3,d5,d6,v7');

// ── Close ────────────────────────────────────────────────────────────────────
s = activate(s, 'visual:2');
let c = close(s, 'visual:2');
ok('closing the focused tab focuses its RIGHT neighbour', keys(c) === 'd1,v4,a3,d5,d6' && c.active === 'analysis:3');
c = close(activate(s, 'dataset:6'), 'dataset:6');
ok('…or its left one when it was last', c.active === 'dataset:5');
c = close(s, 'dataset:1');
ok('closing an unfocused tab leaves focus where it was', c.active === 'visual:2' && keys(c) === 'v4,v2,a3,d5,d6');
c = close(open(empty(), ds('1')), 'dataset:1');
ok('closing the last tab leaves nothing focused', c.tabs.length === 0 && c.active === null);
ok('closing a tab that is not there is a no-op', close(s, 'dataset:nope') === s);
c = closeOthers(s, 'analysis:3');
ok('close others keeps one tab, focused', keys(c) === 'a3' && c.active === 'analysis:3' && c.split === null);

// ── Reorder / cycle ──────────────────────────────────────────────────────────
let m = move(s, 0, 3);
ok('move puts the tab at the target index', keys(m) === 'v4,v2,a3,d1,d5,d6', keys(m));
m = move(m, 3, 0);
ok('…and back', keys(m) === 'd1,v4,v2,a3,d5,d6');
ok('an out-of-range move is a no-op', move(s, 0, 99) === s && move(s, -1, 0) === s && move(s, 2, 2) === s);
ok('moving does not change focus', move(s, 2, 0).active === 'visual:2');
let y = cycle(s, 1);
ok('cycle +1 focuses the next tab', y.active === 'analysis:3');
y = cycle(activate(s, 'dataset:6'), 1);
ok('…and wraps from the last to the first', y.active === 'dataset:1');
y = cycle(activate(s, 'dataset:1'), -1);
ok('cycle −1 wraps from the first to the last', y.active === 'dataset:6');
ok('from no focus, +1 starts at the first tab and −1 at the last',
  cycle(activate(s, null), 1).active === 'dataset:1' && cycle(activate(s, null), -1).active === 'dataset:6');
ok('cycling an empty strip is a no-op', cycle(empty(), 1).active === null);

// ── Split ────────────────────────────────────────────────────────────────────
const differentKind = (a: Rec, b: Rec): boolean => a.kind !== b.kind;
let p = open(open(open(empty(), an('a')), ds('b')), ds('c'));
p = activate(p, 'analysis:a');
ok('the split partner is the next tab that fits beside the focused one',
  partner(p, differentKind) === 'dataset:b');
ok('…wrapping round the strip', partner(activate(p, 'dataset:c'), differentKind) === 'analysis:a');
ok('…and null when nothing fits', partner(open(empty(), ds('x')), differentKind) === null);
let sp = splitToggle(p, 'dataset:b');
ok('split: focused tab left, partner right, focus on the new pane',
  !!sp.split && sp.split.left === 'analysis:a' && sp.split.right === 'dataset:b'
  && sp.split.ratio === 0.5 && sp.active === 'dataset:b', JSON.stringify(sp.split));
ok('splitting with itself, a missing tab or nothing focused is a no-op',
  splitToggle(p, 'analysis:a') === p && splitToggle(p, 'dataset:zz') === p
  && splitToggle(activate(p, null), 'dataset:b').split === null);
const un = splitToggle(sp);
ok('toggling again unsplits and keeps the focused pane', un.split === null && un.active === 'dataset:b');
ok('the ratio is clamped to 0.2–0.8',
  setRatio(sp, 0.05).split!.ratio === 0.2 && setRatio(sp, 0.97).split!.ratio === 0.8
  && setRatio(sp, 0.63).split!.ratio === 0.63);
ok('…a non-number keeps the default, and an unsplit state ignores it',
  setRatio(sp, NaN).split!.ratio === 0.5 && setRatio(p, 0.3) === p);
let fx = activate(sp, 'analysis:a');
ok('focusing the other pane keeps the split', !!fx.split && fx.active === 'analysis:a' && fx.split.right === 'dataset:b');
fx = activate(sp, 'dataset:c');
ok('focusing a third tab REPLACES the pane with focus, not the other one',
  !!fx.split && fx.split.left === 'analysis:a' && fx.split.right === 'dataset:c' && fx.active === 'dataset:c');
ok('going back to a list (activate null) ends the split', activate(sp, null).split === null);
let cs = close(sp, 'analysis:a');
ok('closing the unfocused split side unsplits, focus stays on the survivor',
  cs.split === null && cs.active === 'dataset:b' && keys(cs) === 'db,dc');
cs = close(sp, 'dataset:b');
ok('closing the focused split side unsplits and focuses the OTHER side',
  cs.split === null && cs.active === 'analysis:a');
cs = close(sp, 'dataset:c');
ok('closing a tab outside the split leaves the split alone',
  !!cs.split && cs.split.left === 'analysis:a' && cs.split.right === 'dataset:b');

// ── Persist / restore ────────────────────────────────────────────────────────
const all = (): boolean => true;
const saved = serialize(setRatio(sp, 0.35));
let r = restore(saved, all);
ok('a serialized state restores exactly', serialize(r) === serialize(setRatio(sp, 0.35)), serialize(r));
r = restore(serialize(activate(p, 'dataset:c')), (k) => k !== 'dataset:b');
ok('records that no longer exist are dropped silently', keys(r) === 'aa,dc' && r.active === 'dataset:c');
r = restore(serialize(activate(p, 'dataset:b')), (k) => k !== 'dataset:b');
ok('…and a focused one that vanished leaves nothing focused', keys(r) === 'aa,dc' && r.active === null);
r = restore(saved, (k) => k !== 'analysis:a');
ok('a split whose unfocused side vanished restores unsplit, focus kept',
  r.split === null && r.active === 'dataset:b' && keys(r) === 'db,dc', JSON.stringify(r));
r = restore(saved, (k) => k !== 'dataset:b');
ok('a split whose FOCUSED side vanished restores unsplit, focus on the survivor',
  r.split === null && r.active === 'analysis:a', JSON.stringify(r));
r = restore(JSON.stringify({ tabs: [ds('1'), ds('1'), { kind: 'dataset' }, null, 7, viz('2')], active: 'visual:2' }), all);
ok('duplicates and malformed entries are skipped', keys(r) === 'd1,v2' && r.active === 'visual:2', keys(r));
r = restore(JSON.stringify({ tabs: [ds('1'), viz('2')], active: 'dataset:1', split: { left: 'dataset:1', right: 'visual:2', ratio: 9 } }), all);
ok('a saved ratio out of range is clamped on the way in', !!r.split && r.split.ratio === 0.8);
ok('junk in storage restores to an empty strip, never a throw',
  ['{nope', null, '', '42', '{"tabs":"x"}', undefined].every((j) => {
    const e = restore(j, all);
    return e.tabs.length === 0 && e.active === null && e.split === null;
  }));
ok('an unknown active key is dropped', restore(JSON.stringify({ tabs: [ds('1')], active: 'dataset:9' }), all).active === null);

finish();
