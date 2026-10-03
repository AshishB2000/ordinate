import { app } from 'electron';
import { ipcMain } from './bus';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as config from '../app/config';
import * as jobs from '../app/jobs';
import * as registry from '../automation/registry';
import { createHandler } from '../automation/mcp';
import { startHttp } from '../automation/httpTransport';
import type { HttpServer } from '../automation/httpTransport';
import { LOG_NAME, readNewLines, sizeOf } from '../automation/jobLog';
import { settle as settleReport } from '../automation/reportRunner';
import type { PlatformDeps } from './platform';

// Automation IPC — Settings → Automation, the loopback MCP server's lifecycle,
// its access token, and the Jobs popover's view of headless runs.
//
//   automation:status          what the pane paints (never the token itself)
//   automation:set             { enabled?, http?, port? } → persist, reconcile the server
//   automation:takeToken       the token, ONCE — then only its masked form
//   automation:regenerateToken a new token (the old one stops working at once)
//   automation:reportDone      a hidden report window's bytes (reportRunner.ts)
//
// THE TOKEN is per launch and in memory only: generated when the HTTP server
// first starts, never written to config.json, never logged. The pane may read
// it exactly once (takeToken) — after that main only ever returns a mask, so
// a token is not sitting in a renderer to be read later. Regenerate issues a
// new one, readable once again. Turning automation off discards it.
//
// The CLI is NOT gated here: it is the user's own shell running this binary on
// their own files. The MCP server — something another program connects to —
// is what the Enable switch governs (stdio refuses to start without it; HTTP
// is not listening without it).

let server: HttpServer | null = null;
let serverError = '';
let token: string | null = null;
let revealed = false;
let reconciling: Promise<void> = Promise.resolve();

function newToken(): string {
  return 'ord_' + randomBytes(24).toString('base64url');
}

function prefs(): config.AutomationPrefs {
  const a = config.get().automation;
  return a || { enabled: false, http: false, port: config.AUTOMATION_PORT };
}

/** How to run THIS binary from a shell: the app path too in development. */
function binaryArgv(): string[] {
  return app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
}

const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

function status(): Record<string, unknown> {
  const p = prefs();
  const bin = binaryArgv().map(quote).join(' ');
  return {
    enabled: p.enabled,
    http: p.http,
    port: p.port,
    running: Boolean(server),
    error: serverError || null,
    url: `http://127.0.0.1:${server ? server.port : p.port}/mcp`,
    token: {
      exists: Boolean(token),
      fresh: Boolean(token) && !revealed,
      masked: token ? 'ord_' + '•'.repeat(12) + token.slice(-4) : '',
    },
    stdioSetup: `claude mcp add ordinate -- ${bin} --mcp`,
    httpSetup: `claude mcp add --transport http ordinate http://127.0.0.1:${p.port}/mcp --header "Authorization: Bearer <token>"`,
    cliExample: `${bin} --cli projects list --json`,
    tools: registry.COMMANDS.filter((c) => c.tool).map((c) => ({ name: c.tool, readOnly: c.readOnly, summary: c.summary })),
  };
}

async function stopServer(): Promise<void> {
  const s = server;
  server = null;
  if (s) await s.close();
}

/** Make the running server match the saved switches. Serialized: two quick toggles never race. */
function reconcile(): Promise<void> {
  reconciling = reconciling.then(async () => {
    const p = prefs();
    if (!p.enabled) {
      await stopServer();
      token = null;
      revealed = false;
      serverError = '';
      return;
    }
    if (!p.http) {
      await stopServer();
      serverError = '';
      return;
    }
    if (server && server.port === p.port) return;
    await stopServer();
    if (!token) { token = newToken(); revealed = false; }
    const handle = createHandler({
      commands: registry.COMMANDS, dispatch: registry.dispatch, transport: 'http', headless: false, version: app.getVersion(),
    }, registry.inputSchema);
    try {
      server = await startHttp({ port: p.port, token: () => token, handle });
      serverError = '';
    } catch (e) {
      const code = (e as { code?: string }).code;
      serverError = code === 'EADDRINUSE'
        ? `Port ${p.port} is already in use. Choose another port.`
        : `The server could not start (${(e as Error).message}).`;
    }
  }).catch(() => { /* the error is on serverError; the chain must keep going */ });
  return reconciling;
}

/**
 * Jobs a headless run finished land in the popover: the CLI and the stdio
 * server append to automation-log.jsonl, this reads what is new. Starts at the
 * END of the file, so a launch never replays yesterday's runs. Always on —
 * the CLI works whether or not the MCP server is enabled.
 */
function tailJobLog(): void {
  const file = path.join(app.getPath('userData'), LOG_NAME);
  let offset = sizeOf(file);
  fs.watchFile(file, { interval: 1000, persistent: false }, () => {
    const next = readNewLines(file, offset);
    offset = next.offset;
    for (const line of next.lines) {
      try { jobs.recordExternal(JSON.parse(line)); } catch (_) { /* one bad line is skipped, never fatal */ }
    }
  });
}

export function register(deps: PlatformDeps): void {
  // Both modes: a headless `reports run` answers through this too.
  ipcMain.handle('automation:reportDone', (e, payload: unknown) => ({ ok: settleReport(e.sender.id, payload) }));
  if (deps.headless) return;

  tailJobLog();

  ipcMain.handle('automation:status', () => status());

  ipcMain.handle('automation:set', async (_e, patch: { enabled?: unknown; http?: unknown; port?: unknown } = {}) => {
    const next = { ...prefs() };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.http === 'boolean') next.http = patch.http;
    if (patch.port !== undefined) {
      const port = Number(patch.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return { ...status(), ok: false, message: 'Choose a port between 1024 and 65535.' };
      }
      next.port = port;
    }
    config.save({ automation: next });
    await reconcile();
    return { ...status(), ok: true };
  });

  ipcMain.handle('automation:takeToken', () => {
    if (!token || revealed) return { token: null };
    revealed = true;
    return { token };
  });

  ipcMain.handle('automation:regenerateToken', () => {
    if (!prefs().enabled || !prefs().http) return { ...status(), ok: false };
    token = newToken();
    revealed = false;
    return { ...status(), ok: true };
  });

  void app.whenReady().then(() => reconcile());
  app.on('will-quit', () => { void stopServer(); });
}
