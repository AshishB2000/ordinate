import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Input, Textarea } from './Field';

describe('Input', () => {
  it('is named by its label and described by its hint', () => {
    render(<Input label="Table name" hint="Letters and digits." defaultValue="sales" />);
    const input = screen.getByRole('textbox', { name: 'Table name' });
    const desc = input.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('Letters and digits.');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('an error marks it invalid and replaces the hint', () => {
    render(<Input label="Port" hint="1–65535" error="Must be a number." />);
    const input = screen.getByRole('textbox', { name: 'Port' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const desc = input.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toBe('Must be a number.');
    expect(screen.queryByText('1–65535')).toBeNull();
  });

  it('takes typing and focus; aria-label names it without a visible label', () => {
    const onChange = vi.fn();
    render(<Input aria-label="Search" icon="search" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Search' });
    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'rev' } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('can be disabled', () => {
    render(<Input label="Host" disabled />);
    expect(screen.getByRole('textbox', { name: 'Host' })).toHaveProperty('disabled', true);
  });
});

describe('Textarea', () => {
  it('is labelled, described by its error, and editable', () => {
    const onChange = vi.fn();
    render(<Textarea label="Rules" error="Too long." onChange={onChange} />);
    const ta = screen.getByRole('textbox', { name: 'Rules' });
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(ta, { target: { value: 'x' } });
    expect(onChange).toHaveBeenCalledOnce();
  });
});
