// "Open in Statistics" hands the workbench a crumb back to the dashboard it was opened from
// (useCameFrom) — named, even when the dashboard has no name yet.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Card } from '../api';
import { EditorCtx, type EditorApi } from './context';
import { StatsProps } from './KindProps';

const P = '11111111-1111-4111-8111-111111111111';

function open(name: string) {
  const ed = { projectId: P, doc: { name } } as unknown as EditorApi;
  const card = { id: 'c1', kind: 'stats', stats: { datasetId: 'd1' } } as unknown as Card;
  const router = createMemoryRouter(
    [{ path: '*', element: <EditorCtx.Provider value={ed}><StatsProps card={card} /></EditorCtx.Provider> }],
    { initialEntries: [`/analyses/${P}/a1`] },
  );
  render(<RouterProvider router={router} />);
  screen.getByRole('link', { name: 'Open in Statistics' }).click();
  return router.state.location.state as { back?: { to: string; label: string } };
}

describe('Open in Statistics', () => {
  it('names the dashboard in the crumb it hands over', () => {
    expect(open('Sales overview').back).toEqual({ to: `/analyses/${P}/a1`, label: 'Sales overview' });
  });

  it('an untitled dashboard still gets a crumb back (a blank name would send the reader to the hub)', () => {
    expect(open('').back).toEqual({ to: `/analyses/${P}/a1`, label: 'Dashboard' });
  });
});
