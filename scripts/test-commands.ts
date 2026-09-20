// The command registry — the PURE half of renderer/hub/commands.ts.
//
// What is pinned here is everything that has no excuse for being wrong and that
// a smoke run cannot see:
//
//   1. A DUPLICATE IS REFUSED, LOUDLY. Two commands with one id, or two
//      claiming one shortcut, is the failure this registry exists to prevent —
//      and it is silent if it is tolerated, because the second registration
//      wins in one surface (the palette reads a Map) and loses in another (the
//      keymap keeps the first binding). So registration throws.
//   2. `when()` FILTERS. A command whose surface is not on screen is absent,
//      not greyed out — which is the whole reason one flat list can be
//      context-aware.
//   3. RANKING. "nw dsh" has to put "New dashboard" above "New dataset" and
//      above the longer "New dashboard from a template", or the palette is a
//      list you scroll rather than a box you type into.
//   4. THE PLATFORM MAPPING. `mod` is ⌘ on macOS and Ctrl everywhere else, in
//      ONE helper — and the label, the Electron accelerator and the matcher all
//      read it. This is the half that cannot be checked on a Mac by running the
//      app, so it is checked by loading the module twice with two navigators.
//
// The module is a classic global-scope renderer script with no exports, so it
// is evaluated in a vm sandbox and the symbols read off it — the pattern
// scripts/test-dashUndo.ts and scripts/test-chartCanRender.ts already use.
//
//   npm run build:ts && node scripts/test-commands.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'hub', 'commands.js'), 'utf8');

/** A fresh realm with the two globals commands.js touches at load and at rest. */
function load(platform: string): any {
  const store: Record<string, string> = {};
  const sandbox: any = {
    console,
    navigator: { platform },
    // Renderer VIEW STATE lives in localStorage; the recency nudge reads it on
    // every score, so it has to exist or ranking throws.
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v); },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'commands.js' });
  return sandbox;
}

const mac = load('MacIntel');
const win = load('Win32');

const noop = (): void => {};
const cmd = (over: any): any =>
  Object.assign({ id: 'x', title: 'X', group: 'View', icon: 'x', run: noop }, over);

ok('commands.js loads with no document and no window',
  typeof mac.registerCommand === 'function' && typeof mac.runCommand === 'function');

// ── 1. Duplicates are refused ────────────────────────────────────────────────

const reg = load('MacIntel');
reg.registerCommand(cmd({ id: 'a.one', title: 'One', keys: 'mod+1' }));

let threwId = '';
try { reg.registerCommand(cmd({ id: 'a.one', title: 'Another One' })); }
catch (e: any) { threwId = String(e.message); }
ok('a duplicate id is refused', /duplicate id a\.one/.test(threwId), threwId || '(did not throw)');

let threwKey = '';
try { reg.registerCommand(cmd({ id: 'a.two', title: 'Two', keys: 'mod+1' })); }
catch (e: any) { threwKey = String(e.message); }
ok('a shortcut another command already holds is refused',
  /mod\+1/.test(threwKey) && /a\.one/.test(threwKey), threwKey || '(did not throw)');
ok('…and the refused command is NOT half-registered',
  reg.getCommand('a.two') === undefined);

let threwGroup = '';
try { reg.registerCommand(cmd({ id: 'a.three', group: 'Nonsense' })); }
catch (e: any) { threwGroup = String(e.message); }
ok('a group the menus do not have is refused', /unknown group/.test(threwGroup), threwGroup);

// Case and shape do not let a duplicate through: keys are canonicalised, and a
// one-key command and a many-key command are the same list.
let threwCase = '';
try { reg.registerCommand(cmd({ id: 'a.four', keys: ['mod+9', 'MOD+1'] })); }
catch (e: any) { threwCase = String(e.message); }
ok('…however the key is spelled or wrapped', /a\.one/.test(threwCase), threwCase || '(did not throw)');
ok('…and the partially-claimed key is not left bound to the refused command',
  reg.getCommand('a.four') === undefined);

// ── 2. when() filters ────────────────────────────────────────────────────────

const w = load('MacIntel');
let here = true;
w.registerCommand(cmd({ id: 'w.always', title: 'Always' }));
w.registerCommand(cmd({ id: 'w.sometimes', title: 'Sometimes', when: () => here }));
w.registerCommand(cmd({ id: 'w.never', title: 'Never', when: () => false }));
w.registerCommand(cmd({ id: 'w.broken', title: 'Broken', when: () => { throw new Error('nope'); } }));

const ids = (list: any[]): string[] => list.map((c) => c.id);
ok('every command with no when() is available',
  ids(w.listCommands()).indexOf('w.always') >= 0);
