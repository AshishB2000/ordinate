import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Combobox } from './Combobox';

const OPTS = [
  { value: 'orders', label: 'Orders' },
  { value: 'order_items', label: 'Order items' },
  { value: 'customers', label: 'Customers' },
];

function setup(value: string | null = null) {
  const onValueChange = vi.fn();
  render(<Combobox label="Dataset" value={value} onValueChange={onValueChange} options={OPTS} emptyText="No match" />);
  const input = screen.getByRole('combobox', { name: 'Dataset' });
  input.focus();
  return { input: input as HTMLInputElement, onValueChange };
}

describe('Combobox', () => {
  it('typing filters the list; ↓ + Enter picks; the field shows the pick', () => {
    const { input, onValueChange } = setup();
    fireEvent.change(input, { target: { value: 'ord' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Orders', 'Order items']);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const id = input.getAttribute('aria-activedescendant');
    expect(id && document.getElementById(id)?.textContent).toBe('Order items');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('order_items');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('says so when nothing matches', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByRole('listbox').textContent).toBe('No match');
  });

  it('Escape closes and puts the selected label back', () => {
    const { input, onValueChange } = setup('customers');
    expect(input.value).toBe('Customers');
    fireEvent.change(input, { target: { value: 'Cu' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('Customers');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('opens on ArrowDown with the current value active', () => {
    const { input } = setup('customers');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const id = input.getAttribute('aria-activedescendant');
    expect(id && document.getElementById(id)?.textContent).toBe('Customers');
  });
});
