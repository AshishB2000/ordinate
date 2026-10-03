import { describe, expect, it, vi } from 'vitest';
import { MAX_BLOCKS, MAX_INFLIGHT, PAGE_ROWS, PageCache, type Cell, type PageResult } from './pageCache';

const TOTAL = 1_000_000;

/** A fake server: every request is held until the test settles it. */
function server() {
  const calls: { offset: number; limit: number; resolve(): void; reject(e: Error): void }[] = [];
  const fetch = (offset: number, limit: number) =>
    new Promise<PageResult>((res, rej) => {
      const rows: Cell[][] = Array.from({ length: Math.min(limit, TOTAL - offset) }, (_, k) => [offset + k]);
      calls.push({ offset, limit, resolve: () => res({ rows, total: TOTAL }), reject: rej });
    });
  const settle = async () => {
    // Resolve everything in flight, including what each resolution starts.
    for (let guard = 0; guard < 100; guard++) {
      const open = calls.filter((c) => !('done' in c));
      if (!open.length) return;
      for (const c of open) {
        Object.assign(c, { done: true });
        c.resolve();
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { calls, fetch, settle };
}

describe('PageCache', () => {
  it('fetches the first block, learns the total, and serves rows by index', async () => {
    const srv = server();
    const changed = vi.fn();
    const c = new PageCache(srv.fetch, changed);
    c.want(0, 20);
    expect(srv.calls.map((x) => [x.offset, x.limit])).toEqual([[0, PAGE_ROWS]]);
    expect(c.total).toBeNull();
    await srv.settle();
    expect(c.total).toBe(TOTAL);
    expect(c.row(0)).toEqual([0]);
    expect(c.row(499)).toEqual([499]);
    expect(c.row(500)).toBeUndefined();
    expect(changed).toHaveBeenCalled();
  });

  it('asks for the blocks around the viewport nearest first, at most MAX_INFLIGHT at once', async () => {
    const srv = server();
    const c = new PageCache(srv.fetch, () => {});
    c.want(0, 20);
    await srv.settle();
    srv.calls.length = 0;
    c.want(1470, 1500); // block 2 on screen, block 3 within the margin
    expect(srv.calls.length).toBe(MAX_INFLIGHT);
    expect(srv.calls.map((x) => x.offset)).toEqual([1000, 1500]);
    await srv.settle();
    for (let i = 1470; i <= 1500; i++) expect(c.row(i)).toEqual([i]);
    srv.calls.length = 0;
    c.want(5_000, 6_400); // blocks 9..13 with the margin: the two nearest the middle now, the rest as slots free
    expect(srv.calls.map((x) => x.offset)).toEqual([5_500, 5_000]);
    await srv.settle();
    expect(srv.calls.map((x) => x.offset)).toEqual([5_500, 5_000, 6_000, 4_500, 6_500]);
  });

  it('a scrollbar drag across the table costs requests for where it stops, not for every block it passed', async () => {
    const srv = server();
    const c = new PageCache(srv.fetch, () => {});
    c.want(0, 20);
    await srv.settle();
    srv.calls.length = 0;
    for (let row = 0; row < TOTAL; row += 2_500) c.want(row, row + 25); // 400 positions while nothing returns
    expect(srv.calls.length).toBe(MAX_INFLIGHT);
    await srv.settle();
    // The two early blocks, then only what the last position needs.
    expect(srv.calls.length).toBeLessThanOrEqual(MAX_INFLIGHT + 2);
    expect(c.row(TOTAL - 2_500 + 10)).toEqual([TOTAL - 2_500 + 10]);
  });

  it('drops a reply that comes back after dispose() (a new query)', async () => {
    const srv = server();
    const changed = vi.fn();
    const c = new PageCache(srv.fetch, changed);
    c.want(0, 20);
    c.dispose();
    await srv.settle();
    expect(c.total).toBeNull();
    expect(c.row(0)).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps at most MAX_BLOCKS, never one on screen', async () => {
    const srv = server();
    const c = new PageCache(srv.fetch, () => {});
    for (let b = 0; b < MAX_BLOCKS * 3; b++) {
      c.want(b * PAGE_ROWS + 250, b * PAGE_ROWS + 260);
      await srv.settle();
    }
    const last = (MAX_BLOCKS * 3 - 1) * PAGE_ROWS + 255;
    expect(c.row(last)).toEqual([last]);
    let held = 0;
    for (let b = 0; b < MAX_BLOCKS * 3; b++) if (c.has(b * PAGE_ROWS)) held++;
    expect(held).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(c.has(0)).toBe(false); // the farthest went first
  });

  it('a failed first block is the error state; retry fetches again', async () => {
    let fail = true;
    let n = 0;
    const c = new PageCache(async (offset) => {
      n++;
      if (fail) throw new Error('boom');
      return { rows: [[offset]], total: 1 };
    }, () => {});
    c.want(0, 0);
    await vi.waitFor(() => expect(c.error?.message).toBe('boom'));
    c.want(0, 0);
    expect(n).toBe(1); // no retry storm while the error stands
    fail = false;
    c.retry();
    await vi.waitFor(() => expect(c.total).toBe(1));
    expect(c.error).toBeNull();
    expect(n).toBe(2);
  });

  it('a failed later block is marked failed (no skeleton forever) and retried on demand', async () => {
    const srv = server();
    const c = new PageCache(srv.fetch, () => {});
    c.want(0, 20);
    await srv.settle();
    srv.calls.length = 0;
    c.want(5_000, 5_020);
    srv.calls[0]!.reject(new Error('timeout'));
    await vi.waitFor(() => expect(c.failed.size).toBe(1));
    expect(c.error).toBeNull();
    c.retry();
    await srv.settle();
    expect(c.failed.size).toBe(0);
    expect(c.row(5_010)).toEqual([5_010]);
  });
});