ok('a when() that is false hides the command',
  ids(w.listCommands()).indexOf('w.never') < 0, JSON.stringify(ids(w.listCommands())));
here = false;
ok('…and it is re-asked every time, not cached at registration',
  ids(w.listCommands()).indexOf('w.sometimes') < 0, JSON.stringify(ids(w.listCommands())));
ok('a when() that THROWS hides the command rather than emptying the palette',
  ids(w.listCommands()).indexOf('w.broken') < 0 && w.listCommands().length === 1);
ok('…and listCommands(false) still returns all four — the sheet documents them',
  w.listCommands(false).length === 4);

// ── 3. Ranking ───────────────────────────────────────────────────────────────

const r = load('MacIntel');
[
  ['r.dataset', 'New dataset from a file', 'Create'],
  ['r.dashboard', 'New dashboard', 'Create'],
  ['r.template', 'New dashboard from a template', 'Create'],
  ['r.visual', 'New visual', 'Create'],
  ['r.present', 'Present', 'Dashboard'],
  ['r.addMetric', 'Add a metric', 'Dashboard'],
  ['r.theme', 'Toggle dark mode', 'View'],
].forEach(([id, title, group]) => r.registerCommand(cmd({ id, title, group })));

const rank = (q: string): string[] => r.searchCommands(q).map((c: any) => c.title);

ok('"nw dsh" ranks New dashboard first',
  rank('nw dsh')[0] === 'New dashboard', JSON.stringify(rank('nw dsh')));
ok('…above the longer title that also matches',
  rank('nw dsh').indexOf('New dashboard from a template') === 1, JSON.stringify(rank('nw dsh')));
ok('…and "New dataset" does not match it at all (no h to find)',
  rank('nw dsh').indexOf('New dataset from a file') < 0, JSON.stringify(rank('nw dsh')));
ok('every token has to match — one miss drops the command',
  rank('new zzz').length === 0, JSON.stringify(rank('new zzz')));
ok('a prefix of the title wins over a scattered match elsewhere',
  rank('present')[0] === 'Present', JSON.stringify(rank('present')));
ok('the group is searchable too, below a title match',
  rank('dashboard').indexOf('Add a metric') > rank('dashboard').indexOf('New dashboard'),
  JSON.stringify(rank('dashboard')));
ok('an empty query is the whole available list, unranked',
  r.searchCommands('').length === 7);
ok('a word-start match beats the same letters mid-word',
  r.cmdScoreToken('me', 'add a metric') > r.cmdScoreToken('me', 'dark mode theme'),
  `${r.cmdScoreToken('me', 'add a metric')} vs ${r.cmdScoreToken('me', 'dark mode theme')}`);
ok('a token that is not a subsequence scores -1', r.cmdScoreToken('zq', 'new dashboard') === -1);

