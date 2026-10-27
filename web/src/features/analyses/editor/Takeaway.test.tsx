// The sheet's takeaway (Takeaway.tsx): which card leads, and the server's
// sentence set with its figures in bold — every character kept as sent.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Emphasised, leadVisual } from './Takeaway';
import type { Card } from '../api';

const card = (id: string, x: number, y: number, extra: Partial<Card> = {}): Card => ({ id, type: 'visual', visualId: `v-${id}`, layout: { x, y, w: 6, h: 6 }, ...extra });

describe('the takeaway', () => {
  it('leads with the first chart in reading order — not a KPI, not one inside a group', () => {
    const cards = [card('b', 6, 0), card('a', 0, 0), card('k', 0, -1, { type: 'metric', visualId: undefined }), card('g', 0, -2, { parentId: 'x' })];
    expect(leadVisual(cards)).toBe('v-a');
    expect(leadVisual([card('low', 0, 9), card('high', 6, 2)])).toBe('v-high');
    expect(leadVisual([])).toBeUndefined();
  });

  it('bolds the figures and keeps the sentence as the server wrote it', () => {
    const text = 'California leads Population 2024 at 38.9M, 1.3× Texas';
    const { container } = render(<p><Emphasised text={text} /></p>);
    expect(container.textContent).toBe(text);
    expect(Array.from(container.querySelectorAll('strong')).map((b) => b.textContent)).toEqual(['2024', '38.9M', '1.3×']);
  });
});
