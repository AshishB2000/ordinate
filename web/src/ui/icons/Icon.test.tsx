import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ICON_NAMES, Icon } from './Icon';
import { ICON_PATHS } from './paths';
import { golden } from '../../test-golden';

describe('Icon', () => {
  it('is decorative by default, in the house frame', () => {
    const { container } = render(<Icon name="trash" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect([svg.getAttribute('viewBox'), svg.getAttribute('width'), svg.getAttribute('stroke-width')]).toEqual([
      '0 0 24 24',
      '16',
      '1.5',
    ]);
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(/d="([^"]+)"/.exec(ICON_PATHS.trash)![1]);
  });

  it('a labelled icon is an image with a name', () => {
    render(<Icon name="alert" label="Warning" size={20} />);
    expect(screen.getByRole('img', { name: 'Warning' }).getAttribute('width')).toBe('20');
  });

  // paths.ts was generated from the desktop's hand-authored set (its icons.ts),
  // recorded at the T8.1 cutover as __golden__/icons.json. paths.ts is now the
  // source: an icon changed on purpose changes that fixture with it.
  it('paths.ts is the desktop icon set, glyph for glyph', () => {
    expect(ICON_PATHS).toEqual(golden('src/ui/icons/__golden__/icons.json'));
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(92);
  });

  it('no glyph carries a style attribute (the CSP would drop it)', () => {
    for (const body of Object.values(ICON_PATHS)) expect(body).not.toMatch(/style=/);
  });
});
