// Vitest setup: what jsdom lacks, and Testing Library's cleanup (its auto-
// cleanup needs a global afterEach, and this config keeps globals off).

import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// App tests wait on lazy route chunks, which Vite transforms on first import;
// under a parallel run on a busy machine that alone can pass the 1 s default.
configure({ asyncUtilTimeout: 5000 });

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

// Layout APIs jsdom does not implement, which Radix's popper and the UI kit's
// Splitter / Select call. No-ops: jsdom has no layout to measure anyway.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
