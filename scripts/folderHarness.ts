// The world the folder safety net runs in (docs/team-folders/00-design.md, "The folder safety net"): a scratch
// Postgres, the server in header sign-in, the note's people with real teams and grants, and project P with folders
// Ops (team Ops: view; Ops leads: edit), Ops/Returns, Finance (team Finance: view) and HR (no grants, no reach).
//
// HR holds the canaries — a dataset `HRCANARY Salaries` with a column `hrcanary_bonus` and HRCANARY_ values, and
// what follows it: a visual, a metric, a term, a verified question, an alert rule, and a dashboard `HRCANARY board`.
// Ops holds their twins (`Orders`, the same columns but `ops_bonus`), so every payload asked of HR — which names
// only ids and the shared columns, never a canary — can be asked of Ops (a control) and of an unknown id
// (section 3), by swapping ids. Everyone holds `Plain`. An Ops dashboard published and then
// edited (`OPSDRAFTCANARY`) is D8's: an editor with Can view on Ops reads only its copy.
//
// Not a test file itself (no `test-` prefix): the safety net imports it.

import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

export const context: typeof import('../src/server/context') = require('../src/server/context');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');

type Cell = import('../src/data/transforms').Cell;
type Identity = import('../src/server/context').Identity;

/** In every field HR's records carry: no reply to someone who cannot open HR may hold it, in any case. */
export const CANARY = /hrcanary/i;
export const OPS_DRAFT = /opsdraftcanary/i;

export const PEOPLE = ['boss', 'padmin', 'opsViewer', 'opsLead', 'opsEditorView', 'finViewer', 'ed', 'nobody'] as const;
export type Person = (typeof PEOPLE)[number];

export interface Reply { status: number; body: any; text: string } // any: each channel's own reply
/** One set of records: a dataset and what follows it, and a dashboard showing it. */
export interface Items { ds: string; visual: string; metric: string; term: string; verified: string; rule: string; board: string }
export interface World {
  P: string;
  folders: { ops: string; returns: string; fin: string; hr: string };
  hr: Items;
  ops: Items;
  plain: string;
  /** Ops's dashboard published as "Ops board", its draft since renamed OPSDRAFTCANARY (D8). */
  opsBoard: string;
  /** HR's one-row-per-dept labels (HRCANARY_label_…), which Orders relates to by `dept`: a question on Orders can read HR. */
  hrDim: string;
  /** A visual on Orders labelled from hrDim, its custom order naming HR's labels. */
  labelled: string;
  pool: Pool;
  call(who: Person, channel: string, payload?: unknown): Promise<Reply>;
  /** Runs `fn` in the org's context as `who` (their org role; the rest is their grants). */
  as<T>(who: Person, fn: () => Promise<T>): Promise<T>;
  /** Writes the folder rows: until then P has no folder besides Everyone. */
  plantFolders(): Promise<void>;
  close(): Promise<void>;
}

const COLUMNS = (extra: string) => [{ name: 'dept', type: 'text' as const }, { name: 'salary', type: 'number' as const }, { name: 'person', type: 'text' as const }, { name: 'day', type: 'date' as const }, { name: extra, type: 'number' as const }];
const rows = (tag: string): Cell[][] => Array.from({ length: 24 }, (_, i) => [`d${i % 3}`, (i * 37) % 101, `${tag}_${i % 6}`, `2024-0${1 + (i % 6)}-1${i % 9}`, i]);

