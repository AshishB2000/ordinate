import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandForKey, keyCaps, keyLabel, keyToken, listCommands, recentIds, registerCommands, runCommand, score, searchCommands, type Command } from './registry';

const cmd = (id: string, title: string, extra: Partial<Command> = {}): Command => ({ id, title, group: 'Navigate', icon: 'home', run: () => {}, ...extra });

let off: Array<() => void> = [];
const reg = (list: Command[]) => off.push(registerCommands(list));
afterEach(() => {
  for (const f of off) f();
  off = [];
});

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe('command registry', () => {
  it('lists what is registered, drops what a page unregisters, hides what `when` says is absent', () => {
    let open = false;
    reg([cmd('a.one', 'One'), cmd('a.two', 'Two', { when: () => open })]);
    const page = registerCommands([cmd('p.three', 'Three')]);
    expect(listCommands().map((c) => c.id)).toEqual(['a.one', 'p.three']);
    open = true;
    expect(listCommands().map((c) => c.id)).toEqual(['a.one', 'a.two', 'p.three']);
    page();
    expect(listCommands().map((c) => c.id)).toEqual(['a.one', 'a.two']);
  });

  it('refuses a duplicate id or a key another command holds — both silent bugs otherwise', () => {
    reg([cmd('a.one', 'One', { keys: 'mod+k' })]);
    expect(() => registerCommands([cmd('a.one', 'Again')])).toThrow(/duplicate id a\.one/);
    expect(() => registerCommands([cmd('b.x', 'X', { keys: 'mod+k' })])).toThrow(/already bound to a\.one/);
    expect(listCommands()).toHaveLength(1);
  });

  it('runs through one entry point: `when` checked, recency noted; a key the owner binds is not bound here', () => {
    const run = vi.fn();
    let ok = false;
    reg([cmd('a.run', 'Run', { run, when: () => ok, keys: 'mod+j' }), cmd('a.dock', 'Dock', { keys: 'mod+l', bind: false })]);
    expect(runCommand('a.run')).toBe(false);
    expect(run).not.toHaveBeenCalled();
    ok = true;
    expect(runCommand('a.run')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(recentIds()[0]).toBe('a.run');
    expect(commandForKey('mod+j')?.id).toBe('a.run');
    expect(commandForKey('mod+l')).toBeUndefined();
  });
});

describe('ranking', () => {
  it('finds by subsequence across words, best first; every token must match', () => {
    reg([cmd('c.dash', 'New dashboard'), cmd('c.tpl', 'New dashboard from a template'), cmd('c.data', 'New dataset from a file'), cmd('n.home', 'Go to Home')]);
    expect(searchCommands('nw dsh').map((c) => c.id)).toEqual(['c.dash', 'c.tpl']);
    expect(searchCommands('new data').map((c) => c.id)[0]).toBe('c.data');
    expect(searchCommands('zzz')).toEqual([]);
    // A title that starts with the query beats one that has it later; at equal quality the shorter wins.
    expect(score('home', { title: 'Home page', group: 'Navigate' })).toBeGreaterThan(score('home', { title: 'Go to Home', group: 'Navigate' }));
    expect(score('home', { title: 'Go to Home', group: 'Navigate' })).toBeGreaterThan(score('home', { title: 'Go to Home settings', group: 'Navigate' }));
  });

  it('a recent run breaks a tie but does not outrank a better match', () => {
    const a = { id: 'x.a', title: 'Export as PDF', group: 'Data' };
    const b = { id: 'x.b', title: 'Export as PNG', group: 'Data' };
    expect(score('export', b, ['x.b'])).toBeGreaterThan(score('export', a, ['x.b']));
    expect(score('png', a, ['x.a'])).toBe(-1);
  });
});

describe('keys', () => {
  it('reads a keydown as a token: ⌘ is mod on macOS, Ctrl elsewhere, the other platform’s modifier is not', () => {
    expect(keyToken(key('k', { metaKey: true }), true)).toBe('mod+k');
    expect(keyToken(key('k', { ctrlKey: true }), true)).toBe('');
    expect(keyToken(key('k', { ctrlKey: true }), false)).toBe('mod+k');
    expect(keyToken(key('K', { ctrlKey: true, shiftKey: true }), false)).toBe('mod+shift+k');
    expect(keyToken(key('?', { shiftKey: true }), false)).toBe('?');
    expect(keyToken(key('Meta', { metaKey: true }), true)).toBe('');
    expect(keyToken(key(',', { metaKey: true }), true)).toBe('mod+,');
  });

  it('prints a chord for the platform', () => {
    expect(keyLabel('mod+k', true)).toBe('⌘K');
    expect(keyLabel('mod+k', false)).toBe('Ctrl+K');
    expect(keyCaps('mod+shift+n', true)).toEqual(['⇧', '⌘', 'N']);
    expect(keyCaps('escape', false)).toEqual(['Esc']);
    expect(keyLabel(undefined)).toBe('');
  });
});
