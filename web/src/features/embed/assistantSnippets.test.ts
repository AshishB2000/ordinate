// The Assistant signing code Admin hands out, RUN (Node, and python3 when the machine has it): the token each prints must carry a MAC an
// independent HMAC accepts and exactly the claims the server's parser (src/server/embed/askToken.ts) allows: agent, sub, params, exp (≤ 1 hour).

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iframeSnippet, nodeAssistantSnippet, pythonAssistantSnippet } from './assistantSnippets';

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
  it('names the agent and org, never a secret, and the page snippet is an iframe with no referrer', () => {
    expect(nodeAssistantSnippet(input)).toContain(AGENT);
    expect(nodeAssistantSnippet(input)).not.toContain(SECRET);
    expect(iframeSnippet()).toContain('referrerpolicy="no-referrer"');
  });
});
