// Self-check for the automation surface's FRONT DOORS — src/automation/.
//
//   1. headlessMode + parseCli: commands, subcommands, every flag form, the
//      SQL argument's quoting, and a usage error for every malformed input.
//   2. runCli: the exit code for every class (ok, usage, not found, runtime,
//      disabled) and the --json envelope, over a STUB registry.
//   3. The registry: every schema is JSON-Schema-shaped and round-trips as
//      JSON, names are unique, and validateArgs enforces it.
//   4. The JSON-RPC layer: initialize, notifications, ping, tools/list,
//      tools/call, unknown method/tool, bad params, invalid request.
//   5. The HTTP transport, the REAL server on an ephemeral port: no token,
//      wrong token, right token, non-loopback Host, foreign Origin, 405, 413.
//   6. The headless job log round trip into jobs.recordExternal.
//   7. docs/automation.md is exactly what the registry generates.
//
//   npm run build:ts && node scripts/test-automation.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');
const Module: any = require('module'); // ponytail: Node's loader hook is untyped

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-automation-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '9.9.9' }, ipcMain: { handle: () => {} } };
  return origLoad.apply(this, [request, ...rest]);
};

const argvMod: typeof import('../src/automation/argv') = require('../src/automation/argv');
const cli: typeof import('../src/automation/cli') = require('../src/automation/cli');
const reg: typeof import('../src/automation/registry') = require('../src/automation/registry');
const mcp: typeof import('../src/automation/mcp') = require('../src/automation/mcp');
const httpT: typeof import('../src/automation/httpTransport') = require('../src/automation/httpTransport');
const jobLog: typeof import('../src/automation/jobLog') = require('../src/automation/jobLog');
const docs: typeof import('../src/automation/docs') = require('../src/automation/docs');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const { AutomationError, EXIT } = reg;

type Cmd = import('../src/automation/registry').Command;

const throwsCode = (fn: () => unknown, code: string): boolean => {
  try { fn(); return false; } catch (e) { return e instanceof AutomationError && e.code === code; }
};

