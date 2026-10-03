// <html data-theme> as React state, so a theme switch redraws a map or a
// thumbnail in the new colours (theme.ts writes the attribute).

import { useSyncExternalStore } from 'react';

function subscribe(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

export function useDocTheme(): string {
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme ?? '', () => '');
}
