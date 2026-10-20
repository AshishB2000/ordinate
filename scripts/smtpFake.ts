// An in-process SMTP relay for the email suites (test-smtp, test-email-db, the
// channels e2e) — a helper, not a suite. node:net / node:tls only.
//
// It records every line a client sends (AUTH payloads included, so a canary
// test can prove the relay DID get the password while the logs did not), each
// transaction's envelope and its un-stuffed DATA, and how many sessions were
// open at once. `opts` scripts it and may be changed between sends: the TLS mode,
// the AUTH mechanisms, per-step replies, a step that never answers, plaintext
// bytes injected after STARTTLS's 220, an AUTH failure that echoes the payload.
//
// Its certificate is scripts/fixtures/smtp/test-only-localhost.*.pem (SAN
// DNS:localhost only); a client trusts it only through smtp.trustCaForTest.

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';

const FIX = path.join(__dirname, 'fixtures', 'smtp');
export const CERT = fs.readFileSync(path.join(FIX, 'test-only-localhost.cert.pem'), 'utf8');
const KEY = fs.readFileSync(path.join(FIX, 'test-only-localhost.key.pem'), 'utf8');

type Step = 'greeting' | 'ehlo' | 'starttls' | 'mail' | 'data' | 'dot';
export interface FakeOpts {
  /** starttls (default): offers STARTTLS; implicit: TLS from the first byte; none: plaintext, no STARTTLS. */
  mode?: 'starttls' | 'implicit' | 'none';
  /** AUTH mechanisms advertised once TLS is up (or always, in implicit / none). Default PLAIN LOGIN. */
  auth?: string[];
  /** AUTH mechanisms advertised BEFORE STARTTLS — a client must not believe them. */
  authBeforeTls?: string[];
  /** Credentials AUTH accepts; absent = any. */
  creds?: { user: string; pass: string };
  /** A refused AUTH's 535 repeats what the client sent (a hostile or buggy relay). */
  echoAuth?: boolean;
  reply?: Partial<Record<Step, string>>;
  rcpt?: (address: string) => string;
  /** That step is never answered. */
  stall?: Step;
  /** Plaintext bytes after STARTTLS's 220: in the same write, or a moment later. */
  inject?: 'same' | 'delayed';
}

export interface Txn { from: string; rcpts: string[]; data: string }

export interface Fake {
  port: number;
  opts: FakeOpts;
  connections: number;
  /** Every line each session sent, in order. */
  sessions: string[][];
  txns: Txn[];
  maxOpen: number;
  close(): Promise<void>;
}

