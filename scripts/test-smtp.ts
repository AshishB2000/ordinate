// The SMTP client against an in-process fake relay (docs/email/00-design.md §10)
// — no Postgres, no network beyond loopback.
//
//   transcript   the exact command lines: STARTTLS + AUTH PLAIN, implicit TLS,
//                AUTH LOGIN, no AUTH, and AUTH chosen from the POST-TLS EHLO
//   TLS          STARTTLS required (NEGATIVE CONTROL: plaintext mode delivers),
//                454, injected bytes (same write and delayed), an untrusted and
//                a mismatched certificate, assertEncrypted
//   input        dot-stuffing, bare LF, header-injection canaries, the strict
//                address pattern — all refused before a socket opens
//   MIME         parts decode back; RFC 2047 words; Date / Message-ID
//   timing       timeouts (after the final dot: afterDot), the breaker, the
//                session semaphore
//   batches      120 recipients → 50/50/20; retries before the dot only
//                (NEGATIVE CONTROL: after it, one attempt), backoff 1 s / 4 s;
//                a failed batch leaves the others (partial); a relay-wide
//                failure stops; budgets held per batch, refunded, half a
//                project's; the reply reader's chunking and caps
//   secrets      the password canary over an AUTH-echoing relay
//   SSRF         metadata refused even with SSRF_ALLOW (control: the
//                one-argument guard admits it), plaintext only to private
//                relays, OPERATOR_HOST used from one file
//   env          every refusal of mailEnv, the warnings, defaults
//
//   npm run build:ts && node scripts/test-smtp.js

export {}; // module scope
import * as dns from 'dns';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as util from 'util';
import { finish, ok } from './selfcheck';
import { CERT, startFake, type Fake } from './smtpFake';

const smtp: typeof import('../src/server/mail/smtp') = require('../src/server/mail/smtp');
const email: typeof import('../src/server/mail/emailChannel') = require('../src/server/mail/emailChannel');
const budget: typeof import('../src/server/mail/budget') = require('../src/server/mail/budget');
const mime: typeof import('../src/server/mail/mime') = require('../src/server/mail/mime');
const mailEnv: typeof import('../src/server/mail/mailEnv') = require('../src/server/mail/mailEnv');
const ssrf: typeof import('../src/connectors/ssrf') = require('../src/connectors/ssrf');
const envMod: typeof import('../src/server/env') = require('../src/server/env');

delete process.env.ORDINATE_PUBLIC_URL;
delete process.env.OIDC_REDIRECT_URL;
delete process.env.SSRF_ALLOW;
const PASS = 'smtp-pw-CANARY-9f2e7c';
const USER = 'relay-user';
const FROM = 'bi@acme.test';
const EHLO = 'EHLO [127.0.0.1]';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const PLAIN = b64(`\0${USER}\0${PASS}`);

type Src = Partial<import('../src/server/mail/mailEnv').MailSrc>;
function relay(src: Src): void {
  smtp.useRelay(mailEnv.parseMail({ SMTP_HOST: 'localhost', SMTP_FROM: `Acme BI <${FROM}>`, SMTP_PORT: undefined, SMTP_SECURITY: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined, RATE_LIMIT_EMAIL_ORG_PER_HOUR: undefined, ...src }, true));
}
const msg = (subject = 'Weekly sales'): string => mime.buildMime({ from: { address: FROM, name: 'Acme BI' }, subject, text: 'Revenue 1.2M', html: '<p>Revenue 1.2M</p>' });
async function attempt(to: string[], data = msg()): Promise<import('../src/server/mail/smtp').SendResult | import('../src/server/mail/mime').MailError> {
  try {
    return await smtp.sendOnce(to, data);
  } catch (err) {
    return err as import('../src/server/mail/mime').MailError;
  }
}
const kindOf = (r: unknown): string => (r instanceof mime.MailError ? r.kind : 'sent');
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

