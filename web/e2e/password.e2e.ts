// E2E: password sign-in, the default AUTH_MODE. A real Chromium against a real
// `node src/server/main.js` with no AUTH_MODE set and a fresh Postgres:
//
//   first run   / lands on /sign-in showing "Create the admin account"; a wrong
//               setup code is the designed error; the code the server printed
//               in its log creates the admin and lands in the shell
//   admin       Admin → People → Add person with a generated temporary password
//   sign-in     signed out, the page is an email + password form; a wrong
//               password is the designed error
//   temporary   the new person signs in with the temporary password and is held
//               on /change-password (a deep link is kept), chooses their own,
//               and lands where they were going
//
// Fails on any browser console error (a refused password must not be one), and
// on any password, session id or the setup code (outside its one startup line)
// in the server's output. Light and dark screenshots of every new screen go to
// web/e2e/__screens__/.
//
//   DATABASE_URL=postgres://you@localhost:5432/db node web/e2e/password.e2e.ts
//   (E2E_NO_BUILD=1 skips the two builds; E2E_CHROMIUM points at a browser binary.)

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import pg from 'pg';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCREENS = path.join(import.meta.dirname, '__screens__');
const BOSS = 'boss@acme.test';
const BOSS_PW = 'boss-e2e-password-1';
const SAM = 'sam@acme.test';
const SAM_OWN = 'sam-own-e2e-password';

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
  console.log('skip password e2e: DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)');
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

const dbName = `ordinate_e2e_pw_${process.pid}_${Date.now()}`;
const scratch = new URL(adminUrl);
scratch.pathname = '/' + dbName;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-e2e-password-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

// No AUTH_MODE: password sign-in is what a server nobody configured does.
const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), DATA_DIR: dataDir, ORDINATE_ENV: 'dev', LOG_LEVEL: 'info', DATABASE_URL: scratch.toString() };
delete env.AUTH_MODE;
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

const seen = new Set<string>([BOSS_PW, SAM_OWN]);
const consoleErrors: string[] = [];
const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
let code = '';

