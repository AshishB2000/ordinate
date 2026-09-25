'use strict';

// The command registry — ONE list of everything the app can be told to do.
//
// Four surfaces used to each carry their own copy of "what can I do here": the
// keyboard (a keydown handler per feature file), the palette, a shortcuts
// sheet, and the native menu bar. Four lists drift — a shortcut renamed in one
// place keeps its old name in a tooltip, a menu item points at a flow that was
// deleted. So there is one list, and all four READ it:
//
//   keyboard    → cmdKeydown() below, the ONLY keydown handler that binds a
//                 shortcut. Surfaces declare `keys` on the command; they do not
//                 bind them.
//   palette     → palette.ts
//   sheet       → palette.ts (paletteShowShortcuts)
//   menu bar    → src/ipc/menu.ts, built from cmdForMenu() at boot
//   tooltips    → tooltipFor(id)
//
// Classic global-scope renderer <script>: no import/export. Loads BEFORE
// commandDefs.js (which registers) and palette.js (which reads).

// ── Shape ────────────────────────────────────────────────────────────────────

/** The menus a command can appear under. Order is the order they are shown in. */
const CMD_GROUPS = ['Navigate', 'Create', 'Data', 'Visual', 'Dashboard', 'Assistant', 'View', 'Help'] as const;
type CommandGroup = (typeof CMD_GROUPS)[number];

interface Command {
  /** `area.verb`, stable — the menu bar and any saved recency list key off it. */
  id: string;
  title: string;
  group: CommandGroup;
  /** A name from the icon sprite (icons.ts). */
  icon: string;
  /** Canonical key strings, e.g. 'mod+shift+n'. `mod` is ⌘ on macOS, Ctrl elsewhere. */
  keys?: string | string[];
  /** False hides the command everywhere and makes running it a no-op. */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const CMD_REGISTRY = new Map<string, Command>();
/** key → command id, so a second claim on a shortcut is caught at registration. */
const CMD_BY_KEY = new Map<string, string>();

/**
 * Add a command. Throws on a duplicate id or a shortcut another command already
 * holds — both are programming errors, and both are silent if they are tolerated:
 * the second registration would win in one surface and lose in another.
 */
function registerCommand(cmd: Command): Command {
  if (!cmd || !cmd.id) throw new Error('registerCommand: a command needs an id');
  if (CMD_REGISTRY.has(cmd.id)) throw new Error('registerCommand: duplicate id ' + cmd.id);
  if (CMD_GROUPS.indexOf(cmd.group) < 0) throw new Error('registerCommand: unknown group ' + cmd.group);
  for (const k of cmdKeysOf(cmd)) {
    const held = CMD_BY_KEY.get(k);
    if (held) throw new Error(`registerCommand: ${cmd.id} wants ${k}, already bound to ${held}`);
  }
  CMD_REGISTRY.set(cmd.id, cmd);
  for (const k of cmdKeysOf(cmd)) CMD_BY_KEY.set(k, cmd.id);
  return cmd;
}

/** A command's keys, always as an array (they are declared either way). */
function cmdKeysOf(cmd: { keys?: string | string[] }): string[] {
  if (!cmd.keys) return [];
  return (Array.isArray(cmd.keys) ? cmd.keys : [cmd.keys]).map((k) => String(k).toLowerCase());
}

function getCommand(id: string): Command | undefined {
  return CMD_REGISTRY.get(id);
}

/** Every command, registration order. `available` filters on `when()`. */
function listCommands(available = true): Command[] {
  const all = Array.from(CMD_REGISTRY.values());
  return available ? all.filter(cmdAvailable) : all;
}

function cmdAvailable(cmd: Command): boolean {
  if (typeof cmd.when !== 'function') return true;
  try { return !!cmd.when(); } catch (_) { return false; }
}

/** Run a command by id — the ONE entry point. The palette, the keymap and the
 *  native menu all come through here, so `when()` is checked exactly once. */
function runCommand(id: string): void {
  const cmd = CMD_REGISTRY.get(id);
  if (!cmd) { console.warn('[commands] no such command', id); return; }
  if (!cmdAvailable(cmd)) {
    // Reachable from the menu bar, which is built once at boot and so offers
    // commands that are not applicable on the current surface.
    if (typeof showToast === 'function') showToast('Not available here');
    return;
  }
  cmdNoteRun(id);
  try {
    const r = cmd.run();
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch((e) => console.warn('[commands]', id, e));
    }
  } catch (e) {
    console.warn('[commands]', id, e);
  }
}