// ── 1. Parsing ───────────────────────────────────────────────────────────────
{
  const hm = argvMod.headlessMode;
  ok('headless: --cli anywhere before --', hm(['/bin/electron', '.', '--cli', 'projects', 'list']) === 'cli');
  ok('headless: --mcp', hm(['/Applications/X.app/Contents/MacOS/X', '--mcp']) === 'mcp');
  ok('headless: the first mode wins (a later --mcp is an argument)', hm(['x', '--cli', 'query', '--mcp']) === 'cli');
  ok('headless: a plain launch is the GUI', hm(['x', '.']) === null && hm(['x', '--', '--cli']) === null);
  ok('headless: only whole arguments count', hm(['x', '--client']) === null);
  ok('modeArgs: what follows the switch', JSON.stringify(argvMod.modeArgs(['e', '.', '--user-data-dir=/t', '--cli', 'a', 'b'], 'cli')) === '["a","b"]');

  const P = (a: string[]) => argvMod.parseCli(a, reg.COMMANDS);
  const q = P(['query', 'SELECT a, "b c" FROM t WHERE x = \'--json\'', '--limit', '25', '--json']);
  ok('parse: query keeps the SQL as ONE argument, flag-looking text inside it included',
    q.cmd!.cli === 'query' && q.args.sql === 'SELECT a, "b c" FROM t WHERE x = \'--json\'' && q.args.limit === 25 && q.json);
  const rest = P(['query', 'select', 'count(*)', 'from', 'sales']);
  ok('parse: unquoted SQL words are joined (rest)', rest.args.sql === 'select count(*) from sales');
  ok('parse: --limit=N form', P(['query', 'select 1', '--limit=7']).args.limit === 7);
  ok('parse: -- ends the options', P(['query', '--', '--json is data here']).args.sql === '--json is data here');
  const two = P(['--project', 'My project', 'datasets', 'describe', 'Retail orders']);
  ok('parse: two-word command, global flag first, name with a space',
    two.cmd!.cli === 'datasets describe' && two.args.dataset === 'Retail orders' && two.args.project === 'My project');
  const ex = P(['dashboards', 'export', 'Retail', '--png', '--out', 'x.png']);
  ok('parse: --png shorthand sets format, --out passes through', ex.args.format === 'png' && ex.args.out === 'x.png');
  ok('parse: an argument by flag instead of position', P(['insights', '--dataset', 'Sales']).args.dataset === 'Sales');
  ok('parse: help, and help for one command', P(['help']).help && !P(['help']).cmd && P(['help', 'query']).cmd!.cli === 'query');
  ok('parse: --help after a command', P(['datasets', 'list', '--help']).help);
  ok('parse: no words is help', P([]).help);

  ok('usage: unknown command', throwsCode(() => P(['bogus', 'thing']), 'usage'));
  ok('usage: unknown option', throwsCode(() => P(['datasets', 'list', '--nope']), 'usage'));
  ok('usage: a value flag with no value', throwsCode(() => P(['query', 'select 1', '--limit']), 'usage'));
  ok('usage: --limit must be a whole number', throwsCode(() => P(['query', 'select 1', '--limit', 'ten']), 'usage'));
  ok('usage: an option of another command', throwsCode(() => P(['datasets', 'list', '--limit', '3']), 'usage'));
  ok('usage: two format shorthands', throwsCode(() => P(['dashboards', 'export', 'D', '--pdf', '--png']), 'usage'));
  ok('usage: --project on projects list', throwsCode(() => P(['projects', 'list', '--project', 'x']), 'usage'));
  ok('usage: an extra positional', throwsCode(() => P(['datasets', 'describe', 'A', 'B']), 'usage'));
  ok('usage: a boolean given a value', throwsCode(() => P(['datasets', 'list', '--json=yes']), 'usage'));
}

// ── 2. runCli exit codes, over a stub registry ───────────────────────────────
async function cliCodes(): Promise<void> {
  const stub = (cli: string, run: () => Promise<unknown>, extra: Partial<Cmd> = {}): Cmd => ({
    cli, summary: cli, args: { thing: { type: 'string', description: 't' } }, positional: ['thing'], readOnly: true, run, ...extra,
  });
  const commands: Cmd[] = [
    stub('ok', async () => [{ id: 'a', name: 'Alpha' }]),
    stub('missing', async () => { throw new AutomationError('not_found', 'No dataset called "x".'); }),
    stub('boom', async () => { throw new Error('disk full'); }),
    stub('off', async () => { throw new AutomationError('disabled', 'Automation is off.'); }),
    stub('needs', async () => 1, { required: ['thing'] }),
  ];
  const dispatch = async (cmd: Cmd, raw: unknown) => {
    reg.validateArgs(cmd, raw, 'cli');
    return cmd.run({}, { projectId: '', transport: 'cli', cwd: tmp, headless: true, progress: () => {} });
  };
  const run = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await cli.runCli(argv, { out: (t) => { out += t + '\n'; }, err: (t) => { err += t + '\n'; } },
      { headless: true, commands, dispatch: dispatch as any });
    return { code, out, err };
  };

  const a = await run(['ok', '--json']);
  const env = JSON.parse(a.out);
  ok('exit 0 + {"ok":true,"result"} envelope', a.code === EXIT.ok && env.ok === true && env.result[0].name === 'Alpha' && !a.err);
  const t = await run(['ok']);
  ok('text output is a table', t.code === 0 && /id\s+name/.test(t.out) && t.out.includes('Alpha'));
  const nf = await run(['missing', '--json']);
  const nfe = JSON.parse(nf.out);
  ok('exit 3 not found, JSON error on stdout, message on stderr',
    nf.code === 3 && nfe.ok === false && nfe.code === 'not_found' && nf.err.includes('No dataset'));
  const rt = await run(['boom']);
  ok('exit 1 runtime for an unclassified throw', rt.code === 1 && rt.err.includes('disk full') && !rt.out);
  const off = await run(['off']);
  ok('exit 4 disabled', off.code === 4);
  const us = await run(['nope', '--json']);
  ok('exit 2 for a parse error, still answered in JSON', us.code === 2 && JSON.parse(us.out).code === 'usage');
  ok('exit 2 for a missing required argument', (await run(['needs'])).code === 2);
  ok('exit 2 for no command at all (usage printed)', (await run([])).code === 2);
  const help = await run(['help']);
  ok('help: exit 0, lists every command', help.code === 0 && commands.every((c) => help.out.includes(c.cli!)));
  const realHelp = cli.usage(reg.COMMANDS);
  ok('real usage names every CLI command', reg.COMMANDS.filter((c) => c.cli).every((c) => realHelp.includes(c.cli!)));
  ok('exit codes are the documented five', EXIT.ok === 0 && EXIT.runtime === 1 && EXIT.usage === 2 && EXIT.not_found === 3 && EXIT.disabled === 4);
}

