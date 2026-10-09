import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery, type QueryKey } from '@tanstack/react-query';
import { encode } from '../../../src/server/wire.ts';
import { resetEventsForTest } from './events';
import { DEBOUNCE_MS, isFigureQuery, READS, readsDataset, refreshedOf, REFRESHED_CHANNEL, useDatasetFreshness, type Refreshed } from './freshness';
import { useVizData } from './visuals';
import { useTile } from '../features/analyses/api';
import { useStats, useSource } from '../features/data/api';
import { useAsOfStamps, useSummary } from '../features/dashboards/api';

const P = '11111111-1111-4111-8111-111111111111';
const D = '33333333-3333-4333-8333-333333333333';
const E = '44444444-4444-4444-8444-444444444444'; // another dataset of the same project
const Q = '22222222-2222-4222-8222-222222222222'; // another project
const hit: Refreshed = { projectId: P, datasetId: D, ok: true };
const enc = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' as const }] };

/** Each key exactly as its hook builds it, for D — and the same key for E (must NOT match). */
const KEYS: Record<string, [QueryKey, QueryKey]> = {
  'visual:data': [['visual:data', { projectId: P, datasetId: D, encoding: enc }], ['visual:data', { projectId: P, datasetId: E, encoding: enc }]],
  'visual:preview': [['visual:preview', { projectId: P, datasetId: D, encoding: enc, filters: [] }], ['visual:preview', { projectId: P, datasetId: E, encoding: enc, filters: [] }]],
  'visual:thumbs': [['visual:thumbs', P, 'v1', '2026-01-01'], ['visual:thumbs', Q, 'v1', '2026-01-01']],
  'analysis:tile': [['analysis:tile', P, [], {}, { kind: 'metric', datasetId: D, column: 'amount', aggregation: 'sum' }], ['analysis:tile', P, [], {}, { kind: 'metric', datasetId: E, column: 'amount', aggregation: 'sum' }]],
  'metric:values': [['metric:values', P, ['m1'], [], []], ['metric:values', Q, ['m1'], [], []]],
  'summary:compute': [['summary:compute', { projectId: P, pages: [] }], ['summary:compute', { projectId: Q, pages: [] }]],
  'dashboard:asOfStamps': [['dashboard:asOfStamps', P, [D], []], ['dashboard:asOfStamps', P, [E], []]],
  'answer:card': [['answer:card', P, JSON.stringify({ datasetId: D, category: 'region' })], ['answer:card', P, JSON.stringify({ datasetId: E, category: 'region' })]],
  'dataset:list': [['dataset:list', P], ['dataset:list', Q]],
  'dataset:columns': [['dataset:columns', P, D], ['dataset:columns', P, E]],
  'dataset:stats': [['dataset:stats', P, D], ['dataset:stats', P, E]],
  'dataset:source': [['dataset:source', P, D], ['dataset:source', P, E]],
  'dataset:profile': [['dataset:profile', P, D, 'amount'], ['dataset:profile', P, E, 'amount']],
  'dataset:distinct': [['dataset:distinct', P, D, 'region', 200, ''], ['dataset:distinct', P, E, 'region', 200, '']],
};

describe('the invalidation map', () => {
  it('covers every kind it names, and each reads its own dataset and not another', () => {
    expect(Object.keys(KEYS).sort()).toEqual(Object.keys(READS).sort());
    for (const [kind, [mine, other]] of Object.entries(KEYS)) {
      expect(readsDataset(mine, hit), `${kind} reads D`).toBe(true);
      expect(readsDataset(other, hit), `${kind} must not read E / another project`).toBe(false);
    }
  });

  it('the other shapes a kind takes: the dialog\'s visual:data, a stats tile, a dashboard KPI over a metric', () => {
    expect(readsDataset(['visual:data', P, D, enc], hit)).toBe(true);
    expect(readsDataset(['visual:data', P, E, enc], hit)).toBe(false);
    expect(readsDataset(['analysis:tile', P, [], {}, { kind: 'stats', spec: { kind: 'groups', datasetId: D } }], hit)).toBe(true);
    expect(readsDataset(['analysis:tile', P, [], {}, { kind: 'stats', spec: { kind: 'groups', datasetId: E } }], hit)).toBe(false);
    expect(readsDataset(['dashboard:asOfStamps', P, [E], ['m1']], hit)).toBe(true); // a metric may read D
    expect(readsDataset(['answer:card', P, 'not json'], hit)).toBe(false);
  });

  it('leaves everything else alone — an open editor\'s document above all', () => {
    for (const k of [['analysis:open', P, 'a1'], ['prepare:get', P, D], ['jobs:list'], ['projects:list'], [], [42]] as QueryKey[]) {
      expect(readsDataset(k, hit)).toBe(false);
      expect(isFigureQuery(k)).toBe(false);
    }
    expect(isFigureQuery(['analysis:tile', P])).toBe(true);
  });

  it('a failed refresh moved no rows: only the list (its status dot) is re-read', () => {
    const failed = { ...hit, ok: false };
    expect(readsDataset(['dataset:list', P], failed)).toBe(true);
    expect(readsDataset(KEYS['analysis:tile'][0], failed)).toBe(false);
    expect(readsDataset(KEYS['dataset:stats'][0], failed)).toBe(false);
  });

  it('reads the server\'s payload, and ignores one that names no dataset', () => {
    expect(refreshedOf({ projectId: P, datasetId: D, name: 'x', ok: true, rowsBefore: 1, rowsAfter: 3 })).toEqual(hit);
    expect(refreshedOf({ projectId: P, datasetId: D, ok: false, error: 'x' })).toEqual({ ...hit, ok: false });
    expect(refreshedOf({ projectId: P })).toBeNull();
    expect(refreshedOf('nope')).toBeNull();
  });
});

