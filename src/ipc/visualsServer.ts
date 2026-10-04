// Server-only Visuals channels (T2.7). ./visuals.ts sits at its size cap, so
// what only the web app needs lives here.
//
// `visual:thumbs` — the gallery's live thumbnails in ONE call: each saved
// visual's own `visual:data`, from its STORED definition (encoding + filters),
// answered by the very handler `visual:data` runs. The desktop gallery asked
// per card (visual:get, then visual:data); over HTTP that is two round trips a
// card. A missing visual is a per-item refusal, never a failed batch.

import { ipcMain } from './bus';
import { handlers } from '../server/rpc';
import * as visuals from '../analysis/visuals';

export function register(): void {
  ipcMain.handle('visual:thumbs', async (e, { projectId, ids }: { projectId: string; ids: string[] }) => {
    const data = handlers.get('visual:data');
    if (!data) return ids.map((id) => ({ id, ok: false, error: 'Charts are not available on this server.' }));
    return Promise.all(
      ids.map(async (id) => {
        const v = await visuals.getVisual(projectId, id);
        if (!v) return { id, ok: false, error: 'That visual no longer exists.' };
        const reply = (await data(e, { projectId, datasetId: v.datasetId, encoding: v.encoding, filters: v.filters })) as object;
        return { ...reply, id, chartType: v.chartType, overrides: v.overrides };
      }),
    );
  });
}
