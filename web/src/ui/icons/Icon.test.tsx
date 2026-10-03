import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import hubIcons from '../../../../renderer/hub/icons.ts?raw';
import { ICON_NAMES, Icon } from './Icon';
import { ICON_PATHS } from './paths';

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

  // The generated set must match the desktop's hand-authored one exactly.
  // Same reading as web/scripts/gen-icons.mjs; rerun it if this fails.
  it('paths.ts is in sync with renderer/hub/icons.ts', () => {
    const block = /^const ICONS[^{]*\{([\s\S]*?)^\};/m.exec(hubIcons)![1].replace(/\/\*[\s\S]*?\*\//g, '');
    const source = Object.fromEntries(
      [...block.matchAll(/^\s*'?([\w-]+)'?:\s*'([^']*)',?\s*$/gm)].map((m) => [m[1], m[2]]),
    );
    expect(ICON_PATHS).toEqual(source);
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(92);
  });

  it('no glyph carries a style attribute (the CSP would drop it)', () => {
    for (const body of Object.values(ICON_PATHS)) expect(body).not.toMatch(/style=/);
  });
});
