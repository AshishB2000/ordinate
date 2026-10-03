import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Checkbox, RadioGroup, Switch } from './Choice';

describe('Checkbox', () => {
  it('is a labelled native checkbox that reports the new state', () => {
    const on = vi.fn();
    render(<Checkbox label="Include headers" checked={false} onCheckedChange={on} hint="First row is names." />);
    const box = screen.getByRole('checkbox', { name: 'Include headers' });
    expect(box).toHaveProperty('checked', false);
    const desc = box.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('First row is names.');
    fireEvent.click(screen.getByText('Include headers')); // the label toggles it too
    expect(on).toHaveBeenCalledWith(true);
  });

  it('shows the mixed state through the DOM property', () => {
    render(<Checkbox label="All" checked={false} indeterminate onCheckedChange={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'All' })).toHaveProperty('indeterminate', true);
  });

  it('can be disabled', () => {
    render(<Checkbox label="Locked" checked disabled onCheckedChange={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'Locked' })).toHaveProperty('disabled', true);
  });
});

describe('Switch', () => {
  it('has the switch role and flips', () => {
    const on = vi.fn();
    render(<Switch label="Auto-refresh" checked onCheckedChange={on} />);
    const sw = screen.getByRole('switch', { name: 'Auto-refresh' });
    expect(sw).toHaveProperty('checked', true);
    sw.focus();
    expect(document.activeElement).toBe(sw);
    fireEvent.click(sw);
    expect(on).toHaveBeenCalledWith(false);
  });
});

describe('RadioGroup', () => {
  const opts = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'year', label: 'Year', disabled: true },
  ];

  it('is a named group of one-of-many radios sharing a name', () => {
    const on = vi.fn();
    render(<RadioGroup label="Granularity" value="day" onValueChange={on} options={opts} />);
    const group = screen.getByRole('group', { name: 'Granularity' });
    const radios = screen.getAllByRole('radio');
    expect(group.contains(radios[0])).toBe(true);
    expect(new Set(radios.map((r) => r.getAttribute('name'))).size).toBe(1);
    expect(screen.getByRole('radio', { name: 'Day' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('radio', { name: 'Week' }));
    expect(on).toHaveBeenCalledWith('week');
    expect(screen.getByRole('radio', { name: 'Year' })).toHaveProperty('disabled', true);
  });

  it('an error marks the group invalid and describes it', () => {
    render(<RadioGroup label="Join" value="" onValueChange={() => {}} options={opts} error="Pick one." />);
    const group = screen.getByRole('group', { name: 'Join' });
    expect(group.getAttribute('aria-invalid')).toBe('true');
    const desc = group.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('Pick one.');
  });
});
