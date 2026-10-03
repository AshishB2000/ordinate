import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Button, buttonClass, IconButton } from './Button';

describe('Button', () => {
  it('is a real button named by its label, type=button by default', () => {
    const onClick = vi.fn();
    render(
      <Button icon="plus" onClick={onClick}>
        New visual
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'New visual' });
    expect(b.getAttribute('type')).toBe('button');
    expect(b.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    b.focus();
    expect(document.activeElement).toBe(b);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire when disabled; loading disables and announces busy', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b).toHaveProperty('disabled', true);
    expect(b.getAttribute('aria-busy')).toBe('true');
  });

  it('honours an explicit type (submit inside a form)', () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form onSubmit={(e) => onSubmit(e.nativeEvent)}>
        <Button type="submit">Go</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('exposes its look for links', () => {
    expect(typeof buttonClass('primary', 'sm')).toBe('string');
  });
});

describe('IconButton', () => {
  it('is named by its label (the glyph is hidden) and titled for the pointer', () => {
    const onClick = vi.fn();
    render(<IconButton icon="trash" label="Delete" onClick={onClick} />);
    const b = screen.getByRole('button', { name: 'Delete' });
    expect(b.getAttribute('title')).toBe('Delete');
    expect(b.textContent).toBe('');
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('can be disabled', () => {
    render(<IconButton icon="trash" label="Delete" disabled />);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);
  });
});
