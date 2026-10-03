import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { nextEnabled, Select, type SelectOption } from './Select';

const OPTS: SelectOption[] = [
  { value: 'csv', label: 'CSV file' },
  { value: 'pg', label: 'PostgreSQL' },
  { value: 'sheets', label: 'Google Sheets', disabled: true },
  { value: 'url', label: 'URL' },
];

function setup(value: string | null = 'csv', extra: Partial<Parameters<typeof Select>[0]> = {}) {
  const onValueChange = vi.fn();
  render(<Select label="Source" value={value} onValueChange={onValueChange} options={OPTS} {...extra} />);
  const trigger = screen.getByRole('combobox', { name: 'Source' });
  trigger.focus();
  return { trigger, onValueChange };
}

const active = (trigger: HTMLElement) => {
  const id = trigger.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : null;
};

describe('Select', () => {
  it('shows the selected label, or the placeholder', () => {
    setup('pg');
    expect(screen.getByRole('combobox', { name: 'Source' }).textContent).toBe('PostgreSQL');
  });

  it('opens on ArrowDown at the selected option; arrows skip disabled; Enter picks; focus never leaves', () => {
    const { trigger, onValueChange } = setup('pg');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox', { name: 'Source' });
    expect(trigger.getAttribute('aria-controls')).toBe(list.id);
    expect(active(trigger)).toBe('PostgreSQL');
    expect(screen.getByRole('option', { name: 'PostgreSQL' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // skips the disabled Google Sheets
    expect(active(trigger)).toBe('URL');
    fireEvent.keyDown(trigger, { key: 'Home' });
    expect(active(trigger)).toBe('CSV file');
    fireEvent.keyDown(trigger, { key: 'End' });
    expect(active(trigger)).toBe('URL');

    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('url');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes without changing the value', () => {
    const { trigger, onValueChange } = setup();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click on an option picks it; a click on a disabled one does nothing', () => {
    const { trigger, onValueChange } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Google Sheets' }));
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'URL' }));
    expect(onValueChange).toHaveBeenCalledWith('url');
  });

  it('typeahead picks by prefix while closed, like a native select', () => {
    const { trigger, onValueChange } = setup();
    fireEvent.keyDown(trigger, { key: 'p' });
    expect(onValueChange).toHaveBeenCalledWith('pg');
  });

  it('disabled: does not open; error: invalid and described', () => {
    const { trigger } = setup('csv', { disabled: true, error: 'Choose one.' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    const desc = trigger.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('Choose one.');
  });

  it('nextEnabled walks past disabled options and stops at the ends', () => {
    expect(nextEnabled(OPTS, 1, 1)).toBe(3);
    expect(nextEnabled(OPTS, 3, -1)).toBe(1);
    expect(nextEnabled(OPTS, 3, 1)).toBe(3);
    expect(nextEnabled(OPTS, -1, 1)).toBe(0);
  });
});
