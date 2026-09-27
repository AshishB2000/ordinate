// The app binary with NO window: `--cli <command>` and `--mcp` (stdio).
//
// `start()` is called from the very top of src/main.ts, BEFORE the
// single-instance lock (a headless run must work while the GUI is open) and
// before anything logs. Everything it needs later is required lazily, so
// main.ts's own module order is unchanged.
//
// What a headless process must not do, and how it doesn't:
//   • Fight the GUI for Chromium profile state → `sessionData` (cookies, local
//     storage, GPU cache) goes to a temp dir; `userData` — projects,
//     config.json — stays shared, which is the point.
//   • Write the GUI's jobs.json → the jobs queue runs in memory; finished jobs
//     are APPENDED to automation-log.jsonl, which the GUI tails.
//   • Show up → no window (main.ts skips the hub, hotkey, seed and schedules),
//     no dock icon.
//   • Corrupt the protocol → in MCP mode stdout IS the channel, so every
//     console method is sent to stderr before a single line is logged. In CLI
//     mode stdout carries only the answer; the app's own log lines are dropped
//     unless --verbose, and errors still reach stderr.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { format } from 'util';
import { app } from 'electron';
import { modeArgs } from './argv';
import type { HeadlessMode } from './argv';
import { LOG_NAME, appendJob } from './jobLog';

let tmpSession = '';

export function start(mode: HeadlessMode): void {
  const argv = modeArgs(process.argv, mode);
  const toErr = (...a: unknown[]): void => { process.stderr.write(format(...a) + '\n'); };
  const quiet = mode === 'cli' && !argv.includes('--verbose');
  const chatter = quiet ? (): void => {} : toErr;
  console.log = chatter;
  console.info = chatter;
  console.debug = chatter;
  console.warn = chatter;
  console.error = toErr;

  tmpSession = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-headless-'));
  app.setPath('sessionData', tmpSession);
  try { if (app.dock) app.dock.hide(); } catch (_) { /* not macOS, or too early — cosmetic */ }
  // A hidden report window closing must not end the run; exit is explicit.
  app.on('window-all-closed', () => { /* stay alive until finish() */ });

  void app.whenReady()
    .then(() => run(mode, argv))
    .catch((e: unknown) => {
      toErr('ordinate: ' + ((e instanceof Error && e.message) || String(e)));
      finish(1);
    });
}

/** Flush stdout (a pipe is asynchronous on macOS), clean up, exit with `code`. */
function finish(code: number): void {
  process.stdout.write('', () => {
    try { fs.rmSync(tmpSession, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    app.exit(code);
  });
}

async function run(mode: HeadlessMode, argv: string[]): Promise<void> {
  const config = require('../app/config') as typeof import('../app/config');
  const projects = require('../app/projects') as typeof import('../app/projects');
  const jobs = require('../app/jobs') as typeof import('../app/jobs');
  config.load();
  await projects.init();
  // In memory only; every finished job goes to the log the GUI tails.
  const logFile = path.join(app.getPath('userData'), LOG_NAME);
  jobs.configure({ file: null });
  jobs.onFinish((job) => appendJob(logFile, job));

  if (mode === 'cli') {
    const { runCli } = require('./cli') as typeof import('./cli');
    const code = await runCli(argv, {
      out: (t) => { process.stdout.write(t + '\n'); },
      err: (t) => { process.stderr.write(t + '\n'); },
    }, { headless: true, cwd: process.cwd() });
    finish(code);
    return;
  }

  const { EXIT } = require('./errors') as typeof import('./errors');
  const off = (): string | null => {
    try { config.load(); } catch (_) { /* keep the last good read */ }
    const a = config.get().automation;
    return a && a.enabled ? null : 'Automation is turned off in Ordinate (Settings → Automation).';
  };
  if (off()) {
    process.stderr.write('ordinate: the MCP server is off. Turn on Settings → Automation in Ordinate, then reconnect.\n');
    finish(EXIT.disabled);
    return;
  }
  serveStdio(off);
}

/** Newline-delimited JSON-RPC on stdin/stdout until stdin closes. */
function serveStdio(gate: () => string | null): void {
  const readline = require('readline') as typeof import('readline');
  const registry = require('./registry') as typeof import('./registry');
  const { createHandler, rpcError, RPC } = require('./mcp') as typeof import('./mcp');
  const handle = createHandler({
    commands: registry.COMMANDS, dispatch: registry.dispatch, transport: 'stdio', headless: true,
    version: app.getVersion(), gate,
  }, registry.inputSchema);
  const write = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };
  let inflight = 0;
  let closed = false;
  const settle = (): void => { if (closed && inflight === 0) finish(0); };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      write(rpcError(null, RPC.parse, 'Parse error'));
      return;
    }
    inflight++;
    // Concurrent on purpose: a ping must not wait behind a report.
    handle(msg)
      .then((reply) => { if (reply) write(reply); }, () => write(rpcError(null, RPC.internal, 'Internal error')))
      .finally(() => { inflight--; settle(); })
      .catch(() => { /* write never throws; finish exits */ });
  });
  rl.on('close', () => { closed = true; settle(); });
}
