// The shell against the real server: it loads, every nav item is reachable
// and lands on its route, and Home lists the seeded sample project. Plus the
// negative controls that prove the fixtures can fail at all.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NAV } from '../src/app/nav.ts';
import { e2e, openSession, screens, settled, type Session } from './fixtures.ts';

const heading = (s: Session) => s.page.getByRole('heading', { level: 1 });

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
}

e2e('the shell loads and Home lists the sample project', async (s) => {
  const { page, server } = s;
  await page.goto('/');
  await settled(page);
  assert.equal(await heading(s).textContent(), 'Home');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  for (const item of NAV) assert.ok(await nav.getByRole('link', { name: item.label, exact: true }).isVisible(), item.label);
  // T2.1's Home: no project list (the switcher is T2.2's) — the sample project
  // is the one Home speaks for, and its records are what Recent and Starred list.
  assert.match((await page.getByTestId('home-sub').textContent()) ?? '', new RegExp(`^${server.sample.projectName}  ·  `));
  const rows = page.getByRole('region', { name: /^(Recent|Starred)/ }).getByRole('listitem');
  assert.ok((await rows.count()) >= 1);
  for (const label of await rows.getByRole('link').evaluateAll((as) => as.map((a) => a.getAttribute('aria-label') ?? ''))) {
    assert.ok(label.includes(`in ${server.sample.projectName}`), label);
  }
  const files = await screens(page, 'shell-home');
  console.log(`screens: ${files.join(', ')}`);
  report(s);
});

e2e('every nav item is reachable and lands on its route', async (s) => {
  const { page } = s;
  await page.goto('/');
  await settled(page);
  const nav = page.getByRole('navigation', { name: 'Sections' });
  // Client-side, by clicking — then the same routes as full page loads (the server's index.html fallback).
  for (const item of [...NAV.slice(1), NAV[0]!]) {
    await nav.getByRole('link', { name: item.label, exact: true }).click();
    // An area may settle on its project-scoped path (/data → /data/<projectId>);
    // waiting for the bare path raced that redirect.
    await page.waitForURL((u) => u.pathname === item.to || (item.to !== '/' && u.pathname.startsWith(item.to + '/')));
    // The router keeps the old page up until the new lazy chunk has loaded.
    await page.getByRole('heading', { level: 1, name: item.label, exact: true }).waitFor();
    await settled(page);
    assert.equal(await nav.getByRole('link', { name: item.label, exact: true }).getAttribute('aria-current'), 'page');
  }
  for (const item of NAV) {
    await page.goto(item.to);
    await settled(page);
    assert.equal(await heading(s).textContent(), item.label, `heading on a direct load of ${item.to}`);
  }
  report(s);
});

// T6.2 in a real browser: the document carries the CSP and the other headers
// as response headers, the app's own calls carry the CSRF token (Home loads its
// projects with zero console errors), and the same browser's cookies WITHOUT
// the header — what a forged request carries — are refused. The forged calls go
// through page.request (the context's cookie jar), not page script: a 403 a
// page fetches is itself a console error.
e2e('security headers and CSRF in the browser', async (s) => {
  const { page, server } = s;
  const doc = await page.goto('/');
  await settled(page);
  const h = doc?.headers() ?? {};
  assert.match(h['content-security-policy'] ?? '', /^default-src 'self'; script-src 'self'; style-src 'self';.*frame-ancestors 'none'$/);
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['cross-origin-opener-policy'], 'same-origin');
  assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.ok(h['permissions-policy']?.includes('camera=()'));
  assert.equal(h['strict-transport-security'], undefined, 'no HSTS on a dev server');
  // Home has spoken to the server (T2.1's Home names the sample project in its subtitle).
  await page.getByTestId('home-sub').getByText(new RegExp(`^${server.sample.projectName}  ·  `)).waitFor();

  const token = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf');
  assert.ok(token && /^[A-Za-z0-9_-]{43}$/.test(token.value) && !token.httpOnly && token.sameSite === 'Lax', JSON.stringify(token));
  const post = (headers: Record<string, string>) =>
    page.request.post('/api/rpc/projects:list', { headers: { 'content-type': 'application/json', ...headers }, data: '{"args":[]}' });
  const forged = await post({});
  assert.equal(forged.status(), 403);
  assert.deepEqual(await forged.json(), { error: 'csrf' });
  assert.equal((await post({ 'x-csrf-token': token.value })).status(), 200);
  const crossSite = await post({ 'x-csrf-token': token.value, origin: 'https://evil.example' });
  assert.equal(crossSite.status(), 403);
  assert.deepEqual(await crossSite.json(), { error: 'origin' });
  report(s);
});

void test('negative control: a page load over its RPC budget fails', async () => {
  const s = await openSession({ rpcBudget: 0 });
  try {
    await s.page.goto('/');
    await settled(s.page);
    const problems = s.problems();
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0]!, /^RPC budget: \d+ RPCs on .+ \(budget 0\)$/);
  } finally {
    await s.close();
  }
});

void test('negative control: console errors, page errors and CSP violations are caught', async () => {
  const s = await openSession();
  try {
    await s.page.goto('/');
    await settled(s.page);
    await s.page.evaluate(() => {
      console.error('e2e negative control');
      setTimeout(() => {
        throw new Error('e2e uncaught');
      });
      const style = document.createElement('style'); // style-src 'self' refuses an inline <style>
      style.textContent = 'body { outline: 1px solid red }';
      document.head.append(style);
    });
    await s.page.waitForTimeout(300);
    const problems = s.problems().join('\n');
    assert.match(problems, /console error: e2e negative control/);
    assert.match(problems, /page error: e2e uncaught/);
    assert.match(problems, /CSP violation: style-src/);
  } finally {
    await s.close();
  }
});