// ── Platform keys ────────────────────────────────────────────────────────────
// ONE helper decides what `mod` means, and everything that prints or matches a
// shortcut goes through it. Without that, "⌘K" is hard-coded in the top bar on
// a machine where the binding is Ctrl+K.

const CMD_IS_MAC = navigator.platform.toLowerCase().indexOf('mac') >= 0;

/** '⌘⇧N' on macOS, 'Ctrl+Shift+N' elsewhere. */
function keyLabel(keys: string | string[] | undefined): string {
  const k = Array.isArray(keys) ? keys[0] : keys;
  if (!k) return '';
  const parts = String(k).toLowerCase().split('+');
  const main = parts[parts.length - 1];
  const mod = parts.indexOf('mod') >= 0;
  const shift = parts.indexOf('shift') >= 0;
  const alt = parts.indexOf('alt') >= 0;
  const name = CMD_KEY_NAMES[main] || (main.length === 1 ? main.toUpperCase() : main);
  if (CMD_IS_MAC) return (alt ? '⌥' : '') + (shift ? '⇧' : '') + (mod ? '⌘' : '') + name;
  const pre: string[] = [];
  if (mod) pre.push('Ctrl');
  if (alt) pre.push('Alt');
  if (shift) pre.push('Shift');
  return pre.concat(name).join('+');
}

/** Printed names for the keys whose `e.key` is a word or a symbol. */
const CMD_KEY_NAMES: Record<string, string> = {
  escape: 'Esc',
  enter: '↵',
  ',': ',',
  '?': '?',
  '=': '+',
  '-': '−',
  '0': '0',
};

/** The same key as an Electron accelerator, for the native menu. */
function keyAccelerator(keys: string | string[] | undefined): string {
  const k = Array.isArray(keys) ? keys[0] : keys;
  if (!k) return '';
  const parts = String(k).toLowerCase().split('+');
  const main = parts[parts.length - 1];
  const out: string[] = [];
  if (parts.indexOf('mod') >= 0) out.push('CommandOrControl');
  if (parts.indexOf('alt') >= 0) out.push('Alt');
  if (parts.indexOf('shift') >= 0) out.push('Shift');
  out.push(CMD_ACCEL_NAMES[main] || (main.length === 1 ? main.toUpperCase() : main));
  return out.join('+');
}

const CMD_ACCEL_NAMES: Record<string, string> = {
  escape: 'Escape',
  enter: 'Return',
  ',': ',',
  '=': 'Plus',
  '-': '-',
};

/**
 * Keys matched by POSITION (e.code), not by the character they type. ⌘⇧] types
 * '}' on a US layout (and something else again on others), so a binding written
 * 'mod+shift+]' would never match off e.key. For these three the physical key
 * IS the binding, and shift is part of the chord — as it is for a letter.
 */
const CMD_CODE_KEYS: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Backslash: '\\' };

/** A keydown as a canonical key string, or '' for a bare modifier. */
function cmdKeyToken(e: KeyboardEvent): string {
  const key = String(e.key || '');
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') return '';
  // The platform's own modifier and no other: on macOS ⌃K must not fire ⌘K.
  const mod = CMD_IS_MAC ? e.metaKey : e.ctrlKey;
  const foreign = CMD_IS_MAC ? e.ctrlKey : e.metaKey;
  if (foreign) return '';
  const byCode = CMD_CODE_KEYS[String(e.code || '')];
  const parts: string[] = [];
  if (mod) parts.push('mod');
  // '?' IS shift+/ — the shift is how you type it, not part of the binding.
  if (e.shiftKey && (byCode || (key.length === 1 && /[a-z0-9]/i.test(key)))) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(byCode || key.toLowerCase());
  return parts.join('+');
}

