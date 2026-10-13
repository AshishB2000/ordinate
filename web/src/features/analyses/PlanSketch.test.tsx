// The review's layout sketch: one box per tile of the server's `layout`, at
// that tile's place on the 12-column grid — and nothing at all for a reply that
// carries no layout. The sketch places what it is given; it works nothing out.

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { PlanPreview } from './api';
import { DraftFlow } from './DraftReview';
import { PlanSketch } from './PlanSketch';

type Layout = NonNullable<PlanPreview['sheets'][number]['layout']>;

// A spotlight with a rail of two, two charts side by side, then a note — in
// the reading order the server sends (top to bottom, then left to right).
const LAYOUT: Layout = [
  { kind: 'visual', x: 0, y: 0, w: 8, h: 6 },
  { kind: 'metric', x: 8, y: 0, w: 4, h: 3 },
  { kind: 'metric', x: 8, y: 3, w: 4, h: 3 },
  { kind: 'visual', x: 0, y: 6, w: 6, h: 6 },
  { kind: 'visual', x: 6, y: 6, w: 6, h: 6 },
  { kind: 'text', x: 0, y: 12, w: 12, h: 2 },
];

const boxes = (img: HTMLElement) => [...img.children] as HTMLElement[];

describe('the layout sketch', () => {
  it('draws one box per tile, at its place on the 12-column grid', () => {
    render(<PlanSketch layout={LAYOUT} />);
    expect(boxes(screen.getByRole('img')).map((b) => `${b.style.gridColumn} | ${b.style.gridRow}`)).toEqual([
      '1 / span 8 | 1 / span 6',
      '9 / span 4 | 1 / span 3',
      '9 / span 4 | 4 / span 3',
      '1 / span 6 | 7 / span 6',
      '7 / span 6 | 7 / span 6',
      '1 / span 12 | 13 / span 2',
    ]);
  });

  it('tells a KPI, a chart and a note apart, and the same kind looks the same', () => {
    render(<PlanSketch layout={LAYOUT} />);
    const looks = boxes(screen.getByRole('img')).map((b) => b.className);
    expect(new Set(looks).size).toBe(3);
    expect(looks[1]).toBe(looks[2]); // the two KPIs
    expect(looks[0]).toBe(looks[3]); // two of the charts
    expect(looks[5]).not.toBe(looks[0]);
  });

  it('is an image with the arrangement in words, band by band', () => {
    render(<PlanSketch layout={LAYOUT} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Layout, top to bottom: 1 chart beside 2 KPIs; then 2 charts; then 1 note');
  });

  it('a flat sheet reads as its strip and then its chart', () => {
    render(
      <PlanSketch
        layout={[
          { kind: 'metric', x: 0, y: 0, w: 3, h: 2 },
          { kind: 'metric', x: 3, y: 0, w: 3, h: 2 },
          { kind: 'visual', x: 0, y: 2, w: 12, h: 6 },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'Layout, top to bottom: 2 KPIs; then 1 chart' })).toBeTruthy();
  });

  it('draws nothing without a layout (an older reply), or with an empty one', () => {
    expect(render(<PlanSketch />).container.firstChild).toBeNull();
    expect(render(<PlanSketch layout={[]} />).container.firstChild).toBeNull();
  });

  it('the review shows it on each sheet that has a layout, and on no other', async () => {
    const draft: PlanPreview = {
      ok: true,
      name: 'Orders overview',
      sheets: [
        { name: 'Overview', visuals: [], layout: LAYOUT },
        { name: 'Older', visuals: [] },
      ],
    };
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <DraftFlow projectId="11111111-1111-4111-8111-111111111111" draft={draft} onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const overview = await screen.findByRole('region', { name: 'Overview' });
    expect(boxes(within(overview).getByRole('img', { name: /^Layout, top to bottom/ }))).toHaveLength(LAYOUT.length);
    // A sheet with tiles on it is not an empty one, whatever the charts are.
    expect(within(overview).queryByText('Nothing survived on this sheet.')).toBeNull();
    const older = screen.getByRole('region', { name: 'Older' });
    expect(within(older).queryByRole('img')).toBeNull();
    expect(within(older).getByText('Nothing survived on this sheet.')).toBeTruthy();
  });
});
