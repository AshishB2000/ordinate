import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button } from './Button';
import { Input } from './Field';
import { Popover, PopoverClose } from './Popover';

function setup() {
  render(
    <Popover title="Rename" heading trigger={<Button>Rename</Button>}>
      <Input aria-label="New name" defaultValue="Q3" />
      <PopoverClose asChild>
        <Button>Done</Button>
      </PopoverClose>
    </Popover>,
  );
  const trigger = screen.getByRole('button', { name: 'Rename' });
  act(() => trigger.focus());
  return trigger;
}

describe('Popover', () => {
  it('opens on the trigger, labelled, with focus moved inside', () => {
    const trigger = setup();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('dialog', { name: 'Rename' });
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('heading', { name: 'Rename' })).toBeTruthy();
  });

  it('Escape closes it and focus returns to the trigger', async () => {
    const trigger = setup();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('a PopoverClose control closes it and focus returns', async () => {
    const trigger = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('is not a trap: focus leaving the panel dismisses it', () => {
    const trigger = setup();
    fireEvent.click(trigger);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(screen.queryByRole('dialog')).toBeNull();
    outside.remove();
  });
});