// ── 3. The registry's schemas ────────────────────────────────────────────────
{
  const tools = reg.COMMANDS.filter((c) => c.tool).map((c) => c.tool!);
  const clis = reg.COMMANDS.filter((c) => c.cli).map((c) => c.cli!);
  ok('every entry is a CLI command or an MCP tool', reg.COMMANDS.every((c) => c.cli || c.tool));
  ok('tool names unique and snake_case', new Set(tools).size === tools.length && tools.every((t) => /^[a-z]+(_[a-z]+)*$/.test(t)));
  ok('CLI names unique', new Set(clis).size === clis.length);
  const want = ['list_datasets', 'describe_dataset', 'aggregate', 'query_sql', 'list_metrics', 'metric_value', 'insights',
    'create_visual', 'create_dashboard', 'export_dashboard', 'run_report'];
  ok('every tool the spec names exists', want.every((t) => tools.includes(t)), want.filter((t) => !tools.includes(t)).join());
  const wantCli = ['projects list', 'datasets list', 'datasets describe', 'datasets import', 'datasets refresh', 'query',
    'metrics list', 'metrics value', 'insights', 'dashboards list', 'dashboards export', 'reports run', 'publish'];
  ok('every CLI command the spec names exists', wantCli.every((c) => clis.includes(c)));
  ok('read-only everywhere except the two creators (among tools)',
    reg.COMMANDS.filter((c) => c.tool && !c.readOnly).map((c) => c.tool).sort().join() === 'create_dashboard,create_visual');
  ok('no connection tool is exposed', !tools.some((t) => /conn|secret|config|key/.test(t)));
  let shaped = true;
  for (const c of reg.COMMANDS) {
    const s = reg.inputSchema(c) as any;
    const props = s.properties || {};
    if (s.type !== 'object' || s.additionalProperties !== false) shaped = false;
    for (const [k, p] of Object.entries(props) as Array<[string, any]>) {
      if (!['string', 'integer', 'boolean', 'object', 'array'].includes(p.type) || typeof p.description !== 'string' || !p.description) shaped = false;
      if (p.enum && !(Array.isArray(p.enum) && p.enum.length)) shaped = false;
      if (k === 'out' && c.cliOnly && c.cliOnly.includes('out')) shaped = false; // CLI-only never reaches MCP
    }
    for (const r of s.required || []) if (!(r in props)) shaped = false;
    for (const p of c.positional || []) if (!(p in c.args)) shaped = false;
    if (JSON.stringify(JSON.parse(JSON.stringify(s))) !== JSON.stringify(s)) shaped = false;
  }
  ok('every inputSchema is object-typed, closed, described, JSON round-trippable', shaped);
  const cmd = reg.findTool('query_sql')!;
  ok('validateArgs: unknown argument', throwsCode(() => reg.validateArgs(cmd, { sql: 'x', nope: 1 }, 'stdio'), 'usage'));
  ok('validateArgs: wrong type', throwsCode(() => reg.validateArgs(cmd, { sql: 5 }, 'stdio'), 'usage'));
  ok('validateArgs: over the bound', throwsCode(() => reg.validateArgs(cmd, { sql: 'x', limit: 1_000_001 }, 'stdio'), 'usage'));
  ok('validateArgs: missing required', throwsCode(() => reg.validateArgs(cmd, {}, 'stdio'), 'usage'));
  ok('validateArgs: not an object', throwsCode(() => reg.validateArgs(cmd, [1], 'stdio'), 'usage'));
  const ex = reg.findTool('export_dashboard')!;
  ok('validateArgs: enum', throwsCode(() => reg.validateArgs(ex, { dashboard: 'd', format: 'gif' }, 'stdio'), 'usage'));
  ok('validateArgs: a CLI-only argument is refused over MCP, accepted on the CLI',
    throwsCode(() => reg.validateArgs(ex, { dashboard: 'd', out: '/etc/x' }, 'http'), 'usage')
      && reg.validateArgs(ex, { dashboard: 'd', out: 'x.pdf' }, 'cli').out === 'x.pdf');
  ok('validateArgs: a good call passes through', reg.validateArgs(cmd, { sql: 'select 1', limit: 5 }, 'stdio').limit === 5);
}