// ── The real hooks' keys ──────────────────────────────────────────────────────

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
const wrap = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

describe('held to the hooks\' own keys', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, items: [] }))));
  afterEach(() => vi.unstubAllGlobals());

  it('every figure hook a dashboard or a dataset page mounts is matched for its dataset, and only for it', () => {
    const qc = client();
    const mount = (ds: string) => {
      renderHook(() => useVizData({ projectId: P, datasetId: ds, encoding: enc }), { wrapper: wrap(qc) });
      renderHook(() => useTile(P, [], { kind: 'visual', datasetId: ds, encoding: enc }), { wrapper: wrap(qc) });
      renderHook(() => useTile(P, [], { kind: 'metric', datasetId: ds, column: 'amount', aggregation: 'sum' }), { wrapper: wrap(qc) });
      renderHook(() => useStats(P, ds), { wrapper: wrap(qc) });
      renderHook(() => useSource(P, ds), { wrapper: wrap(qc) });
      renderHook(() => useAsOfStamps(P, [ds], []), { wrapper: wrap(qc) });
    };
    mount(D);
    const forD = qc.getQueryCache().getAll().map((q) => q.queryKey);
    mount(E);
    const forE = qc.getQueryCache().getAll().map((q) => q.queryKey).filter((k) => !forD.includes(k));
    expect(forD.length).toBe(6);
    expect(forE.length).toBe(6);
    for (const k of forD) expect(readsDataset(k, hit), JSON.stringify(k)).toBe(true);
    for (const k of forE) expect(readsDataset(k, hit), JSON.stringify(k)).toBe(false);
    renderHook(() => useSummary({ projectId: P, pages: [] }), { wrapper: wrap(qc) });
    expect(qc.getQueryCache().getAll().some((q) => q.queryKey[0] === 'summary:compute' && readsDataset(q.queryKey, hit))).toBe(true);
  });
});

// ── The hook, driven by the event stream ──────────────────────────────────────

class FakeSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(ch: string, fn: (e: { data: string }) => void) {
    this.handlers.set(ch, [...(this.handlers.get(ch) ?? []), fn]);
  }
  close() {
    this.readyState = FakeSource.CLOSED;
  }
  open() {
    this.readyState = FakeSource.OPEN;
    this.onopen?.();
  }
  emit(ch: string, payload: unknown) {
    for (const fn of this.handlers.get(ch) ?? []) fn({ data: encode(payload) });
  }
}

describe('useDatasetFreshness', () => {
  beforeEach(() => {
    FakeSource.all = [];
    vi.stubGlobal('EventSource', FakeSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetEventsForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Seeds `keys` as fresh, mounted queries (an observer each, so a refetch is visible) and counts each one's fetches. */
  function setup(keys: QueryKey[]) {
    const qc = client();
    const fetches = new Map<string, number>();
    function Probe({ k }: { k: QueryKey }) {
      useQuery({
        queryKey: k,
        queryFn: () => {
          const id = JSON.stringify(k);
          fetches.set(id, (fetches.get(id) ?? 0) + 1);
          return 1;
        },
        staleTime: Infinity,
      });
      return null;
    }
    function Shell() {
      useDatasetFreshness();
      return (
        <>
          {keys.map((k) => (
            <Probe key={JSON.stringify(k)} k={k} />
          ))}
        </>
      );
    }
    render(
      <QueryClientProvider client={qc}>
        <Shell />
      </QueryClientProvider>,
    );
    const count = (k: QueryKey) => fetches.get(JSON.stringify(k)) ?? 0;
    return { qc, count };
  }

  it('one burst of a dataset\'s events → one refetch of what reads it, after the debounce; nothing else', async () => {
    const tile = KEYS['analysis:tile'][0];
    const otherTile = KEYS['analysis:tile'][1];
    const editor: QueryKey = ['analysis:open', P, 'a1'];
    const { count } = setup([tile, otherTile, editor]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect([count(tile), count(otherTile), count(editor)]).toEqual([1, 1, 1]);
    const es = FakeSource.all[0]!;
    es.open();
    act(() => {
      es.emit(REFRESHED_CHANNEL, { projectId: P, datasetId: D, name: 'Orders', ok: true, rowsBefore: 1, rowsAfter: 3 });
      es.emit(REFRESHED_CHANNEL, { projectId: P, datasetId: D, name: 'Orders', ok: true, rowsBefore: 3, rowsAfter: 4 });
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)));
    expect(count(tile)).toBe(1); // still inside the window
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    expect([count(tile), count(otherTile), count(editor)]).toEqual([2, 1, 1]);
  });

  it('a success and a failure in one window: the success wins', async () => {
    const tile = KEYS['analysis:tile'][0];
    const { count } = setup([tile]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const es = FakeSource.all[0]!;
    es.open();
    act(() => {
      es.emit(REFRESHED_CHANNEL, { projectId: P, datasetId: D, ok: true });
      es.emit(REFRESHED_CHANNEL, { projectId: P, datasetId: D, ok: false, error: 'boom' });
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)));
    expect(count(tile)).toBe(2);
  });

  it('a reconnect (events lost meanwhile) re-reads every figure on screen — and not the editor\'s document', async () => {
    const tile = KEYS['analysis:tile'][0];
    const otherTile = KEYS['analysis:tile'][1];
    const list = KEYS['dataset:list'][1];
    const editor: QueryKey = ['analysis:open', P, 'a1'];
    const { count } = setup([tile, otherTile, list, editor]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const first = FakeSource.all[0]!;
    first.open();
    first.open(); // the browser reconnected by itself: onopen again
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect([count(tile), count(otherTile), count(list), count(editor)]).toEqual([2, 2, 2, 1]);
  });
});
