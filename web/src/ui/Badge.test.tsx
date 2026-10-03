import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';
import { Kbd } from './Kbd';

describe('Badge', () => {
  it('carries its meaning in the word, the icon is decoration', () => {
    render(
      <Badge tone="error" icon="alert">
        Failed
      </Badge>,
    );
    const b = screen.getByText('Failed');
    expect(b.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Kbd', () => {
  it('renders each key as a <kbd>', () => {
    render(
      <p>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </p>,
    );
    expect(screen.getByText('K').tagName).toBe('KBD');
    expect(screen.getByText('⌘').tagName).toBe('KBD');
  });
});
