import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp, stubFetch } from '../../test-utils';

afterEach(() => vi.unstubAllGlobals());

describe('Home project list', () => {
  it('shows a skeleton while loading, then the projects', async () => {
    stubFetch(200, [
      { id: 'a', name: 'Sales', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' },
      { id: 'b', name: 'Ops', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', archivedAt: 'x' },
    ]);
    renderApp('/');
    expect(await screen.findByRole('status', { name: 'Loading projects' })).toBeTruthy();
    expect(await screen.findByText('Sales')).toBeTruthy();
    expect(screen.getByText('Ops')).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
  });

  it('designs the empty state', async () => {
    stubFetch(200, []);
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy();
  });

  it('shows the server error with a retry', async () => {
    stubFetch(404, { error: 'unknown channel' });
    renderApp('/');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Projects could not be loaded');
    expect(alert.textContent).toContain('unknown channel');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
