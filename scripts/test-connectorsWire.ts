// Loopback wire fixtures against the REAL drivers — what a stubbed driver cannot
// show: what pg and tedious do when the peer misbehaves. No network leaves the
// machine; every server here listens on 127.0.0.1 and the guard is off (not
// server mode), so the drivers dial it directly.
//
//   NV-12  a Postgres peer that sends an ErrorResponse with no query running,
//          then resets: an unlistened pg 'error' throws from a socket callback
//          and would end the shared pod.
//   NV-11  a SQL Server peer whose plaintext PRELOGIN reply declines
//          encryption: tedious would send LOGIN7 — the password — in the clear.

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as net from 'net';
import type { ConnectorContext, ConnectorDef } from '../src/connectors/types';

const pgConnectors: ConnectorDef[] = require('../src/connectors/postgres').CONNECTORS;
const mssqlConnectors: ConnectorDef[] = require('../src/connectors/mssql').CONNECTORS;
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

// ── NV-11: PRELOGIN declines encryption ──────────────────────────────────────

/** A PRELOGIN reply (TDS type 0x04) with VERSION and the given ENCRYPTION byte. */
function preloginReply(encryption: number): Buffer {
  const payload = Buffer.from([
    0x00, 0x00, 0x0b, 0x00, 0x06, // VERSION at 11, 6 bytes
    0x01, 0x00, 0x11, 0x00, 0x01, // ENCRYPTION at 17, 1 byte
    0xff,
    16, 0, 0, 0, 0, 0,
    encryption,
  ]);
  return Buffer.concat([Buffer.from([0x04, 0x01, 0x00, 8 + payload.length, 0x00, 0x00, 0x01, 0x00]), payload]);
}
const OFF = 0x00;
const NOT_SUP = 0x02;
const LOGIN7 = 0x10;

async function tdsLogin(id: string, encryption: number, values: Record<string, unknown> = {}): Promise<{ sent: number[]; error: string }> {
  const sent: number[] = []; // TDS packet types the client sent
  const server = await listen((sock) => sock.on('data', (d: Buffer) => {
    sent.push(d[0]);
    if (d[0] === 0x12) sock.write(preloginReply(encryption));
    else sock.destroy(); // LOGIN7, or anything else: recorded, hung up
  }));
  const def = mssqlConnectors.find((d) => d.id === id) as ConnectorDef;
  const res = await def.run(ctxFor({ port: server.port, ...values }), 'select 1');
  server.close();
  return { sent, error: res.ok ? '' : res.error };
}

async function tdsDeclined(): Promise<void> {
  for (const [name, enc] of [['NOT_SUP', NOT_SUP], ['OFF', OFF]] as const) {
    for (const id of ['azure-sql', 'sqlserver']) {
      const r = await tdsLogin(id, enc);
      ok(`${id}: a PRELOGIN reply of ${name} stops the login — no LOGIN7 on the wire`,
        r.sent[0] === 0x12 && !r.sent.includes(LOGIN7) && /password was not sent/.test(r.error), `${JSON.stringify(r.sent)} ${r.error}`);
    }
  }
  // Negative control: the user unticked encryption, so the same peer gets the login — the fixture is real.
  const plain = await tdsLogin('sqlserver', NOT_SUP, { encrypt: false });
  ok('negative control: encrypt unticked, the same peer receives LOGIN7', plain.sent.includes(LOGIN7), JSON.stringify(plain.sent));
}

async function main(): Promise<void> {
  await pgErrorEvent();
  await tdsDeclined();
}

main().then(finish, (e) => { console.error(e); process.exit(1); });
