import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { IconButton } from './Button';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('shows on keyboard focus and describes its trigger', () => {
    render(
      <Tooltip content="Refresh from the source">
        <IconButton icon="refresh" label="Refresh" />
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Refresh' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => trigger.focus());
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Refresh from the source');
    expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('Escape hides it; focus stays on the trigger', () => {
    render(
      <Tooltip content="Star">
        <IconButton icon="star" label="Star" />
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Star' });
    act(() => trigger.focus());
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
