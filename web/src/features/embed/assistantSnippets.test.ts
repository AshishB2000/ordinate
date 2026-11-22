// The Assistant signing code Admin hands out, RUN (Node, and python3 when the machine has it): the token each prints must carry a MAC an
// independent HMAC accepts and exactly the claims the server's parser (src/server/embed/askToken.ts) allows: agent, sub, params, exp (≤ 1 hour).

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iframeSnippet, nodeAssistantSnippet, pythonAssistantSnippet } from './assistantSnippets';

// The server's own parser, compiled by `npm run build:ts` (as vite.config.ts reads the contracts).
const { verifyAskToken } = createRequire(import.meta.url)('../../../../src/server/embed/askToken.js') as typeof import('../../../../src/server/embed/askToken');

const SECRET = 'ord_embed_' + 'S'.repeat(43);
const AGENT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const input = { server: 'https://bi.acme.test', org: 'acme', agentId: AGENT, columns: ['customer_id', 'account'] };

function check(url: string) {
  expect(url.startsWith('https://bi.acme.test/embed/ask/')).toBe(true);
  const [h, p, sig] = url.slice('https://bi.acme.test/embed/ask/'.length).trim().split('.');
  expect(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')).toBe(sig);
  expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'acme' });
  const { exp, ...rest } = JSON.parse(Buffer.from(p, 'base64url').toString());
  expect(rest).toEqual({ agent: AGENT, sub: 'cust-9', params: { customer_id: ['C-42'], account: ['C-42'] } });
  const now = Date.now() / 1000;
  expect(exp > now + 29 * 60 && exp <= now + 30 * 60 + 5 && exp <= now + 3600).toBe(true);
}

const hasPython = (): boolean => {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('the Assistant signing snippets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-snippets-'));
  it('Node: prints a link whose token has a valid MAC and only the Assistant claims', () => {
    const file = join(dir, 'sign.cjs');
    writeFileSync(file, nodeAssistantSnippet(input) + "\nconsole.log(assistantUrl({ id: 'cust-9', customerId: 'C-42' }));\n");
    check(execFileSync(process.execPath, [file], { env: { ...process.env, ORDINATE_EMBED_SECRET: SECRET } }).toString());
  });
  it.skipIf(!hasPython())('Python: the same, from the standard library alone', () => {
    const file = join(dir, 'sign.py');
    writeFileSync(file, pythonAssistantSnippet(input) + '\nprint(assistant_url({"id": "cust-9", "customer_id": "C-42"}))\n');
    check(execFileSync('python3', ['-I', file], { env: { ...process.env, ORDINATE_EMBED_SECRET: SECRET } }).toString());
  });
  it('NEGATIVE CONTROL: a link signed with another secret fails the same check', () => {
    const file = join(dir, 'other.cjs');
    writeFileSync(file, nodeAssistantSnippet(input) + "\nconsole.log(assistantUrl({ id: 'cust-9', customerId: 'C-42' }));\n");
    const url = execFileSync(process.execPath, [file], { env: { ...process.env, ORDINATE_EMBED_SECRET: SECRET + 'x' } }).toString();
    expect(() => check(url)).toThrow();
  });
  it('an integer user id (the usual database key) still signs a token the server accepts: sub is sent as text', () => {
    const run = (file: string, code: string, cmd: string[]) => { writeFileSync(file, code); return execFileSync(cmd[0], [...cmd.slice(1), file], { env: { ...process.env, ORDINATE_EMBED_SECRET: SECRET } }).toString().trim(); };
    const url = run(join(dir, 'int.cjs'), nodeAssistantSnippet(input) + "\nconsole.log(assistantUrl({ id: 42, customerId: 7 }));\n", [process.execPath]);
    const v = verifyAskToken(url.slice(url.lastIndexOf('/') + 1), SECRET, Math.floor(Date.now() / 1000));
    expect(v.ok).toBe(true);
    expect(v.ok && v.claims.sub).toBe('42');
    if (hasPython()) {
      const py = run(join(dir, 'int.py'), pythonAssistantSnippet(input) + '\nprint(assistant_url({"id": 42, "customer_id": 7}))\n', ['python3', '-I']);
      const pv = verifyAskToken(py.slice(py.lastIndexOf('/') + 1), SECRET, Math.floor(Date.now() / 1000));
      expect(pv.ok && pv.claims.sub).toBe('42');
    }
  });
  it('NEGATIVE CONTROL: a token whose sub is a number (what the unconverted snippet signed) is refused by the same parser', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'HS256', typ: 'JWT', kid: 'acme' });
    const body = b64({ agent: AGENT, sub: 42, params: { customer_id: ['C'] }, exp: Math.floor(Date.now() / 1000) + 600 });
    const token = `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
    expect(verifyAskToken(token, SECRET, Math.floor(Date.now() / 1000)).ok).toBe(false);
  });
  it('a trailing slash on the server address does not double the slash before /embed/ask (the token would reach a log unmasked)', () => {
    expect(nodeAssistantSnippet({ ...input, server: 'https://bi.acme.test/' })).toContain('const ORDINATE = "https://bi.acme.test";');
    expect(pythonAssistantSnippet({ ...input, server: 'https://bi.acme.test//' })).toContain('ORDINATE = "https://bi.acme.test"\n');
  });
  it('names the agent and org, never a secret, and the page snippet is an iframe with no referrer', () => {
    expect(nodeAssistantSnippet(input)).toContain(AGENT);
    expect(nodeAssistantSnippet(input)).not.toContain(SECRET);
    expect(iframeSnippet()).toContain('referrerpolicy="no-referrer"');
  });
});
