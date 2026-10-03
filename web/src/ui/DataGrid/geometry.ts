// The DataGrid's arithmetic: the compressed scroll space and the keyboard.
// Pure — no DOM, no React — so both are unit-tested directly.

/**
 * The tallest scroll space the grid asks the browser for. Firefox clamps an
 * element's height near 17.9 M px, Chromium near 33.5 M (its LayoutUnit); a
 * million 28 px rows is 28 M, past which the bottom of the table cannot be
 * scrolled to. (T1.4 measured Chromium 151 still reaching row 999,999 with this
 * cap lifted — the compression is for Firefox, and for Chromium past ~1.2 M.)
 * Above this the scroll space COMPRESSES: one real pixel stands for `ratio`
 * virtual ones, while the rows drawn keep their real height (legacy
 * dsVirtual.ts, same cap).
 */
export const MAX_SCROLL_PX = 8_000_000;

/**
 * Virtual offset per real scroll pixel. Mapped over the SCROLLABLE range
 * (total minus the viewport), so the last real scrollTop shows the last row
 * exactly — not a row short, not past the end.
 */
export function scrollRatio(virtualTotal: number, viewport: number): number {
  const real = Math.min(virtualTotal, MAX_SCROLL_PX);
  if (virtualTotal <= MAX_SCROLL_PX || real <= viewport) return 1;
  return (virtualTotal - viewport) / (real - viewport);
}

/** Where a row's content sits in the real scroll box (rows are drawn at real height around the viewport). */
export function realTop(virtualStart: number, virtualOffset: number, ratio: number): number {
  return virtualStart - virtualOffset + virtualOffset / ratio;
}

/**
 * The real scrollTop that brings the row spanning [top, top + size) (virtual
 * px) fully into view under a sticky header of `head` px, or null if it
 * already is.
 */
export function scrollTopFor(
  top: number,
  size: number,
  virtualOffset: number,
  viewport: number,
  head: number,
  ratio: number,
): number | null {
  // Rounded AWAY from the row: the browser keeps whole scroll pixels, and one
  // real pixel is `ratio` virtual ones once the space is compressed.
  if (top < virtualOffset + head) return Math.max(0, Math.floor((top - head) / ratio));
  if (top + size > virtualOffset + viewport) return Math.ceil((top + size - viewport) / ratio);
  return null;
}

/** The active cell. `row` -1 is the header row. */
export interface Pos {
  row: number;
  col: number;
}

export interface KeyInput {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * Where a key moves the active cell, or null when the key is not the grid's
 * (Tab leaves the grid like any control; Cmd/Ctrl+C etc. belong to the page).
 * `page` is the number of rows one screen holds.
 */
export function move(p: Pos, k: KeyInput, rows: number, cols: number, page: number): Pos | null {
  if (k.alt || cols === 0) return null;
  const lastRow = rows - 1;
  const lastCol = cols - 1;
  const clamp = (row: number, col: number): Pos => ({
    row: Math.max(-1, Math.min(lastRow, row)),
    col: Math.max(0, Math.min(lastCol, col)),
  });
  if (k.ctrl) {
    switch (k.key) {
      case 'Home':
        return clamp(0, 0);
      case 'End':
        return clamp(lastRow, lastCol);
      case 'ArrowUp':
        return clamp(0, p.col);
      case 'ArrowDown':
        return clamp(lastRow, p.col);
      case 'ArrowLeft':
        return clamp(p.row, 0);
      case 'ArrowRight':
        return clamp(p.row, lastCol);
      default:
        return null;
    }
  }
  if (k.shift) return null; // Shift+Arrow resizes a column from the header (DataGrid.tsx)
  switch (k.key) {
    case 'ArrowUp':
      return clamp(p.row - 1, p.col);
    case 'ArrowDown':
      return clamp(p.row + 1, p.col);
    case 'ArrowLeft':
      return clamp(p.row, p.col - 1);
    case 'ArrowRight':
      return clamp(p.row, p.col + 1);
    case 'Home':
      return clamp(p.row, 0);
    case 'End':
      return clamp(p.row, lastCol);
    case 'PageUp':
      return clamp(Math.max(p.row - page, Math.min(p.row, 0)), p.col);
    case 'PageDown':
      return clamp(p.row + page, p.col);
    default:
      return null;
  }
}