try {
  check('server: starts with AUTH_MODE unset (password sign-in) against a fresh database', await listening, serverOut);
  code = /First-run setup code: ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(serverOut)?.[1] ?? '';
  check('server: printed a first-run setup code', code !== '', serverOut);
  check('server: warned that password sign-in is for trying Ordinate out', serverOut.includes('AUTH_MODE=password: Ordinate keeps its own passwords'));

  const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });
  const watch = (p: Page, who: string) => {
    p.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`${who} ${p.url()} :: ${m.text()}`);
    });
    p.on('pageerror', (e) => consoleErrors.push(`${who} ${p.url()} :: ${e.message}`));
  };
  const page = await context.newPage();
  watch(page, 'boss');
  fs.mkdirSync(SCREENS, { recursive: true });
  const shoot = (p: Page, name: string) => p.screenshot({ path: path.join(SCREENS, name), animations: 'disabled' });
  /** Light, then dark (reloaded, waiting for `ready`), then back to light. */
  const both = async (p: Page, name: string, ready: () => Promise<unknown>) => {
    await shoot(p, `${name}-light.png`);
    await p.emulateMedia({ colorScheme: 'dark' });
    await p.reload();
    await ready();
    await shoot(p, `${name}-dark.png`);
    await p.emulateMedia({ colorScheme: 'light' });
    await p.reload();
    await ready();
  };

  // ── First run: create the admin account ──────────────────────────────────
  await page.goto(base + '/');
  await page.waitForURL(base + '/sign-in');
  const setupHeading = page.getByRole('heading', { level: 1, name: 'Create the admin account' });
  await setupHeading.waitFor();
  check('first run: / lands on /sign-in, which asks for the setup code', (await page.getByLabel('Setup code').count()) === 1);
  check('first run: no single sign-on button', (await page.getByRole('link', { name: /single sign-on/ }).count()) === 0);
  await both(page, 'sign-in-setup', () => setupHeading.waitFor());

  const fillSetup = async (c: string) => {
    await page.getByLabel('Setup code').fill(c);
    await page.getByLabel('Your email').fill(BOSS);
    await page.getByLabel('Password', { exact: true }).fill(BOSS_PW);
    await page.getByLabel('Confirm password').fill(BOSS_PW);
    await page.getByRole('button', { name: /Create admin account/ }).click();
  };
  await fillSetup(code.startsWith('A') ? 'BBBB-BBBB-BBBB' : 'AAAA-AAAA-AAAA');
  const alert = page.getByRole('alert');
  await alert.waitFor();
  check('first run: a wrong code is the designed error', (await alert.textContent())?.includes("server's log") === true, await alert.textContent());
  await shoot(page, 'sign-in-setup-error-light.png');

  await fillSetup(code.toLowerCase());
  await page.waitForURL(base + '/');
  await page.getByRole('navigation', { name: 'Sections' }).waitFor();
  await page.getByRole('button', { name: 'Account and theme' }).click();
  check('first run: signed in as the new admin', (await page.getByTestId('user-email').textContent()) === BOSS && (await page.getByText('Admin · default').count()) === 1);
  check('first run: the account menu offers Change password', (await page.getByRole('menuitem', { name: 'Change password' }).count()) === 1);
  await page.keyboard.press('Escape');
  for (const c of await context.cookies()) seen.add(c.value);

  // ── Admin → People → Add person ──────────────────────────────────────────
  await page.goto(base + '/admin');
  await page.getByRole('button', { name: 'Add person' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByLabel('Email').fill(SAM);
  const temp = await dialog.getByLabel('Temporary password').inputValue();
  seen.add(temp);
  check('add person: a 16-character temporary password is generated', /^[A-Za-z2-9]{16}$/.test(temp), temp.length);
  await shoot(page, 'admin-add-person-light.png');
  await dialog.getByRole('button', { name: 'Add person' }).click();
  await page.getByText(SAM, { exact: true }).waitFor();
  const samRow = page.getByRole('row').filter({ hasText: SAM });
  check('add person: listed with a Temporary password badge', (await samRow.getByText('Temporary password').count()) === 1);
  await shoot(page, 'admin-people-password-light.png');

  // ── Sign out: the password form ──────────────────────────────────────────
  await page.getByRole('button', { name: 'Account and theme' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(base + '/sign-in');
  const signInHeading = page.getByRole('heading', { level: 1, name: 'Sign in to Ordinate' });
  await signInHeading.waitFor();
  check('signed out: an email and password form', (await page.getByLabel('Email').count()) === 1 && (await page.getByLabel('Password').count()) === 1);
  await both(page, 'sign-in-password', () => signInHeading.waitFor());
  await page.getByLabel('Email').fill(BOSS);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('alert').waitFor();
  check('wrong password: the designed error, still on /sign-in', (await page.getByRole('alert').textContent())?.includes("don't match an account") === true && page.url() === base + '/sign-in');
  await shoot(page, 'sign-in-password-error-light.png');

  // ── A temporary password: held on /change-password until changed ────────
  const samCtx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });
  const sam = await samCtx.newPage();
  watch(sam, 'sam');
  await sam.goto(base + '/data');
  await sam.waitForURL(`${base}/sign-in?next=%2Fdata`);
  await sam.getByLabel('Email').fill(SAM);
  await sam.getByLabel('Password').fill(temp);
  await sam.getByRole('button', { name: /Sign in/ }).click();
  await sam.waitForURL(`${base}/change-password?next=%2Fdata`);
  const chooseHeading = sam.getByRole('heading', { level: 1, name: 'Choose your own password' });
  await chooseHeading.waitFor();
  check('temporary: sign-in goes to /change-password, keeping the deep link', sam.url() === `${base}/change-password?next=%2Fdata`);
  await sam.goto(base + '/visuals');
  await sam.waitForURL(`${base}/change-password?next=%2Fvisuals`);
  check('temporary: any other page is sent back to /change-password', sam.url().startsWith(base + '/change-password'));
  await chooseHeading.waitFor();
  await both(sam, 'change-password', () => chooseHeading.waitFor());
  await sam.getByLabel('Temporary password').fill(temp);
  await sam.getByLabel('New password', { exact: true }).fill(SAM_OWN);
  await sam.getByLabel('Confirm new password').fill(SAM_OWN);
  await sam.getByRole('button', { name: /Change password/ }).click();
  await sam.waitForURL(base + '/visuals');
  await sam.getByRole('navigation', { name: 'Sections' }).waitFor();
  check('temporary: changed, and in the app where they were going', sam.url() === base + '/visuals');
  for (const c of await samCtx.cookies()) seen.add(c.value);
  await samCtx.close();

  check('console: zero errors across every page, refusals included', consoleErrors.length === 0, '\n  ' + consoleErrors.join('\n  '));
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => (server.exitCode !== null ? r(null) : server.once('exit', r)));
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// ── Nothing secret in the server's output ──────────────────────────────────
const secrets = [...seen].filter((v) => v.length >= 10);
const leaked = secrets.filter((v) => serverOut.includes(v));
check(`logs: none of ${secrets.length} passwords or cookie values appear in ${serverOut.split('\n').length} server log lines`, secrets.length >= 4 && leaked.length === 0, leaked.map((v) => v.slice(0, 6) + '…').join(' '));
check('logs: the setup code appears once, in its startup line', code !== '' && serverOut.split(code).length - 1 === 1, serverOut.split(code).length - 1);

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
