// The palette's Create commands are an editor's of the current project: a
// viewer's palette does not list them. An editor's is the negative control.

import { describe, expect, it } from 'vitest';
import { appCommands, type AppCommandDeps } from './appCommands';

const deps = (canEdit: boolean): AppCommandDeps => ({
  go: () => {},
  role: 'viewer',
  canEdit,
  theme: 'system',
  setTheme: () => {},
  dockOpen: false,
  setDockOpen: () => {},
  togglePalette: () => {},
  openShortcuts: () => {},
});
const shown = (canEdit: boolean) => appCommands(deps(canEdit)).filter((c) => !c.when || c.when()).map((c) => c.id);

describe('appCommands', () => {
  it('hides every Create command from a viewer, and only those', () => {
    const viewer = shown(false);
    expect(viewer.filter((id) => id.startsWith('create.'))).toEqual([]);
    expect(viewer).toContain('nav.data');
    expect(viewer).toContain('settings.tokens');
  });

  it('negative control: an editor gets all four', () => {
    expect(shown(true).filter((id) => id.startsWith('create.'))).toEqual(['create.import', 'create.capture', 'create.connect', 'create.dashboard']);
  });
});
