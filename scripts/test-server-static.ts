// Self-check for serving the built web app (src/server/static.ts): files,
// cache headers, the SPA fallback for client-side routes, and that the
// fallback never answers an API or asset miss with HTML.
//
//   npm run build:ts && node scripts/test-server-static.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fastify } from 'fastify';

const staticMod: typeof import('../src/server/static') = require('../src/server/static');

const HTML = { accept: 'text/html,application/xhtml+xml' };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-web-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'theme-boot.js'), '/* boot */');

  const app = fastify();
  app.get('/healthz', async () => ({ ok: true }));
  app.post('/api/rpc/:channel', async () => ({ rpc: true }));
  staticMod.registerStatic(app, root);
  await app.ready();

  try {
    const index = await app.inject({ url: '/', headers: HTML });
    ok('/ serves index.html', index.statusCode === 200 && index.body.includes('id="root"'), index.statusCode);
    ok('index.html is revalidated (no-cache)', index.headers['cache-control'] === 'no-cache', index.headers['cache-control']);

    const asset = await app.inject({ url: '/assets/index-abc123.js' });
    ok('a hashed asset is served as JS', asset.statusCode === 200 && String(asset.headers['content-type']).includes('javascript'));
    ok('a hashed asset is immutable', String(asset.headers['cache-control']).includes('immutable'), asset.headers['cache-control']);

    const boot = await app.inject({ url: '/theme-boot.js' });
    ok('an unhashed root file is not immutable', boot.statusCode === 200 && boot.headers['cache-control'] === 'no-cache', boot.headers['cache-control']);

    const route = await app.inject({ url: '/visuals/abc', headers: HTML });
    ok('a client-side route gets index.html', route.statusCode === 200 && route.body.includes('id="root"'), route.statusCode);

    const missingJs = await app.inject({ url: '/assets/gone-999.js', headers: { accept: '*/*' } });
    ok('a missing asset is a 404, not HTML', missingJs.statusCode === 404 && !missingJs.body.includes('id="root"'), missingJs.statusCode);

    const api = await app.inject({ url: '/api/nope', headers: HTML });
    ok('an /api miss is a JSON 404 even for a browser', api.statusCode === 404 && api.json().error === 'not found', api.body);

    const rpc = await app.inject({ method: 'POST', url: '/api/rpc/x' });
    ok('API routes still win', rpc.statusCode === 200 && rpc.json().rpc === true, rpc.body);
    const health = await app.inject({ url: '/healthz' });
    ok('/healthz still wins', health.statusCode === 200 && health.json().ok === true, health.body);

    const escape = await app.inject({ url: '/../package.json' });
    ok('no path escapes the dist root', escape.statusCode === 404 || !escape.body.includes('"name"'), escape.statusCode);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
