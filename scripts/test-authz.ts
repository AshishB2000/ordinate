// Self-check for authorization WITHOUT Postgres (T3.3): every contract is
// resolvable (scripts/check-contracts.ts), the decision rules (org roles,
// resolvers, unknown → deny), audit target extraction never picking up a
// value, and the route refusing before the handler — server mode, no
// Electron. The role × channel × project matrix against a real Postgres is
// scripts/test-authz-db.ts.
//
//   npm run build:ts && node scripts/test-authz.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { z } from 'zod';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: the loader hook has no public type

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const check: typeof import('./check-contracts') = require('./check-contracts');
const api: typeof import('../src/api/index') = require('../src/api/index');
const contract: typeof import('../src/api/contract') = require('../src/api/contract');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const auditMod: typeof import('../src/server/authz/audit') = require('../src/server/authz/audit');
const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Role = import('../src/server/context').Role;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-authz-'));
const as = (role: Role, org = 'acme'): import('../src/server/context').Identity => ({ user: { email: `${role}@${org}.test`, role }, org: { id: org } });
const CANARY = 'c4nary-VALUE-never-audited';

(async () => {
  // ── Every contract declares its scope ─────────────────────────────────────
  const unresolved = check.unresolvedContracts(api.contracts);
  console.log(`     ${Object.keys(api.contracts).length} contracts, ${unresolved.length} unresolved`);
  ok('check-contracts: zero contracts without a project resolver or org: true', unresolved.length === 0, unresolved.join('; '));
  const anyC = (x: unknown) => x as import('../src/api/contract').Contract; // a hand-built bad contract, past the type
  const negative = check.unresolvedContracts({
    'x:none': anyC({ access: 'read', input: z.undefined() }),
    'x:both': anyC({ access: 'read', input: z.undefined(), org: true, project: () => null }),
    'x:notfn': anyC({ access: 'read', input: z.undefined(), project: 'projectId' }),
    'x:access': anyC({ access: 'owner', input: z.undefined(), org: true }),
    'x:good': contract.rpc({ access: 'read', input: z.undefined(), org: true }),
  });
  ok('check-contracts: negative control lists exactly the four bad ones', negative.length === 4 && negative.every((l) => !l.startsWith('x:good')), negative.join('; '));

  // ── Org roles ──────────────────────────────────────────────────────────────
  const table: [Role, string, boolean][] = [
    ['viewer', 'read', true], ['viewer', 'write', false], ['viewer', 'admin', false],
    ['editor', 'read', true], ['editor', 'write', true], ['editor', 'admin', false],
    ['admin', 'read', true], ['admin', 'write', true], ['admin', 'admin', true],
  ];
  ok('orgAllows: read ≥ viewer, write ≥ editor, admin ≥ admin', table.every(([r, a, want]) => authz.orgAllows(r, a) === want));
  ok('orgAllows: an unknown role or access is a deny', !authz.orgAllows('owner', 'read') && !authz.orgAllows('admin', 'superuser') && !authz.orgAllows('toString', 'read') && !authz.orgAllows('admin', 'toString'));

  // ── authorize(): resolvers, existence, unknown → deny (no Postgres) ───────
  context.enterServerMode(DATA);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const pid = await context.runInContext(as('admin'), 'seed', async () => (await projects.createProject('Mine')).id);
  const at = (who: import('../src/server/context').Identity, c: unknown, input: unknown) =>
    context.runInContext(who, 'r', () => authz.authorize(c as import('../src/api/contract').Contract, input, who, null));
  const readP = contract.rpc({ access: 'read', input: z.strictObject({ projectId: contract.Uuid }), project: contract.byProjectId });
  const ghost = '00000000-0000-4000-8000-000000000000';
  ok('admin: own-org project → allowed, decision names it', (await at(as('admin'), readP, { projectId: pid })).ok && (await at(as('admin'), readP, { projectId: pid })).projectId === pid);
  ok('admin: a project id not in this org → deny', !(await at(as('admin'), readP, { projectId: ghost })).ok);
  ok('admin of ANOTHER org: this org\'s project id → deny', !(await at(as('admin', 'beta'), readP, { projectId: pid })).ok);
  ok('viewer with no grant (no Postgres = no grants) → deny', !(await at(as('viewer'), readP, { projectId: pid })).ok);
  ok('resolver returning null → deny', !(await at(as('admin'), { ...readP, project: () => null }, {})).ok);
  ok('resolver returning a non-UUID (a path) → deny', !(await at(as('admin'), { ...readP, project: () => '../acme' }, {})).ok);
  ok('resolver that throws → deny, no throw out', !(await at(as('admin'), { ...readP, project: () => { throw new Error('x'); } }, {})).ok);
  ok('async resolver (a record → project lookup) → allowed when it resolves', (await at(as('admin'), { ...readP, project: async () => pid }, {})).ok);
  ok('a contract with neither scope → deny', !(await at(as('admin'), { access: 'read', input: z.undefined() }, undefined)).ok);
  ok('access outside read|write|admin → deny, even for an org admin', !(await at(as('admin'), { access: 'owner', input: z.undefined(), org: true }, undefined)).ok);
  ok('org channel: viewer reads, cannot write', (await at(as('viewer'), { access: 'read', org: true }, undefined)).ok && !(await at(as('viewer'), { access: 'write', org: true }, undefined)).ok);
  ok('org channel: admin access needs an org admin', !(await at(as('editor'), { access: 'admin', org: true }, undefined)).ok && (await at(as('admin'), { access: 'admin', org: true }, undefined)).ok);

  // ── Visible lists fail closed ─────────────────────────────────────────────
  const only = contract.onlyReadable('id');
  ok('onlyReadable keeps readable items', JSON.stringify(only([{ id: 'a' }, { id: 'b' }, null, 3], (x) => x === 'a')) === '[{"id":"a"}]');
  ok('onlyReadable: a reply that is not a list shows nothing', JSON.stringify(only({ id: 'a' }, () => true)) === '[]');
  const readNone = await authz.readable(null, as('viewer'));
  const readAll = await authz.readable(null, as('admin'));
  ok('readable(): org admin reads all, a member with no grants none', readAll(pid) && !readNone(pid));

  // ── Audit targets: ids, never values ──────────────────────────────────────
  const ids = auditMod.targetIds({
    projectId: pid, name: CANARY, datasetId: 'not-a-uuid', note: ghost, rows: [[CANARY, ghost]],
    member: { userId: ghost.replace(/0$/, '1') }, deep: { a: { b: { c: { d: { id: ghost.replace(/0$/, '2') } } } } },
  });
  ok('targetIds: UUIDs under id/…Id keys, nested', ids.includes(pid) && ids.includes(ghost.replace(/0$/, '1')), ids.join());
  ok('targetIds: never a value — not a canary, not a UUID under another key, not a non-UUID id', !ids.some((x) => x.includes('c4nary') || x === ghost || x === 'not-a-uuid'), ids.join());
  ok('targetIds: bounded depth', !ids.includes(ghost.replace(/0$/, '2')), ids.join());

  // ── The route: 403 before the handler, uploads and events by org role ─────
  const calls = new Map<string, number>();
  for (const ch of ['projects:list', 'dataset:list', 'quality:run', 'projects:create']) {
    rpc.registry.handle(ch, async (_e, p: unknown) => {
      calls.set(ch, (calls.get(ch) ?? 0) + 1);
      return ch === 'projects:list' ? [{ id: pid }, { id: ghost }] : ch === 'projects:create' ? { id: ghost, name: p } : 'ran';
    });
  }
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    typeof h['x-role'] === 'string' ? as(h['x-role'] as Role) : null);
  const post = (role: Role, ch: string, payload?: unknown) => app.inject({
    method: 'POST', url: `/api/rpc/${ch}`, headers: withCsrf({ 'content-type': 'application/json', 'x-role': role }),
    payload: wire.encode({ args: payload === undefined ? [] : [payload] }),
  });
  const before = (ch: string) => calls.get(ch) ?? 0;
  for (const [role, ch, payload, want] of [
    ['viewer', 'dataset:list', { projectId: pid }, 403],
    ['editor', 'quality:run', { projectId: pid, datasetId: ghost }, 403],
    ['viewer', 'projects:create', { name: CANARY }, 403],
    ['admin', 'dataset:list', { projectId: ghost }, 403],
    ['admin', 'dataset:list', { projectId: pid }, 200],
    ['editor', 'projects:create', { name: 'x' }, 200],
  ] as [Role, string, unknown, number][]) {
    const n = before(ch);
    const r = await post(role, ch, payload);
    ok(`route: ${role} ${ch} → ${want}`, r.statusCode === want, `${r.statusCode} ${r.body}`);
    ok(`…handler ran ${want === 200 ? 'once' : 'never'}`, before(ch) === n + (want === 200 ? 1 : 0));
    if (want === 403) ok('…403 body carries no input value', r.body === '{"error":"forbidden"}', r.body);
  }
  const lv = await post('viewer', 'projects:list');
  ok('route: projects:list as a viewer with no grants → 200, trimmed to nothing', lv.statusCode === 200 && JSON.stringify(wire.decode(lv.body)) === '[]', lv.body);
  const la = await post('admin', 'projects:list');
  ok('route: projects:list as an org admin → every item', la.statusCode === 200 && (wire.decode(la.body) as unknown[]).length === 2, la.body);
  const up = (role: Role) => app.inject({ method: 'POST', url: '/api/files', headers: withCsrf({ 'x-role': role, 'content-type': 'multipart/form-data; boundary=x' }), payload: '--x--\r\n' });
  ok('/api/files upload: org viewer → 403', (await up('viewer')).statusCode === 403);
  ok('/api/files upload: org editor → past authorization', (await up('editor')).statusCode !== 403);
  const ev = await app.inject({ method: 'GET', url: '/api/events?client=bad', headers: { 'x-role': 'viewer' } });
  ok('/api/events: any member passes authorization (here: 400 for the bad client id)', ev.statusCode === 400, ev.statusCode);
  await app.close();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
