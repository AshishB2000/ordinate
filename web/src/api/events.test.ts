import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from '../../../src/server/wire.ts';
import { CLIENT_ID } from './client';
import { onReconnect, resetEventsForTest, subscribe } from './events';

/** A stand-in EventSource: records its url and listeners, and lets the test drive it. */
class FakeSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly handlers = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(ch: string, fn: (e: { data: string }) => void) {
    this.handlers.set(ch, [...(this.handlers.get(ch) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeSource.CLOSED;
  }
  open() {
    this.readyState = FakeSource.OPEN;
    this.onopen?.();
  }
  emit(ch: string, payload: unknown) {
    for (const fn of this.handlers.get(ch) ?? []) fn({ data: encode(payload) });
  }
  fail(closed: boolean) {
    this.readyState = closed ? FakeSource.CLOSED : FakeSource.CONNECTING;
    this.onerror?.();
  }
}

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

describe('server events', () => {
  it('opens one stream, named by this tab, on the first listener', () => {
    subscribe('jobs:changed', () => {});
    subscribe('jobs:finished', () => {});
    expect(FakeSource.all.length).toBe(1);
    expect(FakeSource.all[0]!.url).toBe(`/api/events?client=${CLIENT_ID}`);
  });

  it('delivers wire-decoded payloads to the channel listeners only, until unsubscribed', () => {
    const got: unknown[] = [];
    const other: unknown[] = [];
    const off = subscribe('jobs:changed', (p) => got.push(p));
    subscribe('jobs:finished', (p) => other.push(p));
    const es = FakeSource.all[0]!;
    es.open();
    es.emit('jobs:changed', { progress: Number.NaN });
    expect(Object.is((got[0] as { progress: number }).progress, Number.NaN)).toBe(true);
    expect(other).toEqual([]);
    off();
    es.emit('jobs:changed', { progress: 1 });
    expect(got.length).toBe(1);
  });

  it('leaves a retrying connection to the browser, reopens a closed one with backoff, and says so', () => {
    const got: unknown[] = [];
    let reconnects = 0;
    subscribe('jobs:finished', (p) => got.push(p));
    onReconnect(() => reconnects++);
    const first = FakeSource.all[0]!;
    first.open();
    first.fail(false); // the browser is retrying by itself
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all.length).toBe(1);

    first.fail(true); // gave up (an HTTP error)
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(FakeSource.all.length).toBe(1);
    vi.advanceTimersByTime(1);
    const second = FakeSource.all[1]!;
    second.fail(true); // fails again: the next wait doubles
    vi.advanceTimersByTime(1999);
    expect(FakeSource.all.length).toBe(2);
    vi.advanceTimersByTime(1);
    const third = FakeSource.all[2]!;
    third.open();
    expect(reconnects).toBe(1);
    third.emit('jobs:finished', { id: 'j' });
    expect(got).toEqual([{ id: 'j' }]);
  });
});
