// Vitest setup: what jsdom lacks, and Testing Library's cleanup (its auto-
// cleanup needs a global afterEach, and this config keeps globals off).

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

// jsdom has no matchMedia. Tests that care about the OS theme set `systemDark`.
export const media = { systemDark: false };
window.matchMedia = (query: string) =>
  ({
    matches: query.includes('dark') && media.systemDark,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