// ── 4. JSON-RPC ──────────────────────────────────────────────────────────────
async function rpc(): Promise<void> {
  const calls: unknown[] = [];
  const handle = mcp.createHandler({
    commands: reg.COMMANDS, transport: 'stdio', headless: true, version: '1.2.3',
    dispatch: async (cmd, raw) => {
      const args = reg.validateArgs(cmd, raw, 'stdio');
      calls.push(args);
      if (cmd.tool === 'list_datasets') return [{ id: 'd1', name: 'Sales' }];
      if (cmd.tool === 'describe_dataset') throw new AutomationError('not_found', 'No dataset called "x".');
      return { ok: 1 };
    },
  }, reg.inputSchema);
  const init: any = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
  ok('initialize: echoes a supported version, tools capability, serverInfo',
    init.result.protocolVersion === '2025-03-26' && init.result.capabilities.tools && init.result.serverInfo.version === '1.2.3');
  const init2: any = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  ok('initialize: an unknown version gets the latest', init2.result.protocolVersion === mcp.PROTOCOL_VERSIONS[0]);
  ok('notifications/initialized gets no reply', (await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })) === null);
  const ping: any = await handle({ jsonrpc: '2.0', id: 'p', method: 'ping' });
  ok('ping → {}', ping.id === 'p' && JSON.stringify(ping.result) === '{}');
  const list: any = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const names = list.result.tools.map((t: any) => t.name);
  ok('tools/list: every tool, schema verbatim from the registry',
    names.length === reg.COMMANDS.filter((c) => c.tool).length
      && JSON.stringify(list.result.tools.find((t: any) => t.name === 'query_sql').inputSchema) === JSON.stringify(reg.inputSchema(reg.findTool('query_sql')!)));
  ok('tools/list: read-only hints match the registry',
    list.result.tools.every((t: any) => t.annotations.readOnlyHint === reg.findTool(t.name)!.readOnly));
  const call: any = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_datasets', arguments: {} } });
  ok('tools/call: result as JSON text', call.result.isError === false && JSON.parse(call.result.content[0].text)[0].name === 'Sales');
  const obj: any = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'query_sql', arguments: { sql: 'select 1' } } });
  ok('tools/call: an object result is also structuredContent', obj.result.structuredContent && obj.result.structuredContent.ok === 1);
  const nf: any = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'describe_dataset', arguments: { dataset: 'x' } } });
  ok('tools/call: a tool that fails is isError, not a protocol error', nf.result && nf.result.isError === true && nf.result.content[0].text.includes('No dataset'));
  const bad: any = await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'query_sql', arguments: { sql: 3 } } });
  ok('tools/call: bad params → -32602', bad.error && bad.error.code === -32602);
  const unk: any = await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'drop_everything', arguments: {} } });
  ok('tools/call: unknown tool → -32602', unk.error && unk.error.code === -32602);
  const nm: any = await handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  ok('unknown method → -32601', nm.error && nm.error.code === -32601 && nm.id === 9);
  const ir: any = await handle({ id: 10, method: 'ping' });
  ok('missing jsonrpc → -32600', ir.error && ir.error.code === -32600);
  ok('a non-object message → -32600', ((await handle('hello')) as any).error.code === -32600);
  ok('a client response is ignored', (await handle({ jsonrpc: '2.0', id: 11, result: {} })) === null);
  const gated = mcp.createHandler({ commands: reg.COMMANDS, transport: 'stdio', headless: true, version: '1', dispatch: async () => 1, gate: () => 'Automation is off.' }, reg.inputSchema);
  const g: any = await gated({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'list_datasets', arguments: {} } });
  ok('a switched-off server answers every call with an error result', g.result.isError === true && g.result.content[0].text.includes('off'));
}

