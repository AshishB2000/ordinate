// The e2e fixtures, on the `playwright` library and node:test (the repo has
// no @playwright/test). Every spec goes through `e2e()`, which gives each test
// a fresh browser context wired with `failOnConsoleError` and `rpcBudget`, and
// fails the test when either reports — so no spec can forget them.
//
//   failOnConsoleError(page)  console errors, uncaught page errors and CSP
//                             violations (securitypolicyviolation) → failure
//   rpcBudget(page, n = 25)   POST /api/rpc/* counted per page load; a load
//                             over n → failure (plan §9: a chatty UI)
//   screens(page, name)       one full-page screenshot per theme into
//                             web/e2e/__screens__/<name>-<light|dark>.png
//
// Browser: E2E_BROWSER = chromium (default) | firefox | webkit. E2E_CHROMIUM =
// a Chromium executable to drive instead of Playwright's own download (a dev
// machine whose cache holds a different revision).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';
import { startServer, type Server } from './server.ts';

export const SCREENS = fileURLToPath(new URL('./__screens__/', import.meta.url));
const THEME_KEY = 'ordinate.theme'; // web/src/app/theme.ts + public/theme-boot.js

export async function launchBrowser(): Promise<Browser> {
  const name = process.env.E2E_BROWSER || 'chromium';
  const types = { chromium, firefox, webkit } as const;
  if (!(name in types)) throw new Error(`E2E_BROWSER must be chromium, firefox or webkit, got ${name}`);
  const executablePath = name === 'chromium' ? process.env.E2E_CHROMIUM || undefined : undefined;
  // Maps need WebGL2. Headless Chromium has no GPU and draws through SwiftShader,
  // which newer Chromium only allows for WebGL with this flag (T1.3).
  const args = name === 'chromium' ? ['--enable-unsafe-swiftshader'] : [];
  // Firefox has no clipboard permission to grant (grantClipboard); its testing pref lets a page
  // read back what it copied without the paste prompt no one is there to click.
  const firefoxUserPrefs = name === 'firefox' ? { 'dom.events.testing.asyncClipboard': true } : undefined;
  return types[name as keyof typeof types].launch({ executablePath, args, firefoxUserPrefs });
}

// WebKit's console line for a refused stylesheet. It carries no source (line 0
// even when the app's own script added the <style>), so it cannot be told apart;
// the securitypolicyviolation event WebKit fires with it can, and is what counts.
const WEBKIT_SHEET_REFUSED = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive";