/**
 * The chords a text field OWNS. ⌘Z inside a <textarea> means "undo my typing",
 * and a command that took that key while the caret was in one would be a
 * data-loss bug wearing a shortcut — which is exactly the guard dashHistory.ts
 * carried before its binding moved here, generalised so the next command to
 * claim ⌘A or ⌘V inherits it instead of rediscovering it.
 */
const CMD_NATIVE_EDIT_KEYS = new Set(['z', 'y', 'x', 'c', 'v', 'a']);

/** Whether a keystroke is being typed into something rather than commanded. */
function cmdInTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || !!el.isContentEditable;
}

// ── The keymap ───────────────────────────────────────────────────────────────

/**
 * The one keydown handler that runs commands. Capture phase, because a focused
 * textarea (the dock composer, the rules box) would otherwise swallow ⌘-chords
 * before they ever bubble.
 *
 * Two rules:
 *  - A plain key ('?') never fires while the caret is in a text field. A ⌘ chord
 *    does — that is what makes ⌘S mean save while you are naming a card — unless
 *    it is one the field itself owns (CMD_NATIVE_EDIT_KEYS).
 *  - Escape belongs to whatever layer is on top, so it is not dispatched here
 *    unless the palette or the sheet is holding it. Anything else (the dock, a
 *    modal) still gets its own Escape, unprevented.
 */
function cmdKeydown(e: KeyboardEvent): void {
  const token = cmdKeyToken(e);
  if (!token) return;
  if (token === 'escape') {
    if (typeof paletteCloseTop === 'function' && paletteCloseTop()) e.preventDefault();
    return;
  }
  // An open palette owns the keyboard: it is the top-most layer, and a ⌘ chord
  // that fired a command underneath it would act on a surface the user cannot
  // see. Its OWN key is the exception — ⌘K twice puts it away again — and that
  // is read from the registry rather than spelled out, so rebinding it keeps
  // the toggle.
  if (typeof paletteIsOpen === 'function' && paletteIsOpen()) {
    if (CMD_BY_KEY.get(token) === 'view.palette') { e.preventDefault(); paletteClose(); }
    return;
  }
  const id = CMD_BY_KEY.get(token);
  if (!id) return;
  const isChord = token.indexOf('mod+') === 0;
  const main = token.split('+').pop() as string;
  if ((!isChord || CMD_NATIVE_EDIT_KEYS.has(main)) && cmdInTextField(e.target)) return;
  const cmd = CMD_REGISTRY.get(id);
  if (!cmd || !cmdAvailable(cmd)) return;
  e.preventDefault();
  runCommand(id);
}

function initCommands(): void {
  document.addEventListener('keydown', cmdKeydown, true);
}

// ── Tooltips ─────────────────────────────────────────────────────────────────

/**
 * `title` text for a control that runs a command: its own label plus the key
 * that does the same thing. Read from the registry, so a rebinding moves the
 * tooltip with it instead of leaving the old key printed on a button.
 */
function tooltipFor(id: string, fallback?: string): string {
  const cmd = CMD_REGISTRY.get(id);
  const label = (cmd && cmd.title) || fallback || '';
  const key = cmd ? keyLabel(cmd.keys) : '';
  return key ? `${label} (${key})` : label;
}

/**
 * Put the registry's SHORTCUT on an element that already has a tooltip, or the
 * whole tooltip on one that has none.
 *
 * The registry owns the key, not the copy. The Agent toggle's tooltip says what
 * the dock does differently from the Ask page — replacing that with the
 * command's bare title would trade a sentence that earns its place for a label
 * the button already carries.
 */
function applyTooltip(elId: string, commandId: string): void {
  const el = document.getElementById(elId);
  if (!el) return;
  const cmd = CMD_REGISTRY.get(commandId);
  const key = cmd ? keyLabel(cmd.keys) : '';
  const own = (el.getAttribute('title') || '').trim();
  if (!key) { if (!own && cmd) el.title = cmd.title; return; }
  if (own.indexOf(key) >= 0) return; // already says it
  el.title = own ? `${own} (${key})` : tooltipFor(commandId);
}

