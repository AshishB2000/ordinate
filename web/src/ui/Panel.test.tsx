import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Panel } from './Panel';

describe('Panel', () => {
  it('is a named complementary region with a heading, body and footer', () => {
    render(
      <Panel title="Version history" sub="Dashboard" footer={<button type="button">Restore</button>}>
        <p>body</p>
      </Panel>,
    );
    const region = screen.getByRole('complementary', { name: 'Version history' });
    expect(screen.getByRole('heading', { level: 2, name: 'Version history' })).toBeTruthy();
    expect(region.textContent).toContain('Dashboard');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull(); // no onClose, no ✕
  });

  it('closes from the ✕ and from Escape inside it', () => {
    const onClose = vi.fn();
    render(
      <Panel title="Lineage" onClose={onClose}>
        <input aria-label="inside" />
      </Panel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'inside' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('leaves an Escape that a layer above already handled', () => {
    const onClose = vi.fn();
    render(
      <Panel title="Lineage" onClose={onClose}>
        <input aria-label="inside" onKeyDown={(e) => e.preventDefault()} />
      </Panel>,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