// Recency is the tiebreak, not the ranking: running one of two equal matches
// lifts it, and that is all it does.
const before = rank('new');
r.runCommand('r.dashboard');
const after = rank('new');
ok('a command just run rises among equals',
  after[0] === 'New dashboard' && before[0] !== 'New dashboard',
  `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
ok('…but does not outrank a better match',
  rank('nw dsh')[0] === 'New dashboard', JSON.stringify(rank('nw dsh')));

// ── 4. Platform key mapping ──────────────────────────────────────────────────

ok('mod is ⌘ on macOS', mac.keyLabel('mod+k') === '⌘K', mac.keyLabel('mod+k'));
ok('…and Ctrl everywhere else', win.keyLabel('mod+k') === 'Ctrl+K', win.keyLabel('mod+k'));
ok('modifier order is the platform\'s own', mac.keyLabel('mod+shift+n') === '⇧⌘N', mac.keyLabel('mod+shift+n'));
ok('…spelled out on Windows and Linux',
  win.keyLabel('mod+shift+n') === 'Ctrl+Shift+N', win.keyLabel('mod+shift+n'));
ok('a named key prints as a word, not as its e.key',
  mac.keyLabel('escape') === 'Esc' && mac.keyLabel('?') === '?', mac.keyLabel('escape'));
ok('a command with two keys prints the first one',
  mac.keyLabel(['mod+j', 'mod+l']) === '⌘J', mac.keyLabel(['mod+j', 'mod+l']));
ok('no keys prints nothing', mac.keyLabel(undefined) === '' && mac.keyLabel([]) === '');

ok('the Electron accelerator is platform-agnostic — one string, both OSes',
  mac.keyAccelerator('mod+shift+n') === 'CommandOrControl+Shift+N'
  && win.keyAccelerator('mod+shift+n') === 'CommandOrControl+Shift+N',
  mac.keyAccelerator('mod+shift+n'));
ok('…and names the keys Electron names',
  mac.keyAccelerator('mod+=') === 'CommandOrControl+Plus'
  && mac.keyAccelerator('escape') === 'Escape',
  mac.keyAccelerator('mod+='));

// The matcher is the same mapping read the other way: what the keyboard sends
// has to land on what was registered, and the FOREIGN modifier must not.
const ev = (over: any): any =>
  Object.assign({ key: 'k', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, over);
ok('⌘K matches mod+k on macOS', mac.cmdKeyToken(ev({ metaKey: true })) === 'mod+k');
ok('…and ⌃K does NOT — that is a different chord there',
  mac.cmdKeyToken(ev({ ctrlKey: true })) === '', mac.cmdKeyToken(ev({ ctrlKey: true })));
ok('Ctrl+K matches mod+k on Windows', win.cmdKeyToken(ev({ ctrlKey: true })) === 'mod+k');
ok('…and ⌘K does not reach it there',
  win.cmdKeyToken(ev({ metaKey: true })) === '');
ok('shift is part of a letter chord',
  mac.cmdKeyToken(ev({ key: 'n', metaKey: true, shiftKey: true })) === 'mod+shift+n');
ok('…but not of "?", which IS shift+/ — the shift is how you type it',
  mac.cmdKeyToken(ev({ key: '?', shiftKey: true })) === '?',
  mac.cmdKeyToken(ev({ key: '?', shiftKey: true })));
ok('a bare modifier is not a chord',
  mac.cmdKeyToken(ev({ key: 'Meta', metaKey: true })) === '');
ok('every registered key round-trips from a keydown back to its command',
  ['mod+1', 'mod+shift+z', 'escape'].every((k) => {
    const parts = k.split('+');
    const e = ev({
      key: parts[parts.length - 1],
      metaKey: parts.indexOf('mod') >= 0,
      shiftKey: parts.indexOf('shift') >= 0,
    });
    return mac.cmdKeyToken(e) === k;
  }));

// ── Tooltips ─────────────────────────────────────────────────────────────────

const t = load('MacIntel');
t.registerCommand(cmd({ id: 't.save', title: 'Save', keys: 'mod+s' }));
t.registerCommand(cmd({ id: 't.plain', title: 'Add a metric' }));
ok('a tooltip names the command and its key', t.tooltipFor('t.save') === 'Save (⌘S)', t.tooltipFor('t.save'));
ok('…and omits the brackets when there is no key',
  t.tooltipFor('t.plain') === 'Add a metric', t.tooltipFor('t.plain'));
ok('an unknown id falls back rather than printing "undefined"',
  t.tooltipFor('t.nope', 'Export') === 'Export' && t.tooltipFor('t.nope') === '');

// applyTooltip APPENDS the key to a control that already says something. The
// registry owns the binding, not the copy: the Agent toggle's tooltip explains
// what the dock does, and overwriting it with "Open the Assistant" traded a
// sentence that earns its place for the label already on the button.
const el: any = { title: 'Ask about what you are looking at', getAttribute: (k: string) => (k === 'title' ? el.title : null) };
t.globalThis.document = { getElementById: (id: string) => (id === 'btn' ? el : null) };
t.applyTooltip('btn', 't.save');
ok('applyTooltip keeps the control\'s own copy and adds the key',
  el.title === 'Ask about what you are looking at (⌘S)', el.title);
t.applyTooltip('btn', 't.save');
ok('…and is idempotent — a second call does not stack a second key',
  el.title === 'Ask about what you are looking at (⌘S)', el.title);
el.title = '';
t.applyTooltip('btn', 't.save');
ok('…and supplies the whole tooltip where there was none',
  el.title === 'Save (⌘S)', el.title);

// ── The menu payload ─────────────────────────────────────────────────────────

const m = load('MacIntel');
m.registerCommand(cmd({ id: 'm.present', title: 'Present', group: 'Dashboard', keys: 'mod+p', when: () => false }));
const payload = m.cmdForMenu();
ok('the menu is built from EVERY command, not just the available ones',
  payload.length === 1 && payload[0].id === 'm.present', JSON.stringify(payload));
ok('…carrying strings only — no function crosses the bridge',
  Object.values(payload[0]).every((v) => typeof v === 'string'), JSON.stringify(payload[0]));
ok('…with the accelerator Electron wants',
  payload[0].accelerator === 'CommandOrControl+P', payload[0].accelerator);

finish();
