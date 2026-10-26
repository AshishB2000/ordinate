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

// ── Canvas and highlight (Settings → You → Appearance) ──────────────────────
// Two more per-browser picks, each an attribute on <html> that appearance.css
// reads: data-canvas, the neutral ramp (Slate, the default, is no attribute),
// and data-accent, the member's own accent (none: the workspace's brand, else
// the app's blue). theme-boot.js applies both before first paint — keep the
// keys and its id rule (lowercase letters) in step with these.

export const CANVASES = [
  { id: 'slate', label: 'Slate' },
  { id: 'pure', label: 'Pure' },
  { id: 'indigo', label: 'Indigo' },
  { id: 'stone', label: 'Stone' },
  { id: 'zinc', label: 'Zinc' },
  { id: 'sand', label: 'Sand' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'forest', label: 'Forest' },
  { id: 'rose', label: 'Quartz' },
  { id: 'midnight', label: 'Ink' },
] as const;
export type CanvasPref = (typeof CANVASES)[number]['id'];

/** Each highlight's swatch is its seed (appearance.css holds what brandTokens walked it to); Monochrome is ink and chalk. */
export const HIGHLIGHTS = [
  { id: 'blue', label: 'Refined blue', hex: '#2563eb' },
  { id: 'indigo', label: 'Indigo', hex: '#4f46e5' },
  { id: 'violet', label: 'Violet', hex: '#7c3aed' },
  { id: 'teal', label: 'Ocean teal', hex: '#0d9488' },
  { id: 'emerald', label: 'Emerald', hex: '#059669' },
  { id: 'sky', label: 'Sky cyan', hex: '#0284c7' },
  { id: 'amber', label: 'Amber', hex: '#d97706' },
  { id: 'orange', label: 'Coral orange', hex: '#ea580c' },
  { id: 'rose', label: 'Rose', hex: '#e11d48' },
  { id: 'mono', label: 'Monochrome', hex: null },
] as const;
export type AccentPref = (typeof HIGHLIGHTS)[number]['id'];

/** One <html data-…> preference: stored, applied, and shown by every caller. `none` is stored as no value. */
function attrPref<T extends string>(key: string, attr: 'canvas' | 'accent', ids: readonly T[], none: T | null) {
  let value: T | null | undefined;
  const subs = new Set<() => void>();
  const read = (): T | null => {
    try {
      const v = localStorage.getItem(key) as T | null;
      return v && ids.includes(v) ? v : null;
    } catch {
      return null;
    }
  };
  return {
    get: (): T | null => (value === undefined ? (value = read()) : value),
    subscribe: (l: () => void) => {
      subs.add(l);
      return () => void subs.delete(l);
    },
    set: (v: T | null) => {
      value = v === none ? null : v;
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {
        // storage blocked: the choice lasts for this page only
      }
      const root = document.documentElement;
      if (value) root.dataset[attr] = value;
      else delete root.dataset[attr];
      for (const l of subs) l();
    },
  };
}

const canvasPref = attrPref<CanvasPref>('ordinate.canvas', 'canvas', CANVASES.map((c) => c.id), 'slate');
const accentPref = attrPref<AccentPref>('ordinate.accent', 'accent', HIGHLIGHTS.map((h) => h.id), null);

export function useCanvasPref(): [CanvasPref, (c: CanvasPref) => void] {
  return [useSyncExternalStore(canvasPref.subscribe, canvasPref.get) ?? 'slate', canvasPref.set];
}

/** `null`: no highlight of the member's own — the workspace's accent, else the app's blue. */
export function useAccentPref(): [AccentPref | null, (a: AccentPref | null) => void] {
  return [useSyncExternalStore(accentPref.subscribe, accentPref.get), accentPref.set];
}
