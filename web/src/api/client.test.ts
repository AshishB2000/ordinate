import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_ID, csrfHeaders, rpc, RpcError, upload } from './client';
import { stubFetch } from '../test-utils';
import { decode, encode } from '../../../src/server/wire.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN = 'a'.repeat(43);
const FRESH = 'b'.repeat(43);
/** document.cookie as the browser would show it. */
const cookie = (v: string) => vi.spyOn(document, 'cookie', 'get').mockReturnValue(v);
const sent = (spy: { mock: { calls: unknown[][] } }, i = 0) =>
  ((spy.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>)['X-CSRF-Token'];

describe('rpc', () => {
  it('POSTs the encoded args to /api/rpc/<channel> with the tab id', async () => {
    const spy = stubFetch(200, [{ id: 'p1' }]);
    expect(await rpc('dataset:list', { projectId: 'p' })).toEqual([{ id: 'p1' }]);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/rpc/dataset%3Alist');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Ordinate-Client']).toBe(CLIENT_ID);
    expect(JSON.parse(init.body as string)).toEqual({ args: [{ projectId: 'p' }] });
    expect(CLIENT_ID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('carries what JSON drops, both ways (the wire codec)', async () => {
    const spy = vi.fn(async () => new Response(encode({ mean: NaN, at: new Date(0), ids: new Set([1]) }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const out = (await rpc('recent:list', { limit: 5 })) as { mean: number; at: Date; ids: Set<number> };
    expect(Object.is(out.mean, NaN)).toBe(true);
    expect(out.at).toBeInstanceOf(Date);
    expect(out.ids).toEqual(new Set([1]));
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(decode(init.body as string)).toEqual({ args: [{ limit: 5 }] });
  });

  it('sends no payload when the contract takes none', async () => {
    const spy = stubFetch(200, []);
    await rpc('projects:list');
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ args: [] });
  });

  it('turns a 400 into a typed RpcError with the failing paths', async () => {
    stubFetch(400, { error: 'invalid input', issues: [{ path: 'args.0.projectId', code: 'invalid_format' }] });
    const err = await rpc('dataset:list', {} as { projectId: string }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ status: 400, code: 'invalid input', message: 'invalid input', paths: ['args.0.projectId'] });
  });

  it('survives a non-JSON error body', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(rpc('projects:list')).rejects.toMatchObject({ status: 502, code: 'http_502', message: 'Bad Gateway' });
  });

  it('reports an unreachable server as status 0', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(rpc('projects:list')).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});

describe('CSRF (T6.2)', () => {
  it('echoes the cookie in X-CSRF-Token on every RPC', async () => {
    cookie(`theme=dark; ordinate_csrf=${TOKEN}; other=1`);
    const spy = stubFetch(200, []);
    await rpc('projects:list');
    expect(sent(spy)).toBe(TOKEN);
    expect((spy.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe('same-origin');
  });

  it('reads the __Host- cookie a production server sets', () => {
    cookie(`__Host-ordinate_csrf=${TOKEN}`);
    expect(csrfHeaders()).toEqual({ 'X-CSRF-Token': TOKEN });
  });

  it('sends no header without a well-formed cookie', () => {
    cookie('ordinate_csrf=short; xordinate_csrf=' + TOKEN);
    expect(csrfHeaders()).toEqual({});
  });

  it('retries ONCE after a 403 csrf, with the cookie that 403 set', async () => {
    const jar = cookie('');
    const spy = vi.fn(async () => {
      if (spy.mock.calls.length === 1) {
        jar.mockReturnValue(`ordinate_csrf=${FRESH}`);
        return new Response(JSON.stringify({ error: 'csrf' }), { status: 403 });
      }
      return new Response(encode([{ id: 'p' }]), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    expect(await rpc('projects:list')).toEqual([{ id: 'p' }]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sent(spy, 0)).toBeUndefined();
    expect(sent(spy, 1)).toBe(FRESH);
  });

  it('does not loop: a second 403 csrf is the answer', async () => {
    cookie('');
    const spy = stubFetch(403, { error: 'csrf' });
    await expect(rpc('projects:list')).rejects.toMatchObject({ status: 403, code: 'csrf' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('never retries another 403 (forbidden, origin)', async () => {
    for (const error of ['forbidden', 'origin']) {
      const spy = stubFetch(403, { error });
      await expect(rpc('projects:list')).rejects.toMatchObject({ status: 403, code: error });
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });
});

describe('upload', () => {
  it('POSTs one multipart file to /api/files with the CSRF header and returns the token', async () => {
    cookie(`ordinate_csrf=${TOKEN}`);
    const spy = stubFetch(200, { fileToken: 't'.repeat(43), name: 'a.csv', size: 3 });
    const out = await upload(new Blob(['a,b']), 'a.csv');
    expect(out).toEqual({ fileToken: 't'.repeat(43), name: 'a.csv', size: 3 });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/files');
    expect(init.method).toBe('POST');
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(sent(spy)).toBe(TOKEN);
  });

  it('turns a 413 into an RpcError', async () => {
    stubFetch(413, { error: 'file too large', maxMb: 1 });
    await expect(upload(new Blob(['x']), 'x.csv')).rejects.toMatchObject({ status: 413, code: 'file too large' });
  });
});
