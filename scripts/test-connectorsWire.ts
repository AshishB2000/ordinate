// Loopback wire fixtures against the REAL drivers — what a stubbed driver cannot
// show: what the driver does when the peer misbehaves. No network leaves the
// machine; every server here listens on 127.0.0.1 and the guard is off (not
// server mode), so the drivers dial it directly.
//
//   NV-12  a Postgres peer that sends an ErrorResponse with no query running,
//          then resets: an unlistened pg 'error' throws from a socket callback
//          and would end the shared pod.

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as net from 'net';
import type { ConnectorContext, ConnectorDef } from '../src/connectors/types';

const pgConnectors: ConnectorDef[] = require('../src/connectors/postgres').CONNECTORS;
const { Client } = require('pg') as typeof import('pg');

function listen(onConn: (sock: net.Socket) => void): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    onConn(sock);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })));
}

function ctxFor(values: Record<string, unknown>): ConnectorContext {
  return { values: { host: '127.0.0.1', database: 'd', user: 'u', ...values }, secrets: { password: 'dummy-canary' }, rowLimit: 10, timeoutMs: 3000 };
}

// ── NV-12: a peer-driven pg 'error' ──────────────────────────────────────────

function pgMsg(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
// AuthenticationOk + ReadyForQuery + an ErrorResponse, in ONE write: connect()
// resolves on the second, and the third arrives with no query to fail.
const HOSTILE_PG = Buffer.concat([
  pgMsg('R', Buffer.from([0, 0, 0, 0])),
  pgMsg('Z', Buffer.from('I')),
  pgMsg('E', Buffer.from('SFATAL\0CXX000\0Mpeer says no\0\0')),
]);

async function pgErrorEvent(): Promise<void> {
  const server = await listen((sock) => sock.once('data', () => {
    sock.write(HOSTILE_PG);
    setTimeout(() => sock.destroy(), 50);
  }));
  const uncaught: unknown[] = [];
  const record = (e: unknown): void => { uncaught.push(e); };
  process.on('uncaughtException', record);
  try {
    // Negative control: a bare client with no listener — the hazard is real.
    const bare = new Client({ host: '127.0.0.1', port: server.port, user: 'u', database: 'd', connectionTimeoutMillis: 2000 });
    await bare.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    ok('negative control: against this peer a bare pg Client throws an uncaught error event', uncaught.length > 0, uncaught.length);

    uncaught.length = 0;
    const def = pgConnectors.find((d) => d.id === 'postgres') as ConnectorDef;
    const res = await def.listTables(ctxFor({ port: server.port, ssl: false }));
    await new Promise((r) => setTimeout(r, 200));
    ok('the connector answers {ok:false} and nothing reaches the process', !res.ok && uncaught.length === 0, `${JSON.stringify(res)} uncaught=${uncaught.length}`);
  } finally {
    process.off('uncaughtException', record);
    server.close();
  }
}

async function main(): Promise<void> {
  await pgErrorEvent();
}

main().then(finish, (e) => { console.error(e); process.exit(1); });
