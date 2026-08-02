// Entry point for the hub's Svelte islands.
//
// scripts/build-svelte.js bundles this file (and everything it imports) into
// `renderer/hub/svelte/bundle.js`, an IIFE that assigns ONE global:
//
//     window.OrdinateSvelte = { mountIsland, unmountIsland, version, … }
//
// That is the whole public surface. During the phased migration the hub is two
// worlds at once — ~23 classic global-scope <script>s plus this bundle — and
// they talk across exactly two seams:
//
//   vanilla -> svelte : window.OrdinateSvelte.<fn>()  (esbuild's globalName)
//   svelte  -> vanilla: window.hub.*      (preload bridge, a real window prop)
//                       window.<name>     (globals a script explicitly assigns)
//                       <bareName>        (a script's top-level const/let/class
//                                          lives in the GLOBAL LEXICAL scope and
//                                          is NOT on window — bare name only)
//
// The third case is the one that surprises people, so Island.svelte probes it
// on screen. It is also TDZ-sensitive: a bare read before the defining <script>
// has executed throws. Read globals at CALL time, never at module init — which
// is the same call-time-resolution discipline the classic scripts already use.
//
// This file must stay import-cycle-free with the classic world: it may READ
// globals, but nothing here should be required for a classic script to boot.

import { mount, unmount } from 'svelte';
import Island from './Island.svelte';

/** Injected by esbuild `define` at build time. */
declare const __SVELTE_VERSION__: string;

/** Every live island, so the bundle can tear itself down (dev/HMR-less reload). */
const live = new Map<Element, Record<string, any>>();

export const version: string = __SVELTE_VERSION__;

/**
 * Mount the spike island into `host`.
 *
 * Returns the component's instance exports (Svelte 5 `mount()` returns them),
 * which is how the classic scripts call INTO a component — e.g.
 * `window.OrdinateSvelte.mountIsland(el).setNote('hello')`.
 */
export function mountIsland(
  host: Element | string,
  props: Record<string, unknown> = {},
): Record<string, any> | null {
  const el = typeof host === 'string' ? document.getElementById(host) : host;
  if (!el) return null;
  const existing = live.get(el);
  if (existing) return existing;
  const api = mount(Island, { target: el, props }) as Record<string, any>;
  live.set(el, api);
  return api;
}

/** Tear an island down. Safe to call twice. */
export function unmountIsland(host: Element | string): void {
  const el = typeof host === 'string' ? document.getElementById(host) : host;
  if (!el) return;
  const api = live.get(el);
  if (!api) return;
  live.delete(el);
  unmount(api);
}

// ── auto-mount ──────────────────────────────────────────────────────────────
// The bundle's <script src> is the LAST one in index.html, after hub.js, so the
// DOM and every classic global already exist by the time this runs. Guarded by
// readyState anyway — the ordering is a property of index.html, not of Svelte,
// and index.html is edited by people.
const HOST_ID = 'svelte-island-host';

/**
 * The spike island is DEVELOPER EVIDENCE, not product. Without this gate it
 * auto-mounted a debug card — tick counter, "Probe globals", "not probed" — at
 * the top of the Projects home screen, the first thing every user sees.
 *
 * Same mechanism as `scMosaic` (plotRender.ts) and `scAllCharts`
 * (renderResult.ts): read at call time so devtools can flip it without a
 * rebuild, strict `=== '1'`, default off because `getItem` returns null.
 *
 * The bundle still LOADS unflagged, deliberately — that is what keeps the
 * toolchain honest, because a broken or stale bundle stays a console error on
 * every launch rather than something only a flag-holder would ever see.
 */
export function svelteIslandEnabled(): boolean {
  try {
    return localStorage.getItem('scSvelte') === '1';
  } catch {
    return false; // localStorage unavailable — stay off
  }
}

function autoMount(): void {
  if (!svelteIslandEnabled()) return;
  const host = document.getElementById(HOST_ID);
  if (host) mountIsland(host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoMount, { once: true });
} else {
  autoMount();
}
