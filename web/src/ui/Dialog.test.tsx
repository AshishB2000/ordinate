import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button } from './Button';
import { Dialog, DialogClose, Drawer } from './Dialog';
import { Input } from './Field';

function DialogUnderTest() {
  return (
    <>
      <button type="button">Behind</button>
      <Dialog
        trigger={<Button>Delete…</Button>}
        title="Delete dashboard?"
        description="It moves to the trash."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant="danger">Delete</Button>
          </>
        }
      >
        <Input label="Type the name" />
      </Dialog>
    </>
  );
}

const tab = (shift = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift });

describe('Dialog', () => {
  it('opens named and described, with focus moved inside', () => {
    render(<DialogUnderTest />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete dashboard?' });
    const desc = dialog.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('It moves to the trash.');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('traps focus: Tab from the last control wraps to the first, Shift+Tab back', () => {
    render(<DialogUnderTest />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' }); // first tabbable
    const last = screen.getByRole('button', { name: 'Delete' });
    act(() => last.focus());
    tab();
    expect(document.activeElement).toBe(close);
    tab(true);
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Escape closes it and focus returns to the trigger', async () => {
    render(<DialogUnderTest />);
    const trigger = screen.getByRole('button', { name: 'Delete…' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('a DialogClose button closes it', () => {
    render(<DialogUnderTest />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides the page behind it from assistive tech while open', () => {
    render(<DialogUnderTest />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(screen.queryByRole('button', { name: 'Behind' })).toBeNull(); // aria-hidden
  });

  it('without a description, drops the describedby reference', () => {
    render(<Dialog open title="Rename" onOpenChange={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Rename' }).getAttribute('aria-describedby')).toBeNull();
  });
});

describe('Drawer', () => {
  it('is a modal dialog with focus inside; the ✕ closes it and focus returns', async () => {
    render(
      <Drawer trigger={<Button>History</Button>} title="Version history" description="Dashboard · 14 versions">
        <Input label="Find a version" />
      </Drawer>,
    );
    const trigger = screen.getByRole('button', { name: 'History' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Version history' });
    expect(sheet.contains(document.activeElement)).toBe(true);
    const field = screen.getByRole('textbox', { name: 'Find a version' });
    act(() => field.focus());
    tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
