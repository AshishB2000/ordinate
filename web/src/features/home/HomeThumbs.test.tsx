import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RecentItem } from '../../api/home';

// The props each Home picture asks the gallery's thumbnail for.
const h = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('../visuals/Thumb', () => ({
  NO_THUMB: new Set<string>(),
  Thumb: (p: Record<string, unknown>) => {
    h.props.push(p);
    return null;
  },
}));

const { default: HomeThumb } = await import('./HomeThumbs');

afterEach(cleanup);

it("draws a visual's picture accent-only: Home's thumbnails follow the member's highlight, not the visual's colours", () => {
  const it: RecentItem = { type: 'visual', id: 'v1', projectId: 'p1', projectName: 'P', name: 'Revenue', updatedAt: '2026-10-26T00:00:00Z', meta: { chartType: 'line' } };
  render(<HomeThumb it={it} onDrawn={() => {}} />);
  expect(h.props).toHaveLength(1);
  expect(h.props[0]).toMatchObject({ projectId: 'p1', visible: true, accentOnly: true });
});
