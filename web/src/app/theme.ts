// Light / dark / follow-the-system. The preference lives in localStorage (it is
// per browser, like the OS setting it shadows); the EFFECTIVE theme is written
// to <html data-theme>, which is all theme.css reads. public/theme-boot.js does
// the same before first paint — keep the key and the rule in step with it.

import { useEffect, useState } from 'react';

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

/** The preference and its setter; applies it and, on `system`, follows OS changes live. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState(readThemePref);

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(pref);
    };
    apply();
    try {
      if (pref === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {
      // storage blocked: the choice lasts for this page only
    }
    if (pref !== 'system') return;
    const mq = darkQuery();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);

  return [pref, setPref];
}
