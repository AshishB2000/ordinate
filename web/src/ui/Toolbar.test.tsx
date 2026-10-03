import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Toolbar, ToolbarDivider, ToolbarSpacer } from './Toolbar';

function setup() {
  render(
    <Toolbar label="Dataset actions">
      <button type="button">Add</button>
      <button type="button" disabled>
        Undo
      </button>
      <input aria-label="Filter" />
      <ToolbarDivider />
      <ToolbarSpacer />
      <button type="button">Export</button>
    </Toolbar>,
  );
}

const focusOn = (name: string) => act(() => screen.getByRole('button', { name }).focus());

describe('Toolbar', () => {
  it('is a named toolbar', () => {
    setup();
    expect(screen.getByRole('toolbar', { name: 'Dataset actions' })).toBeTruthy();
  });

  it('→/← move focus between controls, skipping disabled, wrapping at the ends', () => {
    setup();
    focusOn('Add');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter' }));
    focusOn('Export');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Export' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add' }));
  });

  it('leaves arrow keys to a text field inside it', () => {
    setup();
    const input = screen.getByRole('textbox', { name: 'Filter' });
    act(() => input.focus());
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(input);
  });
});
