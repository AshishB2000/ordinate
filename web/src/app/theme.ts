// Light / dark / follow-the-system. The preference lives in localStorage (it is
// per browser, like the OS setting it shadows); the EFFECTIVE theme is written
// to <html data-theme>, which is all theme.css reads. public/theme-boot.js does
// the same before first paint — keep the key and the rule in step with it.
//
// ONE preference per page, shared by every caller (the account menu, Settings,
// the command palette): a module-level value behind useSyncExternalStore, so a
// change made in one is what the others show.

import { useEffect, useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];

const KEY = 'ordinate.theme';
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return darkQuery().matches ? 'dark' : 'light';
}

let current: ThemePref | null = null;
const listeners = new Set<() => void>();

function get(): ThemePref {
  current ??= readThemePref();
  return current;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
    // Nobody left showing it: the next mount reads storage again.
    if (!listeners.size) current = null;
  };
}

/** Sets the preference for this browser: stored, applied, and shown by every caller. */
export function setThemePref(p: ThemePref): void {
  current = p;
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  for (const l of listeners) l();
}

/** The preference and its setter; applies it and, on `system`, follows OS changes live. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const pref = useSyncExternalStore(subscribe, get);

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(pref);
    };
    apply();
    if (pref !== 'system') return;
    const mq = darkQuery();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);

  return [pref, setThemePref];
}