/** Null (with a skip line) without DATABASE_URL. */
export async function world(label: string): Promise<World | null> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log(`skip ${label}: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)`);
    return null;
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-foldernet-db-'));
  const dbName = `ordinate_folders_net_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 3 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown

  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const app: FastifyInstance = appMod.buildApp(envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
    RATE_LIMIT_RPC_PER_MINUTE: '1000000', RATE_LIMIT_RPC_IP_PER_MINUTE: '1000000', // the sweep calls every channel, many times
  }));
  await app.ready();
  const email = (who: Person): string => `${who.toLowerCase()}@acme.test`;
  const call = async (who: Person, channel: string, payload?: unknown): Promise<Reply> => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email(who) }),
      payload: wire.encode({ args: payload === undefined ? [] : [payload] }),
      remoteAddress: '127.0.0.1',
    });
    let body: unknown = null;
    try {
      body = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body);
    } catch {
      body = null;
    }
    return { status: r.statusCode, body, text: r.body };
  };
  const must = <T>(what: string, v: T | null | undefined | ''): T => {
    if (!v) throw new Error(`setup: ${what}`);
    return v;
  };
  for (const p of PEOPLE) await call(p, 'projects:list'); // signs each in once: their users row
  const uid: Record<string, string> = {};
  for (const p of PEOPLE) uid[p] = (await pool.query<{ id: string }>('SELECT id::text FROM users WHERE email = $1', [email(p)])).rows[0].id;
  const team = async (name: string, members: Person[]): Promise<string> => {
    const t = (await pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ('acme', $1) RETURNING id::text`, [name])).rows[0].id;
    for (const m of members) await pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [t, uid[m]]);
    return t;
  };
  const T = { ops: await team('Ops', ['opsViewer', 'opsEditorView', 'nobody']), leads: await team('Ops leads', ['opsLead', 'nobody']), fin: await team('Finance', ['finViewer']) };
  const P: string = must('project', (await call('boss', 'projects:create', { name: 'Folders' })).body?.id);
  const ROLE: Record<string, string> = { padmin: 'admin', opsViewer: 'viewer', opsLead: 'editor', opsEditorView: 'editor', finViewer: 'viewer', ed: 'editor' };
  for (const [who, role] of Object.entries(ROLE)) {
    const r = await call('boss', 'project:share', { projectId: P, member: { userId: uid[who] }, role });
    if (r.body?.ok !== true) throw new Error(`share failed: ${r.text}`);
  }
  const ORG_ROLE: Record<string, Identity['user']['role']> = { boss: 'admin' };
  const as = <T>(who: Person, fn: () => Promise<T>): Promise<T> =>
    context.runInContext({ user: { email: email(who), role: ORG_ROLE[who] ?? 'viewer' }, org: { id: 'acme' } }, `as-${who}-${randomUUID()}`, fn);

  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const save = (name: string, extra: string, tag: string): Promise<string> => as('boss', async () => must(name, (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: COLUMNS(extra), rows: rows(tag) }))?.id));
  const card = (extra: object) => ({ id: randomUUID(), layout: { x: 0, y: 0, w: 6, h: 4 }, ...extra });
  const itemsOn = async (ds: string, word: string): Promise<Items> => {
    const money = 'salary';
    const enc = { category: 'dept', values: [{ column: money, aggregation: 'sum' }] };
    const v = await call('boss', 'visual:save', { projectId: P, datasetId: ds, name: `${word} chart`, chartType: 'bar', encoding: enc });
    const visual = must('visual', String(v.body?.visual?.id ?? v.body?.id ?? ''));
    const m = await call('boss', 'metric:save', { projectId: P, input: { name: `${word} metric`, datasetId: ds, definition: { column: money, aggregation: 'sum' } } });
    const metric = must('metric', String(m.body?.metric?.id ?? m.body?.id ?? ''));
    const t = await call('boss', 'term:save', { projectId: P, input: { name: `${word} term`, aliases: [], description: `${word} words`, datasetId: ds, filters: [{ type: 'filter', column: 'dept', op: '=', value: 'd1' }] } });
    const term = must(`term ${t.text}`, String(t.body?.term?.id ?? t.body?.id ?? ''));
    const q = await call('boss', 'verified:save', { projectId: P, input: { question: `${word} question by dept`, spec: { datasetId: ds, category: 'dept', measures: [{ column: money, aggregation: 'sum' }], filters: [] } } });
    const verified = must(`verified ${q.text}`, String(q.body?.q?.id ?? q.body?.question?.id ?? q.body?.id ?? ''));
    const a = await call('boss', 'alerts:save', { projectId: P, rule: { name: `${word} alert`, datasetId: ds, metric: { column: money, aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 0 }, enabled: true } });
    const rule = must(`rule ${a.text}`, String(a.body?.rule?.id ?? ''));
    const sheets = [{ name: 'One', cards: [card({ type: 'visual', visualId: visual }), card({ type: 'metric', metric: { datasetId: ds, column: money, aggregation: 'sum', label: `${word} total` } })] }];
    const b = await call('boss', 'analysis:create', { projectId: P, name: `${word} board`, sheets });
    const board = must('board', String(b.body?.id ?? b.body?.analysis?.id ?? ''));
    await call('boss', 'analysis:publish', { projectId: P, id: board });
    return { ds, visual, metric, term, verified, rule, board };
  };
  const hrDs = await save('HRCANARY Salaries', 'hrcanary_bonus', 'HRCANARY');
  const opsDs = await save('Orders', 'ops_bonus', 'p');
  const plain = await save('Plain', 'plain_bonus', 'q');
  const hrDim = await as('boss', async () => must('hr dim', (await datasets.saveDataset(P, { name: 'HRCANARY people', sourceKind: 'csv', columns: [{ name: 'dept', type: 'text' }, { name: 'label', type: 'text' }], rows: [0, 1, 2].map((i) => [`d${i}`, `HRCANARY_label_${i}`]) }))?.id));
  const hr = await itemsOn(hrDs, 'HRCANARY');
  const ops = await itemsOn(opsDs, 'Ops');
  await call('boss', 'analysis:update', { projectId: P, id: ops.board, name: 'OPSDRAFTCANARY board' }); // its draft, past its copy
  // A catalog note and a colour the HR chart dealt: values a project-wide reply could carry.
  must('catalog note', (await call('boss', 'catalog:set', { projectId: P, ref: `dataset:${hrDs}`, patch: { description: 'HRCANARY note', tags: ['HRCANARY tag'] } })).status === 200);
  must('colour', (await call('boss', 'format:colors:assign', { projectId: P, column: 'person', values: ['HRCANARY_0'] })).status === 200);
  must('column note', (await call('boss', 'catalog:setColumn', { projectId: P, datasetId: hrDs, column: 'person', patch: { description: 'HRCANARY column note' } })).body?.ok === true);
  must('table note', (await call('boss', 'catalog:setTable', { projectId: P, datasetId: hrDs, patch: { guide: 'HRCANARY table guide' } })).body?.ok === true);
  const rel = await call('boss', 'relationship:save', { projectId: P, relationship: { from: { datasetId: opsDs, column: 'dept' }, to: { datasetId: hrDim, column: 'dept' }, cardinality: 'many_to_one' } });
  must(`relationship ${rel.text}`, rel.body?.ok !== false && rel.status === 200);
  const lv = await call('boss', 'visual:save', { projectId: P, datasetId: opsDs, name: 'Ops labelled chart', chartType: 'bar', encoding: { category: 'label', categoryDatasetId: hrDim, values: [{ column: 'salary', aggregation: 'sum' }] }, overrides: { sortOrder: ['HRCANARY_label_2', 'HRCANARY_label_0'] } });
  const labelled = must(`labelled ${lv.text}`, String(lv.body?.visual?.id ?? lv.body?.id ?? ''));
  const folders = { ops: randomUUID(), returns: randomUUID(), fin: randomUUID(), hr: randomUUID() };
  const plantFolders = async (): Promise<void> => {
    const folder = (id: string, parent: string | null, name: string, share = true) =>
      pool.query('INSERT INTO folders (org_id, project_id, id, parent_id, name, share_figures, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', ['acme', P, id, parent, name, share, 'boss@acme.test']);
    const grant = (f: string, t: string, level: string) => pool.query('INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, $5)', ['acme', P, f, t, level]);
    const place = (kind: string, id: string, f: string) => pool.query('INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, $3, $4, $5, $6)', ['acme', P, kind, id.toLowerCase(), f, 'boss@acme.test']);
    await folder(folders.ops, null, 'Ops');
    await folder(folders.returns, folders.ops, 'Returns');
    await folder(folders.fin, null, 'Finance');
    await folder(folders.hr, null, 'HRCANARY folder', false);
    await grant(folders.ops, T.ops, 'view');
    await grant(folders.ops, T.leads, 'edit');
    await grant(folders.fin, T.fin, 'view');
    await place('dataset', hr.ds, folders.hr);
    await place('dataset', hrDim, folders.hr);
    await place('dashboard', hr.board, folders.hr);
    await place('dataset', ops.ds, folders.ops);
    await place('dashboard', ops.board, folders.ops);
  };
  return {
    P, folders, hr, ops, plain, opsBoard: ops.board, hrDim, labelled, pool, call, as, plantFolders,
    async close() {
      await app.close();
      await pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.end();
      fs.rmSync(DATA, { recursive: true, force: true });
    },
  };
}

