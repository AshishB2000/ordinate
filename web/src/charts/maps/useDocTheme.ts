// <html data-theme> as React state, so a theme switch redraws a map or a
// thumbnail in the new colours (theme.ts writes the attribute).

import { useSyncExternalStore } from 'react';

function watch(attrs: string[]) {
  return (cb: () => void): (() => void) => {
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: attrs });
    return () => mo.disconnect();
  };
}

const onTheme = watch(['data-theme']);
// The canvas and highlight (Settings → Appearance) and the workspace accent (prefs.ts writes --brand-* inline).
const onAppearance = watch(['data-theme', 'data-canvas', 'data-accent', 'style']);

export function useDocTheme(): string {
  return useSyncExternalStore(onTheme, () => document.documentElement.dataset.theme ?? '', () => '');
}

/** Everything that recolours a canvas-drawn picture, as one key: a change redraws it. */
export function useDocAppearance(): string {
  return useSyncExternalStore(
    onAppearance,
    () => {
      const r = document.documentElement;
      return [r.dataset.theme, r.dataset.canvas, r.dataset.accent, r.style.getPropertyValue('--brand-accent')].join('|');
    },
    () => '',
  );
}