/** Starts collecting what must never happen on a page. The returned function lists it so far. */
export async function failOnConsoleError(page: Page): Promise<() => string[]> {
  const webkit = page.context().browser()?.browserType().name() === 'webkit';
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (webkit && m.text().startsWith(WEBKIT_SHEET_REFUSED)) return; // reported by the event below
    const at = m.location();
    problems.push(`console error: ${m.text()}${at.url ? ` (${at.url}:${at.lineNumber})` : ''}`);
  });
  page.on('pageerror', (e) => {
    // A load the departing page starts while a goto or reload is under way (a timer's batch, a
    // component mounting) is refused by WebKit, which reports it as an error of that page:
    // "Fetch API cannot load http://<this server>/… due to access control checks." No access check
    // applies to a same-origin request, so on this origin it can only be that. A cross-origin
    // refusal (a map tile without CORS) names another host, and still fails the test.
    if (webkit && /^(Fetch API|EventSource) cannot load https?$/.test(e.name) && e.message.startsWith(`/${new URL(page.url()).host}/`) && e.message.endsWith(' due to access control checks.')) return;
    problems.push(`page error: ${e.message}`);
  });
  // Firefox and WebKit do not always log a CSP refusal to the console; the event is the reliable signal.
  await page.exposeFunction('__e2eCsp', (v: string) => problems.push(`CSP violation: ${v}`));
  await page.addInitScript((webkit) => {
    const report = (window as unknown as { __e2eCsp(v: string): void }).__e2eCsp;
    document.addEventListener('securitypolicyviolation', (e) => {
      // Playwright's own, not the app's: on WebKit every page.screenshot() appends and at once
      // removes a `<style>body {}</style>` from its utility world to resync animations
      // (playwright-core inPagePrepareForScreenshots, WKPage.shouldToggleStyleSheetToSyncAnimations).
      // style-src 'self' rightly refuses it. Only that one has no source file (the driver evaluated
      // it; the page loaded no script for it) AND is gone when the event fires (target = document).
      // The app's own inline <style> names its script; the negative control's is still attached.
      if (webkit && e.violatedDirective === 'style-src-elem' && e.blockedURI === 'inline' && !e.sourceFile && e.target === document) return;
      report(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`);
    });
  }, webkit);
  return () => [...problems];
}

/**
 * Lets the page read back what it copied. The permission names are per engine:
 * WebKit knows only clipboard-read, Firefox neither (launchBrowser sets its
 * testing pref instead) — granting an unknown name throws.
 */
export async function grantClipboard(page: Page, origin?: string): Promise<void> {
  const names = { chromium: ['clipboard-read', 'clipboard-write'], webkit: ['clipboard-read'] }[page.context().browser()?.browserType().name() ?? ''];
  if (names) await page.context().grantPermissions(names, origin ? { origin } : undefined);
}

export interface RpcLoad {
  readonly url: string;
  rpcs: number;
}

/**
 * Counts RPCs per page load. A "load" is a document load (goto, reload) or a
 * client-side route change, so each screen is measured on its own. A history
 * update that keeps the URL (React Router's startup replaceState) is not one.
 */
export function rpcBudget(page: Page, n = 25): { loads: readonly RpcLoad[]; problems(): string[] } {
  const loads: RpcLoad[] = [];
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads.push({ url: r.url(), rpcs: 0 });
    const current = loads.at(-1);
    if (current && r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/rpc/')) current.rpcs += 1;
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && f.url() !== loads.at(-1)?.url) loads.push({ url: f.url(), rpcs: 0 });
  });
  return {
    loads,
    problems: () => loads.filter((l) => l.rpcs > n).map((l) => `RPC budget: ${l.rpcs} RPCs on ${l.url} (budget ${n})`),
  };
}

/**
 * Records what the page hands `navigator.clipboard.writeText` from now on (and still writes it).
 * Call it right before the click that copies: a navigation drops it. Every copy in the app goes
 * through writeText.
 */
export async function watchCopies(page: Page): Promise<void> {
  await page.evaluate(() => {
    const clip = navigator.clipboard;
    const write = clip.writeText.bind(clip);
    clip.writeText = (text: string) => {
      (window as unknown as { __copied?: string }).__copied = text;
      return write(text);
    };
  });
}

/**
 * What the page last copied. Chromium and Firefox read the clipboard itself back; WebKit on the
 * Linux runner refuses `readText()` with no real user gesture, permission or not, so there it is
 * the text the page handed writeText (`watchCopies`) — the copy itself still had to succeed, which
 * the app's own "copied" toast says.
 */
export async function copiedText(page: Page): Promise<string> {
  if (page.context().browser()?.browserType().name() === 'webkit') {
    return page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '');
  }
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * The CSRF token (T6.2) for an RPC a spec sends itself. Any /api/ reply sets
 * the cookie. Not a page load: the spec's next goto would cut it off mid-load,
 * and WebKit reports every cut-off request (the event stream, a lazy chunk's
 * CSS) as a page error.
 */
export async function csrfToken(s: Pick<Session, 'page' | 'server'>): Promise<string> {
  const cookie = async () => (await s.page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value;
  const have = await cookie();
  if (have) return have;
  await s.page.request.get(`${s.server.base}/api/auth/me`);
  return (await cookie()) ?? '';
}

/**
 * Whether the engine gives the page WebGL2, which MapLibre needs (the app asks
 * the same in maps/maplibre.ts). Headless Firefox on the nightly's GPU-less
 * Linux runner has none — the app then shows its designed "This map needs
 * WebGL" state, which a map spec checks there instead of the drawn map.
 */
export async function hasWebGL2(page: Page): Promise<boolean> {
  const has = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  // Chromium is launched with SwiftShader for exactly this (launchBrowser): there a missing WebGL2 would
  // let every map step pass on its fallback unchecked — the per-PR job's maps — so it fails instead.
  if (!has && page.context().browser()?.browserType().name() === 'chromium') throw new Error('Chromium has no WebGL2: the maps would go unchecked.');
  return has;
}

/** Waits for the routed page to finish: its heading is up and no skeleton is busy. */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => !!document.querySelector('main h1') && !document.querySelector('[aria-busy="true"]'));
}

/**
 * One screenshot per theme, switched the way the app switches it (the stored
 * preference, applied before first paint by theme-boot.js), then the
 * preference the page had is put back. Returns the files written.
 */
export async function screens(page: Page, name: string): Promise<string[]> {
  mkdirSync(SCREENS, { recursive: true });
  const prev = await page.evaluate((k) => localStorage.getItem(k), THEME_KEY);
  const files: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(([k, t]) => localStorage.setItem(k, t), [THEME_KEY, theme] as const);
    await page.reload();
    await settled(page);
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    if (applied !== theme) throw new Error(`screens(${name}): asked for ${theme}, the page shows ${applied}`);
    const file = path.join(SCREENS, `${name}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    files.push(file);
  }
  await page.evaluate(([k, v]) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)), [THEME_KEY, prev] as const);
  await page.reload();
  await settled(page);
  return files;
}

export interface Session {
  readonly page: Page;
  readonly server: Server;
  readonly rpc: ReturnType<typeof rpcBudget>;
  /** Every failure the fixtures have recorded so far. */
  problems(): string[];
}

export interface E2eOptions {
  /** Max RPCs per page load (default 25). */
  readonly rpcBudget?: number;
}

// One server and one browser per spec file (node:test runs each file in its
// own process): importing this module registers the file's hooks. The server
// starts with the first session, not in `before` — a top-level hook runs as it
// is registered, before the spec's own top-level code (withLargeDataset) has.
let server: Promise<Server> | undefined;
let browser: Browser | undefined;
const seedOpts: { large?: boolean; live?: boolean } = {};

/** Call at a spec's top level: this file's server also gets the 1M-row dataset (server.sample.large). */
export function withLargeDataset(): void {
  seedOpts.large = true;
}

/**
 * Call at a spec's top level: this file's server also gets a Live dataset over
 * the test harness's fake warehouse (server.sample.live), and runs with
 * ORDINATE_TEST_LIVE_FAKE=1 so the fake connector resolves (L2.3, L2.4, L2.6).
 */
export function withLiveDataset(): void {
  seedOpts.live = true;
}

let serverEnv: Record<string, string> = {};
let contextHeaders: Record<string, string> | undefined;
before(async () => {
  browser = await launchBrowser();
});

/**
 * For a spec that needs another sign-in mode (T3.4's admin spec runs header
 * mode on its own Postgres): the server's extra env, and headers every page
 * of the spec sends (X-Forwarded-Email, as a trusted proxy would). Call at the
 * spec's top level. The server starts with the first session, not in
 * `before`: a spec that awaits (a scratch database) before calling this would
 * otherwise race the hook.
 */
export function configureServer(opts: { env?: Record<string, string>; headers?: Record<string, string> }): void {
  serverEnv = opts.env ?? {};
  contextHeaders = opts.headers;
}
after(async () => {
  await browser?.close();
  await (await server?.catch(() => undefined))?.stop();
});

/** Opens a fixture-wired page. Exported for negative controls; specs use `e2e()`. */
export async function openSession(opts: E2eOptions = {}): Promise<Session & { close(): Promise<void> }> {
  if (!browser) throw new Error('openSession() before the suite started');
  server ??= startServer(serverEnv, { ...seedOpts });
  const srv = await server;
  const context = await browser.newContext({
    baseURL: srv.base,
    viewport: { width: 1440, height: 900 },
    ...(contextHeaders ? { extraHTTPHeaders: contextHeaders } : {}),
  });
  const page = await context.newPage();
  const consoleProblems = await failOnConsoleError(page);
  const rpc = rpcBudget(page, opts.rpcBudget);
  return {
    page,
    server: srv,
    rpc,
    problems: () => [...consoleProblems(), ...rpc.problems()],
    close: () => context.close(),
  };
}

/** A test with a fresh fixture-wired page; fails on anything a fixture reported. */
export function e2e(name: string, fn: (s: Session) => Promise<void>, opts: E2eOptions = {}): void {
  void test(name, async () => {
    const s = await openSession(opts);
    try {
      await fn(s);
      const problems = s.problems();
      if (problems.length) throw new Error(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    } catch (err) {
      console.error(`--- server log (tail) ---\n${s.server.log().slice(-4000)}`);
      throw err;
    } finally {
      await s.close();
    }
  });
}
