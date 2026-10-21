// The SMTP client — node:net / node:tls only (docs/email/00-design.md §5–6).
// One session = one connection = one transaction of at most MAX_RCPT recipients.
//
// THE RELAY IS THE OPERATOR'S. `sendOnce` takes no host: it talks to the relay
// `useRelay` was handed at wiring (src/server/subscriptions/job.ts, from the
// startup-validated env). The host is resolved by the SSRF guard with the
// operator's ranges admitted (OPERATOR_HOST) and the hard-deny list asked first,
// and the socket is pinned to the address that was checked.
//
// TLS IS ENFORCED HERE, and nothing reaches these options from outside:
//   ① rejectUnauthorized: true, minVersion TLSv1.2, Node's identity check
//     against SMTP_HOST (servername) — literals below
//   ② starttls: no STARTTLS capability, or a reply other than 220, ends the
//     session; no branch carries on in plaintext
//   ③ before the upgrade the reply buffer AND socket.readableLength are empty;
//     the plain socket is paused and its listener removed first, so bytes a
//     man in the middle pipelines are never parsed as replies
//   ④ AUTH mechanisms come from the post-TLS EHLO only
//   ⑤ assertEncrypted() right before AUTH and before MAIL FROM
// plaintext mode (startup-refused with SMTP_USER) only to a loopback / private /
// ULA pinned address, checked on every connect.
//
// What leaves this module on failure is a MailError: a kind, the reply code,
// and a `detail` for the LOG with the password cut out of it.

import * as net from 'net';
import { StringDecoder } from 'string_decoder';
import * as tls from 'tls';
import { checkHost, OPERATOR_HOST, pinnedLookup, SsrfError } from '../../connectors/ssrf';
import { publicOrigin } from '../publicUrl';
import { plaintextAllowedAt, type MailEnv } from './mailEnv';
import { assertAddress, dataBlock, MailError } from './mime';

export const MAX_RCPT = 50;
/** Sessions open at once in this pod. */
export const MAX_SESSIONS = 4;
const BREAKER_AFTER = 3;
const MAX_REPLY_BYTES = 16 * 1024;
const MAX_REPLY_LINES = 100;

let timing = { connectMs: 10_000, commandMs: 30_000, dataMs: 60_000, totalMs: 120_000, breakerMs: 60_000 };
let relay: MailEnv | null = null;
let testCa: string | null = null;

/** Wiring (job.ts): the relay from the env, or null. Tests hand it a parseMail() result. */
export function useRelay(cfg: MailEnv | null): void {
  relay = cfg;
}

export function relayConfigured(): boolean {
  return relay !== null;
}

/** Test hooks — never set by the server. */
export function setTimingForTest(t: Partial<typeof timing>): void {
  timing = { ...timing, ...t };
}
export function trustCaForTest(pem: string | null): void {
  testCa = pem;
}
export function resetTransportForTest(): void {
  breaker = { failures: 0, openUntil: 0 };
}

// ── The per-pod session semaphore and circuit breaker ───────────────────────
let open = 0;
const waiting: Array<() => void> = [];
let breaker = { failures: 0, openUntil: 0 };

async function acquire(): Promise<void> {
  if (open < MAX_SESSIONS) {
    open++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve)); // the releaser hands its slot on
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else open--;
}

/** The session's TLS socket is verified: the invariant checked before AUTH and before MAIL FROM. */
export function assertEncrypted(socket: net.Socket): void {
  if (!(socket instanceof tls.TLSSocket) || !socket.encrypted || !socket.authorized) throw new MailError('tls', 'the session is not on a verified TLS socket');
}

/** The relay's text with the password, its base64 forms and the AUTH PLAIN blob cut out. */
function scrub(text: string): string {
  const cfg = relay;
  if (!cfg || !cfg.user || !cfg.password) return text.slice(0, 500);
  const pass = cfg.password.export().toString('utf8');
  let out = text;
  for (const s of [pass, Buffer.from(pass).toString('base64'), Buffer.from(`\0${cfg.user}\0${pass}`).toString('base64')]) out = out.split(s).join('[redacted]');
  return out.slice(0, 500);
}

/** EHLO's name: this server's public host, else an address literal. Never a request's value. */
function ehloName(): string {
  const origin = publicOrigin(process.env.ORDINATE_PUBLIC_URL, process.env.OIDC_REDIRECT_URL);
  const host = origin ? new URL(origin).hostname : '';
  return /^[A-Za-z0-9.-]{1,253}$/.test(host) ? host : '[127.0.0.1]';
}

const tlsErrorCode = (err: unknown): boolean => /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|ALTNAME|DEPTH|HANDSHAKE|EPROTO/i.test(String((err as { code?: unknown })?.code ?? (err as Error)?.message ?? ''));

interface Reply { code: number; lines: string[] }

