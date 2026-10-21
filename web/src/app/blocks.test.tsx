import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Button, buttonClass } from '../ui/Button';
import { Page, PageHead, useCameFrom, type Back } from './blocks';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function at(node: ReactNode, state?: unknown) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: [{ pathname: '/here', state }] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Page', () => {
  it('a title and a sentence draw what they always did: one h1, the sentence, no crumb, no actions', () => {
    at(
      <Page title="Data" sub="Datasets, per project.">
        <p>body</p>
      </Page>,
    );
    const head = screen.getByRole('banner');
    expect(within(head).getByRole('heading', { level: 1 }).textContent).toBe('Data');
    expect(within(head).getByText('Datasets, per project.').tagName).toBe('P');
    expect(within(head).queryByRole('link')).toBeNull();
    expect(head.querySelectorAll('button, a')).toHaveLength(0);
    expect(screen.getByText('body')).toBeTruthy();
  });

  it('back is the parent crumb ABOVE the title, a real link named by the parent', () => {
    const router = at(<Page title="Orders" back={{ to: '/data/p1', label: 'Datasets' }}>x</Page>);
    const crumb = screen.getByRole('link', { name: 'Datasets' });
    expect(crumb.getAttribute('href')).toBe('/data/p1');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(crumb.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    crumb.click();
    expect(router.state.location.pathname).toBe('/data/p1');
  });

  it('status sits right after the title, outside the heading; a node sub is a row, not a paragraph', () => {
    at(
      <Page title="Orders" status={<Badge>Live</Badge>} sub={<span>5,000 rows</span>}>
        x
      </Page>,
    );
    const h1 = screen.getByRole('heading', { level: 1, name: 'Orders' });
    expect(h1.nextElementSibling?.textContent).toBe('Live');
    expect(screen.getByText('5,000 rows').parentElement?.tagName).toBe('DIV');
  });

  it('a node title is still the one h1 (an editable name)', () => {
    at(<Page title={<input aria-label="Story name" defaultValue="Q3" />}>x</Page>);
    expect(screen.getByRole('heading', { level: 1 }).contains(screen.getByRole('textbox', { name: 'Story name' }))).toBe(true);
  });

  it('actions sit on the right of the title row; one primary is quiet', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    at(
      <Page title="Dashboards" actions={<><Button>Create dashboard</Button><Button variant="primary">Publish…</Button></>}>
        x
      </Page>,
    );
    const actions = screen.getByRole('button', { name: 'Publish…' }).parentElement!;
    expect(within(actions).getAllByRole('button').map((b) => b.textContent)).toEqual(['Create dashboard', 'Publish…']);
    expect(err).not.toHaveBeenCalled();
  });

  it('two primaries are a console error — a Button and a Link styled as one (negative control)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    at(
      <PageHead
        title="Data"
        actions={
          <>
            <Button variant="primary">Import file</Button>
            <a className={buttonClass('primary')} href="/x">
              Connect
            </a>
          </>
        }
      />,
    );
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/at most one primary action; "Data" has 2/);
  });
});

describe('useCameFrom', () => {
  const Crumb = ({ parent }: { parent: Back }) => {
    const b = useCameFrom(parent);
    return <span>{`${b.label} → ${b.to}`}</span>;
  };
  const HUB: Back = { to: '/analytics?project=p', label: 'Analytics' };

  it('the opener\'s crumb when it passed one, the parent otherwise', () => {
    at(<Crumb parent={HUB} />, { back: { to: '/data/p/d', label: 'Orders' } });
    expect(screen.getByText('Orders → /data/p/d')).toBeTruthy();
    cleanup();
    at(<Crumb parent={HUB} />);
    expect(screen.getByText('Analytics → /analytics?project=p')).toBeTruthy();
  });

  it('never a crumb off the app: another origin, a protocol-relative path or a blank label is the parent', () => {
    for (const back of [{ to: 'https://evil.test/', label: 'x' }, { to: '//evil.test', label: 'x' }, { to: '/data', label: '' }, 'junk']) {
      at(<Crumb parent={HUB} />, { back });
      expect(screen.getByText('Analytics → /analytics?project=p')).toBeTruthy();
      cleanup();
    }
  });
});
