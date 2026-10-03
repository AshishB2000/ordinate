import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IconButton } from './Button';
import { ContextMenu, Menu, type MenuEntry } from './Menu';

function entries(onRename = vi.fn(), onSort = vi.fn()): MenuEntry[] {
  return [
    { label: 'Rename', icon: 'pencil', shortcut: 'F2', onSelect: onRename },
    { label: 'Export', disabled: true, onSelect: vi.fn() },
    { label: 'Duplicate', onSelect: vi.fn() },
    { kind: 'separator' },
    { kind: 'heading', label: 'Sort by' },
    {
      kind: 'radio',
      label: 'Sort by',
      value: 'name',
      options: [
        { value: 'name', label: 'Name' },
        { value: 'date', label: 'Date' },
      ],
      onChange: onSort,
    },
    { label: 'Delete', danger: true, onSelect: vi.fn() },
  ];
}

function openMenu(items = entries()) {
  render(<Menu trigger={<IconButton icon="more-horizontal" label="Actions" />} items={items} />);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return trigger;
}

describe('Menu', () => {
  it('opens from the keyboard with focus on the first item; the trigger says so', () => {
    const trigger = openMenu();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu');
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toContain('Rename');
    expect(screen.getByRole('menuitem', { name: /Export/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'Name' }).getAttribute('aria-checked')).toBe('true');
  });

  it('arrow keys move through the items, skipping disabled ones', async () => {
    openMenu();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Duplicate'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Rename'));
  });

  it('Enter runs the item, closes, and returns focus to the trigger', async () => {
    const onRename = vi.fn();
    const trigger = openMenu(entries(onRename));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('a radio item reports its value', () => {
    const onSort = vi.fn();
    openMenu(entries(vi.fn(), onSort));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Date' }));
    expect(onSort).toHaveBeenCalledWith('date');
  });

  it('Escape closes and returns focus to the trigger', async () => {
    const trigger = openMenu();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('keeps focus inside while open (Tab does not leave)', () => {
    openMenu();
    const menu = screen.getByRole('menu');
    const ev = fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(ev).toBe(false); // default prevented: the browser does not move focus out
    expect(menu.contains(document.activeElement)).toBe(true);
  });
});

describe('ContextMenu', () => {
  it('opens on right-click with the same items, and runs one', () => {
    const onRename = vi.fn();
    render(
      <ContextMenu items={entries(onRename)} label="Card actions">
        <div tabIndex={0}>Card</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Card'));
    expect(screen.getByRole('menu', { name: 'Card actions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes it', () => {
    render(
      <ContextMenu items={entries()}>
        <div tabIndex={0}>Card</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Card'));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
