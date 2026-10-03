// "Open in new window" — MAIN PROCESS.
//
// A tab's menu opens a SECOND hub window on one record: the same index.html,
// booted with `?open=<kind>:<id>&project=<id>&secondary=1` so hub.ts lands
// straight on that record with its own tab strip (tabStrip.ts). It is tracked by
// the window registry like the first one, which is what keeps once-only pushes
// (scheduled reports) on the PRIMARY and lets closing this window leave the app
// and the first window alone.
//
// Both windows share main's active project and the same localStorage; that is
// fine, because a secondary window only ever opens on the project it was asked
// for, and it never writes the saved tab set (see tabStrip.ts).

import { ipcMain } from './bus';
import { createHubWindow } from '../windows/hubWindow';
import * as hubs from '../windows/hubRegistry';
import { isValidId } from '../app/ids';

// A tab kind is a short lowercase word (tabKinds.ts); a record id is a UUID or,
// for a capture, its numeric entry id. Anything else never reaches a URL.
const KIND_RE = /^[a-z]{1,24}$/;
const RECORD_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,16})$/i;

export function register(): void {
  ipcMain.handle('windows:openRecord', (_e, arg: unknown) => {
    const { kind, id, projectId } = (arg || {}) as { kind?: unknown; id?: unknown; projectId?: unknown };
    if (typeof kind !== 'string' || !KIND_RE.test(kind)) return { ok: false, error: 'bad kind' };
    if (typeof id !== 'string' || !RECORD_RE.test(id)) return { ok: false, error: 'bad id' };
    if (!isValidId(projectId)) return { ok: false, error: 'bad project' };
    const win = hubs.add(createHubWindow({ query: { open: kind + ':' + id, project: projectId, secondary: '1' } }));
    win.focus();
    return { ok: true };
  });
}
