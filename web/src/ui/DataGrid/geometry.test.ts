import { describe, expect, it } from 'vitest';
import { MAX_SCROLL_PX, move, realTop, scrollRatio, scrollTopFor, type KeyInput, type Pos } from './geometry';

const ROW = 28;
const HEAD = 34;
const VIEW = 600;

describe('compressed scroll space', () => {
  it('is 1:1 while the table fits under the cap', () => {
    expect(scrollRatio(HEAD + 100_000 * ROW, VIEW)).toBe(1);
    expect(realTop(HEAD + 500 * ROW, 500 * ROW, 1)).toBe(HEAD + 500 * ROW);
  });

  it('maps the last real scrollTop to exactly the last row at 1,000,000 rows', () => {
    const total = HEAD + 1_000_000 * ROW;
    const r = scrollRatio(total, VIEW);
    expect(r).toBeGreaterThan(3);
    const maxReal = MAX_SCROLL_PX - VIEW;
    expect(maxReal * r).toBeCloseTo(total - VIEW, 6); // the virtual offset that shows the last row's bottom
  });

  it('draws rows at real height around the viewport', () => {
    const r = 3.5;
    const v = 1_000_000; // virtual offset
    // A row starting exactly at the virtual offset sits at the real scrollTop.
    expect(realTop(v, v, r)).toBeCloseTo(v / r, 9);
    // The next row is one real row height further down, not ROW / r.
    expect(realTop(v + ROW, v, r) - realTop(v, v, r)).toBeCloseTo(ROW, 9);
  });

  it('scrolls a row into view under the sticky header, rounding away from it', () => {
    const r = 3.5;
    const v = 10_000;
    // Above the view: its top goes just under the header.
    const up = scrollTopFor(5_000, ROW, v, VIEW, HEAD, r)!;
    expect(up * r).toBeLessThanOrEqual(5_000 - HEAD);
    // Below: its bottom goes to the bottom edge.
    const down = scrollTopFor(20_000, ROW, v, VIEW, HEAD, r)!;
    expect(down * r).toBeGreaterThanOrEqual(20_000 + ROW - VIEW);
    // Already in view: nothing.
    expect(scrollTopFor(v + HEAD + ROW, ROW, v, VIEW, HEAD, r)).toBeNull();
    expect(scrollTopFor(HEAD, ROW, 0, VIEW, HEAD, 1)).toBeNull();
  });
});

describe('keyboard', () => {
  const k = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key, ctrl: false, shift: false, alt: false, ...mods });
  const at: Pos = { row: 5, col: 1 };
  const go = (p: Pos, key: KeyInput) => move(p, key, 100, 3, 20);

  it('moves one cell with the arrows and stops at the edges', () => {
    expect(go(at, k('ArrowDown'))).toEqual({ row: 6, col: 1 });
    expect(go(at, k('ArrowRight'))).toEqual({ row: 5, col: 2 });
    expect(go({ row: 99, col: 2 }, k('ArrowDown'))).toEqual({ row: 99, col: 2 });
    expect(go({ row: 0, col: 0 }, k('ArrowLeft'))).toEqual({ row: 0, col: 0 });
  });

  it('ArrowUp from the first row reaches the header (row -1), and no further', () => {
    expect(go({ row: 0, col: 1 }, k('ArrowUp'))).toEqual({ row: -1, col: 1 });
    expect(go({ row: -1, col: 1 }, k('ArrowUp'))).toEqual({ row: -1, col: 1 });
    expect(go({ row: -1, col: 1 }, k('ArrowDown'))).toEqual({ row: 0, col: 1 });
  });

  it('Home/End within the row, Ctrl+Home/End and Ctrl+arrows to the table edges', () => {
    expect(go(at, k('Home'))).toEqual({ row: 5, col: 0 });
    expect(go(at, k('End'))).toEqual({ row: 5, col: 2 });
    expect(go(at, k('Home', { ctrl: true }))).toEqual({ row: 0, col: 0 });
    expect(go(at, k('End', { ctrl: true }))).toEqual({ row: 99, col: 2 });
    expect(go(at, k('ArrowDown', { ctrl: true }))).toEqual({ row: 99, col: 1 });
    expect(go(at, k('ArrowUp', { ctrl: true }))).toEqual({ row: 0, col: 1 });
  });

  it('PageUp/PageDown move a screen, PageUp stops at the first row', () => {
    expect(go(at, k('PageDown'))).toEqual({ row: 25, col: 1 });
    expect(go({ row: 90, col: 1 }, k('PageDown'))).toEqual({ row: 99, col: 1 });
    expect(go(at, k('PageUp'))).toEqual({ row: 0, col: 1 });
  });

  it('leaves Tab, Alt and Shift chords (and letters) to someone else', () => {
    expect(go(at, k('Tab'))).toBeNull();
    expect(go(at, k('ArrowDown', { alt: true }))).toBeNull();
    expect(go(at, k('ArrowRight', { shift: true }))).toBeNull();
    expect(go(at, k('a'))).toBeNull();
    expect(move(at, k('ArrowDown'), 100, 0, 20)).toBeNull(); // no columns
  });
});