/** A typed folder refusal: 409 `folder`, or a reply carrying `{ok:false, code:'folder'}` (itself, or per tile or item). */
export function refused(r: Reply, reason = 'closed'): boolean {
  if (r.status === 409) return r.body?.code === 'folder' && r.body?.reason === reason && typeof r.body.message === 'string';
  return r.status === 200 && r.text.includes('"code":"folder"') && r.text.includes(`"reason":"${reason}"`);
}

// ── Payloads, from each contract's own input schema ──────────────────────────

type ZodLike = { def: any; shape?: Record<string, ZodLike>; safeParse(v: unknown): { success: boolean } }; // any: zod's own definition
const FAMILY: Array<[RegExp, keyof Items]> = [[/^(analysis|dashboard|subscription|embed|publish|report)/, 'board'], [/^visual/, 'visual'], [/^(metric|numbers)/, 'metric'], [/^term/, 'term'], [/^verified/, 'verified'], [/^alerts/, 'rule']];

/** Values by field name, for a channel, on `it` (HR's, Ops's): what a payload for that channel names — ids and shared columns, no canary. */
export function valuesFor(P: string, it: Items, channel: string): Record<string, unknown> {
  const money = 'salary';
  const own = FAMILY.find(([re]) => re.test(channel))?.[1] ?? 'ds';
  const spec = { datasetId: it.ds, category: 'dept', measures: [{ column: money, aggregation: 'sum' }], filters: [] };
  return {
    projectId: P, datasetId: it.ds, baseId: it.ds, id: it[own], ids: [it[own]], analysisId: it.board, dashboardId: it.board, visualId: it.visual,
    metricId: it.metric, termId: it.term, ruleId: it.rule, column: money, columns: [money], ref: `dataset:${it.ds}`,
    encoding: { category: 'dept', values: [{ column: money, aggregation: 'sum' }] }, spec, definition: { column: money, aggregation: 'sum' },
    filters: [], query: 'salaries', q: 'salaries', search: '', term: 'salaries', text: 'salaries', aggregation: 'sum',
    sql: 'SELECT 1 AS one', expression: `sum([${money}])`, offset: 0, limit: 50,
    target: { kind: 'dataset', id: it.ds }, type: 'dataset', kind: 'dataset',
  };
}

