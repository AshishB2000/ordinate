import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Button } from './Button';
import { DialogClose } from './Dialog';
import { Sheet } from './Sheet';
import { SWIPE_CLOSE_PX } from './useSwipeDown';

function SheetUnderTest({ onChange }: { onChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open filters
      </button>
      <Sheet
        open={open}
        onOpenChange={(o) => {
          onChange(o);
          setOpen(o);
        }}
        title="Filters"
        description="2 on this page"
        footer={
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        }
      >
        <label>
          Region <input />
        </label>
      </Sheet>
    </>
  );
}

const grabOf = (dialog: HTMLElement) => dialog.firstElementChild as HTMLElement;

describe('Sheet', () => {
  it('is a named, described modal dialog with focus inside, a handle and its footer', () => {
    render(<SheetUnderTest onChange={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    const desc = dialog.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('2 on this page');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('Escape closes it', () => {
    const changes: boolean[] = [];
    render(<SheetUnderTest onChange={(o) => changes.push(o)} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(changes).toEqual([false]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Done (a DialogClose in the footer) closes it', () => {
    const onChange = vi.fn();
    render(<SheetUnderTest onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('a swipe down past the threshold closes it', () => {
    const onChange = vi.fn();
    render(<SheetUnderTest onChange={onChange} />);
    const grab = grabOf(screen.getByRole('dialog'));
    fireEvent.pointerDown(grab, { clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(grab, { clientY: 300 + SWIPE_CLOSE_PX + 10, pointerId: 1 });
    fireEvent.pointerUp(grab, { clientY: 300 + SWIPE_CLOSE_PX + 10, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('a short drag springs back: the sheet stays, its transform cleared', () => {
    const onChange = vi.fn();
    render(<SheetUnderTest onChange={onChange} />);
    const dialog = screen.getByRole('dialog');
    const grab = grabOf(dialog);
    fireEvent.pointerDown(grab, { clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(grab, { clientY: 318, pointerId: 1 });
    expect(dialog.style.transform).toBe('translateY(18px)');
    fireEvent.pointerUp(grab, { clientY: 318, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog.style.transform).toBe('');
  });

  it('a press on the Close button in the grab zone is the button’s, not a drag', () => {
    const onChange = vi.fn();
    render(<SheetUnderTest onChange={onChange} />);
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' });
    fireEvent.pointerDown(close, { clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(grabOf(dialog), { clientY: 500, pointerId: 1 });
    expect(dialog.style.transform).toBe('');
  });
});
