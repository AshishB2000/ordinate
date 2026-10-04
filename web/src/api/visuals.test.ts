import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadVizData, type VizRequest } from './visuals';

afterEach(() => vi.unstubAllGlobals());

const P = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const req = (projectId: string, category: string): VizRequest => ({
  projectId,
  datasetId: D,
  encoding: { category, values: [{ column: 'amount', aggregation: 'sum' }] },
});

function stub(handler: (channel: string, payload: { projectId: string; items?: unknown[] }) => unknown) {
  const calls: { channel: string; payload: { projectId: string; items?: unknown[] } }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(url.replace('/api/rpc/', ''));
      const payload = (JSON.parse(String(init?.body)) as { args: [{ projectId: string; items?: unknown[] }] }).args[0];
      calls.push({ channel, payload });
      const out = handler(channel, payload);
      return out instanceof Response ? out : Response.json(out);
    }),
  );
  return calls;
}

describe('chart data batching', () => {
  it('sends one batch per project for the requests of one tick, and routes each answer back in order', async () => {
    const calls = stub((channel, p) =>
      channel === 'visual:dataBatch'
        ? (p.items as { encoding: { category: string } }[]).map((it) => ({ ok: true, data: { labels: [it.encoding.category] } }))
        : { ok: true, data: { labels: ['alone'] } },
    );
    const answers = await Promise.all([loadVizData(req(P, 'a')), loadVizData(req(P, 'b')), loadVizData(req(Q, 'c')), loadVizData(req(P, 'd'))]);
    expect(calls.map((c) => c.channel).sort()).toEqual(['visual:data', 'visual:dataBatch']);
    const batch = calls.find((c) => c.channel === 'visual:dataBatch')!.payload;
    expect(batch.projectId).toBe(P);
    expect(batch.items).toEqual([req(P, 'a'), req(P, 'b'), req(P, 'd')].map(({ projectId: _p, ...it }) => it));
    expect(answers.map((a) => (a as { data: { labels: string[] } }).data.labels[0])).toEqual(['a', 'b', 'alone', 'd']);
  });

  it('fails every request of a batch that failed on the wire, and none of the next tick', async () => {
    stub(() => new Response('{"error":"boom"}', { status: 500 }));
    const out = await Promise.allSettled([loadVizData(req(P, 'a')), loadVizData(req(P, 'b'))]);
    expect(out.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    stub(() => ({ ok: true, data: { labels: [] } }));
    expect((await loadVizData(req(P, 'c'))).ok).toBe(true);
  });
});
