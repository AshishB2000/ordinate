import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Splitter, useStoredSize } from './Splitter';

function Harness({ pane, onCommit }: { pane: 'before' | 'after'; onCommit?: (n: number) => void }) {
  const [size, setSize] = useState(300);
  return <Splitter size={size} min={200} max={400} pane={pane} label="Resize" onSizeChange={setSize} onCommit={onCommit} />;
}

const now = () => Number(screen.getByRole('separator', { name: 'Resize' }).getAttribute('aria-valuenow'));

describe('Splitter', () => {
  it('is a focusable vertical separator with its range', () => {
    render(<Harness pane="before" />);
    const h = screen.getByRole('separator', { name: 'Resize' });
    expect(h.getAttribute('aria-orientation')).toBe('vertical');
    expect([h.getAttribute('aria-valuemin'), h.getAttribute('aria-valuemax'), now()]).toEqual(['200', '400', 300]);
    h.focus();
    expect(document.activeElement).toBe(h);
  });

  it('arrows step 16px in the pane’s direction, clamped; Home/End jump; commit on key up', () => {
    const onCommit = vi.fn();
    render(<Harness pane="before" onCommit={onCommit} />);
    const h = screen.getByRole('separator');
    fireEvent.keyDown(h, { key: 'ArrowRight' });
    expect(now()).toBe(316);
    fireEvent.keyUp(h, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(h, { key: 'End' });
    expect(now()).toBe(400);
    fireEvent.keyDown(h, { key: 'ArrowRight' });
    expect(now()).toBe(400);
    fireEvent.keyDown(h, { key: 'Home' });
    expect(now()).toBe(200);
  });

  it('a pane AFTER the handle (a right dock) grows on ←', () => {
    render(<Harness pane="after" />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(now()).toBe(316);
  });

  it('drags, clamps, and commits once at the end', () => {
    const onCommit = vi.fn();
    render(<Harness pane="after" onCommit={onCommit} />);
    const h = screen.getByRole('separator');
    fireEvent.pointerDown(h, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 450, pointerId: 1 });
    expect(now()).toBe(350);
    fireEvent.pointerMove(h, { clientX: 100, pointerId: 1 });
    expect(now()).toBe(400);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(h, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(400);
    fireEvent.pointerMove(h, { clientX: 0, pointerId: 1 }); // no longer dragging
    expect(now()).toBe(400);
  });
});

describe('useStoredSize', () => {
  function Stored({ max }: { max: number }) {
    const [size, set, commit] = useStoredSize('test.w', 300, 200, max);
    return (
      <button type="button" onClick={() => (set(360), commit(360))}>
        {size}
      </button>
    );
  }

  it('reads, persists, and clamps to the current bounds on the way out', () => {
    localStorage.setItem('test.w', '900');
    const { rerender } = render(<Stored max={400} />);
    expect(screen.getByRole('button').textContent).toBe('400');
    fireEvent.click(screen.getByRole('button'));
    expect(localStorage.getItem('test.w')).toBe('360');
    rerender(<Stored max={320} />);
    expect(screen.getByRole('button').textContent).toBe('320');
  });

  it('falls back to the initial size when nothing is stored', () => {
    render(<Stored max={400} />);
    expect(screen.getByRole('button').textContent).toBe('300');
  });
});