/** Reads replies off whichever socket it is attached to; one reply at a time. Exported for test-smtp's chunking cases. */
export class Reader {
  private buf = '';
  private lines: string[] = [];
  private replies: Reply[] = [];
  private wait: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private socket: net.Socket | null = null;
  private readonly decoder = new StringDecoder('utf8'); // a character split across two chunks stays whole
  private readonly onData = (chunk: Buffer): void => this.feed(this.decoder.write(chunk));
  private readonly onEnd = (err?: Error): void => this.fail(
    err instanceof MailError ? err
      : err && tlsErrorCode(err) ? new MailError('tls', scrub(String(err.message)))
        : new MailError('unreachable', scrub(err ? String(err.message) : 'the relay closed the connection')),
  );
  private readonly onClose = (): void => this.onEnd();

  attach(socket: net.Socket): void {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onEnd);
    socket.on('close', this.onClose);
  }

  /** Stops reading `socket` (STARTTLS) — and says whether anything was left unread. */
  detach(): boolean {
    const s = this.socket;
    if (s) {
      s.pause();
      s.removeListener('data', this.onData);
      s.removeListener('error', this.onEnd);
      s.removeListener('close', this.onClose);
    }
    this.socket = null;
    return this.buf.length > 0 || this.lines.length > 0 || this.replies.length > 0 || (s ? s.readableLength > 0 : false);
  }

  /** Bytes as they arrive — in any chunking (a CR here, its LF in the next chunk). */
  feed(text: string): void {
    this.buf += text;
    if (this.buf.length > MAX_REPLY_BYTES) return this.fail(new MailError('protocol', 'a reply over 16 KB'));
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]|$)/.exec(line);
      if (!m || (this.lines.length && !this.lines[0].startsWith(m[1])) || this.lines.length >= MAX_REPLY_LINES) {
        return this.fail(new MailError('protocol', scrub(`a reply that is not SMTP: ${line.slice(0, 100)}`)));
      }
      this.lines.push(line);
      if (m[2] !== '-') {
        this.replies.push({ code: Number(m[1]), lines: this.lines });
        this.lines = [];
      }
    }
    this.flush();
  }

  private flush(): void {
    if (this.wait && this.replies.length) {
      const w = this.wait;
      this.wait = null;
      w.resolve(this.replies.shift() as Reply);
    }
  }

  private fail(err: Error): void {
    this.failure ??= err;
    this.socket?.destroy();
    if (this.wait) {
      const w = this.wait;
      this.wait = null;
      w.reject(this.failure);
    }
  }

  read(ms: number, afterDot = false): Promise<Reply> {
    if (this.replies.length) return Promise.resolve(this.replies.shift() as Reply);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new MailError('timeout', 'no reply from the relay in time', 0, afterDot)), ms);
      this.wait = {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(afterDot && e instanceof MailError && !e.afterDot ? new MailError(e.kind, e.detail, e.code, true) : e); },
      };
    });
  }
}

/** A reply that is not `want` as a MailError of the right kind: 4xx temporary, 5xx rejected. */
function unexpected(r: Reply, step: string, afterDot = false): MailError {
  const kind = r.code >= 400 && r.code < 500 ? 'temporary' : r.code >= 500 ? 'rejected' : 'protocol';
  return new MailError(kind, scrub(`${step}: ${r.lines.join(' / ')}`), r.code, afterDot);
}

function connected(socket: net.Socket, event: 'connect' | 'secureConnect'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new MailError('timeout', 'the relay did not answer the connection in time')); }, timing.connectMs);
    socket.once(event, () => { clearTimeout(timer); resolve(); });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof MailError ? err : new MailError(tlsErrorCode(err) ? 'tls' : 'unreachable', scrub(`${(err as { code?: string }).code ?? ''} ${err.message}`)));
    });
  });
}

const tlsOptions = (host: string): tls.ConnectionOptions => ({
  host,
  ...(net.isIP(host) ? {} : { servername: host }),
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2',
  ...(testCa ? { ca: testCa } : {}),
});

export interface SendResult {
  accepted: number;
  /** Rejected recipients' reply codes; the addresses stay in the log line the caller writes. */
  rejected: Array<{ address: string; code: number }>;
}

/**
 * One session: connect, greet, (STARTTLS,) (AUTH,) MAIL, RCPT ×n, DATA. Throws
 * MailError. `data` is the whole message (./mime.buildMime); recipients ≤ MAX_RCPT.
 */
