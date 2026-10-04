// The command registry — commands.ts, ported. ONE list of what the app can be
// told to do; the palette, the shortcuts sheet and the keymap all read it, so
// a shortcut renamed in one place cannot keep its old name in another.
//
// Commands are registered BY WHOEVER OWNS THEM, for as long as they are on
// screen: the shell registers the app-wide set (sections, theme, help…), and a
// page calls `useCommands([...])` for its own, which leave with it. `when()`
// is what makes one flat list context-aware: a command whose `when` is false
// is absent, not greyed.
//
// A command only ever navigates to an existing route or calls an existing
// contracted channel through the same function its button calls — nothing here
// re-implements a flow.

import { useEffect, useSyncExternalStore } from 'react';
import type { IconName } from '../../ui/icons/Icon';

export const GROUPS = ['Navigate', 'Create', 'Data', 'Assistant', 'View', 'Settings', 'Help'] as const;
export type Group = (typeof GROUPS)[number];

export interface Command {
  /** `area.verb`, stable: the recency list keys off it. */
  id: string;
  title: string;
  group: Group;
  icon: IconName;
  /** Canonical chord, e.g. 'mod+k'. `mod` is ⌘ on macOS, Ctrl elsewhere. */
  keys?: string;
  /** False: the key is bound by its owner (the dock binds ⌘L itself) — shown here, not bound here. */
  bind?: boolean;
  /** False hides the command everywhere and makes running it a no-op. */
  when?: () => boolean;
  run: () => void;
}

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const l of listeners) l();
}

/**
 * Adds commands; returns the function that removes them. A duplicate id or a
 * key another command holds throws — both are programming errors that would
 * otherwise win in one surface and lose in another.
 */
export function registerCommands(list: readonly Command[]): () => void {
  const keys = new Map<string, string>();
  for (const c of registry.values()) if (c.keys) keys.set(c.keys, c.id);
  for (const c of list) {
    if (registry.has(c.id)) throw new Error(`registerCommands: duplicate id ${c.id}`);
    const held = c.keys ? keys.get(c.keys) : undefined;
    if (held) throw new Error(`registerCommands: ${c.id} wants ${c.keys}, already bound to ${held}`);
    if (c.keys) keys.set(c.keys, c.id);
  }
  for (const c of list) registry.set(c.id, c);
  changed();
  return () => {
    for (const c of list) if (registry.get(c.id) === c) registry.delete(c.id);
    changed();
  };
}

/** Registers `list` while the calling component is mounted. Memoize it (useMemo): a new list re-registers. */
export function useCommands(list: readonly Command[]): void {
  useEffect(() => registerCommands(list), [list]);
}

export function available(c: Command): boolean {
  try {
    return !c.when || c.when();
  } catch {
    return false;
  }
}

/** Every available command, registration order. */
export function listCommands(): Command[] {
  return [...registry.values()].filter(available);
}

/** Re-renders the caller when commands come or go. */
export function useRegistryVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** Runs a command by id — the ONE entry point, so `when()` is checked exactly once. */
export function runCommand(id: string): boolean {
  const c = registry.get(id);
  if (!c || !available(c)) return false;
  noteRun(id);
  c.run();
  return true;
}

/** The command a keydown token is bound to, if this registry binds it. */
export function commandForKey(token: string): Command | undefined {
  for (const c of registry.values()) if (c.keys === token && c.bind !== false && available(c)) return c;
  return undefined;
}

// ── Keys ────────────────────────────────────────────────────────────────────

export const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

const KEY_NAMES: Record<string, string> = { escape: 'Esc', enter: '↵', arrowup: '↑', arrowdown: '↓', ',': ',', '?': '?', '/': '/' };

/** The chord as key caps: ['⌘', 'K'] on macOS, ['Ctrl', 'K'] elsewhere. */
export function keyCaps(keys: string | undefined, mac = IS_MAC): string[] {
  if (!keys) return [];
  const parts = keys.split('+');
  const main = parts[parts.length - 1];
  const name = KEY_NAMES[main] ?? (main.length === 1 ? main.toUpperCase() : main);
  const caps: string[] = [];
  if (parts.includes('alt')) caps.push(mac ? '⌥' : 'Alt');
  if (parts.includes('shift')) caps.push(mac ? '⇧' : 'Shift');
  if (parts.includes('mod')) caps.push(mac ? '⌘' : 'Ctrl');
  return [...caps, name];
}

/** One string: '⌘K' on macOS, 'Ctrl+K' elsewhere. */
export function keyLabel(keys: string | undefined, mac = IS_MAC): string {
  return keyCaps(keys, mac).join(mac ? '' : '+');
}

/**
 * A keydown as a canonical token, or '' for a bare modifier or the other
 * platform's modifier (on macOS ⌃K must not fire ⌘K). '?' is shift+/ — the
 * shift is how it is typed, not part of the binding.
 */
export function keyToken(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac = IS_MAC): string {
  const key = String(e.key || '');
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') return '';
  if (mac ? e.ctrlKey : e.metaKey) return '';
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.shiftKey && key.length === 1 && /[a-z0-9]/i.test(key)) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(key.toLowerCase());
  return parts.join('+');
}

/** Whether a keystroke is being typed into something rather than commanded. */
export function inTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

// ── Ranking ─────────────────────────────────────────────────────────────────
// Fuzzy, subsequence, whitespace-separated tokens: "nw dat" finds "New
// dataset". Every token has to match somewhere or the command is out.

function scoreToken(tok: string, text: string): number {
  let from = 0;
  let prev = -1;
  let score = 0;
  for (const ch of tok) {
    const idx = text.indexOf(ch, from);
    if (idx < 0) return -1;
    if (idx === 0 || text[idx - 1] === ' ' || text[idx - 1] === '-') score += 8; // start of a word
    if (prev >= 0 && idx === prev + 1) score += 6; // runs beat scatter
    else if (prev >= 0) score -= Math.min(idx - prev - 1, 8); // …but a gap is not fatal
    prev = idx;
    from = idx + 1;
  }
  return score;
}

/** -1 = do not show. Title beats group; shorter beats longer; recent gets a nudge. */
export function score(query: string, c: { title: string; group: string; id?: string }, recent: readonly string[] = []): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const title = c.title.toLowerCase();
  const group = c.group.toLowerCase();
  let total = 0;
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const inTitle = scoreToken(tok, title);
    const inGroup = scoreToken(tok, group);
    const best = Math.max(inTitle, inGroup < 0 ? -1 : inGroup - 6);
    if (best < 0) return -1;
    total += best;
  }
  if (title.startsWith(q)) total += 12;
  total -= title.length / 20;
  const i = c.id ? recent.indexOf(c.id) : -1;
  if (i >= 0) total += (RECENT_MAX - i) / 4;
  return total;
}

/** Commands matching `query`, best first; empty query → the available list. */
export function searchCommands(query: string): Command[] {
  const avail = listCommands();
  if (!query.trim()) return avail;
  const recent = recentIds();
  return avail
    .map((c) => ({ c, s: score(query, c, recent) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.c);
}

// ── Recency: per browser, so localStorage ───────────────────────────────────

const RECENT_KEY = 'ordinate.commands.recent';
const RECENT_MAX = 12;

export function recentIds(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function noteRun(id: string): void {
  const list = [id, ...recentIds().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // storage blocked: no recency nudge
  }
}
