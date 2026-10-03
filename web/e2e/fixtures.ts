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
  return types[name as keyof typeof types].launch({ executablePath });
}

/** Starts collecting what must never happen on a page. The returned function lists it so far. */
export async function failOnConsoleError(page: Page): Promise<() => string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const at = m.location();
    problems.push(`console error: ${m.text()}${at.url ? ` (${at.url}:${at.lineNumber})` : ''}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  // Firefox and WebKit do not always log a CSP refusal to the console; the event is the reliable signal.
  await page.exposeFunction('__e2eCsp', (v: string) => problems.push(`CSP violation: ${v}`));
  await page.addInitScript(() => {
    const report = (window as unknown as { __e2eCsp(v: string): void }).__e2eCsp;
    document.addEventListener('securitypolicyviolation', (e) =>
      report(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`),
    );
  });
  return () => [...problems];
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
const seedOpts: { large?: boolean } = {};

/** Call at a spec's top level: this file's server also gets the 1M-row dataset (server.sample.large). */
export function withLargeDataset(): void {
  seedOpts.large = true;
}

before(async () => {
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await (await server?.catch(() => undefined))?.stop();
});

/** Opens a fixture-wired page. Exported for negative controls; specs use `e2e()`. */
export async function openSession(opts: E2eOptions = {}): Promise<Session & { close(): Promise<void> }> {
  if (!browser) throw new Error('openSession() before the suite started');
  server ??= startServer({}, { ...seedOpts });
  const srv = await server;
  const context = await browser.newContext({ baseURL: srv.base, viewport: { width: 1440, height: 900 } });
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
