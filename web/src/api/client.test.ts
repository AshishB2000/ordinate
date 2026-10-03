import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_ID, rpc, RpcError } from './client';
import { stubFetch } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

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

  it('turns a 400 into a typed RpcError with the failing paths', async () => {
    stubFetch(400, { error: 'invalid input', issues: [{ path: 'args.0.projectId', code: 'invalid_format' }] });
    const err = await rpc('dataset:list', {}).catch((e: unknown) => e);
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
