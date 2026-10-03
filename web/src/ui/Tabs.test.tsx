import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Tab, TabList, TabPanel, Tabs } from './Tabs';

function setup(onValueChange = vi.fn()) {
  render(
    <Tabs defaultValue="rows" onValueChange={onValueChange}>
      <TabList label="Dataset">
        <Tab value="rows" icon="table" count="12">
          Rows
        </Tab>
        <Tab value="rules" disabled>
          Rules
        </Tab>
        <Tab value="profile">Profile</Tab>
      </TabList>
      <TabPanel value="rows">rows panel</TabPanel>
      <TabPanel value="profile">profile panel</TabPanel>
    </Tabs>,
  );
}

describe('Tabs', () => {
  it('is a named tablist whose selected tab controls the visible panel', () => {
    setup();
    expect(screen.getByRole('tablist', { name: 'Dataset' })).toBeTruthy();
    const rows = screen.getByRole('tab', { name: /Rows/ });
    expect(rows.getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByRole('tabpanel');
    expect(rows.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.textContent).toBe('rows panel');
  });

  it('→ moves to the next enabled tab and activates it', async () => {
    const onValueChange = vi.fn();
    setup(onValueChange);
    const rows = screen.getByRole('tab', { name: /Rows/ });
    act(() => rows.focus());
    fireEvent.keyDown(rows, { key: 'ArrowRight' });
    const profile = screen.getByRole('tab', { name: 'Profile' });
    await waitFor(() => expect(document.activeElement).toBe(profile));
    expect(onValueChange).toHaveBeenCalledWith('profile');
    expect(screen.getByRole('tabpanel').textContent).toBe('profile panel');
  });

  it('click selects; a disabled tab cannot be selected', () => {
    setup();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Rules' }));
    expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('false');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Profile' }), { button: 0 });
    expect(screen.getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
  });
});
