// The rows a DataGrid has in hand: blocks of PAGE_ROWS fetched from the
// server as the viewport reaches them (legacy dsVirtual.ts, same block size).
//
//   - `want(first, last)` says what is on screen. Missing blocks covering it
//     (plus MARGIN rows either side, so a steady scroll finds the next block
//     already there) are fetched NEAREST FIRST, at most MAX_INFLIGHT at once —
//     so dragging the scrollbar across a million rows asks for what is under
//     the thumb when a slot frees, not for every block it passed.
//   - At most MAX_BLOCKS are kept; the ones farthest from the viewport go.
//   - `dispose()` (a new query, an unmount) bumps the generation: a reply that
//     comes back for an older one is dropped, never painted.
//
// The cache never computes a cell — it holds what the server returned.

export type Cell = string | number | null;

export interface PageResult {
  rows: Cell[][];
  /** Rows in the whole (searched / filtered) result. */
  total: number;
}

/** One window of rows. Rejects with an Error the grid shows. */
export type FetchPage = (offset: number, limit: number) => Promise<PageResult>;

export const PAGE_ROWS = 500;
/** 20 blocks = 10,000 rows ≈ 20 screens either way; a few MB at most. */
export const MAX_BLOCKS = 20;
export const MAX_INFLIGHT = 2;
const MARGIN = 200;

export class PageCache {
  /** Unknown until the first block lands. */
  total: number | null = null;
  /** A block failed with nothing in hand yet: the grid shows the error state. */
  error: Error | null = null;
  /** Some later block failed: the grid offers a retry. */
  failed = new Map<number, Error>();
  /** Page requests started, for the e2e's RPC count and for tests. */
  requests = 0;

  private blocks = new Map<number, Cell[][]>();
  private inflight = new Set<number>();
  private wanted: number[] = [];
  private center = 0;
  private gen = 0;
  private readonly fetchPage: FetchPage;
  private readonly onChange: () => void;

  /** `total`: a row count to assume until the first block says (the previous query's). */
  constructor(fetchPage: FetchPage, onChange: () => void, total: number | null = null) {
    this.fetchPage = fetchPage;
    this.onChange = onChange;
    this.total = total;
  }

  /** Row `i`, or undefined while its block is not in hand. */
  row(i: number): Cell[] | undefined {
    return this.blocks.get(Math.floor(i / PAGE_ROWS))?.[i % PAGE_ROWS];
  }

  has(i: number): boolean {
    return this.blocks.has(Math.floor(i / PAGE_ROWS));
  }

  /** Rows first..last (inclusive) are on screen: fetch what is missing. */
  want(first: number, last: number): void {
    const max = this.total === null ? first + PAGE_ROWS - 1 : this.total - 1;
    const lo = Math.max(0, first - MARGIN);
    const hi = Math.min(Math.max(lo, max), last + MARGIN);
    const b0 = Math.floor(lo / PAGE_ROWS);
    const b1 = Math.floor(hi / PAGE_ROWS);
    this.center = (first + last) / 2 / PAGE_ROWS;
    const list: number[] = [];
    for (let b = b0; b <= b1; b++) list.push(b);
    this.wanted = list.sort((a, b) => Math.abs(a + 0.5 - this.center) - Math.abs(b + 0.5 - this.center));
    this.pump();
  }

  /** Forget the failures and fetch again. */
  retry(): void {
    this.failed.clear();
    this.error = null;
    this.onChange();
    this.pump();
  }

  /** This cache is done (new query, unmount): late replies are dropped. */
  dispose(): void {
    this.gen++;
    this.inflight.clear();
  }

  private pump(): void {
    for (const b of this.wanted) {
      if (this.inflight.size >= MAX_INFLIGHT) return;
      if (this.blocks.has(b) || this.inflight.has(b) || this.failed.has(b) || this.error) continue;
      void this.load(b);
    }
  }

  private async load(b: number): Promise<void> {
    const gen = this.gen;
    this.inflight.add(b);
    this.requests++;
    let res: PageResult;
    try {
      res = await this.fetchPage(b * PAGE_ROWS, PAGE_ROWS);
    } catch (err) {
      if (gen !== this.gen) return;
      this.inflight.delete(b);
      const e = err instanceof Error ? err : new Error(String(err));
      if (this.total === null || this.blocks.size === 0) this.error = e;
      else this.failed.set(b, e);
      this.onChange();
      return;
    }
    if (gen !== this.gen) return; // a stale reply: the query moved on
    this.inflight.delete(b);
    this.blocks.set(b, res.rows);
    this.total = res.total;
    this.evict();
    this.onChange();
    this.pump();
  }

  private evict(): void {
    if (this.blocks.size <= MAX_BLOCKS) return;
    const keep = new Set(this.wanted);
    const far = [...this.blocks.keys()]
      .filter((b) => !keep.has(b))
      .sort((a, b) => Math.abs(b - this.center) - Math.abs(a - this.center));
    for (const b of far) {
      if (this.blocks.size <= MAX_BLOCKS) return;
      this.blocks.delete(b);
    }
  }
}
