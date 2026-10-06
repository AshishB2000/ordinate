// E2E (T3.2): a real Chromium signs in to a real `node src/server/main.js`
// (AUTH_MODE=oidc, real Postgres) through the mock OIDC provider in
// scripts/mockOidc.ts, lands in the shell showing the user's email, signs in
// again (the session rotates), signs out, follows a deep link through
// sign-in, and walks a denied sign-in to the designed error state. Fails on
// any browser console error, and on any cookie value, code, token or the
// client secret appearing in the server's log output.
//
// Self-contained until T0.8's harness lands: builds the server and the web
// app, makes a scratch database, starts the mock IdP and the server, cleans up.
// Screenshots of the sign-in page (light, dark, error) go to web/e2e/__screens__/.
//
//   DATABASE_URL=postgres://you@localhost:5432/db node web/e2e/auth.e2e.ts
//   (E2E_NO_BUILD=1 skips the two builds when they are current; E2E_CHROMIUM
//   points at a browser binary when `npx playwright install` has not been run.)

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import pg from 'pg';
import { startMockOidc } from '../../scripts/mockOidc.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCREENS = path.join(import.meta.dirname, '__screens__');
const SECRET = 'e2e-cl1ent-s3cret-canary';
const ADMIN = 'admin@acme.test';

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log('ok   ' + label);
  else {
    failures++;
    console.error('FAIL ' + label + (extra === undefined ? '' : '  ' + String(extra)));
  }
}

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  console.log('skip auth e2e: DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)');
  process.exit(0);
}