async function main(): Promise<void> {
  smtp.trustCaForTest(CERT);
  const fakes: Fake[] = [];
  const fake = async (o: Parameters<typeof startFake>[0]): Promise<Fake> => {
    const f = await startFake(o);
    fakes.push(f);
    return f;
  };

  // ── Transcripts ──────────────────────────────────────────────────────────
  {
    const f = await fake({ creds: { user: USER, pass: PASS } });
    relay({ SMTP_PORT: String(f.port), SMTP_USER: USER, SMTP_PASSWORD: PASS });
    const data = msg();
    const r = await attempt(['a@x.test', 'b@x.test'], data);
    await settle();
    const want = [EHLO, 'STARTTLS', EHLO, `AUTH PLAIN ${PLAIN}`, `MAIL FROM:<${FROM}>`, 'RCPT TO:<a@x.test>', 'RCPT TO:<b@x.test>', 'DATA'];
    ok('transcript: starttls + AUTH PLAIN, exactly', JSON.stringify(f.sessions[0].slice(0, 8)) === JSON.stringify(want), f.sessions[0]);
    ok('transcript: the relay got the message byte for byte, both recipients', kindOf(r) === 'sent' && f.txns.length === 1 && f.txns[0].data === data && f.txns[0].rcpts.join() === 'a@x.test,b@x.test' && f.txns[0].from === FROM);
  }
  {
    const f = await fake({ mode: 'implicit', creds: { user: USER, pass: PASS } });
    relay({ SMTP_PORT: String(f.port), SMTP_SECURITY: 'tls', SMTP_USER: USER, SMTP_PASSWORD: PASS });
    const r = await attempt(['a@x.test']);
    ok('implicit TLS: no STARTTLS, AUTH on the TLS socket', kindOf(r) === 'sent' && JSON.stringify(f.sessions[0].slice(0, 3)) === JSON.stringify([EHLO, `AUTH PLAIN ${PLAIN}`, `MAIL FROM:<${FROM}>`]), f.sessions[0]);
  }
  {
    const f = await fake({ auth: ['LOGIN'], authBeforeTls: ['PLAIN'], creds: { user: USER, pass: PASS } });
    relay({ SMTP_PORT: String(f.port), SMTP_USER: USER, SMTP_PASSWORD: PASS });
    const r = await attempt(['a@x.test']);
    ok('AUTH LOGIN, chosen from the POST-TLS EHLO (the pre-TLS list offered only PLAIN)', kindOf(r) === 'sent' && JSON.stringify(f.sessions[0].slice(3, 6)) === JSON.stringify(['AUTH LOGIN', b64(USER), b64(PASS)]), f.sessions[0]);
  }
  {
    const f = await fake({});
    relay({ SMTP_PORT: String(f.port) });
    const r = await attempt(['a@x.test']);
    ok('no SMTP_USER: no AUTH at all', kindOf(r) === 'sent' && !f.sessions[0].some((l) => l.startsWith('AUTH')));
  }

  // ── TLS is required ──────────────────────────────────────────────────────
  {
    const f = await fake({ mode: 'none' });
    relay({ SMTP_PORT: String(f.port), SMTP_USER: USER, SMTP_PASSWORD: PASS });
    const r = await attempt(['a@x.test']);
    ok('STARTTLS not offered: refused as tls — the relay saw EHLO and nothing else', kindOf(r) === 'tls' && JSON.stringify(f.sessions[0]) === JSON.stringify([EHLO]) && f.txns.length === 0, f.sessions[0]);
    relay({ SMTP_PORT: String(f.port), SMTP_SECURITY: 'plaintext' });
    const c = await attempt(['a@x.test']);
    ok('NEGATIVE CONTROL: the same relay under explicit plaintext delivers', kindOf(c) === 'sent' && f.txns.length === 1);
  }
  {
    const f = await fake({ reply: { starttls: '454 4.7.0 TLS not available' } });
    relay({ SMTP_PORT: String(f.port) });
    const r = await attempt(['a@x.test']);
    ok('STARTTLS answered 454: tls, nothing after it', kindOf(r) === 'tls' && JSON.stringify(f.sessions[0]) === JSON.stringify([EHLO, 'STARTTLS']));
  }
  for (const inject of ['same', 'delayed'] as const) {
    const f = await fake({ inject });
    relay({ SMTP_PORT: String(f.port) });
    const r = await attempt(['a@x.test']);
    await settle();
    ok(`bytes injected after STARTTLS's 220 (${inject} write): tls, never parsed as a reply, no MAIL`, kindOf(r) === 'tls' && !f.sessions.flat().some((l) => l.startsWith('MAIL')), [kindOf(r), f.sessions]);
  }
  {
    const f = await fake({});
    relay({ SMTP_PORT: String(f.port) });
    smtp.trustCaForTest(null);
    const r = await attempt(['a@x.test']);
    smtp.trustCaForTest(CERT);
    const c = await attempt(['a@x.test']);
    ok('an untrusted certificate: tls, nothing sent (control: trusted → delivered)', kindOf(r) === 'tls' && kindOf(c) === 'sent' && f.txns.length === 1);
    relay({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(f.port) });
    const m = await attempt(['a@x.test']);
    ok('a trusted certificate whose name is not SMTP_HOST (SAN localhost, host 127.0.0.1): tls', kindOf(m) === 'tls' && f.txns.length === 1);
  }
  {
    let threw = '';
    try { smtp.assertEncrypted(new net.Socket()); } catch (err) { threw = kindOf(err); }
    ok('assertEncrypted: a plain socket throws tls', threw === 'tls');
  }

  // ── Input walls ──────────────────────────────────────────────────────────
  {
    const raw = 'Subject: x\r\n\r\n.\r\n..two\r\n.x\r\nend\r\n';
    ok('dot-stuffing: every line starting with "." gets another; then CRLF.CRLF', mime.dataBlock(raw) === 'Subject: x\r\n\r\n..\r\n...two\r\n..x\r\nend\r\n.\r\n');
    const f = await fake({});
    relay({ SMTP_PORT: String(f.port) });
    const r = await attempt(['a@x.test'], raw);
    ok('dot-stuffing: the relay un-stuffs exactly the original', kindOf(r) === 'sent' && f.txns[0].data === raw);
    const before = f.connections;
    const bare = await attempt(['a@x.test'], 'Subject: x\r\n\r\nline\nsmuggled\r\n');
    const cr = await attempt(['a@x.test'], 'Subject: x\r\n\r\nline\rsmuggled\r\n');
    ok('a bare LF or CR in DATA: input, before any socket', kindOf(bare) === 'input' && kindOf(cr) === 'input' && f.connections === before);
    const evil = 'Q3\r\nBcc: canary@evil.test';
    const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch (err) { return kindOf(err) === 'input'; } };
    ok('header injection: subject with CRLF refused', throws(() => mime.buildMime({ from: { address: FROM, name: null }, subject: evil, text: '', html: '' })));
    ok('header injection: subject with NUL refused', throws(() => mime.buildMime({ from: { address: FROM, name: null }, subject: 'Q3\0', text: '', html: '' })));
    ok('header injection: a sender name with CRLF refused', throws(() => mime.mailbox(FROM, 'Acme\r\nBcc: canary@evil.test')));
    const inj = await attempt(['a@x.test>\r\nRCPT TO:<canary@evil.test']);
    ok('header injection: a recipient carrying a second RCPT is refused before any socket', kindOf(inj) === 'input' && f.connections === before);
    const okSubj = await attempt(['a@x.test'], msg('Q3 Bcc: canary@evil.test'));
    ok('NEGATIVE CONTROL: the same subject without the CRLF is delivered', kindOf(okSubj) === 'sent' && !f.txns[f.txns.length - 1].data.includes('\r\nBcc:'));
    const bad = ['a%b@x.test', 'a!b@x.test', '"a"@x.test', 'a@[10.0.0.1]', 'a@10.0.0.1', 'a\\b@x.test', 'a b@x.test', 'a@x', '.a@x.test'];
    ok('the strict address pattern refuses %, !, quotes, [ip] and bare-IP domains', bad.every((a) => !mailEnv.isMailAddress(a)), bad.filter((a) => mailEnv.isMailAddress(a)));
    ok('control: ordinary addresses pass', ['first.last+tag@x.test', "o'brien@sub.x.co", 'a_b-c@x-y.test'].every((a) => mailEnv.isMailAddress(a)));
  }

  // ── MIME ─────────────────────────────────────────────────────────────────
  {
    const subject = 'Umsatz – Q3 ✓ 日本語のレポート with a long English tail to force folding';
    const m = mime.buildMime({ from: { address: FROM, name: 'Acme BI' }, subject, text: 'plain ünï', html: '<b>html ünï</b>', date: new Date(Date.UTC(2026, 9, 20, 8, 0, 0)), messageId: 'id-1' });
    const [head, ...rest] = m.split('\r\n\r\n');
    const unfolded = head.replace(/\r\n /g, ' ');
    const subj = /^Subject: (.*)$/m.exec(unfolded)?.[1] ?? '';
    const words = subj.split(' ');
    const decoded = words.map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)?.[1] ?? '', 'base64').toString('utf8')).join('');
    ok('a non-ASCII subject: B-encoded words that decode back to the original', decoded === subject && words.every((w) => w.length <= 75));
    ok('no header line passes 76 characters', head.split('\r\n').every((l) => l.length <= 76), head.split('\r\n').map((l) => l.length));
    const eq = /^Subject: (.*)$/m.exec(mime.buildMime({ from: { address: FROM, name: null }, subject: 'Figures =?x?= now', text: '', html: '' }).replace(/\r\n /g, ' '))?.[1] ?? '';
    ok('an ASCII subject holding "=?" is encoded too (a reader would decode it)', eq.startsWith('=?UTF-8?B?') && !eq.includes('=?x?='));
    ok('Date and Message-ID', /^Date: Tue, 20 Oct 2026 08:00:00 \+0000$/m.test(head) && /^Message-ID: <id-1@acme\.test>$/m.test(head) && /^From: "Acme BI" <bi@acme\.test>$/m.test(head) && /^To: undisclosed-recipients:;$/m.test(head));
    const body = rest.join('\r\n\r\n');
    const parts = [...body.matchAll(/Content-Type: (text\/\w+); charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)];
    ok('multipart/alternative: text then HTML, each decoding back', parts.length === 2 && parts[0][1] === 'text/plain' && Buffer.from(parts[0][2].replace(/\r\n/g, ''), 'base64').toString('utf8') === 'plain ünï' && Buffer.from(parts[1][2].replace(/\r\n/g, ''), 'base64').toString('utf8') === '<b>html ünï</b>');
    ok('body lines are at most 76 characters', body.split('\r\n').every((l) => l.length <= 76));
  }

  // ── Timing: timeouts, the breaker, the semaphore ─────────────────────────
  smtp.setTimingForTest({ connectMs: 500, commandMs: 300, dataMs: 300, totalMs: 3000, breakerMs: 400 });
  {
    const f = await fake({ stall: 'greeting' });
    relay({ SMTP_PORT: String(f.port) });
    const r = await attempt(['a@x.test']);
    ok('no greeting: timeout', kindOf(r) === 'timeout' && !(r as import('../src/server/mail/mime').MailError).afterDot);
    smtp.resetTransportForTest();
  }
  {
    const f = await fake({ stall: 'dot' });
    relay({ SMTP_PORT: String(f.port) });
    const r = await attempt(['a@x.test']) as import('../src/server/mail/mime').MailError;
    ok('no reply to the final dot: timeout, marked afterDot', kindOf(r) === 'timeout' && r.afterDot === true);
    f.opts = { reply: { dot: '451 4.3.0 try later' } };
    const t = await attempt(['a@x.test']) as import('../src/server/mail/mime').MailError;
    ok('a 451 to the final dot: temporary, marked afterDot', kindOf(t) === 'temporary' && t.afterDot === true && t.code === 451);
    f.opts = { stall: 'mail' };
    const m = await attempt(['a@x.test']) as import('../src/server/mail/mime').MailError;
    ok('control: a stall before DATA is a timeout NOT after the dot', kindOf(m) === 'timeout' && m.afterDot === false);
  }
  {
    smtp.resetTransportForTest();
    const f = await fake({ stall: 'greeting' });
    relay({ SMTP_PORT: String(f.port) });
    for (let i = 0; i < 3; i++) await attempt(['a@x.test']);
    const tripped = await attempt(['a@x.test']);
    ok('breaker: after 3 greeting failures the next send opens no socket', kindOf(tripped) === 'unreachable' && f.connections === 3, f.connections);
    await new Promise((r) => setTimeout(r, 450));
    f.opts = {};
    const back = await attempt(['a@x.test']);
    ok('control: after the cool-down it connects and sends', kindOf(back) === 'sent' && f.connections === 4);
  }
  {
    const f = await fake({ stall: 'dot' });
    relay({ SMTP_PORT: String(f.port) });
    const all = Promise.all(Array.from({ length: 6 }, () => attempt(['a@x.test'])));
    await new Promise((r) => setTimeout(r, 150)); // the first sessions are stalled at the dot (300 ms)
    const during = f.connections;
    await all;
    ok(`semaphore: 6 concurrent sends, ${smtp.MAX_SESSIONS} sessions at a time (${during} open while the first were stalled), all 6 in the end`, during === smtp.MAX_SESSIONS && f.connections === 6, [during, f.connections]);
  }
  smtp.setTimingForTest({ connectMs: 10_000, commandMs: 30_000, dataMs: 60_000, totalMs: 120_000, breakerMs: 60_000 });
  smtp.resetTransportForTest();

  // ── RCPT outcomes ────────────────────────────────────────────────────────
  {
    const f = await fake({ rcpt: (a) => (a.startsWith('bad') ? '550 5.1.1 <bad@x.test> unknown user' : '250 ok') });
    relay({ SMTP_PORT: String(f.port) });
    const r = await attempt(['good@x.test', 'bad@x.test']) as import('../src/server/mail/smtp').SendResult;
    ok('one RCPT refused: the other is delivered, the refusal counted', r.accepted === 1 && r.rejected.length === 1 && r.rejected[0].code === 550 && f.txns[0].rcpts.join() === 'good@x.test');
    const all = await attempt(['bad1@x.test', 'bad2@x.test']);
    ok('every RCPT refused: rejected, no DATA', kindOf(all) === 'rejected' && f.txns.length === 1);
    const big = await attempt(Array.from({ length: smtp.MAX_RCPT + 1 }, (_, i) => `u${i}@x.test`));
    ok(`more than ${smtp.MAX_RCPT} recipients in one session: input`, kindOf(big) === 'input');
  }

  // ── Batches and retries (emailChannel.sendBatches) ──────────────────────
  {
    const waits: number[] = [];
    email.setMailSleepForTest(async (ms) => { waits.push(ms); });
    const lines: string[] = [];
    const capture = { info: (o: object, m: string) => lines.push(m + JSON.stringify(o)), warn: (o: object, m: string) => lines.push(m + JSON.stringify(o)) };
    const f = await fake({});
    email.wireMail(mailEnv.parseMail({ SMTP_HOST: 'localhost', SMTP_PORT: String(f.port), SMTP_FROM: FROM } as import('../src/server/mail/mailEnv').MailSrc, true), null, [], capture);
    const to = Array.from({ length: 120 }, (_, i) => `u${i}@x.test`);
    const r = await email.sendBatches(to, msg(), 'ch-1');
    ok('batches: 120 recipients go as 50 / 50 / 20, all accepted', r.error === null && r.accepted === 120 && f.txns.map((t) => t.rcpts.length).join() === '50,50,20');
    ok('the log counts recipients and never names one', lines.length === 3 && !lines.some((l) => l.includes('u0@x.test')));
    smtp.setTimingForTest({ commandMs: 200, dataMs: 200 });
    f.opts = { stall: 'mail' };
    let c0 = f.connections;
    const r2 = await email.sendBatches(['a@x.test'], msg(), 'ch-1');
    ok('a timeout BEFORE the final dot is retried: 3 attempts, backing off 1 s then 4 s', r2.error?.kind === 'timeout' && f.connections - c0 === 3 && waits.join() === '1000,4000', [f.connections - c0, waits]);
    waits.length = 0;
    f.opts = { stall: 'dot' };
    c0 = f.connections;
    const r3 = await email.sendBatches(['a@x.test'], msg(), 'ch-1');
    ok('NEGATIVE CONTROL: a timeout AFTER the final dot is never retried (the relay may have queued it)', r3.error?.afterDot === true && f.connections - c0 === 1 && waits.length === 0);
    f.opts = { reply: { dot: '451 4.3.0 later' } };
    c0 = f.connections;
    const r4 = await email.sendBatches(['a@x.test'], msg(), 'ch-1');
    ok('a 4xx to the final dot is final too: one attempt', r4.error?.kind === 'temporary' && f.connections - c0 === 1);
    f.opts = { reply: { mail: '550 5.7.1 sender refused' } };
    c0 = f.connections;
    const r5 = await email.sendBatches(['a@x.test'], msg(), 'ch-1');
    ok('a 5xx is final: one attempt', r5.error?.kind === 'rejected' && r5.error.code === 550 && f.connections - c0 === 1);
    smtp.setTimingForTest({ commandMs: 30_000, dataMs: 60_000 });
    smtp.resetTransportForTest();
    email.wireMail(null, null, []);
  }

  // ── The reply reader: chunking and the caps ──────────────────────────────
  {
    const fed = async (chunks: string[]): Promise<string> => {
      const r = new smtp.Reader();
      for (const c of chunks) r.feed(c);
      return r.read(200).then((x) => `${x.code}:${x.lines.join('|')}`, (e) => `error:${(e as import('../src/server/mail/mime').MailError).kind}`);
    };
    ok('reader: a reply whose CR and LF arrive in two chunks', (await fed(['250 ok\r', '\n'])) === '250:250 ok');
    ok('reader: a multi-line EHLO across chunks, split mid-line', (await fed(['250-fake.te', 'st\r\n250-STARTTLS\r', '\n250 AUTH PL', 'AIN\r\n'])) === '250:250-fake.test|250-STARTTLS|250 AUTH PLAIN');
    ok('reader: a continuation under another code is a protocol error', (await fed(['250-a\r\n251 b\r\n'])) === 'error:protocol');
    ok('reader: a garbled line is a protocol error', (await fed(['hello there\r\n'])) === 'error:protocol');
    ok('reader: over 16 KB with no line end is a protocol error', (await fed(['250-' + 'x'.repeat(17_000)])) === 'error:protocol');
    ok('reader: over 100 lines in one reply is a protocol error', (await fed([Array.from({ length: 101 }, () => '250-x\r\n').join('') + '250 end\r\n'])) === 'error:protocol');
    ok('control: 99 continuation lines and an end are one reply', (await fed([Array.from({ length: 99 }, () => '250-x\r\n').join('') + '250 end\r\n'])).startsWith('250:'));
    ok('control: nothing yet is a timeout, not a parse', (await fed(['250-half'])) === 'error:timeout');
  }

  // ── Every batch is tried; a failed one leaves the others ─────────────────
  {
    email.setMailSleepForTest(async () => undefined);
    const f = await fake({ rcpt: (a) => (/^u1\d\d@/.test(a) ? '421 4.7.0 try later' : '250 ok') }); // u100–u119: batch 3 only
    email.wireMail(mailEnv.parseMail({ SMTP_HOST: 'localhost', SMTP_PORT: String(f.port), SMTP_FROM: FROM } as import('../src/server/mail/mailEnv').MailSrc, true), null, []);
    const to = Array.from({ length: 120 }, (_, i) => `u${i}@x.test`);
    const r = await email.sendBatches(to, msg(), 'ch-partial');
    ok('partial: batch 3 refused with 421 (three tries) — batches 1 and 2 still delivered', r.accepted === 100 && r.failedBatches === 1 && r.error?.kind === 'temporary' && f.txns.length === 2 && r.attempts === 5, r);
    f.opts = { rcpt: (a) => (/^u[0-4]?\d@/.test(a) ? '421 4.7.0 try later' : '250 ok') }; // batch 1 refused
    const first = await email.sendBatches(to, msg(), 'ch-partial');
    ok('partial: batch 1 refused — batches 2 and 3 are still tried and delivered', first.accepted === 70 && first.failedBatches === 1, first);
    f.opts = {};
    const all = await email.sendBatches(to, msg(), 'ch-partial');
    ok('control: with no refusal every batch goes and none failed', all.accepted === 120 && all.failedBatches === 0 && all.error === null);
    const g = await fake({ creds: { user: USER, pass: 'not-it' } });
    email.wireMail(mailEnv.parseMail({ SMTP_HOST: 'localhost', SMTP_PORT: String(g.port), SMTP_FROM: FROM, SMTP_USER: USER, SMTP_PASSWORD: PASS } as import('../src/server/mail/mailEnv').MailSrc, true), null, []);
    const wide = await email.sendBatches(to, msg(), 'ch-partial');
    ok('a relay-wide failure (AUTH) ends the send at the first batch — the others would repeat it', wide.error?.kind === 'auth' && wide.failedBatches === 1 && g.connections === 1);
    email.wireMail(null, null, []);
  }

  // ── Budgets: held per batch, refunded, a project's half ──────────────────
  {
    await budget.resetBudgetsForTest();
    const A = budget.sendBuckets('acme', 'project-a', 'dashboard', 10);
    const B = budget.sendBuckets('acme', 'project-b', 'dashboard', 10);
    ok('a project may hold half the org\'s hour', budget.projectShare(10) === 5 && (await budget.hold(A, 5)) !== null && (await budget.hold(A, 1)) === null);
    ok('project A exhausting its share does not refuse project B', (await budget.hold(B, 5)) !== null);
    ok('…and the org\'s own bucket still binds both (10 held of 10)', (await budget.hold(budget.sendBuckets('acme', 'project-c', 'dashboard', 10), 1)) === null);
    ok('alerts have their own buckets', (await budget.hold(budget.sendBuckets('acme', 'project-a', 'alert', 10), 5)) !== null);
    await budget.resetBudgetsForTest();
    const h = await budget.hold(A, 5);
    await h?.refund(3);
    ok('a refund gives the room back (5 held, 3 refunded → 3 more fit, 4 do not)', (await budget.hold(A, 3)) !== null && (await budget.hold(A, 1)) === null);
    await budget.resetBudgetsForTest();
    const f = await fake({});
    email.wireMail(mailEnv.parseMail({ SMTP_HOST: 'localhost', SMTP_PORT: String(f.port), SMTP_FROM: FROM } as import('../src/server/mail/mailEnv').MailSrc, true), null, []);
    const to = Array.from({ length: 120 }, (_, i) => `u${i}@x.test`);
    const r = await email.sendBatches(to, msg(), 'ch-budget', budget.sendBuckets('acme', 'p', 'dashboard', 200)); // a project's share: 100
    ok('a budget that runs out mid-send stops there: 100 sent, the third batch never held', r.accepted === 100 && r.limited === true && f.txns.length === 2, r);
    await budget.resetBudgetsForTest();
    f.opts = { rcpt: () => '550 5.1.1 no such user' };
    await email.sendBatches(to.slice(0, 50), msg(), 'ch-budget', budget.sendBuckets('acme', 'p', 'dashboard', 200));
    ok('a batch the relay did not take costs nothing: the full share is still free', (await budget.hold(budget.sendBuckets('acme', 'p', 'dashboard', 200), 100)) !== null);
    await budget.resetBudgetsForTest();
    email.wireMail(null, null, []);
  }

  // ── The password canary ──────────────────────────────────────────────────
  {
    const f = await fake({ creds: { user: USER, pass: 'something-else' }, echoAuth: true });
    relay({ SMTP_PORT: String(f.port), SMTP_USER: USER, SMTP_PASSWORD: PASS });
    const r = await attempt(['a@x.test']) as import('../src/server/mail/mime').MailError;
    const all = JSON.stringify({ kind: r.kind, code: r.code, message: r.message, detail: r.detail, stack: r.stack });
    ok('a refused AUTH: auth', kindOf(r) === 'auth' && r.code === 535);
    ok('password canary: the error holds neither the password, its base64 nor the PLAIN blob', ![PASS, b64(PASS), PLAIN].some((s) => all.includes(s)) && all.includes('[redacted]'), all);
    ok('NEGATIVE CONTROL: the relay DID receive the PLAIN blob (and echoed it)', f.sessions[0].includes(`AUTH PLAIN ${PLAIN}`));
  }

  // ── SSRF: the operator's relay and nothing else ──────────────────────────
  {
    const real = dns.promises.lookup;
    const FAKE_DNS: Record<string, string> = { 'public.mail.test': '93.184.216.34' };
    (dns.promises as { lookup: unknown }).lookup = async (host: string, o?: unknown) => (FAKE_DNS[host] ? [{ address: FAKE_DNS[host], family: 4 }] : (real as (h: string, o?: unknown) => Promise<unknown>)(host, o));
    for (const host of ['169.254.169.254', '100.100.100.200', 'fd20:ce::254', 'fd00:ec2::254', '0.0.0.0', '224.0.0.1']) {
      relay({ SMTP_HOST: host, SMTP_SECURITY: 'tls' });
      const r = await attempt(['a@x.test']);
      ok(`relay ${host}: refused before any socket`, kindOf(r) === 'refused', r);
    }
    process.env.SSRF_ALLOW = '169.254.0.0/16';
    relay({ SMTP_HOST: '169.254.169.254', SMTP_SECURITY: 'tls' });
    const r = await attempt(['a@x.test']);
    const plain = await ssrf.checkHost('169.254.169.254').then(() => 'admitted', () => 'refused');
    ok('metadata stays refused for the relay with SSRF_ALLOW=169.254.0.0/16 (hard-deny first)', kindOf(r) === 'refused');
    ok('NEGATIVE CONTROL: the one-argument guard DOES admit it under that SSRF_ALLOW', plain === 'admitted');
    delete process.env.SSRF_ALLOW;
    const loop = await ssrf.checkHost('127.0.0.1').then(() => 'admitted', () => 'refused');
    ok('the one-argument guard (every connector) still refuses loopback', loop === 'refused');
    relay({ SMTP_HOST: 'public.mail.test', SMTP_SECURITY: 'plaintext' });
    const pub = await attempt(['a@x.test']);
    ok('plaintext to a public address: refused at connect (tls), no socket', kindOf(pub) === 'tls');
    (dns.promises as { lookup: unknown }).lookup = real;
    const SRC = path.join(__dirname, '..', 'src');
    const files = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) files.set(path.relative(SRC, p), fs.readFileSync(p, 'utf8'));
      }
    };
    walk(SRC);
    const users = (m: Map<string, string>): string[] => [...m].filter(([f, t]) => f !== path.join('connectors', 'ssrf.ts') && t.includes('OPERATOR_HOST')).map(([f]) => f);
    ok('OPERATOR_HOST is used from exactly one file: the SMTP client', JSON.stringify(users(files)) === JSON.stringify([path.join('server', 'mail', 'smtp.ts')]), users(files));
    ok('NEGATIVE CONTROL: a planted second user is found', users(new Map([...files, ['connectors/evil.ts', 'checkHost(h, OPERATOR_HOST)']])).length === 2);
  }

  // ── mailEnv ──────────────────────────────────────────────────────────────
  {
    const base = { SMTP_HOST: 'smtp.acme.test', SMTP_FROM: FROM } as Src;
    const refuse = (src: Src, name: string): boolean => {
      try { mailEnv.parseMail({ ...base, ...src } as import('../src/server/mail/mailEnv').MailSrc, true); return false; } catch (err) { return err instanceof envMod.EnvError && err.message.includes(name); }
    };
    const cases: Array<[string, Src, string]> = [
      ['SMTP_FROM without SMTP_HOST', { SMTP_HOST: '' }, 'SMTP_HOST'],
      ['a host with :25', { SMTP_HOST: 'smtp.acme.test:25' }, 'SMTP_HOST'],
      ['a host with :80 (the URL parser drops a default port)', { SMTP_HOST: 'relay.example.com:80' }, 'SMTP_HOST'],
      ['a host with :443', { SMTP_HOST: 'relay.example.com:443' }, 'SMTP_HOST'],
      ['a bracketed IPv6 with a port', { SMTP_HOST: '[::1]:25' }, 'SMTP_HOST'],
      ['a host with a path', { SMTP_HOST: 'relay.example.com/x' }, 'SMTP_HOST'],
      ['an unknown mode', { SMTP_SECURITY: 'ssl' }, 'SMTP_SECURITY'],
      ['port 0', { SMTP_PORT: '0' }, 'SMTP_PORT'],
      ['port 70000', { SMTP_PORT: '70000' }, 'SMTP_PORT'],
      ['a user without a password', { SMTP_USER: 'u' }, 'SMTP_PASSWORD'],
      ['a password without a user', { SMTP_PASSWORD: 'p' }, 'SMTP_USER'],
      ['a user with plaintext', { SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_SECURITY: 'plaintext' }, 'SMTP_USER'],
      ['plaintext to a public IP', { SMTP_HOST: '93.184.216.34', SMTP_SECURITY: 'plaintext' }, 'plaintext'],
      ['no SMTP_FROM', { SMTP_FROM: '' }, 'SMTP_FROM'],
      ['SMTP_FROM not an address', { SMTP_FROM: 'Acme <not an address>' }, 'SMTP_FROM'],
      ['SMTP_FROM name with a quote', { SMTP_FROM: 'Ac"me <bi@acme.test>' }, 'SMTP_FROM'],
      ['SMTP_FROM name with a backslash', { SMTP_FROM: 'Acme\\ <bi@acme.test>' }, 'SMTP_FROM'],
      ['a password with a line break', { SMTP_USER: 'u', SMTP_PASSWORD: 'p\r\nx' }, 'SMTP_PASSWORD'],
      ['rate 0', { RATE_LIMIT_EMAIL_ORG_PER_HOUR: '0' }, 'RATE_LIMIT_EMAIL_ORG_PER_HOUR'],
    ];
    const bad = cases.filter(([, src, name]) => !refuse(src, name)).map(([what]) => what);
    ok(`mailEnv refuses all ${cases.length} bad settings, each naming its variable`, bad.length === 0, bad);
    let echoed = '';
    try { mailEnv.parseMail({ ...base, SMTP_HOST: 'smtp://u:hunter2@relay.acme.test' } as import('../src/server/mail/mailEnv').MailSrc, true); } catch (err) { echoed = (err as Error).message; }
    ok('an SMTP_HOST with credentials is refused without echoing it', echoed.includes('SMTP_HOST') && !echoed.includes('hunter2'), echoed);
    const parse = (src: Src, db = true) => mailEnv.parseMail({ ...base, ...src } as import('../src/server/mail/mailEnv').MailSrc, db) as import('../src/server/mail/mailEnv').MailEnv;
    ok('defaults: starttls 587, tls 465, plaintext 25, 1000 recipients an hour', parse({}).port === 587 && parse({ SMTP_SECURITY: 'tls' }).port === 465 && parse({ SMTP_HOST: '10.0.0.5', SMTP_SECURITY: 'plaintext' }).port === 25 && parse({}).orgPerHour === 1000);
    ok('SMTP_HOST unset and nothing else: email off', mailEnv.parseMail({} as import('../src/server/mail/mailEnv').MailSrc, true) === null);
    const w = (src: Src, db = true): string => parse(src, db).warnings.join(' | ');
    ok('warnings: plaintext, starttls on 465, tls on 587, no database; none for a normal relay', w({ SMTP_HOST: '10.0.0.5', SMTP_SECURITY: 'plaintext' }).includes('unencrypted') && w({ SMTP_PORT: '465' }).includes('465') && w({ SMTP_SECURITY: 'tls', SMTP_PORT: '587' }).includes('587') && w({}, false).includes('DATABASE_URL') && w({}) === '');
    const withPw = parse({ SMTP_USER: 'u', SMTP_PASSWORD: PASS });
    ok('the password is in neither JSON nor util.inspect of the parsed settings', !JSON.stringify(withPw).includes(PASS) && !util.inspect(withPw, { depth: 5 }).includes(PASS));
    ok('the sender: name and address apart, quotes stripped', parse({ SMTP_FROM: '"Acme Analytics" <bi@acme.test>' }).from.name === 'Acme Analytics' && parse({}).from.name === null);
    let full = '';
    try { envMod.parseEnv({ AUTH_MODE: 'dev', SMTP_FROM: FROM }); } catch (err) { full = (err as Error).message; }
    ok('parseEnv runs it at startup: SMTP_FROM alone stops the process, naming SMTP_HOST', full.includes('SMTP_HOST'), full);
  }

  for (const f of fakes) await f.close();
}

main().then(finish, (err) => {
  ok('suite ran', false, err);
  finish();
});
