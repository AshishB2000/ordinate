// E2E: `npm run dev:web`'s /api proxy (web/vite.config.ts) in front of the real
// server. The page is served by Vite, so the browser stamps every POST with
// Vite's origin; the proxy must pass the browser's Host through with it, or
// the CSRF check (src/server/csrf.ts) sees two different hosts and refuses
// every call with 403 `origin`. The config's /api entry is used as written —
// only its target moves to this run's server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer, type Plugin } from 'vite';
import { startServer } from './server.ts';

const WEB = fileURLToPath(new URL('..', import.meta.url));

void test('dev proxy: a POST from the Vite dev page reaches the API', async () => {
  const server = await startServer();
  const retarget: Plugin = {
    name: 'e2e-retarget-api',
    config(c) {
      const proxy = c.server?.proxy ?? {};
      const api = proxy['/api'];
      assert.ok(api, 'web/vite.config.ts proxies /api');
      proxy['/api'] = typeof api === 'string' ? server.base : { ...api, target: server.base };
    },
  };
  const vite = await createServer({
    root: WEB,
    configFile: `${WEB}vite.config.ts`,
    logLevel: 'silent',
    plugins: [retarget],
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    await vite.listen();
    const dev = vite.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? '';
    assert.match(dev, /^http:\/\/127\.0\.0\.1:\d+$/);

    const me = await fetch(`${dev}/api/auth/me`);
    assert.equal(me.status, 200, await me.text());
    const token = /^ordinate_csrf=([^;]+)/.exec(me.headers.getSetCookie().find((c) => c.startsWith('ordinate_csrf=')) ?? '')?.[1] ?? '';
    assert.ok(token, 'the proxied response sets the CSRF cookie');

    const res = await fetch(`${dev}/api/rpc/projects:list`, {
      method: 'POST',
      headers: { origin: dev, cookie: `ordinate_csrf=${token}`, 'x-csrf-token': token, 'content-type': 'application/json' },
      body: '{"args":[]}',
    });
    assert.equal(res.status, 200, `${res.status} ${await res.text()}`);
  } catch (e) {
    console.error(server.log());
    throw e;
  } finally {
    await vite.close();
    await server.stop();
  }
});