if (!process.env.E2E_NO_BUILD) {
  execFileSync('npm', ['run', 'build:ts'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('npm', ['--prefix', 'web', 'run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const dbName = `ordinate_e2e_${process.pid}_${Date.now()}`;
const scratch = new URL(adminUrl);
scratch.pathname = '/' + dbName;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-e2e-auth-'));
const mock = await startMockOidc({ clientId: 'ordinate-e2e', clientSecret: SECRET });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(port),
  DATA_DIR: dataDir,
  ORDINATE_ENV: 'dev',
  LOG_LEVEL: 'debug',
  DATABASE_URL: scratch.toString(),
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: mock.issuer,
  OIDC_CLIENT_ID: 'ordinate-e2e',
  OIDC_CLIENT_SECRET: SECRET,
  OIDC_REDIRECT_URL: `${base}/api/auth/callback`,
  ORDINATE_ADMIN_EMAIL: ADMIN,
};
const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
const listening = new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 30_000);
  const onData = (c: Buffer): void => {
    serverOut += c.toString();
    if (serverOut.includes('Server listening')) {
      clearTimeout(timer);
      resolve(true);
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  server.once('exit', () => resolve(false));
});

/** Every cookie value the browser held during the run: none may reach a log. */
const seen = new Set<string>();
const consoleErrors: string[] = [];
// E2E_CHROMIUM: an already-installed Chromium/headless-shell binary, for a
// machine whose Playwright browser cache holds a different revision.
const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});

try {
  check('server: starts with AUTH_MODE=oidc against a fresh database', await listening, serverOut);
  const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });
  const harvest = async (): Promise<void> => {
    for (const c of await context.cookies()) seen.add(c.value);
  };
  const session = async () => (await context.cookies()).find((c) => c.name === 'ordinate_session');
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()} :: ${e.message}`));
  fs.mkdirSync(SCREENS, { recursive: true });
  // animations: 'disabled' fast-forwards the kit menu's open transition (a mid-fade capture otherwise).
  const shoot = (name: string) => page.screenshot({ path: path.join(SCREENS, name), animations: 'disabled' });

  /** At the mock IdP's page: type the address and press a button. */
  const atIdp = async (p: Page, email: string, button: 'Sign in' | 'Deny'): Promise<void> => {
    await p.waitForURL((u) => u.href.startsWith(mock.issuer));
    await harvest(); // the login cookie exists now
    await p.getByLabel('Email').fill(email);
    await p.getByRole('button', { name: button }).click();
  };
  const meFromPage = () => page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { user: { email: string } | null }).user);

  // ── Signed out: the server sends the browser to the sign-in page ─────────
  await page.goto(base + '/');
  await page.waitForURL(base + '/sign-in');
  await page.getByRole('heading', { name: 'Sign in to Ordinate' }).waitFor();
  check('signed out: GET / lands on /sign-in before the app loads', page.url() === base + '/sign-in', page.url());
  check('signed out: the sign-in page has no section nav', (await page.getByRole('navigation', { name: 'Sections' }).count()) === 0);
  await shoot('sign-in-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await page.getByRole('heading', { name: 'Sign in to Ordinate' }).waitFor();
  check('theme: dark is applied from the OS setting', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await shoot('sign-in-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });

  // ── A denied sign-in comes back to the designed error state ──────────────
  await page.goto(base + '/sign-in');
  await page.getByRole('link', { name: /Continue with single sign-on/ }).click();
  await atIdp(page, ADMIN, 'Deny');
  await page.waitForURL(`${base}/sign-in?error=denied`);
  const alert = page.getByRole('alert');
  await alert.waitFor();
  check('denied: the error state explains it', (await alert.textContent())?.includes('cancelled at your identity provider') === true, await alert.textContent());
  check('denied: no session cookie was set', (await session()) === undefined);
  await shoot('sign-in-error-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await page.getByRole('alert').waitFor();
  await shoot('sign-in-error-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();

  // ── Sign in: lands in the shell showing the user's email ─────────────────
  await page.getByRole('link', { name: /Try again/ }).click();
  await atIdp(page, ADMIN, 'Sign in');
  await page.waitForURL(base + '/');
  await page.getByRole('navigation', { name: 'Sections' }).waitFor();
  await page.getByRole('button', { name: 'Account and theme' }).click();
  const shown = page.getByTestId('user-email');
  await shown.waitFor();
  check('signed in: the shell shows the user email', (await shown.textContent()) === ADMIN, await shown.textContent());
  check('signed in: the bootstrap admin is an admin', (await page.getByText('Admin · default').count()) === 1);
  const first = await session();
  check('cookie: httpOnly, SameSite=Lax, Path=/', first?.httpOnly === true && first.sameSite === 'Lax' && first.path === '/', JSON.stringify({ ...first, value: '…' }));
  check('cookie: not readable from page script', !(await page.evaluate(() => document.cookie)).includes('ordinate_session'));
  await harvest();
  await shoot('shell-signed-in-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await page.getByRole('button', { name: 'Account and theme' }).click();
  await page.getByTestId('user-email').waitFor();
  await shoot('shell-signed-in-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');

  // ── Sign in again from the same browser: the session id rotates ──────────
  await page.goto(base + '/api/auth/login');
  await atIdp(page, ADMIN, 'Sign in');
  await page.waitForURL(base + '/');
  const second = await session();
  await harvest();
  check('rotation: a new session id on every sign-in', !!second && second.value !== first?.value);
  const old = await fetch(base + '/api/auth/me', { headers: { cookie: `ordinate_session=${first?.value}` } });
  check('rotation: the previous id no longer signs anyone in', ((await old.json()) as { user: unknown }).user === null);

  // ── Sign out ─────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Account and theme' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(base + '/sign-in');
  check('sign out: back on the sign-in page', page.url() === base + '/sign-in');
  check('sign out: the session cookie is gone', (await session()) === undefined);
  check('sign out: the server no longer knows us', (await meFromPage()) === null);
  const reuse = await fetch(base + '/api/auth/me', { headers: { cookie: `ordinate_session=${second?.value}` } });
  check('sign out: the ended id is dead server-side', ((await reuse.json()) as { user: unknown }).user === null);

  // ── A deep link survives the trip through sign-in ────────────────────────
  await page.goto(base + '/data');
  await page.waitForURL(`${base}/sign-in?next=%2Fdata`);
  await page.getByRole('link', { name: /Continue with single sign-on/ }).click();
  await atIdp(page, 'Pat@Acme.test', 'Sign in');
  await page.waitForURL(base + '/data');
  await page.getByRole('heading', { level: 1, name: 'Data' }).waitFor();
  check('deep link: signed in and back on /data', page.url() === base + '/data');
  await page.getByRole('button', { name: 'Account and theme' }).click();
  check('deep link: a new user is provisioned as a viewer', (await page.getByTestId('user-email').textContent()) === 'pat@acme.test' && (await page.getByText('Viewer · default').count()) === 1);
  await harvest();

  // ── Sign out everywhere (T6.2): the account menu ends every device ───────
  const phone = await browser.newContext({ colorScheme: 'light' });
  const phonePage = await phone.newPage();
  phonePage.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`phone ${phonePage.url()} :: ${m.text()}`);
  });
  await phonePage.goto(base + '/api/auth/login');
  await phonePage.waitForURL((u) => u.href.startsWith(mock.issuer));
  await phonePage.getByLabel('Email').fill('pat@acme.test');
  await phonePage.getByRole('button', { name: 'Sign in' }).click();
  await phonePage.waitForURL(base + '/');
  const phoneMe = () => phonePage.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { user: unknown }).user);
  check('everywhere: precondition — a second device is signed in as the same user', (await phoneMe()) !== null);
  for (const c of await phone.cookies()) seen.add(c.value);
  await page.getByRole('menuitem', { name: 'Sign out everywhere' }).click();
  await page.waitForURL(base + '/sign-in');
  check('everywhere: this device is back on the sign-in page, cookie gone', page.url() === base + '/sign-in' && (await session()) === undefined);
  check('everywhere: the other device is signed out too', (await phoneMe()) === null);
  await phone.close();

  check('console: zero errors across every page', consoleErrors.length === 0, '\n  ' + consoleErrors.join('\n  '));
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => (server.exitCode !== null ? r(null) : server.once('exit', r)));
  await mock.close();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// ── Nothing secret in the server's output ──────────────────────────────────
const secrets = [SECRET, ...mock.issued, ...[...seen].filter((v) => v.length >= 16)];
const leaked = secrets.filter((v) => serverOut.includes(v));
check(`logs: ${serverOut.split('\n').length} server log lines, none holding any of ${secrets.length} cookie values, codes, tokens or the client secret`,
  serverOut.length > 0 && secrets.length > 5 && leaked.length === 0, leaked.map((v) => v.slice(0, 8) + '…').join(' '));
check('logs: the callback was logged by path only', serverOut.includes('"url":"/api/auth/callback"') && !serverOut.includes('/api/auth/callback?'));

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
