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
  const projects = page.getByRole('region', { name: 'Projects' });
  await projects.getByText(server.sample.projectName, { exact: true }).waitFor();
  assert.equal(await projects.getByRole('listitem').count(), 1);
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
    await page.waitForURL((u) => u.pathname === item.to);
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
