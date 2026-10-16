// The signing code Admin → Embedding hands out, RUN: the Node snippet under
// this Node, the Python one under python3 when the machine has it. Each must
// print a token whose MAC an independent HMAC accepts and whose claims are the
// ones asked for — so a broken snippet cannot ship looking right.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimsOf, nodeSnippet, pythonSnippet } from './snippets';
import { normalizeOrigin, paramsOf } from './api';

const SECRET = 'ord_embed_' + 'S'.repeat(43);
const input = {
  server: 'https://bi.acme.test', org: 'acme', pub: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', dash: '6f1c1b5e-6a0e-4a8f-9c55-1f8e4c0d2a10',
  params: { Customer: ['Acme “East”', 'Ünïcode'], Year: [2025] }, theme: 'dark' as const, hide: ['title'],
};

function check(url: string) {
  expect(url.startsWith('https://bi.acme.test/embed/')).toBe(true);
  const token = url.slice('https://bi.acme.test/embed/'.length).trim();
  const [h, p, sig] = token.split('.');
  expect(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')).toBe(sig);
  expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'acme' });
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const { exp, ...rest } = claims;
  expect(rest).toEqual(claimsOf(input));
  const now = Date.now() / 1000;
  expect(exp > now + 9 * 60 && exp <= now + 10 * 60 + 5).toBe(true);
}

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('the signing snippets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'embed-snippets-'));
  it('Node: prints a token the server’s check accepts, with exactly the claims asked for', () => {
    const file = join(dir, 'sign.cjs');
    writeFileSync(file, nodeSnippet(input) + '\nconsole.log(src);\n');
    check(execFileSync(process.execPath, [file], { env: { ...process.env, ORDINATE_EMBED_SECRET: SECRET } }).toString());
  });
  it.skipIf(!hasPython())('Python: the same, from the standard library alone', () => {
    const file = join(dir, 'sign.py');
    writeFileSync(file, pythonSnippet(input) + '\nprint(src)\n');
    check(execFileSync('python3', ['-I', file], { env: { ...process.env, ORDINATE_EMBED_SECRET: SECRET } }).toString());
  });
  it('NEGATIVE CONTROL: a token signed with another secret fails the same check', () => {
    const file = join(dir, 'other.cjs');
    writeFileSync(file, nodeSnippet(input) + '\nconsole.log(src);\n');
    const url = execFileSync(process.execPath, [file], { env: { ...process.env, ORDINATE_EMBED_SECRET: SECRET + 'x' } }).toString();
    expect(() => check(url)).toThrow();
  });
  it('without a published link yet, the claims name the placeholder, not a guess', () => {
    expect(claimsOf({ server: 'x', org: 'acme' })).toEqual({ pub: '<published link id>' });
  });
});

describe('origins and locks, as the screens build them', () => {
  it('normalises an origin the way the server does', () => {
    expect(normalizeOrigin('https://Portal.Acme.com/')).toBe('https://portal.acme.com');
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    for (const bad of ['http://portal.acme.com', 'https://a.com/x', 'https://*.a.com', 'https://u:p@a.com', 'a.com', '']) expect(normalizeOrigin(bad)).toBeNull();
  });
  it('turns locks into params: trimmed, empty dropped, a number column’s values as numbers', () => {
    const cols = [{ name: 'Year', type: 'number' as const, tiles: 3 }, { name: 'Customer', type: 'text' as const, tiles: 3 }];
    expect(paramsOf([{ column: 'Year', values: ['2025', ' 2026'] }, { column: 'Customer', values: [' Acme', '', '007'] }, { column: '', values: ['x'] }, { column: 'Region', values: [] }], cols))
      .toEqual({ Year: [2025, 2026], Customer: ['Acme', '007'] });
  });
});