export async function sendOnce(to: readonly string[], data: string): Promise<SendResult> {
  const cfg = relay;
  if (!cfg) throw new MailError('refused', 'no relay is configured');
  if (to.length === 0 || to.length > MAX_RCPT) throw new MailError('input', `${to.length} recipients in one message`);
  to.forEach(assertAddress);
  const wire = dataBlock(data); // the input walls, before any socket
  if (Date.now() < breaker.openUntil) throw new MailError('unreachable', 'the relay failed repeatedly; waiting before trying again');

  let pin;
  try {
    pin = await checkHost(cfg.host, OPERATOR_HOST);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MailError(err instanceof SsrfError && !msg.startsWith('Could not resolve') ? 'refused' : 'unreachable', msg);
  }
  if (cfg.security === 'plaintext' && !plaintextAllowedAt(pin.address)) throw new MailError('tls', 'plaintext is allowed only to a loopback, private or unique-local relay');

  await acquire();
  let socket: net.Socket | null = null;
  const deadline = setTimeout(() => socket?.destroy(new MailError('timeout', 'the session ran past its deadline')), timing.totalMs);
  try {
    const reader = new Reader();
    const lookup = pinnedLookup(pin);
    let greeted = false;
    try {
      socket = cfg.security === 'tls'
        ? tls.connect({ ...tlsOptions(cfg.host), port: cfg.port, lookup })
        : net.connect({ host: cfg.host, port: cfg.port, lookup });
      await connected(socket, cfg.security === 'tls' ? 'secureConnect' : 'connect');
      reader.attach(socket);
      const hello = await reader.read(timing.commandMs);
      if (hello.code !== 220) throw unexpected(hello, 'greeting');
      greeted = true;
      breaker = { failures: 0, openUntil: 0 };
    } finally {
      if (!greeted && ++breaker.failures >= BREAKER_AFTER) breaker = { failures: 0, openUntil: Date.now() + timing.breakerMs };
    }
    const say = async (line: string, ms = timing.commandMs): Promise<Reply> => {
      (socket as net.Socket).write(line + '\r\n');
      return reader.read(ms);
    };
    const ehlo = async (): Promise<string[]> => {
      const r = await say(`EHLO ${ehloName()}`);
      if (r.code !== 250) throw unexpected(r, 'EHLO');
      return r.lines.slice(1).map((l) => l.slice(4).trim().toUpperCase());
    };
    let caps = await ehlo();

    if (cfg.security === 'starttls') {
      if (!caps.includes('STARTTLS')) throw new MailError('tls', 'the relay does not offer STARTTLS');
      const r = await say('STARTTLS');
      if (r.code !== 220) throw new MailError('tls', scrub(`STARTTLS: ${r.lines.join(' / ')}`), r.code);
      const plain = socket as net.Socket;
      if (reader.detach()) throw new MailError('tls', 'the relay sent bytes after its STARTTLS reply');
      socket = tls.connect({ ...tlsOptions(cfg.host), socket: plain });
      await connected(socket, 'secureConnect');
      reader.attach(socket);
      caps = await ehlo(); // the pre-TLS list is discarded
    }

    if (cfg.user && cfg.password) {
      assertEncrypted(socket as net.Socket);
      const mechs = caps.filter((c) => c.startsWith('AUTH ')).flatMap((c) => c.split(/\s+/).slice(1));
      const pass = cfg.password.export().toString('utf8');
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
      let r: Reply;
      if (mechs.includes('PLAIN')) r = await say(`AUTH PLAIN ${b64(`\0${cfg.user}\0${pass}`)}`);
      else if (mechs.includes('LOGIN')) {
        r = await say('AUTH LOGIN');
        if (r.code === 334) r = await say(b64(cfg.user));
        if (r.code === 334) r = await say(b64(pass));
      } else throw new MailError('auth', 'the relay offers neither AUTH PLAIN nor AUTH LOGIN');
      if (r.code !== 235) throw new MailError('auth', scrub(`AUTH: ${r.lines.join(' / ')}`), r.code);
    }

    if (cfg.security !== 'plaintext') assertEncrypted(socket as net.Socket);
    const mail = await say(`MAIL FROM:<${cfg.from.address}>`);
    if (mail.code !== 250) throw unexpected(mail, 'MAIL FROM');
    const result: SendResult = { accepted: 0, rejected: [] };
    const soft: number[] = [];
    for (const a of to) {
      const r = await say(`RCPT TO:<${a}>`);
      if (r.code === 250 || r.code === 251) result.accepted++;
      else {
        result.rejected.push({ address: a, code: r.code });
        if (r.code < 500) soft.push(r.code);
      }
    }
    if (!result.accepted) {
      const all4xx = soft.length === to.length;
      throw new MailError(all4xx ? 'temporary' : 'rejected', 'the relay accepted none of the recipients', result.rejected[0]?.code ?? 0);
    }
    const go = await say('DATA');
    if (go.code !== 354) throw unexpected(go, 'DATA');
    (socket as net.Socket).write(wire);
    const done = await reader.read(timing.dataMs, true);
    if (done.code !== 250) throw unexpected(done, 'end of data', true);
    (socket as net.Socket).end('QUIT\r\n');
    return result;
  } catch (err) {
    socket?.destroy();
    throw err instanceof MailError ? err : new MailError('unreachable', scrub(err instanceof Error ? err.message : String(err)));
  } finally {
    clearTimeout(deadline);
    release();
  }
}