function sample(s: ZodLike, key: string, values: Record<string, unknown>, depth: number): unknown {
  const d = s.def;
  if (Object.prototype.hasOwnProperty.call(values, key) && depth <= 1) return values[key];
  switch (d.type) {
    case 'optional': case 'default': case 'nullable': case 'readonly': case 'catch': case 'nonoptional': return sample(d.innerType, key, values, depth);
    case 'pipe': return sample(d.in, key, values, depth);
    case 'string': return d.format === 'guid' || d.format === 'uuid' ? randomUUID() : 'x';
    case 'number': return 1;
    case 'boolean': return false;
    case 'enum': { const opts = Object.values(d.entries as Record<string, unknown>); return opts.includes(values[key]) ? values[key] : opts[0]; }
    case 'literal': return d.values[0];
    case 'array': return d.element && depth < 4 ? [sample(d.element, key.replace(/s$/, ''), values, depth + 1)] : [];
    case 'object': return depth < 4 ? objectFor(s, values, depth + 1) : {};
    case 'union': return sample(d.options[0], key, values, depth);
    case 'record': return {};
    default: return undefined;
  }
}

function objectFor(s: ZodLike, values: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(s.shape ?? {})) {
    const optional = f.safeParse(undefined).success;
    if (optional && !(Object.prototype.hasOwnProperty.call(values, k) && depth <= 1)) continue;
    const v = sample(f, k, values, depth);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A payload for `contract` naming `values`' items, or null when its schema cannot be satisfied that way. */
export function payloadFor(contract: { input: ZodLike }, values: Record<string, unknown>): Record<string, unknown> | null {
  if (contract.input.def.type !== 'object') return null;
  const full = objectFor(contract.input, values, 1);
  if (contract.input.safeParse(full).success) return full;
  const required = Object.fromEntries(Object.entries(full).filter(([k]) => !contract.input.shape?.[k]?.safeParse(undefined).success));
  return contract.input.safeParse(required).success ? required : null;
}

/** `v` with every string's `from` replaced by `to`, deeply (a payload or a reply, swapped onto other items). */
export function swapped<T>(v: T, map: Record<string, string>): T {
  const s = (x: string): string => Object.entries(map).reduce((acc, [from, to]) => acc.split(from).join(to), x);
  const walk = (x: unknown): unknown => (typeof x === 'string' ? s(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x);
  return walk(v) as T;
}

/** Keys that differ between two runs of the same call: times, tokens, and ids minted per call. */
const VOLATILE = new Set(['asOf', 'computedAt', 'generatedAt', 'threadId', 'turnId', 'askId', 'createdAt', 'updatedAt', 'downloadToken', 'token', 'at', 'requestId', 'ms', 'elapsedMs', 'tookMs', 'checkedAt', 'startedAt', 'finishedAt']);

/** The reply without its volatile keys, as text: what two runs of one call must agree on. */
export function stable(r: Reply): string {
  // Keys sorted: a reply built concurrently (metric:table's rows) may list the same keys in another order.
  const walk = (x: unknown): unknown => (Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, walk(y)])) : x);
  return `${r.status} ${JSON.stringify(walk(r.body))}`;
}