// ── 5. HTTP transport — the real server ──────────────────────────────────────
function request(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method || 'POST', path: opts.path || '/mcp', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function httpGate(): Promise<void> {
  let token = 'ord_right-token';
  const handle = mcp.createHandler({ commands: reg.COMMANDS, transport: 'http', headless: false, version: '1', dispatch: async () => [] }, reg.inputSchema);
  const srv = await httpT.startHttp({ port: 0, token: () => token, handle });
  const p = srv.port;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const hdr = (extra: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', Host: `127.0.0.1:${p}`, ...extra });
  try {
    ok('http: no token → 401', (await request(p, { headers: hdr(), body })).status === 401);
    ok('http: wrong token → 401', (await request(p, { headers: hdr({ Authorization: 'Bearer ord_wrong' }), body })).status === 401);
    ok('http: a non-Bearer scheme → 401', (await request(p, { headers: hdr({ Authorization: 'Basic ' + token }), body })).status === 401);
    const good = await request(p, { headers: hdr({ Authorization: 'Bearer ' + token }), body });
    ok('http: right token → 200 with tools/list', good.status === 200 && JSON.parse(good.body).result.tools.length > 5);
    ok('http: localhost Host is fine too', (await request(p, { headers: hdr({ Host: `localhost:${p}`, Authorization: 'Bearer ' + token }), body })).status === 200);
    ok('http: a rebinding Host → 403 even with the token',
      (await request(p, { headers: hdr({ Host: `evil.example:${p}`, Authorization: 'Bearer ' + token }), body })).status === 403);
    ok('http: a foreign Origin → 403 even with the token',
      (await request(p, { headers: hdr({ Origin: 'https://evil.example', Authorization: 'Bearer ' + token }), body })).status === 403);
    ok('http: the "null" Origin → 403', (await request(p, { headers: hdr({ Origin: 'null', Authorization: 'Bearer ' + token }), body })).status === 403);
    ok('http: a loopback Origin is allowed',
      (await request(p, { headers: hdr({ Origin: `http://localhost:${p}`, Authorization: 'Bearer ' + token }), body })).status === 200);
    ok('http: GET → 405', (await request(p, { method: 'GET', headers: hdr({ Authorization: 'Bearer ' + token }) })).status === 405);
    ok('http: another path → 404', (await request(p, { path: '/', headers: hdr({ Authorization: 'Bearer ' + token }), body })).status === 404);
    const pe = await request(p, { headers: hdr({ Authorization: 'Bearer ' + token }), body: '{not json' });
    ok('http: bad JSON → 400 + -32700', pe.status === 400 && JSON.parse(pe.body).error.code === -32700);
    const big = await request(p, { headers: hdr({ Authorization: 'Bearer ' + token }), body: 'x'.repeat(httpT.MAX_BODY + 10) }).catch(() => ({ status: 413, body: '' }));
    ok('http: an oversized body → 413', big.status === 413);
    const note = await request(p, { headers: hdr({ Authorization: 'Bearer ' + token }), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    ok('http: a notification → 202, no body', note.status === 202 && note.body === '');
    const old = token;
    token = 'ord_regenerated';
    ok('http: after Regenerate the old token is refused at once',
      (await request(p, { headers: hdr({ Authorization: 'Bearer ' + old }), body })).status === 401);
    ok('http: bearerMatches is exact', httpT.bearerMatches('Bearer abc', 'abc') && !httpT.bearerMatches('Bearer abcd', 'abc') && !httpT.bearerMatches('Bearer abc', null));
  } finally {
    await srv.close();
  }
  const busy = await httpT.startHttp({ port: 0, token: () => 't', handle });
  const clash = await httpT.startHttp({ port: busy.port, token: () => 't', handle }).then(() => 'started', (e) => e.code);
  ok('http: a taken port rejects with EADDRINUSE (the pane shows it)', clash === 'EADDRINUSE');
  await busy.close();
}

// ── 6. Headless job log → the GUI's Jobs popover ─────────────────────────────
{
  const file = path.join(tmp, jobLog.LOG_NAME);
  const job = (id: string) => ({ id, kind: 'automation', label: 'Create visual "X"', state: 'done', progress: 1, cancellable: false, createdAt: new Date().toISOString() });
  let offset = jobLog.sizeOf(file);
  jobLog.appendJob(file, job('11111111-1111-4111-8111-111111111111'));
  jobLog.appendJob(file, job('22222222-2222-4222-8222-222222222222'));
  fs.appendFileSync(file, '{"id":"half-writ');
  const r1 = jobLog.readNewLines(file, offset);
  ok('job log: complete lines only, the half-written tail waits', r1.lines.length === 2 && r1.offset < jobLog.sizeOf(file));
  offset = r1.offset;
  fs.appendFileSync(file, 'ten"}\n');
  const r2 = jobLog.readNewLines(file, offset);
  ok('job log: the tail arrives once finished', r2.lines.length === 1 && r2.offset === jobLog.sizeOf(file));
  jobs.reset();
  const got = r1.lines.map((l) => jobs.recordExternal(JSON.parse(l)));
  ok('job log: each line lands in the Jobs list via recordExternal', got.every(Boolean) && jobs.snapshot().recent.length === 2);
  ok('job log: a replayed line is not recorded twice', jobs.recordExternal(JSON.parse(r1.lines[0])) === null);
  fs.writeFileSync(file, '');
  ok('job log: a truncated file is read from the start', jobLog.readNewLines(file, offset).offset === 0);
}

// ── 7. The generated reference ───────────────────────────────────────────────
{
  const committed = fs.readFileSync(path.join(__dirname, '..', 'docs', 'automation.md'), 'utf8');
  const generated = docs.generateDocs(reg.COMMANDS) + '\n';
  ok('docs/automation.md is exactly what the registry generates (run node scripts/gen-automation-docs.js)', committed === generated);
  const everyName = reg.COMMANDS.every((c) => (!c.tool || committed.includes('`' + c.tool + '`')) && (!c.cli || committed.includes(c.cli))
    && Object.keys(c.args).every((a) => committed.includes('`' + a + '`')));
  ok('docs name every tool, command and argument', everyName);
}

void (async () => {
  await cliCodes();
  await rpc();
  await httpGate();
  fs.rmSync(tmp, { recursive: true, force: true });
  finish();
})();