export async function startFake(opts: FakeOpts = {}): Promise<Fake> {
  const live = new Set<net.Socket>();
  let open = 0;
  const fake = { port: 0, opts, connections: 0, sessions: [] as string[][], txns: [] as Txn[], maxOpen: 0, close: async () => {} } as Fake;

  const session = (raw: net.Socket, startTls: boolean): void => {
    fake.connections++;
    open++;
    fake.maxOpen = Math.max(fake.maxOpen, open);
    live.add(raw);
    raw.on('close', () => { open--; live.delete(raw); });
    raw.on('error', () => undefined);
    const lines: string[] = [];
    fake.sessions.push(lines);
    let sock: net.Socket = raw;
    let secure = startTls;
    let buf = '';
    let data: string[] | null = null;
    let txn: Txn | null = null;
    let login: 'user' | 'pass' | null = null;
    let loginUser = '';
    const o = (): FakeOpts => fake.opts;
    const send = (step: Step | null, text: string): void => {
      if (step && o().stall === step) return;
      sock.write(text + '\r\n');
    };
    const authOk = (user: string, pass: string, payload: string): void => {
      const c = o().creds;
      if (!c || (c.user === user && c.pass === pass)) send(null, '235 2.7.0 accepted');
      else send(null, `535 5.7.8 bad credentials${o().echoAuth ? ': ' + payload : ''}`);
    };
    const ehlo = (): string => {
      const mode = o().mode ?? 'starttls';
      const mechs = mode === 'starttls' && !secure ? o().authBeforeTls ?? [] : o().auth ?? ['PLAIN', 'LOGIN'];
      const caps = ['fake.test', ...(mode === 'starttls' && !secure ? ['STARTTLS'] : []), ...(mechs.length ? ['AUTH ' + mechs.join(' ')] : []), '8BITMIME'];
      return caps.map((c, i) => `250${i === caps.length - 1 ? ' ' : '-'}${c}`).join('\r\n');
    };
    const onLine = (line: string): void => {
      if (data) {
        if (line === '.') {
          (txn as Txn).data = data.join('\r\n') + '\r\n';
          fake.txns.push(txn as Txn);
          data = null;
          txn = null;
          send('dot', o().reply?.dot ?? '250 2.0.0 queued');
        } else data.push(line.startsWith('.') ? line.slice(1) : line);
        return;
      }
      lines.push(line);
      if (login) {
        const v = Buffer.from(line, 'base64').toString('utf8');
        if (login === 'user') { loginUser = v; login = 'pass'; send(null, '334 UGFzc3dvcmQ6'); } else { login = null; authOk(loginUser, v, line); }
        return;
      }
      const cmd = line.split(' ')[0].toUpperCase();
      if (cmd === 'EHLO') send('ehlo', o().reply?.ehlo ?? ehlo());
      else if (cmd === 'STARTTLS') {
        const r = o().reply?.starttls ?? '220 2.0.0 ready';
        if (o().stall === 'starttls') return;
        if (!r.startsWith('220')) return send(null, r);
        sock.removeAllListeners('data');
        const upgrade = (): void => {
          const t = new tls.TLSSocket(sock, { isServer: true, key: KEY, cert: CERT });
          t.on('error', () => undefined);
          sock = t;
          secure = true;
          buf = '';
          t.on('data', feed);
        };
        if (o().inject === 'same') sock.write(r + '\r\n250 injected\r\n');
        else sock.write(r + '\r\n');
        if (o().inject === 'delayed') setTimeout(() => { sock.write('250 injected\r\n'); upgrade(); }, 30);
        else upgrade();
      } else if (cmd === 'AUTH') {
        const [, mech, initial] = line.split(' ');
        if (mech?.toUpperCase() === 'PLAIN' && initial) {
          const [, user, pass] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
          authOk(user ?? '', pass ?? '', initial);
        } else if (mech?.toUpperCase() === 'LOGIN') { login = 'user'; send(null, '334 VXNlcm5hbWU6'); } else send(null, '504 5.5.4 unsupported');
      } else if (cmd === 'MAIL') {
        txn = { from: (/<([^>]*)>/.exec(line) ?? [])[1] ?? '', rcpts: [], data: '' };
        send('mail', o().reply?.mail ?? '250 2.1.0 ok');
      } else if (cmd === 'RCPT') {
        const a = (/<([^>]*)>/.exec(line) ?? [])[1] ?? '';
        const r = o().rcpt ? (o().rcpt as (a: string) => string)(a) : '250 2.1.5 ok';
        if (r.startsWith('25') && txn) txn.rcpts.push(a);
        send(null, r);
      } else if (cmd === 'DATA') {
        const r = o().reply?.data ?? '354 go ahead';
        if (r.startsWith('354')) data = [];
        send('data', r);
      } else if (cmd === 'QUIT') { send(null, '221 bye'); sock.end(); } else send(null, '250 ok');
    };
    const feed = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    raw.on('data', feed);
    send('greeting', o().reply?.greeting ?? '220 fake.test ESMTP');
  };

  const server = (opts.mode ?? 'starttls') === 'implicit'
    ? tls.createServer({ key: KEY, cert: CERT }, (s) => session(s, true))
    : net.createServer((s) => session(s, false));
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => server.listen(0, '127.0.0.1', resolve)); // no IPv6 here: loopback v4 only
    server.listen(0, '::', resolve);
    void reject;
  });
  fake.port = (server.address() as net.AddressInfo).port;
  fake.close = () => new Promise<void>((resolve) => {
    for (const s of live) s.destroy();
    server.close(() => resolve());
  });
  return fake;
}