// ── Ranking ──────────────────────────────────────────────────────────────────
// Fuzzy, subsequence, whitespace-separated tokens: "nw dsh" finds "New
// dashboard". Every token has to match somewhere or the command is out, so a
// longer query narrows rather than drifting.

/** One token against one string. -1 for no match; higher is a better match. */
function cmdScoreToken(tok: string, text: string): number {
  let from = 0;
  let prev = -1;
  let score = 0;
  for (let i = 0; i < tok.length; i++) {
    const idx = text.indexOf(tok[i], from);
    if (idx < 0) return -1;
    if (idx === 0 || text[idx - 1] === ' ' || text[idx - 1] === '-') score += 8; // start of a word
    if (prev >= 0 && idx === prev + 1) score += 6;                               // runs beat scatter
    else if (prev >= 0) score -= Math.min(idx - prev - 1, 8);                    // …but a gap is not fatal
    prev = idx;
    from = idx + 1;
  }
  return score;
}

/**
 * Score a query against a command. -1 means "do not show it".
 *
 * Title matches beat group matches; a shorter title beats a longer one at equal
 * quality (so "New dashboard" outranks "New dashboard from template"); and a
 * command run recently gets a nudge, which is the "then recency" half of the
 * ranking.
 */
function cmdScore(query: string, cmd: { title: string; group: string; id?: string }): number {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const title = cmd.title.toLowerCase();
  const group = String(cmd.group || '').toLowerCase();
  let total = 0;
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const inTitle = cmdScoreToken(tok, title);
    const inGroup = cmdScoreToken(tok, group);
    const best = Math.max(inTitle, inGroup < 0 ? -1 : inGroup - 6);
    if (best < 0) return -1;
    total += best;
  }
  if (title.indexOf(q) === 0) total += 12;
  total -= title.length / 20;
  if (cmd.id) total += cmdRecency(cmd.id);
  return total;
}

/** Commands matching `query`, best first. Empty query → the available list. */
function searchCommands(query: string): Command[] {
  const q = String(query || '').trim();
  const avail = listCommands();
  if (!q) return avail;
  return avail
    .map((c) => ({ c, s: cmdScore(q, c) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.c);
}

// ── Recency ──────────────────────────────────────────────────────────────────
// Renderer view state, so localStorage — never config.json.

const CMD_RECENT_KEY = 'ordCmdRecent';
const CMD_RECENT_MAX = 12;

function cmdRecentIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CMD_RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
  } catch (_) { return []; }
}

function cmdNoteRun(id: string): void {
  const list = cmdRecentIds().filter((x) => x !== id);
  list.unshift(id);
  try { localStorage.setItem(CMD_RECENT_KEY, JSON.stringify(list.slice(0, CMD_RECENT_MAX))); } catch (_) { /* private mode */ }
}

/** A small bonus, biggest for the most recent — enough to break a tie, not to
 *  outrank a better match. */
function cmdRecency(id: string): number {
  const i = cmdRecentIds().indexOf(id);
  return i < 0 ? 0 : (CMD_RECENT_MAX - i) / 4;
}

// ── The native menu ──────────────────────────────────────────────────────────

/** The registry, flattened for main to build the application menu from. */
function cmdForMenu(): { id: string; title: string; group: string; accelerator: string }[] {
  return listCommands(false).map((c) => ({
    id: c.id,
    title: c.title,
    group: c.group,
    accelerator: keyAccelerator(c.keys),
  }));
}

/**
 * Hand the registry to main once, and take menu clicks back.
 *
 * ponytail: built ONCE, at boot, with every command enabled. A menu that
 * tracked `when()` would have to be rebuilt on every section switch; instead an
 * inapplicable item says "Not available here" (runCommand). Rebuild per section
 * if that ever reads as broken rather than as honest.
 */
function initCommandMenu(): void {
  const bridge = window.hub as any;
  if (!bridge || typeof bridge.buildMenu !== 'function') return;
  bridge.buildMenu(cmdForMenu());
  if (typeof bridge.onMenuRun === 'function') bridge.onMenuRun((id: string) => runCommand(String(id)));
}
