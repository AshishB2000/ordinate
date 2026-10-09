// Self-check for the RPC route (POST /api/rpc/:channel), the handler registry
// (src/server/rpc.ts) and the Home contracts (src/api/).
//
// The REAL handler modules are registered through app.ts's `registerHandlers`
// and driven over `inject()` against the seeded sample project. Each reply is
// compared byte for byte with the wire encoding of the SAME handler called
// directly, so the route can neither drop nor reshape a figure.
//
// This suite runs the route in LOCAL mode, where src/app/paths.ts resolves
// every path under ORDINATE_LOCAL_DIR. Server mode — per-org paths — is
// scripts/test-server-context.ts.
//
//   npm run build:ts && node scripts/test-rpc.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-rpc-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const bus: typeof import('../src/ipc/bus') = require('../src/ipc/bus');

const SECRET = 'S3CRET-VALUE-do-not-echo';
const PID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

(async () => {
  // ── Registry and bus ──────────────────────────────────────────────────────
  ok('bus: ipcMain IS the RPC registry', (bus.ipcMain as unknown) === rpc.registry);
  const ipcLoaded = (): boolean => Object.keys(require.cache).some((k) => /[\\/]src[\\/]ipc[\\/]projects\.js$/.test(k));
  ok('loading app.js loads no handler module', !ipcLoaded());

  rpc.registry.handle('test:echo', async (_e, p) => p);
  let dup = false;
  try { rpc.registry.handle('test:echo', async () => 1); } catch { dup = true; }
  ok('registry: a second handler for one channel throws', dup);
  rpc.registry.removeHandler('test:echo');
  ok('registry: removeHandler removes', !rpc.handlers.has('test:echo'));

  appMod.registerHandlers();
  ok('registerHandlers: the Home channels are stored', ['projects:list', 'dataset:list', 'recent:list'].every((c) => rpc.handlers.has(c)));
  ok('registerHandlers: so are their uncontracted neighbours', rpc.handlers.has('dataset:meta') && rpc.handlers.has('dataset:get'));

  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  await projects.init();
  const projectId = String((await sample.seedSampleProject()).projectId);
  const dsId = (await datasets.listDatasets(projectId))[0].id;

  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent' }));
  const post = (channel: string, body: unknown, raw = false) => app.inject({
    method: 'POST',
    url: `/api/rpc/${encodeURIComponent(channel)}`,
    headers: withCsrf({ 'content-type': 'application/json' }),
    payload: raw ? (body as string) : wire.encode(body),
  });
  const direct = async (ch: string, ...args: unknown[]): Promise<string> => wire.encode(await rpc.handlers.get(ch)!(null, ...args));

  // ── Good input → the handler's own result, wire-encoded ──────────────────
  const pl = await post('projects:list', { args: [] });
  ok('projects:list: 200', pl.statusCode === 200, pl.body);
  ok('projects:list: body ≡ the handler called directly', pl.body === await direct('projects:list'));
  ok('projects:list: the sample project is listed', (wire.decode(pl.body) as { id: string }[]).some((p) => p.id === projectId));
  ok('projects:list: content-type is JSON', String(pl.headers['content-type']).startsWith('application/json'));

  const dl = await post('dataset:list', { args: [{ projectId }] });
  ok('dataset:list: 200', dl.statusCode === 200, dl.body);
  ok('dataset:list: body ≡ the handler called directly', dl.body === await direct('dataset:list', { projectId }));
  ok('dataset:list: the sample dataset is listed', (wire.decode(dl.body) as { name: string }[]).some((d) => d.name === sample.SAMPLE_DATASET_NAME));

  const rl = await post('recent:list', { args: [{ limit: 6 }] });
  ok('recent:list {limit}: 200 and ≡ direct', rl.statusCode === 200 && rl.body === await direct('recent:list', { limit: 6 }), rl.body);
  const rn = await post('recent:list', { args: [] });
  ok('recent:list with no payload: 200 and ≡ direct', rn.statusCode === 200 && rn.body === await direct('recent:list'), rn.body);
  const ru = await post('recent:list', { args: [{ limit: undefined }] });
  ok('recent:list {limit: undefined} (what the preload sends): 200', ru.statusCode === 200, ru.body);

  // ── No contract → 404, even with a handler registered ────────────────────
  // `dataset:meta` stays uncontracted for good (its reply carries the origin:
  // a path, a URL that may hold a key, a statement). `dataset:delete` was the
  // example here until T2.3 contracted it.
  const meta = await post('dataset:meta', { args: [{ projectId, id: dsId }] });
  const name = (await datasets.listDatasets(projectId)).find((d) => d.id === dsId)?.name ?? '';
  ok('dataset:meta (registered, uncontracted): 404', meta.statusCode === 404, meta.body);
  ok('…and the handler never answered: the reply is not the record', !!name && !meta.body.includes(name), meta.body);
  for (const ch of ['nope:nope', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    const r = await post(ch, { args: [] });
    ok(`"${ch}": 404`, r.statusCode === 404, r.statusCode);
  }

  // ── Malformed input → 400 naming paths, never echoing values ─────────────
  const bad: [string, string, unknown, string][] = [
    ['not a UUID', 'dataset:list', { args: [{ projectId: `../../etc/${SECRET}` }] }, 'args.0.projectId'],
    ['wrong type', 'dataset:list', { args: [{ projectId: 42 }] }, 'args.0.projectId'],
    ['missing field', 'dataset:list', { args: [{}] }, 'args.0.projectId'],
    ['an unknown key', 'dataset:list', { args: [{ projectId: PID, [SECRET]: SECRET }] }, 'args.0'],
    ['limit as a string', 'recent:list', { args: [{ limit: SECRET }] }, 'args.0.limit'],
    ['limit out of range', 'recent:list', { args: [{ limit: 1e9 }] }, 'args.0.limit'],
    ['limit NaN (wire carries it, zod refuses it)', 'recent:list', { args: [{ limit: NaN }] }, 'args.0.limit'],
    ['a payload where none is taken', 'projects:list', { args: [{ q: SECRET }] }, 'args.0'],
    ['two arguments', 'dataset:list', { args: [{ projectId: PID }, SECRET] }, 'args'],
    ['args not an array', 'dataset:list', { args: SECRET }, 'args'],
    ['no args key', 'dataset:list', { projectId: PID }, 'args'],
  ];
  for (const [label, ch, body, at] of bad) {
    const r = await post(ch, body);
    const j = (() => { try { return r.json(); } catch { return null; } })();
    ok(`400 ${label}`, r.statusCode === 400, `${r.statusCode} ${r.body}`);
    ok(`…names ${at}`, Array.isArray(j?.issues) && j.issues.some((i: { path: string }) => i.path === at), r.body);
    ok('…and never echoes the value', !r.body.includes(SECRET) && !r.body.includes('etc/'), r.body);
  }
  for (const [label, raw] of [
    ['an unknown wire tag', `{"args":[{"$":"zzz","v":"${SECRET}"}]}`],
    ['a bigint tag that is not digits', `{"args":[{"$":"B","v":"${SECRET}"}]}`],
    ['not JSON', `{"args":[${SECRET}`],
  ]) {
    const r = await post('dataset:list', raw, true);
    ok(`400 ${label}, without the value`, r.statusCode === 400 && !r.body.includes(SECRET), `${r.statusCode} ${r.body}`);
  }

  // ── The wire codec end to end, and failures that must stay quiet ──────────
  // The two reply-shape cases go through dataset:list: recent:list's reply is
  // trimmed to readable projects since T3.3 (a non-list reply becomes []).
  rpc.registry.removeHandler('dataset:list');
  rpc.registry.handle('dataset:list', async () => ({ n: NaN, z: -0, d: new Date(0), m: new Map([[1, undefined]]) }));
  const w = await post('dataset:list', { args: [{ projectId }] });
  const wv = wire.decode(w.body) as { n: number; z: number; d: Date; m: Map<number, undefined> };
  ok('a NaN / -0 / Date / Map reply survives the route', w.statusCode === 200 && Number.isNaN(wv.n) && Object.is(wv.z, -0)
    && wv.d instanceof Date && wv.d.getTime() === 0 && wv.m.has(1), w.body);

  rpc.registry.removeHandler('recent:list');
  rpc.registry.handle('recent:list', async () => { throw new Error(`/Users/x/${SECRET}`); });
  const thrown = await post('recent:list', { args: [] });
  ok('a throwing handler: 500 without its message', thrown.statusCode === 500 && !thrown.body.includes(SECRET), thrown.body);

  rpc.registry.removeHandler('dataset:list');
  rpc.registry.handle('dataset:list', async () => () => SECRET);
  const unenc = await post('dataset:list', { args: [{ projectId }] });
  ok('a reply the codec refuses (a function): 500, not a mangled 200', unenc.statusCode === 500 && !unenc.body.includes(SECRET), unenc.body);

  rpc.registry.removeHandler('recent:list');
  const missing = await post('recent:list', { args: [] });
  ok('contracted but no handler registered: 501', missing.statusCode === 501, missing.body);

  await app.close();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    finish();
  });
